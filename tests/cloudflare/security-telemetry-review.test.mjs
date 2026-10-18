import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

// Optional comparison reads only public source from Git, never configuration/secrets.
const baseline = process.env.HIDRA_TELEMETRY_BASELINE_REVISION;
if (baseline && !/^[a-f0-9]{7,40}$/i.test(baseline)) throw new Error('Invalid baseline revision');

const bundled = await build({
  stdin: {
    contents: `export {history} from './cloudflare/history.ts';
      export {ingest} from './cloudflare/ingest.ts';
      export {telemetryRoute} from './cloudflare/telemetry.ts';
      export {owned} from './cloudflare/db/reservoirs.ts';
      export {remoteHistory,remoteSnapshot} from './cloudflare/monitorie/cache.ts';
      export {cachedTelemetry} from './cloudflare/monitorie/single-flight.ts';
      export {MonitorieAPI} from './cloudflare/monitorie/adapter.ts';
      export {D1MonitorieGate} from './cloudflare/monitorie/protocol.ts';
      export {MonitorieReadClient} from './cloudflare/monitorie/protocol.ts';
      export {MonitorieAuth} from './cloudflare/monitorie/auth.ts';
      export {discoverMonitorie} from './cloudflare/admin/monitorie-association.ts';
      export {HttpError} from './cloudflare/http.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  plugins: baseline
    ? [
        {
          name: 'public-baseline-source',
          setup(builder) {
            builder.onLoad({ filter: /cloudflare[\\/].*\.ts$/ }, (args) => ({
              contents: execFileSync(
                'git',
                ['show', baseline + ':' + relative(process.cwd(), args.path).replaceAll('\\', '/')],
                { encoding: 'utf8', windowsHide: true },
              ),
              loader: 'ts',
            }));
          },
        },
      ]
    : [],
});
const api = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      bundled.outputFiles[0].text + '\n//# sourceURL=security-telemetry-review-helpers.mjs',
    ).toString('base64')
);
const seconds = () => Math.floor(Date.now() / 1000);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const errorCode = (code) => (error) => error.code === code;
const mapping = JSON.stringify({
  distancia: { key: 'd', unit: 'cm' },
  nivel: { key: 'level', unit: '%' },
  volume: { key: 'volume', unit: 'L' },
  rssi_wifi: { key: 'rssi', unit: 'dBm' },
});
const json = (value) => Response.json(value);

async function withDatabase(run) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'security-telemetry-review' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
    outboundService: () => {
      throw new Error('Unexpected external request');
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Unexpected external request');
  };
  try {
    const DB = await mf.getD1Database('DB');
    for (const file of (await readdir('cloudflare/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await DB.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          DB.prepare(sql),
        ),
      );
    const env = {
      DB,
      APP_ENV: 'production',
      INGEST_ENABLED: 'true',
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      MONITORIE_MODE: 'live',
      MONITORIE_JWT:
        'e30.' +
        Buffer.from(JSON.stringify({ exp: seconds() + 86400 * 10 })).toString('base64url') +
        '.synthetic',
      MONITORIE_SMWU_MAPPING: mapping,
    };
    const context = (userId = 1, path = '/api/device/history?reservoir_id=1', options = {}) => {
      const request = new Request('https://api.telemetry.test' + path, options);
      return {
        request,
        url: new URL(request.url),
        env,
        user: { id: userId },
        session: null,
        cookies: [],
        ctx: {},
        requestId: 'synthetic',
      };
    };
    async function seed({ source = 'monitorie', linkedAt = seconds() - 10000, reservoir = true } = {}) {
      await DB.batch(
        [1, 2, 3].map((id) =>
          DB.prepare(
            'INSERT INTO users(id,name,email,password_hash,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          ).bind(
            id,
            'Synthetic user',
            `u${id}@example.test`,
            'synthetic-unusable-hash',
            seconds(),
            seconds(),
            seconds(),
          ),
        ),
      );
      await DB.prepare(
        'INSERT INTO devices(id,device_code,device_type,source,external_id,mac_address,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?)',
      )
        .bind(
          'synthetic-device',
          'SM-WU',
          source,
          source === 'monitorie' ? 'synthetic-external-1' : null,
          '02:00:00:00:00:01',
          seconds(),
          seconds(),
        )
        .run();
      if (reservoir)
        await DB.prepare(
          'INSERT INTO reservoirs(id,user_id,device_id,name,linked_at,linked_at_ms,created_at,updated_at) VALUES(1,1,1,?,?,?,?,?)',
        )
          .bind('Synthetic reservoir', linkedAt, Math.round(linkedAt * 1000), seconds(), seconds())
          .run();
      return reservoir ? api.owned(context(), 1) : null;
    }
    await run({ DB, env, context, seed });
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
}

test('A8/D3: mismatched provider timestamps retain truncation through adapter, cache and API', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    const row = await seed();
    const stamp = Date.now() - 1000;
    const series = Object.fromEntries(
      ['d', 'level', 'volume', 'rssi'].map((key) => [
        key,
        Array.from({ length: 2000 }, (_, index) => ({
          ts: stamp - index * 1000 + (key === 'd' && index === 1999 ? -1 : 0),
          value: { d: 50, level: 50, volume: 500, rssi: -60 }[key],
        })),
      ]),
    );
    let calls = 0;
    globalThis.fetch = async (request) => {
      assert.equal(new URL(request.url).origin, 'https://monitorie.com.br');
      calls++;
      return json(series);
    };
    const c = context(1, '/api/device/history?reservoir_id=1&limit=2000');
    const first = await (await api.history(c, row)).json();
    assert.equal(first.count, 1999);
    assert.equal(first.meta.truncated, true);
    const again = await (await api.history(c, row)).json();
    assert.equal(again.meta.truncated, true);
    assert.equal(calls, 1);
    const cached = await DB.prepare('SELECT payload FROM telemetry_cache').first();
    assert.equal(JSON.parse(cached.payload).possiblyTruncated, true);
  });
});

test('A7/A15: owner and member share provider cache but retain millisecond access boundaries', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    const stamp = Date.now() - 5000;
    const row = await seed({ linkedAt: (stamp - 10000) / 1000 });
    const boundary = stamp + 1;
    await DB.prepare(
      'INSERT INTO device_users(device_id,user_id,linked_at,access_generation,access_started_ms) VALUES(1,2,?,?,?)',
    )
      .bind(Math.floor(boundary / 1000), 'synthetic-member-generation', boundary)
      .run();
    const series = Object.fromEntries(
      ['d', 'level', 'volume', 'rssi'].map((key) => [
        key,
        [stamp, stamp + 2000].map((ts) => ({ ts, value: { d: 50, level: 50, volume: 500, rssi: -60 }[key] })),
      ]),
    );
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return json(series);
    };
    const owner = await (await api.history(context(), row)).json();
    const memberContext = context(2);
    const memberRow = await api.owned(memberContext, 1);
    const member = await (await api.history(memberContext, memberRow)).json();
    assert.equal(owner.count, 2);
    assert.equal(member.count, 1);
    assert.equal(Date.parse(member.data[0].timestamp), stamp + 2000);
    assert.equal(calls, 1);
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM telemetry_cache').first()).n, 1);
    assert.equal(
      (await DB.prepare('SELECT access_user_id FROM telemetry_cache').first()).access_user_id,
      null,
    );
    const limited = await (await api.history(context(1, '/api/device/history?limit=1'), row)).json();
    assert.equal(limited.meta.truncated, true);
    assert.equal(limited.count, 1);

    // The first producer may itself be a later member: keep owner-wide raw data.
    await DB.prepare('DELETE FROM telemetry_cache').run();
    await DB.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
    assert.equal((await (await api.history(memberContext, memberRow)).json()).count, 1);
    assert.equal((await (await api.history(context(), row)).json()).count, 2);
    assert.equal(calls, 2);

    await DB.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
    globalThis.fetch = async () => {
      calls++;
      return json(Object.fromEntries(Object.entries(series).map(([key, values]) => [key, [values[0]]])));
    };
    const memberSnapshot = await api.remoteSnapshot(memberContext, memberRow);
    assert.equal(memberSnapshot.data, null);
    assert.equal(memberSnapshot.device.last_seen, null);
    assert.equal(memberSnapshot.device.status, 'unknown');
    assert.ok(
      (await api.remoteSnapshot(context(), row)).data,
      'Filtering a member must not mutate the owner cache',
    );
    assert.equal(calls, 3);
    await DB.prepare('DELETE FROM device_users WHERE device_id=1 AND user_id=2').run();
    await assert.rejects(api.history(memberContext, memberRow), errorCode('RESERVOIR_NOT_FOUND'));
    await DB.prepare(
      'INSERT INTO device_users(device_id,user_id,linked_at,access_generation,access_started_ms) VALUES(1,2,?,?,?)',
    )
      .bind(Math.floor(stamp / 1000) + 3, 'synthetic-regrant', stamp + 3000)
      .run();
    const regranted = await api.owned(memberContext, 1);
    assert.equal((await (await api.history(memberContext, regranted)).json()).count, 0);
    await assert.rejects(api.history(memberContext, memberRow), errorCode('RESERVOIR_NOT_FOUND'));
  });
});

test('A7: contention has no negative cache; real failure is bounded; gate serializes and queues devices', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    await seed();
    await assert.rejects(
      api.cachedTelemetry(context(), 'synthetic-busy', async () => {
        throw new api.HttpError(503, 'MONITORIE_RATE_LIMITED', 'synthetic', 70);
      }),
      errorCode('MONITORIE_RATE_LIMITED'),
    );
    assert.equal(
      (
        await DB.prepare('SELECT negative_until FROM telemetry_cache WHERE cache_key=?')
          .bind('synthetic-busy')
          .first()
      ).negative_until,
      0,
    );
    assert.deepEqual(await api.cachedTelemetry(context(), 'synthetic-busy', async () => ['retry']), [
      'retry',
    ]);
    let failures = 0;
    const fail = async () => {
      failures++;
      throw new Error('synthetic private provider body');
    };
    await assert.rejects(
      api.cachedTelemetry(context(), 'synthetic-failure', fail),
      (error) => !error.message.includes('private'),
    );
    await assert.rejects(api.cachedTelemetry(context(), 'synthetic-failure', fail));
    assert.equal(failures, 1);
    const negative = await DB.prepare('SELECT negative_until FROM telemetry_cache WHERE cache_key=?')
      .bind('synthetic-failure')
      .first();
    assert.ok(negative.negative_until >= seconds() + 58 && negative.negative_until <= seconds() + 60);
    for (const id of [2, 3])
      await DB.prepare(
        'INSERT INTO devices(id,device_code,device_type,source,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
        .bind(id, 'synthetic-' + id, 'SM-WU', 'monitorie', seconds(), seconds())
        .run();
    await new api.D1MonitorieGate(DB, 1).reserve();
    const attempts = await Promise.allSettled([2, 3].map((id) => new api.D1MonitorieGate(DB, id).reserve()));
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 0);
    const gate = await DB.prepare(
      "SELECT CAST(value AS INTEGER) value FROM settings WHERE key='monitorie:next-request-ms'",
    ).first();
    assert.ok(gate.value >= Date.now() + 68000);
    // Fix queue age in the ephemeral database instead of waiting for real quota windows.
    await DB.prepare('UPDATE monitorie_queue SET requested_at=unixepoch()-10 WHERE device_id=3').run();
    await DB.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
    await assert.rejects(new api.D1MonitorieGate(DB, 1).reserve(), errorCode('MONITORIE_RATE_LIMITED'));
    await new api.D1MonitorieGate(DB, 3).reserve();
  });
});

test('A9/D4: discovery resumes active scans older than 24h and restarts idle progress', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    await seed();
    await DB.prepare('UPDATE devices SET external_id=NULL WHERE id=1').run();
    const stamp = Date.now();
    const originalNow = Date.now;
    Date.now = () => stamp;
    try {
      const scan = {
        mac: '02:00:00:00:00:01',
        page: 12,
        totalPages: 20,
        devices: [{ id: 'synthetic-1200', type: 'SM-WU' }],
        index: 0,
        matches: [],
        started: seconds() - 2 * 86400,
      };
      await DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)')
        .bind('monitorie:discovery:1', JSON.stringify(scan), seconds() - 60)
        .run();
      const requests = [];
      globalThis.fetch = async (request) => {
        requests.push(new URL(request.url));
        if (new URL(request.url).pathname === '/api/user/devices')
          return json({ data: [], totalPages: 0, totalElements: 0, hasNext: false });
        return json({ mac: [{ ts: stamp, value: '02:00:00:00:00:02' }] });
      };
      const result = await (
        await api.discoverMonitorie(
          context(1, '/api/admin/devices/1/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
          1,
        )
      ).json();
      assert.equal(result.checked, 1201);
      assert.match(requests[0].pathname, /synthetic-1200\/values\/timeseries$/);
      assert.equal(
        JSON.parse(
          (await DB.prepare('SELECT value FROM settings WHERE key=?').bind('monitorie:discovery:1').first())
            .value,
        ).started,
        scan.started,
      );
      await DB.prepare('UPDATE settings SET updated_at=? WHERE key=?')
        .bind(seconds() - 86401, 'monitorie:discovery:1')
        .run();
      await DB.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
      globalThis.fetch = async (request) => {
        requests.push(new URL(request.url));
        return json({ data: [], totalPages: 0, totalElements: 0, hasNext: false });
      };
      await api.discoverMonitorie(
        context(1, '/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        1,
      );
      assert.equal(requests[1].searchParams.get('page'), '0');
    } finally {
      Date.now = originalNow;
    }
  });
});

test('A9/D4: a resumed long scan never associates expired or future MAC evidence', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    await seed();
    await DB.prepare('UPDATE devices SET external_id=NULL WHERE id=1').run();
    const started = Date.now();
    const originalNow = Date.now;
    Date.now = () => started + 31 * 86400 * 1000;
    try {
      for (const ts of [started, Date.now() + 60001]) {
        const scan = {
          mac: '02:00:00:00:00:01',
          page: 19,
          totalPages: 20,
          devices: [],
          index: 0,
          matches: [{ id: 'synthetic-match', type: 'SM-WU', ts }],
          started: Math.floor(started / 1000),
        };
        await DB.prepare(
          'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
        )
          .bind('monitorie:discovery:1', JSON.stringify(scan), seconds())
          .run();
        const result = await (
          await api.discoverMonitorie(
            context(1, '/discover', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }),
            1,
          )
        ).json();
        assert.equal(result.status, 'unlinked');
        assert.match(result.reason, /inválida ou expirou/);
        assert.equal(
          (await DB.prepare('SELECT external_id FROM devices WHERE id=1').first()).external_id,
          null,
        );
        assert.equal(
          await DB.prepare('SELECT key FROM settings WHERE key=?').bind('monitorie:discovery:1').first(),
          null,
        );
      }
    } finally {
      Date.now = originalNow;
    }
  });
});

test('A13/A14: unlinked telemetry consumes no event identity; out-of-range samples preserve communication', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    await seed({ source: 'local', reservoir: false });
    const token = randomBytes(32).toString('base64url');
    async function credential() {
      const device = await DB.prepare('SELECT ownership_generation FROM devices WHERE id=1').first();
      await DB.prepare(
        'INSERT INTO device_credentials(device_id,token_hash,ownership_generation,created_at,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET revoked_at=NULL,ownership_generation=excluded.ownership_generation',
      )
        .bind(digest(token), device.ownership_generation, seconds(), seconds())
        .run();
    }
    await credential();
    const send = (values = {}) =>
      api.ingest(
        context(1, '/api/device/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
            'Idempotency-Key': 'synthetic-event-1',
          },
          body: JSON.stringify({ id: 1, distancia: 50, nivel: 50, volume: 500, rssi_wifi: -60, ...values }),
        }),
      );
    await assert.rejects(send(), errorCode('DEVICE_UNLINKED'));
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM smwu_readings').first()).n, 0);
    await DB.prepare(
      'INSERT INTO reservoirs(id,user_id,device_id,name,linked_at,linked_at_ms,created_at,updated_at,capacity_liters,geometry,measurement_config) VALUES(1,1,1,?,?,?,?,?,1000,?,?)',
    )
      .bind(
        'Synthetic reservoir',
        seconds() - 60,
        (seconds() - 60) * 1000,
        seconds(),
        seconds(),
        'uniform',
        JSON.stringify({ empty_distance_cm: 120, full_distance_cm: 20, sensor_min_cm: 10, tolerance_cm: 1 }),
      )
      .run();
    await credential();
    const result = await (await send({ distancia: 150 })).json();
    assert.equal(result.stored, true);
    assert.equal(result.measurement_quality, 'out_of_range');
    const reading = await DB.prepare(
      'SELECT reservoir_id,volume,nivel,measurement_quality FROM smwu_readings',
    ).first();
    assert.equal(reading.reservoir_id, 1);
    assert.equal(reading.volume, null);
    assert.equal(reading.nivel, null);
    const device = await DB.prepare('SELECT reported_status,last_seen FROM devices WHERE id=1').first();
    assert.equal(device.reported_status, 'online');
    assert.ok(device.last_seen >= seconds() - 2);
    await assert.rejects(send({ distancia: -10 }), errorCode('INVALID_TELEMETRY'));
    assert.equal((await DB.prepare('SELECT COUNT(*) n FROM smwu_readings').first()).n, 1);
    assert.equal(
      (await DB.prepare('SELECT COUNT(*) n FROM smwu_readings WHERE reservoir_id IS NULL').first()).n,
      0,
    );
  });
});

test('A6/A22: nonlinear local history enforces its sample budget and bounded output', async () => {
  await withDatabase(async ({ DB, env, context, seed }) => {
    const row = await seed({ source: 'local' });
    env.HISTORY_MAX_SAMPLES = '500';
    await DB.prepare('UPDATE reservoirs SET geometry=?,capacity_liters=1000,measurement_config=? WHERE id=1')
      .bind(
        'horizontal_cylinder',
        JSON.stringify({
          empty_distance_cm: 120,
          full_distance_cm: 20,
          sensor_min_cm: 10,
          tolerance_cm: 1,
          diameter_cm: 100,
        }),
      )
      .run();
    const configured = await api.owned(context(), row.id);
    const stamp = seconds() - 1000;
    await DB.batch(
      Array.from({ length: 500 }, (_, index) =>
        DB.prepare(
          'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(1,1,70,50,500,-60,?)',
        ).bind(stamp + index),
      ),
    );
    const response = await (await api.history(context(1, '/api/device/history?limit=1'), configured)).json();
    assert.equal(response.count, 1);
    assert.equal(response.data[0].sample_count, 500);
    assert.ok(Math.abs(response.data[0].volume - 500) < 1e-8);
    await DB.prepare(
      'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(1,1,70,50,500,-60,?)',
    )
      .bind(stamp + 501)
      .run();
    await assert.rejects(api.history(context(), configured), errorCode('HISTORY_WORK_LIMIT'));
  });
});

test('A14: authenticated out-of-range geometry remains online without fabricating level or volume', async () => {
  await withDatabase(async ({ DB, context, seed }) => {
    await seed({ source: 'local' });
    await DB.prepare('UPDATE reservoirs SET geometry=?,capacity_liters=1000,measurement_config=? WHERE id=1')
      .bind(
        'uniform',
        JSON.stringify({ empty_distance_cm: 120, full_distance_cm: 20, sensor_min_cm: 10, tolerance_cm: 1 }),
      )
      .run();
    const token = randomBytes(32).toString('base64url');
    const device = await DB.prepare('SELECT ownership_generation FROM devices WHERE id=1').first();
    await DB.prepare(
      'INSERT INTO device_credentials(device_id,token_hash,ownership_generation,created_at,updated_at) VALUES(1,?,?,?,?)',
    )
      .bind(digest(token), device.ownership_generation, seconds(), seconds())
      .run();
    const response = await api.ingest(
      context(1, '/api/device/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ id: 1, distancia: 150, rssi_wifi: -60 }),
      }),
    );
    assert.equal((await response.json()).measurement_quality, 'out_of_range');
    const c = context(1, '/api/device/snapshot?reservoir_id=1');
    const snapshot = await (await api.telemetryRoute(c, 'snapshot')).json();
    assert.equal(snapshot.device.status, 'online');
    assert.ok(Date.parse(snapshot.device.last_seen) >= Date.now() - 3000);
    assert.equal(snapshot.data.volume, null);
    assert.equal(snapshot.data.nivel, null);
  });
});

test('outbound telemetry cancels rejected/oversized bodies without following redirects or leaking errors', async () => {
  for (const mode of ['redirect', 'wrong-content-type', 'oversized-header', 'oversized-stream']) {
    let cancelled = 0,
      calls = 0;
    const client = new api.MonitorieReadClient(
      async () => 'synthetic-token',
      { async reserve() {}, async defer() {} },
      async (request) => {
        calls++;
        assert.equal(request.redirect, 'manual');
        assert.equal(new URL(request.url).origin, 'https://monitorie.com.br');
        const stream = new ReadableStream({
          start(controller) {
            if (mode === 'oversized-stream') controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
          cancel() {
            cancelled++;
          },
        });
        return new Response(stream, {
          status: mode === 'redirect' ? 302 : 200,
          headers: {
            'Content-Type': mode === 'wrong-content-type' ? 'text/plain' : 'application/json',
            ...(mode === 'oversized-header' ? { 'Content-Length': String(1024 * 1024 + 1) } : {}),
          },
        });
      },
    );
    await assert.rejects(
      client.latest('synthetic-device', ['x']),
      (error) => error.status === 503 && !error.message.includes('synthetic-token'),
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
  await withDatabase(async ({ env }) => {
    let cancelled = 0;
    const auth = new api.MonitorieAuth(
      { ...env, MONITORIE_USERNAME: 'synthetic-user', MONITORIE_PASSWORD: 'synthetic-password' },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16385));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await assert.rejects(auth.get(), errorCode('MONITORIE_AUTH_INVALID_DATA'));
    assert.equal(cancelled, 1);
  });
});
