import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { relative } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const password = 'Synthetic-Review-8472!';
const origin = 'https://api.auth-review.test';
const app = 'https://app.auth-review.test';
const time = () => Math.floor(Date.now() / 1000);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const revision = process.env.HIDRA_AUTH_BASELINE_REVISION;
if (revision && !/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error('Invalid baseline revision');
const plugins = revision
  ? [
      {
        name: 'auth-review-baseline',
        setup(builder) {
          builder.onLoad({ filter: /cloudflare[\\/].*\.ts$/ }, (args) => ({
            contents: execFileSync(
              'git',
              ['show', revision + ':' + relative(process.cwd(), args.path).replaceAll('\\', '/')],
              { encoding: 'utf8', windowsHide: true },
            ),
            loader: 'ts',
          }));
        },
      },
    ]
  : [];
const worker = await build({
  stdin: {
    // Drain background work in the test adapter so mail/state assertions do not
    // race waitUntil. The application itself keeps generic asynchronous replies.
    contents: `import worker from './cloudflare/worker.ts';
      export default { async fetch(request, env, ctx) {
        const tasks = [];
        const response = await worker.fetch(request, env, {
          waitUntil(task) { tasks.push(task); ctx.waitUntil(task); }
        });
        await Promise.all(tasks);
        return response;
      }};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins,
  define: { __BUILD_REVISION__: JSON.stringify('synthetic-auth-review') },
});
const helperBuild = await build({
  stdin: {
    contents:
      "export * from './cloudflare/auth/sessions.ts'; export * from './cloudflare/auth/security-events.ts'; export * from './cloudflare/auth/totp-routes.ts'; export * from './cloudflare/auth/rate-limit.ts'; export * from './cloudflare/auth/email-verification.ts'; export * from './cloudflare/auth/routes.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  plugins,
});
const helpers = await import(
  'data:text/javascript;base64,' + Buffer.from(helperBuild.outputFiles[0].text).toString('base64')
);
if (!crypto.subtle.timingSafeEqual)
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

function code(secret, step = Math.floor(Date.now() / 30000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0,
    value = 0;
  const decoded = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(step, 4);
  const hash = createHmac('sha1', Buffer.from(decoded)).update(counter).digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function withApp(run) {
  const bindings = {
    APP_ENV: 'production',
    APP_URL: app,
    CORS_ORIGINS: app,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    RESEND_API_KEY: randomBytes(32).toString('base64url'),
    MAIL_MODE: 'resend',
    EMAIL_FROM: 'Synthetic <sender@example.test>',
    MONITORIE_MODE: 'unconfigured',
    SECURITY_EVENT_FAILURE_SAMPLE_RATE: '1',
  };
  const fixture = { status: 201, sent: [] };
  const options = () => ({
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'security-auth-review' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
    bindings,
    outboundService: async (request) => {
      assert.equal(request.url, 'https://api.resend.com/emails', 'All external traffic must be mocked');
      fixture.sent.push(await request.json());
      await fixture.beforeResponse?.();
      return new MFResponse('{}', { status: fixture.status });
    },
  });
  const mf = new Miniflare(options());
  let database = await mf.getD1Database('DB');
  const db = { prepare: (sql) => database.prepare(sql), batch: (stmts) => database.batch(stmts) };
  try {
    for (const file of (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort())
      await db.batch(
        unstable_splitSqlQuery(await readFile('cloudflare/migrations/' + file, 'utf8')).map((sql) =>
          db.prepare(sql),
        ),
      );
    let users = 0,
      addresses = 0;
    async function user(role = 'user', verified = true) {
      const id = ++users,
        salt = randomBytes(16).toString('base64url');
      const raw = createHmac('sha256', bindings.PASSWORD_PEPPER).update(password).digest('hex');
      const hash = pbkdf2Sync(raw, salt, 100000, 32, 'sha256').toString('hex');
      await db
        .prepare(
          'INSERT INTO users(id,name,email,password_hash,role,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          'Synthetic account ' + id,
          `u${id}@example.test`,
          `pbkdf2-sha256-pepper$v2$primary$100000$${salt}$${hash}`,
          role,
          verified ? time() : null,
          time(),
          time(),
        )
        .run();
      return id;
    }
    async function browser(id = null) {
      const token = randomBytes(32).toString('base64url');
      let cookie = '__Host-HIDRAR3B=' + token,
        csrf = randomBytes(32).toString('base64url');
      const address = '198.51.100.' + ++addresses;
      await db
        .prepare(
          'INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen,rotated_at,expires_at) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(digest(token), id, csrf, time(), time(), time(), time() + 3600)
        .run();
      return {
        get cookie() {
          return cookie;
        },
        get csrf() {
          return csrf;
        },
        async request(path, data, headers = {}, capture = true) {
          const response = await mf.dispatchFetch(origin + path, {
            method: data === undefined ? 'GET' : 'POST',
            redirect: 'manual',
            headers: {
              Origin: app,
              Cookie: cookie,
              'CF-Connecting-IP': address,
              ...headers,
              ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
          if (capture && response.headers.get('Set-Cookie'))
            cookie = response.headers.get('Set-Cookie').split(';')[0];
          const text = await response.text();
          const payload = response.headers.get('Content-Type')?.includes('application/json')
            ? JSON.parse(text)
            : text;
          if (capture && payload.csrf_token) csrf = payload.csrf_token;
          return { status: response.status, headers: response.headers, payload };
        },
      };
    }
    const context = (cookie, data, csrf = '') => ({
      env: { ...bindings, DB: db },
      request: new Request(origin + '/api/auth/admin-totp/confirm', {
        method: data ? 'POST' : 'GET',
        headers: { Cookie: cookie, Origin: app, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      url: new URL(origin),
      cookies: [],
      session: null,
      user: null,
      requestId: crypto.randomUUID(),
    });
    await run({
      db,
      bindings,
      fixture,
      user,
      browser,
      context,
      async reconfigure() {
        await mf.setOptions(options());
        database = await mf.getD1Database('DB');
      },
    });
  } finally {
    await mf.dispose();
  }
}

test('A1 distributed account failures never reject a valid password; identity and IP limits remain', () =>
  withApp(async (h) => {
    const id = await h.user();
    const clients = await Promise.all(Array.from({ length: 12 }, () => h.browser()));
    const rejected = await Promise.all(
      clients.map((client) =>
        client.request('/api/auth/login', { email: `u${id}@example.test`, password: 'wrong' }),
      ),
    );
    assert.equal(rejected.filter((r) => r.status === 401).length, 12);
    assert.ok(rejected.every((r) => r.payload.error.code === 'INVALID_CREDENTIALS'));
    assert.equal('checkFailureLimit' in helpers, false, 'No unused account pre-KDF blocker is exported');
    const owner = await h.browser();
    assert.equal(
      (await owner.request('/api/auth/login', { email: `u${id}@example.test`, password })).status,
      200,
    );
    const single = await h.browser();
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await single.request('/api/auth/login', { email: `u${id}@example.test`, password: 'wrong' })).status,
        401,
      );
    assert.equal(
      (await single.request('/api/auth/login', { email: `u${id}@example.test`, password })).status,
      429,
    );
    const ipOnly = await h.browser();
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await ipOnly.request('/api/auth/login', { email: `absent-${i}@example.test`, password })).status,
        401,
      );
    assert.equal(
      (await ipOnly.request('/api/auth/login', { email: 'absent-next@example.test', password })).status,
      429,
    );
  }));

test('A2 sharing configured cannot intercept normal login, downgrade sessions or rate limit regular users', () =>
  withApp(async (h) => {
    const user = await h.user(),
      admin = await h.user('admin'),
      regular = await h.browser(user);
    Object.assign(h.bindings, {
      DASHBOARD_SHARE_USERNAME: 'synthetic-reader',
      DASHBOARD_SHARE_PASSWORD: randomBytes(20).toString('hex'),
      DASHBOARD_SHARE_USER_EMAIL: `u${user}@example.test`,
    });
    await h.reconfigure();
    const basic =
      'Basic ' + Buffer.from('synthetic-reader:' + h.bindings.DASHBOARD_SHARE_PASSWORD).toString('base64');
    const ordinary = await regular.request('/api/auth/me', undefined, { Authorization: basic });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.payload.read_only, false);
    assert.equal(ordinary.headers.get('Set-Cookie'), null);
    const anonymous = await h.browser();
    for (const page of ['/login', '/']) {
      const redirect = await anonymous.request(page);
      assert.equal(redirect.status, 302);
      assert.ok(redirect.headers.get('Location').startsWith(app + '/'));
      assert.equal(redirect.headers.get('WWW-Authenticate'), null);
    }
    for (let i = 0; i < 31; i++) {
      const denied = await anonymous.request('/api/reservoirs');
      assert.equal(denied.status, 401);
      assert.equal(denied.payload.error.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(denied.headers.get('WWW-Authenticate'), null);
    }
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM rate_limits').first()).n, 0);
    for (let i = 0; i < 30; i++) {
      const denied = await anonymous.request('/api/reservoirs', undefined, {
        Authorization: 'Basic ' + Buffer.from('invalid:credentials').toString('base64'),
      });
      assert.equal(denied.status, 401);
      assert.match(denied.headers.get('WWW-Authenticate'), /^Basic /);
    }
    assert.equal(
      (await anonymous.request('/api/reservoirs', undefined, { Authorization: 'Basic invalid' })).status,
      429,
    );
    assert.equal(
      (await anonymous.request('/api/auth/login', { email: `u${admin}@example.test`, password })).status,
      200,
    );
    assert.equal((await regular.request('/api/reservoirs')).status, 200);
    const shared = await h.browser();
    const result = await shared.request('/api/auth/me', undefined, { Authorization: basic });
    assert.equal(result.status, 200);
    assert.equal(result.payload.read_only, true);
    assert.equal((await shared.request('/api/admin/devices')).status, 404);
    assert.equal((await shared.request('/api/auth/logout', {})).status, 200);
  }));

for (const legacy of ['v1', 'previous-pepper'])
  for (const enrolled of [false, true])
    test(`post-review: admin ${legacy} hash upgrade replaces a revoked own session before MFA ${enrolled ? 'verification' : 'setup'}`, () =>
      withApp(async (h) => {
        const id = await h.user('admin');
        let secret;
        if (enrolled) {
          const first = await h.browser();
          const login = await first.request('/api/auth/login', { email: `u${id}@example.test`, password });
          const challenge = login.payload.challenge;
          const setup = await first.request('/api/auth/admin-totp/setup', { challenge });
          secret = setup.payload.secret;
          assert.equal(
            (await first.request('/api/auth/admin-totp/confirm', { challenge, code: code(secret) })).status,
            200,
          );
        }
        if (legacy === 'v1') {
          const row = await h.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(id).first();
          await h.db
            .prepare('UPDATE users SET password_hash=? WHERE id=?')
            .bind(row.password_hash.replace('$v2$primary$', '$v1$'), id)
            .run();
        } else {
          Object.assign(h.bindings, {
            PASSWORD_PEPPER_PREVIOUS: h.bindings.PASSWORD_PEPPER,
            PASSWORD_PEPPER_PREVIOUS_ID: 'primary',
            PASSWORD_PEPPER_PREVIOUS_UNTIL: String(time() + 3600),
            PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
            PASSWORD_PEPPER_ID: 'next',
          });
          await h.reconfigure();
        }
        const client = await h.browser(id),
          oldCookie = client.cookie;
        const login = await client.request('/api/auth/login', { email: `u${id}@example.test`, password });
        assert.equal(login.status, 200);
        assert.equal(login.payload.stage, enrolled ? 'totp' : 'totp_setup');
        const challenge = login.payload.challenge;
        if (enrolled) {
          assert.equal(
            (
              await client.request('/api/auth/admin-totp/verify', {
                challenge,
                code: code(secret, Math.floor(Date.now() / 30000) + 1),
              })
            ).status,
            200,
          );
        } else {
          const setup = await client.request('/api/auth/admin-totp/setup', { challenge });
          assert.equal(setup.status, 200);
          assert.equal(
            (
              await client.request('/api/auth/admin-totp/confirm', {
                challenge,
                code: code(setup.payload.secret),
              })
            ).status,
            200,
          );
        }
        assert.notEqual(client.cookie, oldCookie);
        assert.ok(login.payload.csrf_token);
        assert.equal(
          await h.db
            .prepare('SELECT 1 FROM sessions WHERE token_hash=?')
            .bind(digest(oldCookie.split('=')[1]))
            .first(),
          null,
        );
        assert.equal((await client.request('/api/admin/devices')).status, 200);
      }));

test('A3 parallel rotation issues one candidate and concurrent acknowledgement preserves the winner', () =>
  withApp(async (h) => {
    const browser = await h.browser(await h.user());
    const oldCookie = browser.cookie,
      oldHash = digest(oldCookie.split('=')[1]);
    await h.db
      .prepare('UPDATE sessions SET rotated_at=? WHERE token_hash=?')
      .bind(time() - 901, oldHash)
      .run();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => browser.request('/api/auth/me', undefined, {}, false)),
    );
    assert.ok(responses.every((r) => r.status === 200));
    const issued = responses.filter((r) => r.headers.get('Set-Cookie'));
    assert.equal(issued.length, 1);
    const candidate = issued[0].headers.get('Set-Cookie').split(';')[0];
    let row = await h.db.prepare('SELECT * FROM sessions WHERE token_hash=?').bind(oldHash).first();
    assert.equal(row.pending_hash, digest(candidate.split('=')[1]));
    assert.equal(row.previous_hash, null);
    const clock = Date.now,
      base = clock();
    try {
      Date.now = () => base + 75000;
      const afterLostResponse = h.context(oldCookie);
      await helpers.loadSession(afterLostResponse);
      assert.ok(afterLostResponse.user);
      const acknowledgements = Array.from({ length: 6 }, () => h.context(candidate));
      await Promise.all(acknowledgements.map((c) => helpers.loadSession(c)));
      assert.ok(acknowledgements.every((c) => c.user));
      row = await h.db.prepare('SELECT * FROM sessions WHERE previous_hash=?').bind(oldHash).first();
      assert.equal(row.pending_hash, null);
      assert.equal(row.token_hash, digest(candidate.split('=')[1]));
      const grace = h.context(oldCookie);
      await helpers.loadSession(grace);
      assert.ok(grace.user);
      Date.now = () => base + 106000;
      const expired = h.context(oldCookie);
      await helpers.loadSession(expired);
      assert.equal(expired.user, null);
      const active = h.context(candidate);
      await helpers.loadSession(active);
      assert.ok(active.user);
    } finally {
      Date.now = clock;
    }
  }));

test('A16 mail rejection removes orphan proof and returns only failed delivery budgets; resend revokes old proof', () =>
  withApp(async (h) => {
    const id = await h.user('user', false),
      client = await h.browser(id);
    h.fixture.status = 503;
    for (let i = 0; i < 4; i++) {
      assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 202);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM email_verification_tokens').first()).n, 0);
    }
    h.fixture.status = 201;
    assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 202);
    const first = await h.db.prepare('SELECT * FROM email_verification_tokens').first();
    assert.equal(first.used_at, null);
    assert.equal(first.expires_at - first.created_at, 1200);
    // A cooldown rejection cannot consume the hourly send budget.
    for (let i = 0; i < 4; i++)
      assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 429);
    const sendKey = createHmac('sha256', h.bindings.SESSION_SECRET)
      .update('email-proof-send\0' + id)
      .digest('hex');
    assert.equal(
      (await h.db.prepare('SELECT attempts FROM rate_limits WHERE key_hash=?').bind(sendKey).first())
        .attempts,
      1,
    );
    const cooldownKey = createHmac('sha256', h.bindings.SESSION_SECRET)
      .update('email-proof-cooldown\0' + id)
      .digest('hex');
    await h.db
      .prepare('UPDATE rate_limits SET expires_at=? WHERE key_hash=?')
      .bind(time() - 1, cooldownKey)
      .run();
    h.fixture.status = 503;
    assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 202);
    assert.equal(
      (
        await h.db
          .prepare('SELECT used_at FROM email_verification_tokens WHERE token_hash=?')
          .bind(first.token_hash)
          .first()
      ).used_at,
      null,
      'A rejected resend must preserve the last delivered proof',
    );
    h.fixture.status = 201;
    assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 202);
    const proofs = (await h.db.prepare('SELECT * FROM email_verification_tokens ORDER BY rowid').all())
      .results;
    assert.equal(proofs.length, 2);
    assert.ok(proofs[0].used_at);
    assert.equal(proofs[1].used_at, null);
    assert.equal(
      (await h.db.prepare('SELECT attempts FROM rate_limits WHERE key_hash=?').bind(sendKey).first())
        .attempts,
      2,
    );
  }));

test('A16 uncertain transport keeps quota; reservation rollback cannot clear newer windows or duplicate itself', () =>
  withApp(async (h) => {
    const id = await h.user('user', false),
      client = await h.browser(id);
    const pending = [],
      deliveryContext = h.context(client.cookie, {}, client.csrf),
      originalFetch = globalThis.fetch;
    await helpers.loadSession(deliveryContext);
    deliveryContext.ctx = { waitUntil: (task) => pending.push(task) };
    try {
      globalThis.fetch = async () => {
        throw new Error('Synthetic uncertain transport');
      };
      assert.equal(
        (await helpers.emailVerification(deliveryContext, 'request-email-verification')).status,
        202,
      );
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal((await client.request('/api/auth/request-email-verification', {})).status, 429);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM email_verification_tokens').first()).n, 0);
    const context = h.context(client.cookie);
    const first = await helpers.reserveAttempt(context, 'synthetic-delivery', 'account', 3, 60);
    const second = await helpers.reserveAttempt(context, 'synthetic-delivery', 'account', 3, 60);
    await helpers.releaseAttempt(context, first);
    await helpers.releaseAttempt(context, first);
    assert.equal(
      (await h.db.prepare('SELECT attempts FROM rate_limits WHERE key_hash=?').bind(second.keyHash).first())
        .attempts,
      1,
    );
    await h.db
      .prepare('UPDATE rate_limits SET attempts=2,expires_at=expires_at+60 WHERE key_hash=?')
      .bind(second.keyHash)
      .run();
    await helpers.releaseAttempt(context, second);
    assert.equal(
      (await h.db.prepare('SELECT attempts FROM rate_limits WHERE key_hash=?').bind(second.keyHash).first())
        .attempts,
      2,
    );
  }));

test('B security failures are sampled before stdout; stdout has no account identifiers and D1 retains correlation', () =>
  withApp(async (h) => {
    const id = await h.user(),
      context = h.context('');
    context.env.SECURITY_EVENT_FAILURE_SAMPLE_RATE = '20';
    const logs = [],
      oldLog = console.log,
      oldRandom = crypto.getRandomValues;
    try {
      console.log = (entry) => logs.push(JSON.parse(entry));
      crypto.getRandomValues = (target) => target.fill(1);
      await helpers.securityEvent(context, 'login', 'failure', id, `u${id}@example.test`);
      assert.equal(logs.length, 0);
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM security_events').first()).n, 0);
      crypto.getRandomValues = (target) => target.fill(0);
      await helpers.securityEvent(context, 'login', 'failure', id, `u${id}@example.test`);
      await helpers.securityEvent(context, 'login', 'success', id, `u${id}@example.test`);
      assert.equal(logs.length, 2);
      assert.ok(logs.every((entry) => !('account_id' in entry) && !('account_hash' in entry)));
      assert.ok(!JSON.stringify(logs).includes('@example.test'));
      const persisted = (await h.db.prepare('SELECT * FROM security_events').all()).results;
      assert.equal(persisted.length, 2);
      assert.ok(
        persisted.every((entry) => entry.account_id === id && /^[a-f0-9]{64}$/.test(entry.account_hash)),
      );
    } finally {
      console.log = oldLog;
      crypto.getRandomValues = oldRandom;
    }
  }));

test('A4/A17 password reset is generic, expires and is single-use under concurrency; changes revoke sessions', () =>
  withApp(async (h) => {
    const id = await h.user(),
      owner = await h.browser(id),
      requester = await h.browser();
    const known = await requester.request('/api/auth/forgot-password', { email: `u${id}@example.test` });
    const absent = await requester.request('/api/auth/forgot-password', { email: 'absent@example.test' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.payload, absent.payload);
    assert.equal(h.fixture.sent.length, 1);
    const token = h.fixture.sent[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    assert.equal((await requester.request('/api/auth/reset-password?token=' + token)).payload.valid, true);
    const row = await h.db.prepare('SELECT * FROM password_reset_tokens').first();
    assert.equal(row.expires_at - row.created_at, 1200);
    assert.equal(row.token_hash, digest(token));
    const next = 'Synthetic-Reset-9421!';
    const results = await Promise.all(
      (await Promise.all([h.browser(), h.browser()])).map((client) =>
        client.request('/api/auth/reset-password', { token, password: next, password_confirmation: next }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 422]);
    assert.equal((await owner.request('/api/auth/me')).status, 401);
    assert.equal((await requester.request('/api/auth/reset-password?token=' + token)).payload.valid, false);
    const expired = randomBytes(32).toString('base64url');
    await h.db
      .prepare('INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(digest(expired), id, time() - 1, time() - 1201)
      .run();
    assert.equal((await requester.request('/api/auth/reset-password?token=' + expired)).payload.valid, false);
    h.fixture.status = 503;
    assert.equal(
      (await requester.request('/api/auth/forgot-password', { email: `u${id}@example.test` })).status,
      200,
    );
    assert.equal(
      (
        await h.db
          .prepare(
            'SELECT COUNT(*) n FROM password_reset_tokens WHERE used_at IS NULL AND expires_at>unixepoch()',
          )
          .first()
      ).n,
      0,
    );
  }));

test('A17 rejected and uncertain reset resend preserves the delivered proof; success supersedes only older proofs', () =>
  withApp(async (h) => {
    const id = await h.user(),
      client = await h.browser();
    const requestReset = () => client.request('/api/auth/forgot-password', { email: `u${id}@example.test` });
    assert.equal((await requestReset()).status, 200);
    const first = await h.db.prepare('SELECT * FROM password_reset_tokens').first();
    h.fixture.status = 503;
    assert.equal((await requestReset()).status, 200);
    assert.equal(
      (
        await h.db
          .prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?')
          .bind(first.token_hash)
          .first()
      ).used_at,
      null,
    );
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').first()).n, 1);
    const uncertain = h.context(client.cookie, { email: `u${id}@example.test` }, client.csrf),
      pending = [],
      originalFetch = globalThis.fetch;
    await helpers.loadSession(uncertain);
    uncertain.ctx = { waitUntil: (task) => pending.push(task) };
    try {
      globalThis.fetch = async () => {
        throw new Error('Synthetic uncertain transport');
      };
      assert.equal((await helpers.authRoute(uncertain, 'forgot-password')).status, 200);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(
      (
        await h.db
          .prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?')
          .bind(first.token_hash)
          .first()
      ).used_at,
      null,
    );
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').first()).n, 1);
    // Anonymous reset quotas remain uniform, including failed delivery attempts.
    assert.equal((await requestReset()).status, 429);
    const key = createHmac('sha256', h.bindings.SESSION_SECRET)
      .update('reset-email\0' + `u${id}@example.test`)
      .digest('hex');
    await h.db
      .prepare('UPDATE rate_limits SET expires_at=? WHERE key_hash=?')
      .bind(time() - 1, key)
      .run();
    h.fixture.status = 201;
    assert.equal((await requestReset()).status, 200);
    assert.ok(
      (
        await h.db
          .prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?')
          .bind(first.token_hash)
          .first()
      ).used_at,
    );
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM password_reset_tokens WHERE used_at IS NULL').first()).n,
      1,
    );
    h.fixture.beforeResponse = async () => {
      await h.db
        .prepare('UPDATE users SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=?')
        .bind('synthetic-new-password-hash', time(), id)
        .run();
    };
    assert.equal((await requestReset()).status, 200);
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM password_reset_tokens WHERE used_at IS NULL').first()).n,
      0,
    );
  }));

test('A4 session idle, absolute expiration, version revocation, email change and role demotion are enforced', () =>
  withApp(async (h) => {
    const id = await h.user();
    for (const sql of [
      'UPDATE sessions SET last_seen=unixepoch()-7201 WHERE user_id=?',
      'UPDATE sessions SET expires_at=unixepoch()-1 WHERE user_id=?',
      'UPDATE users SET session_version=session_version+1 WHERE id=?',
    ]) {
      await h.db.prepare('UPDATE users SET session_version=1 WHERE id=?').bind(id).run();
      const client = await h.browser(id);
      await h.db.prepare(sql).bind(id).run();
      assert.equal((await client.request('/api/auth/me')).status, 401);
    }
    await h.db.prepare('UPDATE users SET session_version=1 WHERE id=?').bind(id).run();
    const changedEmail = await h.browser(id);
    await h.db.prepare("UPDATE users SET email='changed@example.test' WHERE id=?").bind(id).run();
    assert.equal((await changedEmail.request('/api/auth/me')).status, 401);
    const admin = await h.user('admin'),
      client = await h.browser(admin);
    await h.db.prepare('UPDATE sessions SET admin_mfa_at=unixepoch() WHERE user_id=?').bind(admin).run();
    assert.equal((await client.request('/api/admin/devices')).status, 200);
    await h.db.prepare("UPDATE users SET role='user' WHERE id=?").bind(admin).run();
    assert.equal((await client.request('/api/admin/devices')).status, 404);
  }));

test('A4/A5 MFA challenge binding, replay, recovery use and recent admin reauthentication remain protected', () =>
  withApp(async (h) => {
    const id = await h.user('admin'),
      client = await h.browser(),
      outsider = await h.browser();
    const login = await client.request('/api/auth/login', { email: `u${id}@example.test`, password });
    assert.equal(login.payload.stage, 'totp_setup');
    const challenge = login.payload.challenge;
    assert.equal((await outsider.request('/api/auth/admin-totp/setup', { challenge })).status, 401);
    const setup = await client.request('/api/auth/admin-totp/setup', { challenge });
    assert.equal(setup.status, 200);
    const secret = setup.payload.secret;
    const confirmed = await client.request('/api/auth/admin-totp/confirm', { challenge, code: code(secret) });
    assert.equal(confirmed.status, 200);
    const recovery = confirmed.payload.recovery_codes[0];
    assert.equal((await client.request('/api/admin/devices')).status, 200);
    assert.equal((await client.request('/api/auth/admin-totp/reauth', { code: code(secret) })).status, 422);
    await h.db.prepare('UPDATE sessions SET admin_mfa_at=unixepoch()-301 WHERE user_id=?').bind(id).run();
    assert.equal((await client.request('/api/auth/delete-account', { confirmation: true })).status, 403);
    const loginAgain = await outsider.request('/api/auth/login', { email: `u${id}@example.test`, password });
    const token = loginAgain.payload.challenge;
    const recovered = await outsider.request('/api/auth/admin-totp/verify', {
      challenge: token,
      recovery_code: recovery,
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.payload.stage, 'totp_setup');
    assert.equal((await outsider.request('/api/admin/devices')).status, 404);
    assert.equal(
      (await outsider.request('/api/auth/admin-totp/verify', { challenge: token, recovery_code: recovery }))
        .status,
      401,
    );
    const used = await h.db
      .prepare('SELECT COUNT(*) n FROM admin_totp_recovery WHERE user_id=? AND used_at IS NOT NULL')
      .bind(id)
      .first();
    assert.equal(used.n, 1);
  }));

test('new: password change after consuming an MFA setup challenge cannot install a stale credential', () =>
  withApp(async (h) => {
    const id = await h.user('admin'),
      client = await h.browser();
    const login = await client.request('/api/auth/login', { email: `u${id}@example.test`, password });
    const challenge = login.payload.challenge;
    const setup = await client.request('/api/auth/admin-totp/setup', { challenge });
    const context = h.context(client.cookie, { challenge, code: code(setup.payload.secret) }, client.csrf);
    await helpers.loadSession(context);
    let injected = false;
    context.env.DB = {
      prepare: (sql) => h.db.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true;
          await h.db
            .prepare(
              'UPDATE users SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=?',
            )
            .bind('synthetic-changed-password-hash', time(), id)
            .run();
        }
        return h.db.batch(statements);
      },
    };
    const error = await helpers.totpRoute(context, 'confirm').then(
      () => null,
      (failure) => failure,
    );
    assert.ok(injected);
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM admin_totp WHERE user_id=?').bind(id).first()).n,
      0,
      'A revoked setup must not install an MFA credential',
    );
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM admin_totp_recovery WHERE user_id=?').bind(id).first()).n,
      0,
    );
    assert.equal(
      (await h.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind(id).first()).n,
      0,
    );
    assert.match(error?.message ?? '', /mutation_guard|CHECK constraint/);
  }));
