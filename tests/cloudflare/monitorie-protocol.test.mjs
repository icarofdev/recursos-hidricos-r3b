import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

const compiled = await build({
  entryPoints: ['cloudflare/monitorie/protocol.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const { MonitorieReadClient, monitorieJwt, D1MonitorieGate, timestampMsToIso, secondsToTimestampMs } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const id = '00000000-0000-4000-8000-000000000001';
const stamp = 1700000000123;
const makeGate = () => ({
  calls: 0,
  delays: [],
  async reserve() {
    this.calls++;
  },
  async defer(n) {
    this.delays.push(n);
  },
});
const json = (value) => Response.json(value);
const code = (expected) => (error) => error.code === expected && !error.message.includes('FAKE_SECRET');
const jwt = (expires) =>
  `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64url')}.signature`;

test('MonitorIE: secret JWT ausente, malformado ou expirado falha fechado sem chamada externa', () => {
  const now = 1700000000000;
  assert.throws(
    () => monitorieJwt({ MONITORIE_MODE: 'unconfigured' }, now),
    code('MONITORIE_NOT_CONFIGURED'),
  );
  assert.throws(
    () => monitorieJwt({ MONITORIE_MODE: 'live', MONITORIE_JWT: 'FAKE_SECRET' }, now),
    code('MONITORIE_NOT_CONFIGURED'),
  );
  assert.throws(
    () => monitorieJwt({ MONITORIE_MODE: 'live', MONITORIE_JWT: jwt(now / 1000 - 1) }, now),
    code('MONITORIE_TOKEN_EXPIRED'),
  );
  assert.equal(
    monitorieJwt({ MONITORIE_MODE: 'live', MONITORIE_JWT: jwt(now / 1000 + 3600) }, now),
    jwt(now / 1000 + 3600),
  );
});

test('MonitorIE: dispositivos, keys e latest usam somente GET, destino fixo e X-Authorization', async () => {
  const requests = [];
  const gate = makeGate();
  const client = new MonitorieReadClient(
    async () => 'FAKE_ACCESS',
    gate,
    async (req) => {
      requests.push(req);
      assert.equal(req.headers.get('X-Authorization'), 'Bearer FAKE_ACCESS');
      assert.equal(req.headers.get('Authorization'), null);
      assert.equal(req.method, 'GET');
      assert.equal(req.redirect, 'manual');
      if (req.url.includes('/api/user/devices')) {
        const query = new URL(req.url).searchParams;
        assert.equal(query.get('page'), '0');
        assert.equal(query.get('pageSize'), '100');
        return json({
          data: [{ id: { entityType: 'DEVICE', id }, name: 'SM-WA teste', label: null, type: 'default' }],
          totalPages: 1,
          totalElements: 1,
          hasNext: false,
        });
      }
      if (req.url.endsWith('/keys/timeseries')) return json(['variavel_teste']);
      assert.equal(new URL(req.url).searchParams.get('keys'), 'variavel_teste');
      assert.equal(new URL(req.url).searchParams.get('useStrictDataTypes'), 'true');
      return json({ variavel_teste: [{ ts: stamp, value: '42.5' }] });
    },
  );
  assert.deepEqual(
    (await client.devices()).data.map((device) => device.id),
    [id],
  );
  assert.deepEqual(await client.keys(id), ['variavel_teste']);
  assert.equal((await client.latest(id, ['variavel_teste'])).variavel_teste[0].value, '42.5');
  assert.equal(requests.length, 3);
  assert.equal(gate.calls, 3);
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(timestampMsToIso(stamp), '2023-11-14T22:13:20.123Z');
  assert.equal(secondsToTimestampMs(1700000000), 1700000000000);
});

test('MonitorIE: histórico mantém ms, limita por key e sinaliza possível truncamento', async () => {
  const client = new MonitorieReadClient(
    async () => 'FAKE_ACCESS',
    makeGate(),
    async (req) => {
      const q = new URL(req.url).searchParams;
      assert.equal(q.get('startTs'), String(stamp));
      assert.equal(q.get('endTs'), String(stamp + 1000));
      assert.equal(q.get('agg'), 'NONE');
      assert.equal(q.get('orderBy'), 'ASC');
      assert.equal(q.get('limit'), '2');
      return json({
        variavel_teste: [
          { ts: stamp + 1000, value: 2 },
          { ts: stamp, value: 1 },
        ],
      });
    },
  );
  const data = await client.history(id, ['variavel_teste', 'ausente'], stamp, stamp + 1000, 2);
  assert.equal(data.possiblyTruncated, true);
  assert.deepEqual(
    data.series.variavel_teste.map((x) => x.ts),
    [stamp, stamp + 1000],
  );
  assert.deepEqual(data.series.ausente, []);
});

test('MonitorIE: IDs/keys/limites inválidos não disparam chamadas', async () => {
  let calls = 0;
  const client = new MonitorieReadClient(
    async () => 'FAKE_ACCESS',
    makeGate(),
    async () => {
      calls++;
      return json({});
    },
  );
  for (const bad of ['../../api/auth/user', 'not-an-id', 'https://example.test'])
    await assert.rejects(client.latest(bad, ['x']), code('MONITORIE_NOT_CONFIGURED'));
  for (const bad of [[], ['a,b'], ['x', 'x'], ['\n']])
    await assert.rejects(client.latest(id, bad), code('MONITORIE_NOT_CONFIGURED'));
  await assert.rejects(client.history(id, ['x'], stamp, stamp - 1, 2));
  await assert.rejects(client.history(id, ['x'], stamp, stamp + 1, 2001));
  assert.equal(calls, 0);
});

test('MonitorIE: 401, 403, 404, 429 e 5xx são controlados e não causam retry automático', async () => {
  const statuses = new Map([
    [401, 'MONITORIE_TOKEN_REJECTED'],
    [403, 'MONITORIE_ACCESS_DENIED'],
    [404, 'MONITORIE_DEVICE_NOT_FOUND'],
    [429, 'MONITORIE_RATE_LIMITED'],
    [500, 'MONITORIE_UNAVAILABLE'],
    [302, 'MONITORIE_UNAVAILABLE'],
  ]);
  for (const [status, expected] of statuses) {
    const gate = makeGate();
    let calls = 0;
    const client = new MonitorieReadClient(
      async () => 'FAKE_ACCESS',
      gate,
      async () => {
        calls++;
        return new Response('FAKE_SECRET', { status, headers: { 'Retry-After': '120' } });
      },
    );
    await assert.rejects(client.latest(id, ['x']), code(expected));
    assert.equal(calls, 1);
    if (status === 429) assert.deepEqual(gate.delays, [120]);
  }
  for (const transport of [
    async () => {
      throw new Error('FAKE_SECRET');
    },
    async () => new Response('FAKE_SECRET'),
    async () => json({ x: 'z'.repeat(1024 * 1024 + 1) }),
    async () => json({ unexpected: [{ ts: stamp, value: 1 }] }),
    async () => json({ x: [{ ts: '1700000000123', value: 1 }] }),
    async () => json({ x: [{ ts: Date.now() + 120000, value: 1 }] }),
  ])
    await assert.rejects(
      new MonitorieReadClient(async () => 'FAKE_ACCESS', makeGate(), transport).latest(id, ['x']),
      (e) => e.status === 503 && !e.message.includes('FAKE_SECRET'),
    );
});

test('MonitorIE: timeout aborta uma única chamada e retorna erro controlado', async () => {
  let calls = 0;
  const client = new MonitorieReadClient(
    async () => 'FAKE_ACCESS',
    makeGate(),
    (request) => {
      calls++;
      return new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error('FAKE_SECRET')), { once: true }),
      );
    },
    5,
  );
  await assert.rejects(client.latest(id, ['x']), code('MONITORIE_TIMEOUT'));
  assert.equal(calls, 1);
});

test('MonitorIE: trava D1 disputa entre instâncias e mantém bloqueio após falha/Retry-After', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'monitorie-test' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
    const a = new D1MonitorieGate(db),
      b = new D1MonitorieGate(db);
    const results = await Promise.allSettled([a.reserve(), b.reserve(), a.reserve(), b.reserve()]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const row = await db.prepare('SELECT value FROM settings').first();
    assert.ok(Number(row.value) >= Date.now() + 68000);
    await b.defer(180);
    const later = await db.prepare('SELECT value FROM settings').first();
    assert.ok(Number(later.value) > Number(row.value) + 100000);
    await assert.rejects(a.reserve(), code('MONITORIE_RATE_LIMITED'));
    let sent = false;
    const client = new MonitorieReadClient(
      async () => 'FAKE_ACCESS',
      a,
      async () => {
        sent = true;
        return json({});
      },
    );
    await assert.rejects(client.latest(id, ['x']), code('MONITORIE_RATE_LIMITED'));
    assert.equal(sent, false);
    // Avançar somente o estado do banco de teste, sem aguardar tempo real.
    await db.prepare('UPDATE settings SET value=?').bind('0').run();
    await b.reserve();
  } finally {
    await mf.dispose();
  }
});
