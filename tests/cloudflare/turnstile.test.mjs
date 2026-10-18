import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const password = 'Synthetic-Turnstile-9147!';
const email = 'owner@example.test';
const origin = 'https://api.turnstile.test';
const app = 'https://app.turnstile.test';
const seconds = () => Math.floor(Date.now() / 1000);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const compiled = await build({
  stdin: {
    contents: `import worker from './cloudflare/worker.ts';
      import {testVerifyCalls} from './cloudflare/auth/crypto.ts';
      export default {async fetch(request,env,ctx) {
        const tasks=[];
        const response=await worker.fetch(request,env,{waitUntil(p){tasks.push(p);ctx.waitUntil(p);}});
        await Promise.all(tasks);
        const headers=new Headers(response.headers); headers.set('X-Test-KDF-Calls',String(testVerifyCalls()));
        return new Response(response.body,{status:response.status,headers});
      }};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  define: { __BUILD_REVISION__: JSON.stringify('synthetic-turnstile-test') },
  plugins: [
    {
      name: 'count-real-password-verifications',
      setup(builder) {
        builder.onLoad({ filter: /auth[\\/]crypto\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const needle = "  let parts = stored?.split('$') ?? [];";
          assert.ok(source.includes(needle));
          return {
            loader: 'ts',
            contents:
              'let calls=0; export const testVerifyCalls=()=>calls;\n' +
              source.replace(needle, () => '  calls++;\n' + needle),
          };
        });
      },
    },
  ],
});

async function fixture(run) {
  const bindings = {
    APP_ENV: 'production',
    APP_URL: app,
    CORS_ORIGINS: app,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    MONITORIE_MODE: 'unconfigured',
    LOGIN_TURNSTILE_MODE: 'adaptive',
    LOGIN_TURNSTILE_FAILURE_THRESHOLD: '2',
    LOGIN_TURNSTILE_WINDOW_SECONDS: '900',
    TURNSTILE_SITE_KEY: 'synthetic_site_key',
    TURNSTILE_SECRET_KEY: randomBytes(32).toString('base64url'),
  };
  const tokens = new Map(),
    used = new Set(),
    verifications = [];
  let override,
    issued = 0,
    addresses = 0;
  const options = () => ({
    modules: true,
    script: compiled.outputFiles[0].text,
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'turnstile-tests' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
    bindings,
    outboundService: async (request) => {
      assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(request.method, 'POST');
      const input = await request.json();
      assert.equal(input.secret, bindings.TURNSTILE_SECRET_KEY);
      assert.deepEqual(Object.keys(input).sort(), ['response', 'secret']);
      verifications.push(input.response);
      if (override) return override(request, input);
      let result = tokens.get(input.response);
      if (!result) result = { success: false, 'error-codes': ['invalid-input-response'] };
      else if (used.has(input.response) || Date.now() - Date.parse(result.challenge_ts) >= 300000)
        result = { success: false, 'error-codes': ['timeout-or-duplicate'] };
      else used.add(input.response);
      return new MFResponse(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const mf = new Miniflare(options());
  let db = await mf.getD1Database('DB');
  try {
    for (const file of (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort())
      await db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    const salt = randomBytes(16).toString('base64url');
    const peppered = createHmac('sha256', bindings.PASSWORD_PEPPER).update(password).digest('hex');
    const hash = pbkdf2Sync(peppered, salt, 100000, 32, 'sha256').toString('hex');
    await db
      .prepare(
        'INSERT INTO users(id,name,email,password_hash,email_verified_at,created_at,updated_at) VALUES(1,?,?,?,?,?,?)',
      )
      .bind(
        'Synthetic owner',
        email,
        `pbkdf2-sha256-pepper$v2$primary$100000$${salt}$${hash}`,
        seconds(),
        seconds(),
        seconds(),
      )
      .run();
    async function client() {
      const token = randomBytes(32).toString('base64url');
      let cookie = '__Host-HIDRAR3B=' + token,
        csrf = randomBytes(32).toString('base64url');
      const address = '198.51.100.' + ++addresses;
      await db
        .prepare(
          'INSERT INTO sessions(token_hash,csrf_token,created_at,last_seen,rotated_at,expires_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(sha(token), csrf, seconds(), seconds(), seconds(), seconds() + 3600)
        .run();
      return {
        async request(data, headers = {}, path = '/api/auth/login') {
          const response = await mf.dispatchFetch(origin + path, {
            method: data === undefined ? 'GET' : 'POST',
            redirect: 'manual',
            headers: {
              Origin: app,
              Cookie: cookie,
              'CF-Connecting-IP': address,
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf,
              ...headers,
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          if (response.headers.get('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
          const payload = await response.json();
          if (payload.csrf_token) csrf = payload.csrf_token;
          if (bindings.TURNSTILE_SECRET_KEY)
            assert.ok(!JSON.stringify(payload).includes(bindings.TURNSTILE_SECRET_KEY));
          return { status: response.status, payload, kdf: Number(response.headers.get('X-Test-KDF-Calls')) };
        },
      };
    }
    const counterKey = (identity) =>
      createHmac('sha256', bindings.SESSION_SECRET)
        .update('login-account-failure\0' + identity.toLowerCase().trim())
        .digest('hex');
    const fail = (identity = email, count = 2, expiry = seconds() + 900) =>
      db
        .prepare(
          'INSERT INTO rate_limits(key_hash,attempts,expires_at) VALUES(?,?,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at',
        )
        .bind(counterKey(identity), count, expiry)
        .run();
    await run({
      bindings,
      verifications,
      client,
      fail,
      db: () => db,
      issue(challenge, extra = {}) {
        const token = 'synthetic-turnstile-' + ++issued;
        tokens.set(token, {
          success: true,
          action: 'login',
          hostname: new URL(app).hostname,
          cdata: challenge.cdata,
          challenge_ts: new Date().toISOString(),
          ...extra,
        });
        return token;
      },
      setResponse(value) {
        override = value;
      },
      async reconfigure() {
        await mf.setOptions(options());
        db = await mf.getD1Database('DB');
      },
    });
  } finally {
    await mf.dispose();
  }
}
const login = (token, pass = password, identity = email) => ({
  email: identity,
  password: pass,
  ...(token === undefined ? {} : { turnstile_token: token }),
});

test('adaptive login counts distributed failures and requires missing token before the real KDF', () =>
  fixture(async (h) => {
    for (const identity of [email, 'absent@example.test']) {
      for (let i = 0; i < 2; i++) {
        const result = await (await h.client()).request(login(undefined, 'wrong', identity));
        assert.equal(result.status, 401);
      }
      const owner = await h.client();
      const before = await h
        .db()
        .prepare('SELECT attempts,expires_at FROM rate_limits WHERE attempts=2')
        .all();
      const result = await owner.request(login(undefined, password, identity));
      assert.equal(result.status, 403);
      assert.equal(result.payload.error.code, 'TURNSTILE_REQUIRED');
      assert.equal(result.kdf, identity === email ? 2 : 4);
      assert.equal(result.payload.turnstile.site_key, h.bindings.TURNSTILE_SITE_KEY);
      assert.match(result.payload.turnstile.cdata, /^[a-f0-9]{64}$/);
      assert.equal(h.verifications.length, 0);
      assert.deepEqual(
        (await h.db().prepare('SELECT attempts,expires_at FROM rate_limits WHERE attempts=2').all()).results,
        before.results,
      );
    }
  }));

test('invalid, expired, malformed and oversized tokens never reach password verification', () =>
  fixture(async (h) => {
    await h.fail();
    const owner = await h.client();
    const required = await owner.request(login());
    const expired = h.issue(required.payload.turnstile, {
      challenge_ts: new Date(Date.now() - 301000).toISOString(),
    });
    for (const token of ['invalid-token', expired, 'x'.repeat(2049), 42]) {
      const result = await owner.request(login(token));
      assert.equal(result.status, 403);
      assert.equal(result.payload.error.code, 'TURNSTILE_INVALID');
      assert.equal(result.kdf, 0);
    }
    assert.equal(h.verifications.length, 2, 'Malformed tokens do not call Siteverify');
  }));

test('each challenged password attempt needs a fresh token; legitimate owner can log in despite saturation', () =>
  fixture(async (h) => {
    await h.fail(email, 10);
    const owner = await h.client();
    const required = await owner.request(login());
    const first = h.issue(required.payload.turnstile);
    const wrong = await owner.request(login(first, 'wrong'));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.payload.error.code, 'INVALID_CREDENTIALS');
    assert.equal(wrong.kdf, 1);
    const replay = await owner.request(login(first));
    assert.equal(replay.status, 403);
    assert.equal(replay.kdf, 1);
    const fresh = h.issue(replay.payload.turnstile);
    const success = await owner.request(login(fresh));
    assert.equal(success.status, 200);
    assert.equal(success.payload.user.email, email);
    assert.equal(success.kdf, 2);
    assert.equal(
      (await h.db().prepare('SELECT COUNT(*) n FROM rate_limits WHERE attempts>=10').first()).n,
      0,
    );
    const reusedAfterSuccess = await owner.request(login(fresh));
    assert.equal(
      reusedAfterSuccess.status,
      403,
      'Supplied tokens are checked even after a success cleared the counter',
    );
    assert.equal(reusedAfterSuccess.kdf, 2);
    assert.equal((await (await h.client()).request(login())).status, 200, 'No account-wide lock remains');
    await h.fail(email, 10);
    const parallel = await h.client();
    const context = await parallel.request(login());
    const once = h.issue(context.payload.turnstile);
    const attempts = await Promise.all([parallel.request(login(once)), parallel.request(login(once))]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 403]);
    assert.equal(
      attempts.find((result) => result.status === 200).kdf,
      4,
      'Concurrent reuse admits exactly one additional password verification',
    );
  }));

test('hostname, action, session/identity binding and validation timestamps are checked server-side', () =>
  fixture(async (h) => {
    await h.fail();
    const owner = await h.client(),
      other = await h.client();
    const required = await owner.request(login());
    const crossSession = h.issue(required.payload.turnstile);
    assert.equal((await other.request(login(crossSession))).kdf, 0);
    await h.fail('other@example.test');
    const crossIdentity = await owner.request(
      login(h.issue(required.payload.turnstile), password, 'other@example.test'),
    );
    assert.equal(crossIdentity.status, 403);
    assert.equal(crossIdentity.kdf, 0);
    for (const extra of [
      { hostname: 'evil.example.test' },
      { action: 'register' },
      { cdata: '0'.repeat(64) },
      { challenge_ts: 'invalid' },
      { challenge_ts: new Date(Date.now() + 120000).toISOString() },
    ]) {
      const result = await owner.request(login(h.issue(required.payload.turnstile, extra)));
      assert.equal(result.status, 403);
      assert.equal(result.kdf, 0);
    }
  }));

test('IP and IP/email limits precede Siteverify and KDF, including challenged requests', () =>
  fixture(async (h) => {
    await h.fail();
    const one = await h.client();
    for (let i = 0; i < 10; i++) assert.equal((await one.request(login())).status, 403);
    const limited = await one.request(login('not-checked'));
    assert.equal(limited.status, 429);
    assert.equal(limited.kdf, 0);
    const many = await h.client();
    for (let i = 0; i < 20; i++) {
      const identity = `u${i}@example.test`;
      await h.fail(identity);
      assert.equal((await many.request(login(undefined, password, identity))).status, 403);
    }
    assert.equal((await many.request(login('not-checked', password, 'next@example.test'))).status, 429);
    assert.equal(h.verifications.length, 0);
  }));

test('threshold/window are configurable above ten; expired counters and disabled mode preserve normal login', () =>
  fixture(async (h) => {
    h.bindings.LOGIN_TURNSTILE_FAILURE_THRESHOLD = '21';
    h.bindings.LOGIN_TURNSTILE_WINDOW_SECONDS = '120';
    await h.reconfigure();
    await h.fail(email, 20);
    const attacker = await h.client();
    assert.equal((await attacker.request(login(undefined, 'wrong'))).status, 401);
    const required = await attacker.request(login());
    assert.equal(required.status, 403);
    const passed = await attacker.request(login(h.issue(required.payload.turnstile)));
    assert.equal(passed.status, 200);
    assert.equal((await attacker.request(login(undefined, 'wrong'))).status, 401);
    const window = await h
      .db()
      .prepare('SELECT expires_at FROM rate_limits WHERE attempts=1 AND expires_at<=?')
      .bind(seconds() + 120)
      .all();
    assert.ok(window.results.some((row) => row.expires_at >= seconds() + 118));
    await h.fail(email, 21, seconds() - 1);
    assert.equal((await (await h.client()).request(login())).status, 200);
    await h.fail(email, 21);
    h.bindings.LOGIN_TURNSTILE_MODE = 'disabled';
    h.bindings.TURNSTILE_SECRET_KEY = '';
    await h.reconfigure();
    assert.equal((await (await h.client()).request(login())).status, 200);
  }));

test('Siteverify errors/redirects/oversize responses fail closed without leaking remote text', () =>
  fixture(async (h) => {
    await h.fail();
    const owner = await h.client();
    for (const response of [
      () => {
        throw new Error('private-provider-error');
      },
      () => new MFResponse('private-provider-error', { status: 503 }),
      () => new MFResponse(null, { status: 302, headers: { Location: 'https://evil.test' } }),
      () => new MFResponse(' '.repeat(16385), { headers: { 'Content-Type': 'application/json' } }),
      () =>
        new MFResponse('{"success":false,"error-codes":["internal-error"]}', {
          headers: { 'Content-Type': 'application/json' },
        }),
    ]) {
      h.setResponse(response);
      const result = await owner.request(login('synthetic-rejected'));
      assert.equal(result.status, 503);
      assert.equal(result.payload.error.code, 'TURNSTILE_UNAVAILABLE');
      assert.equal(result.kdf, 0);
      assert.ok(!JSON.stringify(result.payload).includes('private-provider-error'));
    }
    assert.equal(h.verifications.length, 5, 'No retry or redirect follow');
  }));

test('adaptive mode with missing configuration fails readiness and all login before KDF', () =>
  fixture(async (h) => {
    h.bindings.TURNSTILE_SECRET_KEY = '';
    await h.reconfigure();
    const owner = await h.client();
    const result = await owner.request(login());
    assert.equal(result.status, 503);
    assert.equal(result.payload.error.code, 'TURNSTILE_CONFIGURATION_REQUIRED');
    assert.equal(result.kdf, 0);
    assert.equal((await owner.request(undefined, {}, '/api/ready')).status, 503);
    assert.equal(h.verifications.length, 0);
  }));
