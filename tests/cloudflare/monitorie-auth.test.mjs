import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

async function load(entry) {
  const compiled = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  );
}
const { MonitorieAuth, monitorieAuthConfigured } = await load('cloudflare/monitorie/auth.ts');
const { MonitorieReadClient } = await load('cloudflare/monitorie/protocol.ts');
const deviceId = '00000000-0000-4000-8000-000000000001';
const fakeJwt = (expirationMs, marker) =>
  `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expirationMs / 1000), marker })).toString('base64url')}.signature`;
const response = (value) => Response.json(value);
const gate = () => ({ async reserve() {}, async defer() {} });

async function withDb(run) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'monitorie-auth-test' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    const sql = unstable_splitSqlQuery(
      await readFile('cloudflare/migrations/0007_monitorie_auth_cache.sql', 'utf8'),
    );
    await db.batch(sql.map((statement) => db.prepare(statement)));
    return await run(db);
  } finally {
    await mf.dispose();
  }
}
function env(db) {
  return {
    DB: db,
    MONITORIE_MODE: 'live',
    MONITORIE_USERNAME: 'operator@example.test',
    MONITORIE_PASSWORD: 'test password never logged',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  };
}

test('MonitorIE: login, consulta, refresh rotativo e nova consulta usam X-Authorization', async () =>
  withDb(async (db) => {
    let time = Date.now();
    const start = time;
    const seen = [];
    const access1 = fakeJwt(start + 180_000, 'access1');
    const access2 = fakeJwt(start + 1_200_000, 'access2');
    const access3 = fakeJwt(start + 1_200_000, 'access3');
    const refresh1 = fakeJwt(start + 3_600_000, 'refresh1');
    const refresh2 = fakeJwt(start + 3_600_000, 'refresh2');
    let refreshes = 0;
    const transport = async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://monitorie.com.br');
      assert.equal(request.redirect, 'manual');
      if (request.method === 'POST') {
        assert.equal(request.headers.get('Authorization'), null);
        const body = await request.json();
        seen.push(url.pathname);
        if (url.pathname === '/api/auth/login') {
          assert.deepEqual(body, {
            username: env(db).MONITORIE_USERNAME,
            password: env(db).MONITORIE_PASSWORD,
          });
          return response({ token: access1, refreshToken: refresh1 });
        }
        assert.equal(url.pathname, '/api/auth/token');
        refreshes++;
        assert.equal(body.refreshToken, refreshes === 1 ? refresh1 : refresh2);
        return response(refreshes === 1 ? { token: access2, refreshToken: refresh2 } : { token: access3 });
      }
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('Authorization'), null);
      seen.push(request.headers.get('X-Authorization'));
      assert.equal(url.searchParams.get('useStrictDataTypes'), 'true');
      return response({ level: [{ ts: start, value: 40 }] });
    };
    const auth = new MonitorieAuth(env(db), transport, () => time);
    const client = new MonitorieReadClient(auth, gate(), transport);
    assert.equal((await client.latest(deviceId, ['level'])).level[0].value, 40);
    time += 61_000;
    assert.equal((await client.latest(deviceId, ['level'])).level[0].value, 40);
    await auth.rejected(access2);
    assert.equal((await client.latest(deviceId, ['level'])).level[0].value, 40);
    assert.deepEqual(seen, [
      '/api/auth/login',
      `Bearer ${access1}`,
      '/api/auth/token',
      `Bearer ${access2}`,
      '/api/auth/token',
      `Bearer ${access3}`,
    ]);
    const stored = await db.prepare('SELECT * FROM monitorie_auth_cache WHERE id=1').first();
    assert.ok(stored.sealed && stored.nonce);
    for (const sensitive of [env(db).MONITORIE_USERNAME, env(db).MONITORIE_PASSWORD, access3, refresh2])
      assert.equal(JSON.stringify(stored).includes(sensitive), false);
    assert.equal(await monitorieAuthConfigured(env(db)), true);
  }));

test('MonitorIE: refresh inválido faz um login novo; falha de rede não cria loop', async () =>
  withDb(async (db) => {
    let time = Date.now();
    let logins = 0,
      refreshes = 0,
      networkFailure = false;
    const transport = async (request) => {
      if (request.url.endsWith('/api/auth/login')) {
        logins++;
        return response({
          token: fakeJwt(time + (logins === 1 ? 180_000 : 1_200_000), `login${logins}`),
          refreshToken: fakeJwt(time + 3_600_000, `refresh${logins}`),
        });
      }
      assert.ok(request.url.endsWith('/api/auth/token'));
      refreshes++;
      if (networkFailure) throw new Error('test password never logged');
      return new Response('test password never logged', { status: 401 });
    };
    const auth = new MonitorieAuth(env(db), transport, () => time);
    await auth.get();
    time += 61_000;
    await auth.get();
    assert.equal(logins, 2);
    assert.equal(refreshes, 1);
    await auth.rejected(await auth.get());
    networkFailure = true;
    await assert.rejects(
      auth.get(),
      (error) => error.code === 'MONITORIE_AUTH_UNAVAILABLE' && !error.message.includes('password'),
    );
    assert.equal(logins, 2);
    assert.equal(refreshes, 2);
  }));

test('MonitorIE: cache criptografado e lease D1 impedem dois logins simultâneos', async () =>
  withDb(async (db) => {
    const start = Date.now();
    let release, entered;
    const begun = new Promise((resolve) => {
      entered = resolve;
    });
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let logins = 0;
    const transport = async (request) => {
      assert.ok(request.url.endsWith('/api/auth/login'));
      logins++;
      entered();
      await hold;
      return response({
        token: fakeJwt(start + 1_200_000, 'one'),
        refreshToken: fakeJwt(start + 3_600_000, 'one-refresh'),
      });
    };
    const first = new MonitorieAuth(env(db), transport);
    const second = new MonitorieAuth(env(db), transport);
    const pending = Promise.all([first.get(), second.get()]);
    await begun;
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const tokens = await pending;
    assert.equal(tokens[0], tokens[1]);
    assert.equal(logins, 1);
  }));

test('MonitorIE: configuração parcial e segredo ausente falham sem transmitir credenciais', async () =>
  withDb(async (db) => {
    const config = env(db);
    let calls = 0;
    const transport = async () => {
      calls++;
      return response({});
    };
    await assert.rejects(
      new MonitorieAuth({ ...config, MONITORIE_PASSWORD: '' }, transport).get(),
      (error) => error.code === 'MONITORIE_NOT_CONFIGURED',
    );
    await assert.rejects(
      new MonitorieAuth({ ...config, SESSION_SECRET: '' }, transport).get(),
      (error) => error.code === 'CONFIGURATION_REQUIRED',
    );
    assert.equal(calls, 0);
  }));

test('MonitorIE: prazo informado de 20 minutos limita até um JWT com exp maior', async () =>
  withDb(async (db) => {
    let time = Date.now();
    let logins = 0;
    let refreshes = 0;
    const transport = async (request) => {
      if (request.url.endsWith('/api/auth/login')) {
        logins++;
        return response({
          token: fakeJwt(time + 3 * 3_600_000, 'long-access'),
          refreshToken: fakeJwt(time + 4 * 3_600_000, 'long-refresh'),
        });
      }
      refreshes++;
      return response({ token: fakeJwt(time + 3 * 3_600_000, 'renewed-access') });
    };
    const auth = new MonitorieAuth(env(db), transport, () => time);
    await auth.get();
    time += 18 * 60_000 + 1_000;
    await auth.get();
    assert.equal(logins, 1);
    assert.equal(refreshes, 1);
  }));

test('MonitorIE: 401 da telemetria invalida só o token usado e renova no próximo ciclo', async () =>
  withDb(async (db) => {
    const start = Date.now();
    const access1 = fakeJwt(start + 1_200_000, 'rejected');
    const access2 = fakeJwt(start + 1_200_000, 'accepted');
    const refresh = fakeJwt(start + 3_600_000, 'refresh');
    const calls = [];
    const transport = async (request) => {
      if (request.method === 'POST') {
        calls.push(new URL(request.url).pathname);
        if (request.url.endsWith('/api/auth/login'))
          return response({ token: access1, refreshToken: refresh });
        return response({ token: access2, refreshToken: refresh });
      }
      calls.push(request.headers.get('X-Authorization'));
      return request.headers.get('X-Authorization') === `Bearer ${access1}`
        ? new Response(null, { status: 401 })
        : response({ level: [{ ts: start, value: 42 }] });
    };
    const auth = new MonitorieAuth(env(db), transport);
    const client = new MonitorieReadClient(auth, gate(), transport);
    await assert.rejects(
      client.latest(deviceId, ['level']),
      (error) => error.code === 'MONITORIE_TOKEN_REJECTED',
    );
    assert.equal((await client.latest(deviceId, ['level'])).level[0].value, 42);
    assert.deepEqual(calls, ['/api/auth/login', `Bearer ${access1}`, '/api/auth/token', `Bearer ${access2}`]);
  }));
