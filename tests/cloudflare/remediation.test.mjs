import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const time = () => Math.floor(Date.now() / 1000);
const origin = 'https://api.remediation.test',
  app = 'https://app.remediation.test';
const baselineRoot = resolve('cloudflare');
const baselineRevision = process.env.HIDRA_BASELINE_REVISION;
if (baselineRevision && !/^[a-f0-9]{7,40}$/i.test(baselineRevision))
  throw new Error('Invalid baseline revision');
const originalSource = (file) =>
  execFileSync(
    'git',
    ['show', baselineRevision + ':' + relative(process.cwd(), file).replaceAll('\\', '/')],
    { encoding: 'utf8', windowsHide: true },
  );
const current = await build({
  entryPoints: ['cloudflare/worker.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  define: { __BUILD_REVISION__: JSON.stringify('local-remediation') },
});
let baseline;
const helperBuild = await build({
  stdin: {
    contents:
      "export * from './cloudflare/auth/sessions.ts'; export * from './cloudflare/auth/crypto.ts'; export * from './cloudflare/auth/totp.ts'; export * from './cloudflare/auth/totp-rotation.ts'; export * from './cloudflare/db/maintenance.ts'; export {D1MonitorieGate} from './cloudflare/monitorie/protocol.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const helpers = await import(
  'data:text/javascript;base64,' + Buffer.from(helperBuild.outputFiles[0].text).toString('base64')
);
// Workers supplies this primitive; Node's WebCrypto needs the equivalent only in tests.
if (!crypto.subtle.timingSafeEqual)
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function withApp(run, original = false) {
  if (original && !baseline)
    baseline = await build({
      entryPoints: ['cloudflare/worker.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      define: { __BUILD_REVISION__: JSON.stringify('baseline') },
      plugins: [
        {
          name: 'baseline-public-code',
          setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, (args) => {
              assert.ok(args.path.startsWith(baselineRoot));
              return { contents: originalSource(args.path), loader: 'ts' };
            });
          },
        },
      ],
    });
  const bindings = {
    APP_ENV: 'production',
    APP_URL: app,
    CORS_ORIGINS: app,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    INGEST_ENABLED: 'true',
    MAIL_MODE: 'resend',
    RESEND_API_KEY: randomBytes(32).toString('base64url'),
    EMAIL_FROM: 'Hidra <sender@example.test>',
    MONITORIE_MODE: 'unconfigured',
    OBSERVABILITY_SAMPLE_RATE: '1',
  };
  const sent = [];
  const fixture = { ts: Date.now(), calls: 0 };
  const options = () => ({
    modules: true,
    script: (original ? baseline : current).outputFiles[0].text,
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'remediation' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
    bindings,
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.origin === 'https://api.resend.com' && url.pathname === '/emails') {
        sent.push(await request.json());
        return new MFResponse('{}', { status: 201 });
      }
      assert.equal(url.origin, 'https://monitorie.com.br', 'Unexpected external destination');
      fixture.calls++;
      assert.ok(url.pathname.endsWith('/values/timeseries'));
      const values = { d: 100, nivel: 50, volume: 500, rssi_wifi: -60 };
      const inRange =
        !url.searchParams.has('startTs') || fixture.ts >= Number(url.searchParams.get('startTs'));
      return new MFResponse(
        JSON.stringify(
          Object.fromEntries(
            url.searchParams
              .get('keys')
              .split(',')
              .map((key) => [key, inRange ? [{ ts: fixture.ts, value: values[key] }] : []]),
          ),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  const mf = new Miniflare(options());
  let database = await mf.getD1Database('DB');
  const db = { prepare: (sql) => database.prepare(sql), batch: (statements) => database.batch(statements) };
  async function reconfigure() {
    await mf.setOptions(options());
    database = await mf.getD1Database('DB');
  }
  try {
    for (const file of (await readdir('cloudflare/migrations'))
      .filter((f) => f.endsWith('.sql') && (!original || f < '0012'))
      .sort())
      await db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    let nextUser = 0,
      ip = 0;
    async function user(verified = true) {
      const id = ++nextUser,
        salt = randomBytes(16).toString('base64url');
      const raw = createHmac('sha256', bindings.PASSWORD_PEPPER).update('Synthetic-Test-8472!').digest('hex');
      const hash = pbkdf2Sync(raw, salt, 100000, 32, 'sha256').toString('hex');
      const stored = original
        ? `pbkdf2-sha256-pepper$v1$100000$${salt}$${hash}`
        : `pbkdf2-sha256-pepper$v2$primary$100000$${salt}$${hash}`;
      await db
        .prepare(
          `INSERT INTO users(id,name,email,password_hash,created_at,updated_at${original ? '' : ',email_verified_at'}) VALUES(?,?,?,?,?,?${original ? '' : ',?'})`,
        )
        .bind(
          id,
          'Synthetic user ' + id,
          `u${id}@example.test`,
          stored,
          time(),
          time(),
          ...(original ? [] : [verified ? time() : null]),
        )
        .run();
      return id;
    }
    async function browser(id = null) {
      let cookie = '',
        csrf = '';
      const address = '198.51.100.' + ++ip;
      if (id !== null) {
        const token = randomBytes(32).toString('base64url');
        csrf = randomBytes(32).toString('base64url');
        await db
          .prepare(
            'INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen,rotated_at,expires_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(digest(token), id, csrf, time(), time(), time(), time() + 3600)
          .run();
        cookie = '__Host-HIDRAR3B=' + token;
      }
      const client = {
        get cookie() {
          return cookie;
        },
        get csrf() {
          return csrf;
        },
        async request(path, data, headers = {}, capture = true) {
          const response = await mf.dispatchFetch(origin + path, {
            method: data === undefined ? 'GET' : 'POST',
            headers: {
              Origin: app,
              Cookie: cookie,
              'CF-Connecting-IP': address,
              ...headers,
              ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          if (capture) {
            const set = response.headers.get('Set-Cookie');
            if (set) cookie = set.split(';')[0];
          }
          const payload = await response.json();
          if (capture && payload.csrf_token) csrf = payload.csrf_token;
          return { status: response.status, payload, headers: response.headers };
        },
      };
      if (id === null) await client.request('/api/auth/csrf');
      return client;
    }
    async function provision(id = 1, source = 'local') {
      const code = randomBytes(16).toString('hex').toUpperCase();
      await db
        .prepare(
          'INSERT INTO devices(id,device_code,source,external_id,pairing_code_hash,pairing_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          'SYNTHETIC-' + id,
          source,
          source === 'monitorie' ? 'fixture-device-' + id : null,
          digest(code),
          time() + 3600,
          time(),
          time(),
        )
        .run();
      await db
        .prepare(
          'INSERT INTO activation_codes(device_id,code_hash,expires_at,created_at,created_by_user_id) VALUES(?,?,?,?,?)',
        )
        .bind(id, digest(code), time() + 3600, time(), original ? 1 : null)
        .run();
      return code;
    }
    async function connect(client, code) {
      const response = await client.request('/api/devices/connect', {
        pairing_code: code,
        reservoir_name: 'Synthetic reservoir',
      });
      assert.equal(response.status, 201);
      return response.payload.data;
    }
    async function credential(id = 1) {
      const token = randomBytes(32).toString('base64url');
      await db
        .prepare(
          `INSERT INTO device_credentials(device_id,token_hash,created_at,updated_at${original ? '' : ',ownership_generation'})
      SELECT id,?,?,?${original ? '' : ',ownership_generation'} FROM devices WHERE id=? ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash,revoked_at=NULL${original ? '' : ',ownership_generation=excluded.ownership_generation'}`,
        )
        .bind(digest(token), time(), time(), id)
        .run();
      return token;
    }
    async function ingest(token, values = {}, key) {
      const response = await mf.dispatchFetch(origin + '/api/device/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Token': token,
          'CF-Connecting-IP': '203.0.113.25',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify({ id: 1, distancia: 70, nivel: 50, volume: 500, rssi_wifi: -60, ...values }),
      });
      return { status: response.status, payload: await response.json() };
    }
    async function live() {
      bindings.MONITORIE_MODE = 'live';
      bindings.MONITORIE_JWT =
        'e30.' + Buffer.from(JSON.stringify({ exp: time() + 3600 })).toString('base64url') + '.fixture';
      bindings.MONITORIE_SMWU_MAPPING = JSON.stringify({
        distancia: { key: 'd', unit: 'cm' },
        nivel: { key: 'nivel', unit: '%' },
        volume: { key: 'volume', unit: 'L' },
        rssi_wifi: { key: 'rssi_wifi', unit: 'dBm' },
      });
      bindings.MONITORIE_CACHE_SECONDS = '300';
      await reconfigure();
    }
    await run({
      mf,
      db,
      bindings,
      sent,
      fixture,
      user,
      browser,
      provision,
      connect,
      credential,
      ingest,
      live,
      reconfigure,
    });
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  } finally {
    await mf.dispose();
  }
}

test(
  'baseline: geometry rejects authenticated communication and identical events are suppressed',
  { skip: !baselineRevision },
  async () =>
    withApp(async (h) => {
      const owner = await h.browser(await h.user()),
        r = await h.connect(owner, await h.provision()),
        token = await h.credential();
      const first = await h.ingest(token),
        second = await h.ingest(token);
      assert.equal(first.payload.stored, true);
      assert.equal(second.payload.stored, false);
      await h.db
        .prepare('UPDATE reservoirs SET geometry=?,capacity_liters=?,measurement_config=? WHERE id=?')
        .bind(
          'uniform',
          1000,
          JSON.stringify({
            empty_distance_cm: 120,
            full_distance_cm: 20,
            sensor_min_cm: 10,
            tolerance_cm: 0,
          }),
          r.id,
        )
        .run();
      assert.equal((await h.ingest(token, { distancia: 200 })).status, 422);
      const oldBuild = await build({
        entryPoints: ['cloudflare/auth/sessions.ts'],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        write: false,
        plugins: [
          {
            name: 'baseline-session',
            setup(builder) {
              builder.onLoad({ filter: /\.ts$/ }, (args) => ({
                contents: originalSource(args.path),
                loader: 'ts',
              }));
            },
          },
        ],
      });
      const oldSession = await import(
        'data:text/javascript;base64,' + Buffer.from(oldBuild.outputFiles[0].text).toString('base64')
      );
      const lost = await h.browser(await h.user()),
        hash = digest(lost.cookie.split('=')[1]);
      await h.db
        .prepare('UPDATE sessions SET rotated_at=? WHERE token_hash=?')
        .bind(time() - 901, hash)
        .run();
      await lost.request('/api/auth/me', undefined, {}, false);
      const clock = Date.now,
        stamp = clock();
      try {
        Date.now = () => stamp + 75000;
        const context = {
          env: { ...h.bindings, DB: h.db },
          request: new Request(origin, { headers: { Cookie: lost.cookie } }),
          url: new URL(origin),
          cookies: [],
          session: null,
          user: null,
        };
        await oldSession.loadSession(context);
        assert.equal(context.user, null, 'Baseline loses the session after the next 75s poll');
      } finally {
        Date.now = clock;
      }
    }, true),
);
test('e-mail proof prevents preclaimed identities and promotions; expiry, replay and account binding', async () =>
  withApp(async (h) => {
    const a = await h.user(false),
      b = await h.user(false),
      owner = await h.browser(a),
      other = await h.browser(b),
      r = await h.connect(owner, await h.provision());
    assert.equal(
      (await owner.request('/api/devices/users/add', { reservoir_id: r.id, email: `u${b}@example.test` }))
        .status,
      403,
    );
    await assert.rejects(h.db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(a).run());
    const proof = async (client) => {
      assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 202);
      for (let i = 0; i < 100 && !h.sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      return new URL(h.sent.pop().text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
    };
    const token = await proof(owner);
    assert.equal((await other.request('/api/auth/verify-email', { token })).status, 422);
    assert.equal((await owner.request('/api/auth/verify-email', { token })).status, 200);
    assert.equal((await owner.request('/api/auth/verify-email', { token })).status, 422);
    const unknown = await owner.request('/api/devices/users/add', {
      reservoir_id: r.id,
      email: 'absent@example.test',
    });
    const unverified = await owner.request('/api/devices/users/add', {
      reservoir_id: r.id,
      email: `u${b}@example.test`,
    });
    assert.deepEqual(unknown.payload, unverified.payload);
    assert.equal(unverified.status, 202);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM device_users').first()).n, 1);
    const expiring = await proof(other);
    await h.db
      .prepare('UPDATE email_verification_tokens SET expires_at=? WHERE user_id=?')
      .bind(time() - 1, b)
      .run();
    assert.equal((await other.request('/api/auth/verify-email', { token: expiring })).status, 422);
    await h.db
      .prepare(
        'INSERT INTO email_verification_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',
      )
      .bind(digest('old-proof'), a, time() + 1200, time())
      .run();
    await h.db.prepare('UPDATE users SET email=? WHERE id=?').bind('changed@example.test', a).run();
    assert.equal((await owner.request('/api/auth/me')).status, 401);
    assert.equal(
      (await h.db.prepare('SELECT email_verified_at FROM users WHERE id=?').bind(a).first())
        .email_verified_at,
      null,
    );
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM email_verification_tokens WHERE user_id=?').bind(a).first())
        .n,
      0,
    );
  }));
test('privacy survives erasure; member access generations and cache invalidation', async () =>
  withApp(async (h) => {
    await h.live();
    const a = await h.user(),
      b = await h.user(),
      c = await h.user(),
      first = await h.browser(a),
      next = await h.browser(b),
      member = await h.browser(c);
    await h.connect(first, await h.provision(1, 'monitorie'));
    assert.equal((await first.request('/api/auth/delete-account', { confirmation: true })).status, 200);
    const code = randomBytes(16).toString('hex').toUpperCase();
    await h.db
      .prepare('INSERT INTO activation_codes(device_id,code_hash,expires_at,created_at) VALUES(1,?,?,?)')
      .bind(digest(code), time() + 3600, time())
      .run();
    await h.db
      .prepare('UPDATE devices SET pairing_code_hash=?,pairing_expires_at=? WHERE id=1')
      .bind(digest(code), time() + 3600)
      .run();
    const r = await h.connect(next, code);
    h.fixture.ts = Date.now() - 3600000;
    assert.equal((await next.request('/api/device/snapshot?reservoir_id=' + r.id)).payload.data, null);
    await next.request('/api/devices/users/add', { reservoir_id: r.id, email: `u${c}@example.test` });
    const before = await h.db
      .prepare('SELECT access_generation FROM device_users WHERE device_id=1 AND user_id=?')
      .bind(c)
      .first();
    await member.request('/api/device/snapshot?reservoir_id=' + r.id);
    await next.request('/api/devices/users/remove', { reservoir_id: r.id, user_id: c });
    assert.equal((await member.request('/api/device/snapshot?reservoir_id=' + r.id)).status, 404);
    await next.request('/api/devices/users/add', { reservoir_id: r.id, email: `u${c}@example.test` });
    const after = await h.db
      .prepare('SELECT access_generation FROM device_users WHERE device_id=1 AND user_id=?')
      .bind(c)
      .first();
    assert.notEqual(after.access_generation, before.access_generation);
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM telemetry_cache WHERE access_user_id=?').bind(c).first()).n,
      0,
    );
    await h.db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
    assert.equal((await member.request('/api/device/history?reservoir_id=' + r.id)).payload.count, 0);
  }));
test('sharing logout, explicit revocation and normal sessions', async () =>
  withApp(async (h) => {
    const id = await h.user(),
      regular = await h.browser(id);
    Object.assign(h.bindings, {
      DASHBOARD_SHARE_USERNAME: 'test-reader',
      DASHBOARD_SHARE_PASSWORD: randomBytes(16).toString('hex'),
      DASHBOARD_SHARE_USER_EMAIL: `u${id}@example.test`,
    });
    await h.reconfigure();
    assert.equal((await regular.request('/api/auth/me')).status, 200);
    const basic =
      'Basic ' + Buffer.from('test-reader:' + h.bindings.DASHBOARD_SHARE_PASSWORD).toString('base64');
    const shared = await h.browser();
    assert.equal((await shared.request('/api/auth/me', undefined, { Authorization: basic })).status, 200);
    assert.equal((await shared.request('/api/admin/devices')).status, 404);
    assert.equal((await shared.request('/api/auth/logout', {})).status, 200);
    assert.equal((await shared.request('/api/auth/me')).status, 401);
    await shared.request('/api/auth/me', undefined, { Authorization: basic });
    delete h.bindings.DASHBOARD_SHARE_PASSWORD;
    delete h.bindings.DASHBOARD_SHARE_USERNAME;
    delete h.bindings.DASHBOARD_SHARE_USER_EMAIL;
    await h.reconfigure();
    assert.equal((await shared.request('/api/auth/me')).status, 401);
  }));
test('aborted rotation retains current cookie; acknowledged rotation keeps a 30s grace', async () =>
  withApp(async (h) => {
    const client = await h.browser(await h.user()),
      oldHash = digest(client.cookie.split('=')[1]);
    await h.db
      .prepare('UPDATE sessions SET rotated_at=? WHERE token_hash=?')
      .bind(time() - 901, oldHash)
      .run();
    const issued = await client.request('/api/auth/me', undefined, {}, false);
    const row = await h.db
      .prepare('SELECT token_hash,pending_hash,previous_hash FROM sessions WHERE token_hash=?')
      .bind(oldHash)
      .first();
    assert.ok(row.pending_hash);
    assert.equal(row.previous_hash, null);
    const clock = Date.now,
      baseTime = clock();
    const context = (cookie) => ({
      env: { ...h.bindings, DB: h.db },
      request: new Request(origin + '/api/auth/me', { headers: { Cookie: cookie } }),
      url: new URL(origin),
      cookies: [],
      session: null,
      user: null,
    });
    try {
      Date.now = () => baseTime + 75000;
      const afterLost = context(client.cookie);
      await helpers.loadSession(afterLost);
      assert.ok(afterLost.user, 'The old cookie must survive a lost rotation response and a 75s poll');
      const received = context(issued.headers.get('Set-Cookie').split(';')[0]);
      await helpers.loadSession(received);
      assert.ok(received.user);
      const confirmed = await h.db
        .prepare('SELECT previous_until FROM sessions WHERE previous_hash=?')
        .bind(oldHash)
        .first();
      assert.ok(confirmed.previous_until <= time() + 30);
      Date.now = () => baseTime + 106000;
      const expired = context(client.cookie);
      await helpers.loadSession(expired);
      assert.equal(expired.user, null);
    } finally {
      Date.now = clock;
    }
  }));
test('activation validity, issuer erasure and concurrent claim', async () =>
  withApp(async (h) => {
    const issuer = await h.user(),
      id = await h.user(),
      owner = await h.browser(id),
      code = await h.provision();
    await h.db
      .prepare('UPDATE activation_codes SET created_by_user_id=? WHERE device_id=1')
      .bind(issuer)
      .run();
    await h.db.prepare('DELETE FROM users WHERE id=?').bind(issuer).run();
    assert.equal((await owner.request('/api/devices/validate-pairing', { pairing_code: code })).status, 422);
    assert.equal(
      (await owner.request('/api/devices/connect', { pairing_code: code, reservoir_name: 'Synthetic' }))
        .status,
      422,
    );
    const fresh = await h.provision(2),
      other = await h.browser(await h.user());
    const results = await Promise.all(
      [owner, other].map((client) =>
        client.request('/api/devices/connect', { pairing_code: fresh, reservoir_name: 'Synthetic' }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 422]);
  }));
test('ingestion distinguishes quality, events, retransmission, buffered timestamps and ownership', async () =>
  withApp(async (h) => {
    const owner = await h.browser(await h.user()),
      next = await h.browser(await h.user()),
      r = await h.connect(owner, await h.provision()),
      token = await h.credential();
    assert.equal((await h.ingest(token)).payload.stored, true);
    assert.equal((await h.ingest(token)).payload.stored, true);
    assert.equal((await h.ingest(token, {}, 'event-1')).payload.stored, true);
    assert.equal((await h.ingest(token, {}, 'event-1')).payload.stored, false);
    await h.db
      .prepare('UPDATE reservoirs SET geometry=?,capacity_liters=?,measurement_config=? WHERE id=?')
      .bind(
        'uniform',
        1000,
        JSON.stringify({ empty_distance_cm: 120, full_distance_cm: 20, sensor_min_cm: 10, tolerance_cm: 0 }),
        r.id,
      )
      .run();
    const invalid = await h.ingest(token, { distancia: 200 });
    assert.equal(invalid.status, 200);
    assert.equal(invalid.payload.measurement_quality, 'out_of_range');
    const last = await h.db
      .prepare('SELECT distancia,volume,nivel FROM smwu_readings ORDER BY reading_id DESC LIMIT 1')
      .first();
    assert.equal(last.distancia, 200);
    assert.equal(last.volume, null);
    assert.equal(last.nivel, null);
    assert.equal(
      (await owner.request('/api/device/snapshot?reservoir_id=' + r.id)).payload.device.status,
      'online',
    );
    assert.equal(
      (await h.ingest(token, { timestamp: new Date(Date.now() - 60000).toISOString() })).payload.error.code,
      'EVENT_BEFORE_LINK',
    );
    await owner.request('/api/devices/unlink', { reservoir_id: r.id, confirmation: true });
    assert.equal((await h.ingest(token)).status, 401);
    const code = randomBytes(16).toString('hex').toUpperCase();
    await h.db
      .prepare('INSERT INTO activation_codes(device_id,code_hash,expires_at,created_at) VALUES(1,?,?,?)')
      .bind(digest(code), time() + 3600, time())
      .run();
    await h.db
      .prepare('UPDATE devices SET pairing_code_hash=?,pairing_expires_at=? WHERE id=1')
      .bind(digest(code), time() + 3600)
      .run();
    await h.connect(next, code);
    assert.equal((await h.ingest(token)).status, 401);
    assert.equal((await h.ingest(await h.credential())).status, 200);
  }));
test('atomic account budget rejects concurrent login before password work', async () =>
  withApp(async (h) => {
    const id = await h.user(),
      clients = await Promise.all(Array.from({ length: 12 }, () => h.browser()));
    const results = await Promise.all(
      clients.map((client) =>
        client.request('/api/auth/login', { email: `u${id}@example.test`, password: 'wrong' }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 401).length, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 2);
    const rows = await h.db.prepare('SELECT attempts FROM rate_limits WHERE attempts=10').all();
    assert.ok(rows.results.length > 0);
  }));
test('stale cache is unknown, contention does not create negative cache, denied requests write no counters', async () =>
  withApp(async (h) => {
    await h.live();
    const client = await h.browser(await h.user()),
      r = await h.connect(client, await h.provision(1, 'monitorie'));
    h.fixture.ts = Date.now();
    assert.equal(
      (await client.request('/api/device/snapshot?reservoir_id=' + r.id)).payload.device.status,
      'online',
    );
    await h.db
      .prepare('UPDATE telemetry_cache SET fetched_at=?')
      .bind(time() - 100)
      .run();
    const stale = await client.request('/api/device/snapshot?reservoir_id=' + r.id);
    assert.equal(stale.payload.device.status, 'unknown');
    assert.ok(!stale.payload.alerts.some((a) => a.message.includes('sem comunicação')));
    await h.db.prepare('UPDATE telemetry_cache SET expires_at=0').run();
    const busy = await client.request('/api/device/snapshot?reservoir_id=' + r.id);
    assert.equal(busy.payload.device.integration_status, 'busy');
    assert.equal((await h.db.prepare('SELECT MAX(negative_until) n FROM telemetry_cache').first()).n, 0);
    await h.db.prepare('DELETE FROM endpoint_requests').run();
    const anon = await h.browser();
    await anon.request('/api/not-a-route');
    await anon.request('/api/health');
    assert.equal(
      (
        await h.db
          .prepare(
            "SELECT COUNT(*) n FROM endpoint_requests WHERE path IN('/api/health','/unmatched','/api/auth/csrf')",
          )
          .first()
      ).n,
      0,
    );
  }));
test('readiness validates migrations, TOTP and required mail; HTTPS precedes all routes', async () =>
  withApp(async (h) => {
    const client = await h.browser();
    assert.equal((await client.request('/api/health')).status, 200);
    assert.equal((await client.request('/api/ready')).status, 200);
    h.bindings.TOTP_ENCRYPTION_KEY = 'invalid';
    await h.reconfigure();
    assert.equal((await client.request('/api/ready')).status, 503);
    assert.equal((await client.request('/api/health')).status, 200);
    h.bindings.TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
    h.bindings.MAIL_REQUIRED = 'true';
    h.bindings.MAIL_MODE = 'disabled';
    await h.reconfigure();
    assert.equal((await client.request('/api/ready')).status, 503);
    for (const path of ['/api/health', '/api/ready', '/static/test.js', '/health.php'])
      assert.equal((await h.mf.dispatchFetch('http://api.remediation.test' + path)).status, 400);
  }));

test('key rotation has bounded previous versions, upgrades passwords and reencrypts TOTP', async () =>
  withApp(async (h) => {
    const id = await h.user(),
      oldSession = await h.browser(id),
      secret = helpers.newTotpSecret();
    const hash = await helpers.hashPassword('Synthetic-Test-8472!', h.bindings),
      encrypted = await helpers.encryptTotp(h.bindings, id, secret);
    const legacyHash = hash.replace('$v2$primary$', '$v1$'),
      legacyCipher = encrypted.replace('v2.primary.', 'v1.');
    const rotated = {
      ...h.bindings,
      PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
      PASSWORD_PEPPER_ID: 'next',
      PASSWORD_PEPPER_PREVIOUS: h.bindings.PASSWORD_PEPPER,
      PASSWORD_PEPPER_PREVIOUS_ID: 'primary',
      PASSWORD_PEPPER_PREVIOUS_UNTIL: String(time() + 3600),
      TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
      TOTP_KEY_ID: 'next',
      TOTP_ENCRYPTION_KEY_PREVIOUS: h.bindings.TOTP_ENCRYPTION_KEY,
      TOTP_KEY_PREVIOUS_ID: 'primary',
      TOTP_KEY_PREVIOUS_UNTIL: String(time() + 3600),
    };
    for (const value of [hash, legacyHash])
      assert.equal(await helpers.verifyPassword('Synthetic-Test-8472!', value, rotated), true);
    for (const value of [encrypted, legacyCipher])
      assert.equal(await helpers.decryptTotp(rotated, id, value), secret);
    await assert.rejects(helpers.decryptTotp(rotated, id + 1, encrypted));
    const expired = {
      ...rotated,
      TOTP_KEY_PREVIOUS_UNTIL: String(time() - 1),
      PASSWORD_PEPPER_PREVIOUS_UNTIL: String(time() - 1),
    };
    assert.equal(await helpers.verifyPassword('Synthetic-Test-8472!', hash, expired), false);
    await assert.rejects(helpers.decryptTotp(expired, id, encrypted));
    const tooLong = {
      ...rotated,
      TOTP_KEY_PREVIOUS_UNTIL: String(time() + 8 * 86400),
      PASSWORD_PEPPER_PREVIOUS_UNTIL: String(time() + 8 * 86400),
    };
    assert.equal(await helpers.verifyPassword('Synthetic-Test-8472!', legacyHash, tooLong), false);
    await assert.rejects(helpers.decryptTotp(tooLong, id, legacyCipher));
    await h.db
      .prepare('INSERT INTO admin_totp(user_id,secret_encrypted,created_at) VALUES(?,?,?)')
      .bind(id, legacyCipher, time())
      .run();
    assert.equal(await helpers.reencryptTotp(h.db, rotated), 1);
    assert.equal(await helpers.reencryptTotp(h.db, rotated), 0);
    const saved = await h.db
      .prepare('SELECT secret_encrypted FROM admin_totp WHERE user_id=?')
      .bind(id)
      .first();
    assert.ok(saved.secret_encrypted.startsWith('v2.next.'));
    assert.equal(await helpers.decryptTotp(expired, id, saved.secret_encrypted), secret);
    Object.assign(h.bindings, rotated);
    await h.reconfigure();
    const login = await h.browser();
    assert.equal(
      (
        await login.request('/api/auth/login', {
          email: `u${id}@example.test`,
          password: 'Synthetic-Test-8472!',
        })
      ).status,
      200,
    );
    assert.equal((await oldSession.request('/api/auth/me')).status, 401);
    assert.ok(
      (
        await h.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(id).first()
      ).password_hash.startsWith('pbkdf2-sha256-pepper$v2$next$'),
    );
  }));

test('history bounds work, provider queue preserves 70s and operational retention converges', async () =>
  withApp(async (h) => {
    const id = await h.user(),
      client = await h.browser(id),
      r = await h.connect(client, await h.provision());
    await h.provision(2);
    h.bindings.HISTORY_MAX_SAMPLES = '500';
    await h.reconfigure();
    const start = time() - 1000;
    await h.db
      .prepare('UPDATE reservoirs SET linked_at=?,linked_at_ms=? WHERE id=?')
      .bind(start, start * 1000, r.id)
      .run();
    await h.db
      .prepare('UPDATE device_users SET access_started_ms=? WHERE device_id=1')
      .bind(start * 1000)
      .run();
    for (let offset = 0; offset < 501; offset += 50)
      await h.db.batch(
        Array.from({ length: Math.min(50, 501 - offset) }, (_, index) =>
          h.db
            .prepare(
              'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(1,?,70,50,500,-60,?)',
            )
            .bind(r.id, start + offset + index + 1),
        ),
      );
    assert.equal(
      (await client.request('/api/device/history?reservoir_id=' + r.id)).payload.error.code,
      'HISTORY_WORK_LIMIT',
    );
    const gate1 = new helpers.D1MonitorieGate(h.db, 1),
      gate2 = new helpers.D1MonitorieGate(h.db, 2);
    await gate1.reserve();
    await assert.rejects(gate2.reserve());
    await h.db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
    await assert.rejects(gate1.reserve());
    await gate2.reserve();
    assert.ok(
      Number(
        (await h.db.prepare("SELECT value FROM settings WHERE key='monitorie:next-request-ms'").first())
          .value,
      ) >=
        Date.now() + 68000,
    );
    const past = time() - 10 * 86400;
    for (let i = 0; i < 3; i++)
      await h.db.batch([
        h.db
          .prepare(
            'INSERT INTO activation_codes(device_id,code_hash,expires_at,revoked_at,created_at) VALUES(1,?,?,?,?)',
          )
          .bind(digest('expired-' + i), past, past, past),
        h.db
          .prepare('INSERT INTO admin_totp_recovery(code_hash,user_id,used_at,created_at) VALUES(?,?,?,?)')
          .bind(digest('recovery-' + i), id, past, past),
        h.db
          .prepare(
            'INSERT INTO email_verification_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',
          )
          .bind(digest('proof-' + i), id, past, past),
        h.db
          .prepare('INSERT INTO telemetry_cache(cache_key,expires_at) VALUES(?,?)')
          .bind('expired-' + i, past),
        h.db
          .prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)')
          .bind('monitorie:discovery:' + i, '{}', past),
        h.db
          .prepare(
            'INSERT INTO sessions(token_hash,csrf_token,created_at,last_seen,rotated_at,expires_at) VALUES(?,?,?,?,?,?)',
          )
          .bind(digest('session-' + i), 'synthetic-csrf', past, past, past, past),
      ]);
    const env = { ...h.bindings, DB: h.db, RETENTION_BATCH_SIZE: '1', RETENTION_MAX_BATCHES: '1' };
    await helpers.maintenance({ env });
    let state = JSON.parse(
      (await h.db.prepare("SELECT value FROM settings WHERE key='maintenance'").first()).value,
    );
    assert.equal(state.backlog, true);
    assert.ok(state.tables.includes('admin_totp_recovery'));
    for (let i = 0; i < 3; i++) {
      await h.db.prepare("UPDATE settings SET updated_at=0 WHERE key='maintenance'").run();
      await helpers.maintenance({ env });
    }
    state = JSON.parse(
      (await h.db.prepare("SELECT value FROM settings WHERE key='maintenance'").first()).value,
    );
    assert.equal(state.backlog, false);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM admin_totp_recovery').first()).n, 0);
  }));

test('upgrade from schema 11 preserves data and suspends unverified member access', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'legacy-upgrade' },
    log: new Log(LogLevel.NONE),
  });
  try {
    const db = await mf.getD1Database('DB'),
      files = (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const migrate = async (file) =>
      db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    for (const file of files.filter((f) => f < '0012')) await migrate(file);
    for (const id of [1, 2])
      await db
        .prepare(
          'INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          'Legacy synthetic',
          `legacy${id}@example.test`,
          'old-hash',
          id === 1 ? 'admin' : 'user',
          time(),
          time(),
        )
        .run();
    await db
      .prepare(
        "INSERT INTO devices(id,device_code,source,created_at,updated_at) VALUES(1,'LEGACY','local',?,?)",
      )
      .bind(time(), time())
      .run();
    await db
      .prepare(
        "INSERT INTO reservoirs(id,user_id,device_id,name,linked_at,created_at,updated_at) VALUES(1,1,1,'Legacy tank',?,?,?)",
      )
      .bind(time() - 100, time() - 100, time() - 100)
      .run();
    await db
      .prepare('INSERT INTO device_users(device_id,user_id,linked_at) VALUES(1,2,?)')
      .bind(time() - 50)
      .run();
    await db
      .prepare('INSERT INTO admin_totp(user_id,secret_encrypted,created_at) VALUES(1,?,?)')
      .bind('preserved-synthetic-cipher', time())
      .run();
    await db
      .prepare(
        'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES(1,1,70,50,500,-60,?)',
      )
      .bind(time())
      .run();
    for (const readOnly of [0, 1])
      await db
        .prepare(
          'INSERT INTO sessions(token_hash,user_id,csrf_token,read_only,created_at,last_seen,rotated_at,expires_at) VALUES(?,1,?,?,?,?,?,?)',
        )
        .bind(
          digest('legacy-session-' + readOnly),
          'synthetic',
          readOnly,
          time(),
          time(),
          time(),
          time() + 3600,
        )
        .run();
    for (const file of files.filter((f) => f >= '0012')) await migrate(file);
    const users = await db.prepare('SELECT role,email_verified_at FROM users ORDER BY id').all();
    assert.equal(users.results[0].role, 'admin');
    assert.ok(users.results.every((u) => u.email_verified_at === null));
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM sessions').first()).n, 1);
    assert.equal(
      (await db.prepare('SELECT secret_encrypted FROM admin_totp').first()).secret_encrypted,
      'preserved-synthetic-cipher',
    );
    assert.equal((await db.prepare('SELECT volume FROM smwu_readings').first()).volume, 500);
    const memberContext = { env: { DB: db }, user: { id: 2 } },
      ownedBuild = await build({
        entryPoints: ['cloudflare/db/reservoirs.ts'],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        write: false,
      });
    const { owned } = await import(
      'data:text/javascript;base64,' + Buffer.from(ownedBuild.outputFiles[0].text).toString('base64')
    );
    await assert.rejects(owned(memberContext, 1), (error) => error.status === 404);
    await db.prepare('UPDATE users SET email_verified_at=? WHERE id=2').bind(time()).run();
    assert.equal((await owned(memberContext, 1)).access_user_id, 2);
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  } finally {
    await mf.dispose();
  }
});
