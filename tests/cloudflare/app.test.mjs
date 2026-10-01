import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Miniflare, Response as MFResponse, Log, LogLevel } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const password = 'Senha-de-teste-8472';
const base = 'https://api.hidra.test';
const frontend = 'https://hidra.test';
const seconds = () => Math.floor(Date.now() / 1000);
let mf,
  db,
  sent = [],
  mailStatus = 201,
  monitorieFixture = null,
  monitorieRequests = [],
  ipCounter = 0;
const keys = {
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  PASSWORD_PEPPER: randomBytes(32).toString('base64url'),
  BREVO_API_KEY: randomBytes(32).toString('base64url'),
};
const bindings = {
  ...keys,
  APP_ENV: 'production',
  APP_URL: frontend,
  CORS_ORIGINS: frontend,
  MAIL_MODE: 'brevo',
  MONITORIE_MODE: 'unconfigured',
  BREVO_SENDER_EMAIL: 'sender@example.test',
  BREVO_SENDER_NAME: 'Hidra testes',
  INGEST_ENABLED: 'true',
  MONITORIE_CACHE_SECONDS: '60',
};
function options(overrides = {}) {
  return {
    modules: true,
    scriptPath: 'dist/worker/index.js',
    compatibilityDate: '2026-03-01',
    d1Databases: { DB: 'test-only' },
    bindings: { ...bindings, ...overrides },
    log: new Log(LogLevel.NONE),
    serviceBindings: { ASSETS: () => new MFResponse('asset') },
    outboundService: async (request) => {
      if (request.url.startsWith('https://monitorie.com.br/')) {
        monitorieRequests.push(request.url);
        assert.ok(monitorieFixture, 'MonitorIE não deve ser chamada sem fixture');
        assert.equal(request.headers.get('X-Authorization'), `Bearer ${monitorieFixture.jwt}`);
        const uri = new URL(request.url);
        if (uri.pathname === '/api/user/devices') {
          return new MFResponse(
            JSON.stringify({
              data: [
                {
                  id: { entityType: 'DEVICE', id: monitorieFixture.id },
                  name: 'Equipamento confirmado',
                  label: 'SM-WU',
                  type: monitorieFixture.type ?? 'SM-WU',
                },
              ],
              totalPages: 1,
              totalElements: 1,
              hasNext: false,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (uri.pathname.endsWith('/values/attributes')) {
          return new MFResponse(JSON.stringify(monitorieFixture.attributes ?? []),
            { headers: { 'Content-Type': 'application/json' } });
        }
        if (uri.pathname.endsWith('/values/timeseries')) {
          const ts = monitorieFixture.readingTs ?? Date.now();
          const data = Object.fromEntries(
            (uri.searchParams.get('keys') || '').split(',').map((key) => [
              key,
              key === 'mac' && !monitorieFixture.mac ? [] : [
                {
                  ts,
                  value: { mac: monitorieFixture.mac, d: 100, nivel: 50, volume: 500, rssi_wifi: -60, vazao: 12, consumo: 345 }[key],
                },
              ],
            ]),
          );
          return new MFResponse(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        }
        assert.fail(`Caminho MonitorIE inesperado: ${uri.pathname}`);
      }
      assert.equal(
        request.url,
        'https://api.brevo.com/v3/smtp/email',
        'Qualquer rede externa não prevista é proibida no teste',
      );
      assert.equal(request.headers.get('api-key'), keys.BREVO_API_KEY);
      assert.equal(request.method, 'POST');
      sent.push(await request.json());
      return new MFResponse('{}', { status: mailStatus, headers: { 'Content-Type': 'application/json' } });
    },
  };
}
async function configure(overrides = {}) {
  await mf.setOptions(options(overrides));
  db = await mf.getD1Database('DB');
}
async function freshDatabase() {
  if (mf) await mf.dispose();
  mf = new Miniflare(options());
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort())
    await db.batch(
      unstable_splitSqlQuery(await readFile(`cloudflare/migrations/${file}`, 'utf8')).map((q) =>
        db.prepare(q),
      ),
    );
}
after(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  sent = [];
  mailStatus = 201;
  monitorieFixture = null;
  monitorieRequests = [];
  await freshDatabase();
});

function browser(origin = base) {
  let cookie = '',
    csrf = '';
  const ip = `198.51.100.${++ipCounter}`;
  return {
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
    origin,
    ip,
    async request(path, { method = 'GET', data, headers = {}, capture = true } = {}) {
      const response = await mf.dispatchFetch(origin + path, {
        method,
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'CF-Connecting-IP': ip,
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (capture) for (const value of response.headers.getSetCookie()) cookie = value.split(';')[0];
      return response;
    },
    async init() {
      const res = await this.request('/api/auth/csrf');
      assert.equal(res.status, 200);
      csrf = (await res.json()).csrf_token;
    },
    async register(email, name = 'Pessoa de teste') {
      const targetEmail = email ?? `u${++ipCounter}@example.test`;
      await this.init();
      const res = await this.request('/api/auth/register', {
        method: 'POST',
        data: { name, email: targetEmail, password, password_confirmation: password },
      });
      const payload = await res.json();
      assert.equal(res.status, 201, JSON.stringify(payload));
      csrf = payload.csrf_token;
      return payload.user;
    },
    async login(email, remember = false, pass = password, next = '/') {
      await this.init();
      const res = await this.request('/api/auth/login', {
        method: 'POST',
        data: { email, password: pass, remember, next },
      });
      const payload = await res.json();
      if (payload.csrf_token) csrf = payload.csrf_token;
      return { res, payload };
    },
  };
}
async function provision(
  id = 1,
  source = 'local',
  code = randomBytes(24).toString('base64url').toUpperCase(),
) {
  const time = seconds();
  await db
    .prepare(
      `INSERT INTO devices(id,device_code,source,external_id,pairing_code_hash,pairing_expires_at,created_at,updated_at)
 VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      `DEVICE-${id}`,
      source,
      source === 'local' ? null : `external-${id}`,
      digest(code),
      time + 3600,
      time,
      time,
    )
    .run();
  return code;
}
async function connect(client, code, name = 'Caixa principal', macAddress = '') {
  const res = await client.request('/api/devices/connect', {
    method: 'POST',
    data: { pairing_code: code, mac_address: macAddress, reservoir_name: name },
  });
  const payload = await res.json();
  assert.equal(res.status, 201, JSON.stringify(payload));
  return payload.data;
}
async function waitFor(predicate) {
  for (let i = 0; i < 80; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Operação assíncrona não terminou');
}
async function issueReset(client, email) {
  const res = await client.request('/api/auth/forgot-password', { method: 'POST', data: { email } });
  assert.equal(res.status, 200);
  await waitFor(() => sent.length > 0);
  return new URL(sent.at(-1).textContent.match(/https:\/\/[^\s]+/)[0]).searchParams.get('token');
}

test('migrations inicializam D1 vazio e as cinco páginas mantêm o design', async () => {
  const client = browser();
  assert.equal((await client.request('/api/health')).status, 200);
  const root = await client.request('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('Location'), frontend + '/');
  for (const page of ['/login', '/cadastro', '/esqueci-senha', '/redefinir-senha']) {
    const res = await client.request(page);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), frontend + page);
  }
  for (const file of [
    'index.html',
    'login.html',
    'register.html',
    'forgot-password.html',
    'reset-password.html',
  ]) {
    const html = await readFile('dist/frontend/' + file, 'utf8');
    assert.ok(html.includes('auth-layout') || html.includes('dashboard-content'));
    assert.doesNotMatch(html, /<\?|\{\{|api\/[^"\s]+\.php/);
  }
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(
    (r) => r.name,
  );
  for (const table of [
    'users',
    'sessions',
    'password_reset_tokens',
    'rate_limits',
    'devices',
    'reservoirs',
    'smwu_readings',
    'settings',
  ])
    assert.ok(tables.includes(table));
});
test('cadastro, hash com salt/pepper, cookie seguro, CSRF e logout', async () => {
  const client = browser();
  await client.init();
  const anonymous = client.cookie;
  const user = await client.register('pessoa@example.test', '<script>Nome</script>');
  assert.notEqual(client.cookie, anonymous);
  const row = await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  assert.match(row.password_hash, /^pbkdf2-sha256-pepper\$v1\$100000\$/);
  assert.ok(!row.password_hash.includes(password));
  const duplicate = browser();
  const user2 = await duplicate.register('pessoa2@example.test');
  const row2 = await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user2.id).first();
  assert.notEqual(row.password_hash, row2.password_hash);
  const meRes = await client.request('/api/auth/me');
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.user.name, '<script>Nome</script>');
  const page = await client.request('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('Location'), frontend + '/');
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    (await client.request('/api/auth/me', { headers: { Cookie: anonymous }, capture: false })).status,
    401,
  );
  assert.equal(
    (
      await client.request('/api/auth/logout', {
        method: 'POST',
        data: {},
        headers: { 'X-CSRF-Token': 'wrong' },
      })
    ).status,
    419,
  );
  const old = client.cookie;
  const logout = await client.request('/api/auth/logout', { method: 'POST', data: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /HttpOnly/);
  assert.match(logout.headers.get('set-cookie'), /Secure/);
  assert.match(logout.headers.get('set-cookie'), /SameSite=(?:Lax|None)/);
  assert.equal((await client.request('/api/auth/me', { headers: { Cookie: old } })).status, 401);
});
test('login lembrado, redirects seguros e bloqueio de origem externa', async () => {
  const client = browser();
  await client.register('login@example.test');
  const login = browser();
  const { res, payload } = await login.login('LOGIN@example.test', true, password, '//evil.example');
  assert.equal(res.status, 200);
  assert.equal(payload.redirect, '/');
  assert.match(res.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.equal(
    (
      await login.request('/api/auth/logout', {
        method: 'POST',
        data: {},
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await browser().login('login@example.test', false, 'wrong')).res.status, 401);
  const basic = await browser().login('login@example.test');
  assert.equal(basic.res.status, 200);
  assert.doesNotMatch(basic.res.headers.get('set-cookie'), /Max-Age/);
});
test('validação de senha exige 8+ caracteres, maiúscula, minúscula, número e caractere especial', async () => {
  const client = browser();
  await client.init();
  const invalidPasswords = [
    'Aa1!aaa', // menos de 8 caracteres
    'senha-teste-1234', // sem maiúscula
    'SENHA-TESTE-1234', // sem minúscula
    'Senha-de-teste!', // sem número
    'SenhaForte1234', // sem caractere especial
  ];
  for (const pass of invalidPasswords) {
    const res = await client.request('/api/auth/register', {
      method: 'POST',
      data: {
        name: 'Teste',
        email: `weak_${++ipCounter}@example.test`,
        password: pass,
        password_confirmation: pass,
      },
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error?.code, 'WEAK_PASSWORD');
  }
  const mismatch = await client.request('/api/auth/register', {
    method: 'POST',
    data: {
      name: 'Teste',
      email: `mismatch_${++ipCounter}@example.test`,
      password: 'Senha-Forte-123',
      password_confirmation: 'Outra-Senha-123',
    },
  });
  assert.equal(mismatch.status, 422);
  assert.equal((await mismatch.json()).error?.code, 'PASSWORD_MISMATCH');
});
test('sessões expiram por inatividade, limite absoluto e giram após 15 minutos', async () => {
  const client = browser();
  await client.register();
  const old = client.cookie;
  await db
    .prepare('UPDATE sessions SET rotated_at=?')
    .bind(seconds() - 901)
    .run();
  const rotated = await client.request('/api/auth/me');
  assert.equal(rotated.status, 200);
  assert.notEqual(client.cookie, old);
  assert.equal(
    (await client.request('/api/auth/me', { headers: { Cookie: old }, capture: false })).status,
    200,
  );
  await db
    .prepare('UPDATE sessions SET previous_until=?')
    .bind(seconds() - 1)
    .run();
  assert.equal(
    (await client.request('/api/auth/me', { headers: { Cookie: old }, capture: false })).status,
    401,
  );
  await db
    .prepare('UPDATE sessions SET last_seen=?')
    .bind(seconds() - 7201)
    .run();
  assert.equal((await client.request('/api/auth/me')).status, 401);
  const next = browser();
  await next.register();
  await db
    .prepare('UPDATE sessions SET expires_at=?')
    .bind(seconds() - 1)
    .run();
  assert.equal((await next.request('/api/auth/me')).status, 401);
});
test('APIs privadas rejeitam anônimos; métodos e entradas são validados', async () => {
  const client = browser();
  for (const route of [
    '/api/auth/me',
    '/api/reservoirs',
    '/api/device/current',
    '/api/device/history',
    '/api/device/status',
    '/api/device/alerts',
    '/api/device/snapshot',
  ])
    assert.equal((await client.request(route)).status, 401, route);
  await client.register();
  assert.equal((await client.request('/api/reservoirs', { method: 'POST', data: {} })).status, 405);
  assert.equal(
    (await client.request('/api/devices/connect', { method: 'POST', data: { owner_user_id: 1 } })).status,
    422,
  );
  assert.equal((await client.request('/api/device/current?reservoir_id=1%20OR%201=1')).status, 422);
  assert.equal((await client.request('/.env')).status, 404);
  assert.equal((await client.request('/__telemetry-cache/anything')).status, 404);
});
test('logout concorrente à rotação revoga também o identificador novo', async () => {
  const client = browser();
  const user = await client.register();
  await db
    .prepare('UPDATE sessions SET rotated_at=?')
    .bind(seconds() - 901)
    .run();
  const old = client.cookie;
  const [rotated, logout] = await Promise.all([
    client.request('/api/auth/me', { capture: false }),
    client.request('/api/auth/logout', {
      method: 'POST',
      data: {},
      headers: { Cookie: old },
      capture: false,
    }),
  ]);
  assert.equal(logout.status, 200);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind(user.id).first()).n,
    0,
  );
  const next = rotated.headers.get('set-cookie')?.split(';')[0];
  if (next)
    assert.equal(
      (await client.request('/api/auth/me', { headers: { Cookie: next }, capture: false })).status,
      401,
    );
});
test('rate limit de login é compartilhado pelo D1 e retorna Retry-After', async () => {
  const client = browser();
  await client.init();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await client.request('/api/auth/login', {
          method: 'POST',
          data: { email: 'nobody@example.test', password },
        })
      ).status,
      401,
    );
  const denied = await client.request('/api/auth/login', {
    method: 'POST',
    data: { email: 'nobody@example.test', password },
  });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
});
test('recuperação usa Brevo simulado, token com hash, URL pública e validade de 20 minutos', async () => {
  const client = browser();
  const user = await client.register('reset@example.test');
  const token = await issueReset(client, user.email);
  assert.match(token, /^[\w-]{43}$/);
  const entry = await db.prepare('SELECT * FROM password_reset_tokens WHERE user_id=?').bind(user.id).first();
  assert.equal(entry.token_hash, digest(token));
  assert.notEqual(entry.token_hash, token);
  assert.equal(entry.expires_at - entry.created_at, 1200);
  assert.match(sent[0].htmlContent, /https:\/\/hidra.test\/redefinir-senha/);
  assert.doesNotMatch(sent[0].htmlContent, /127\.0\.0\.1/);
  const validation = await client.request(`/api/auth/reset-password?token=${token}`);
  assert.equal((await validation.json()).valid, true);
  const missing = await client.request('/api/auth/forgot-password', {
    method: 'POST',
    data: { email: 'missing@example.test' },
  });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).success, true);
});
test('reset é de uso único sob concorrência, invalida outros tokens e TODAS as sessões', async () => {
  const client = browser();
  const user = await client.register('reset2@example.test');
  const second = browser();
  await second.login(user.email, true);
  const token = await issueReset(client, user.email);
  const other = randomBytes(32).toString('base64url');
  await db
    .prepare('INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .bind(digest(other), user.id, seconds() + 1200, seconds())
    .run();
  const guest1 = browser(),
    guest2 = browser();
  await guest1.init();
  await guest2.init();
  const data = { token, password: 'Nova-senha-85744', password_confirmation: 'Nova-senha-85744' };
  const results = await Promise.all([
    guest1.request('/api/auth/reset-password', { method: 'POST', data }),
    guest2.request('/api/auth/reset-password', { method: 'POST', data }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 422]);
  assert.equal((await client.request('/api/auth/me')).status, 401);
  assert.equal((await second.request('/api/auth/me')).status, 401);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL')
        .bind(user.id)
        .first()
    ).n,
    0,
  );
  assert.equal((await browser().login(user.email)).res.status, 401);
  assert.equal((await browser().login(user.email, false, 'Nova-senha-85744')).res.status, 200);
});
test('tokens expirados não redefinem a senha; falha de envio não deixa token utilizável', async () => {
  const client = browser();
  const user = await client.register('expired@example.test');
  const token = await issueReset(client, user.email);
  await db
    .prepare('UPDATE password_reset_tokens SET expires_at=?')
    .bind(seconds() - 1)
    .run();
  const check = await client.request(`/api/auth/reset-password?token=${token}`);
  assert.equal((await check.json()).valid, false);
  assert.equal(
    (
      await client.request('/api/auth/reset-password', {
        method: 'POST',
        data: { token, password, password_confirmation: password },
      })
    ).status,
    422,
  );
  mailStatus = 401;
  sent = [];
  await client.request('/api/auth/forgot-password', { method: 'POST', data: { email: user.email } });
  await waitFor(() => sent.length === 1);
  const failedToken = new URL(sent[0].textContent.match(/https:\/\/[^\s]+/)[0]).searchParams.get('token');
  await waitFor(
    async () =>
      !(await db
        .prepare('SELECT 1 FROM password_reset_tokens WHERE token_hash=?')
        .bind(digest(failedToken))
        .first()),
  );
});
test('pareamento atômico, autorização entre usuários, renomeação e histórico preservado', async () => {
  const a = browser(),
    b = browser();
  await a.register('a@example.test');
  await b.register('b@example.test');
  const code = await provision();
  const paired = await Promise.all([
    a.request('/api/devices/connect', { method: 'POST', data: { pairing_code: code, reservoir_name: 'A' } }),
    b.request('/api/devices/connect', { method: 'POST', data: { pairing_code: code, reservoir_name: 'B' } }),
  ]);
  assert.deepEqual(paired.map((r) => r.status).sort(), [201, 422]);
  const winner = paired[0].status === 201 ? a : b,
    loser = winner === a ? b : a;
  const reservoir = (await (paired[0].status === 201 ? paired[0] : paired[1]).json()).data;
  for (const endpoint of ['current', 'status', 'history', 'alerts', 'snapshot'])
    assert.equal((await loser.request(`/api/device/${endpoint}?reservoir_id=${reservoir.id}`)).status, 404);
  const renamed = await winner.request('/api/reservoirs/rename', {
    method: 'POST',
    data: { reservoir_id: reservoir.id, name: 'Novo nome' },
  });
  assert.equal((await renamed.json()).data.name, 'Novo nome');
  assert.equal(
    (
      await loser.request('/api/devices/unlink', {
        method: 'POST',
        data: { reservoir_id: reservoir.id, confirmation: true },
      })
    ).status,
    404,
  );
  await db
    .prepare(
      'INSERT INTO smwu_readings(id,reservoir_id,distancia,nivel,volume,rssi_wifi,created_at) VALUES (1,?,20,80,1000,-50,?)',
    )
    .bind(reservoir.id, seconds())
    .run();
  assert.equal(
    (await winner.request('/api/device/history?reservoir_id=' + reservoir.id + '&hours=721')).status,
    422,
  );
  assert.equal(
    (
      await winner.request('/api/devices/unlink', {
        method: 'POST',
        data: { reservoir_id: reservoir.id, confirmation: true },
      })
    ).status,
    200,
  );
  assert.equal((await winner.request('/api/device/history?reservoir_id=' + reservoir.id)).status, 404);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM smwu_readings').first()).n, 1);
  const nextCode = randomBytes(24).toString('hex').toUpperCase();
  await db
    .prepare('UPDATE devices SET pairing_code_hash=?,pairing_expires_at=? WHERE id=1')
    .bind(digest(nextCode), seconds() + 3600)
    .run();
  const next = await connect(loser, nextCode);
  assert.equal((await (await loser.request('/api/device/history?reservoir_id=' + next.id)).json()).count, 0);
});
test('contrato de adicionar e desvincular distingue vínculo existente, ID ausente e rota ausente', async () => {
  const client = browser();
  await client.register();
  const code = await provision();
  const connected = await client.request('/api/devices/connect', {
    method: 'POST',
    data: { pairing_code: code, mac_address: '', reservoir_name: 'Teste isolado' },
  });
  assert.equal(connected.status, 201);
  const reservoir = (await connected.json()).data;
  assert.equal(reservoir.name, 'Teste isolado');
  assert.equal(reservoir.device.id, 1);
  const missingId = reservoir.id + 10000;
  const missing = await client.request('/api/devices/unlink', {
    method: 'POST',
    data: { reservoir_id: missingId, confirmation: true },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'RESERVOIR_NOT_FOUND');
  assert.equal(
    (await db.prepare('SELECT unlinked_at FROM reservoirs WHERE id=?').bind(reservoir.id).first())
      .unlinked_at,
    null,
  );
  const unlinked = await client.request('/api/devices/unlink', {
    method: 'POST',
    data: { reservoir_id: reservoir.id, confirmation: true },
  });
  assert.equal(unlinked.status, 200);
  assert.equal((await unlinked.json()).success, true);
  assert.ok(
    (await db.prepare('SELECT unlinked_at FROM reservoirs WHERE id=?').bind(reservoir.id).first())
      .unlinked_at,
  );
  assert.equal(
    (await db.prepare('SELECT owner_user_id FROM devices WHERE id=1').first()).owner_user_id,
    null,
  );
  assert.equal((await (await client.request('/api/reservoirs')).json()).count, 0);
  const repeated = await client.request('/api/devices/unlink', {
    method: 'POST',
    data: { reservoir_id: reservoir.id, confirmation: true },
  });
  assert.equal(repeated.status, 404);
  assert.equal((await repeated.json()).error.code, 'RESERVOIR_NOT_FOUND');
  const unknownRoute = await client.request('/api/devices/unlink-missing', {
    method: 'POST',
    data: { reservoir_id: reservoir.id, confirmation: true },
  });
  assert.equal(unknownRoute.status, 404);
  assert.equal((await unknownRoute.json()).error.code, 'NOT_FOUND');
});
test('Monitorie ausente retorna erro controlado e cache negativo; conta continua acessível', async () => {
  const client = browser();
  await client.register();
  const reservoir = await connect(client, await provision(1, 'monitorie'));
  const first = await client.request('/api/device/snapshot?reservoir_id=' + reservoir.id);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error.code, 'MONITORIE_NOT_CONFIGURED');
  const second = await client.request('/api/device/snapshot?reservoir_id=' + reservoir.id);
  assert.equal(second.status, 503);
  assert.equal((await second.json()).error.code, 'MONITORIE_UNAVAILABLE');
  assert.equal((await client.request('/api/auth/me')).status, 200);
  assert.equal((await client.request('/api/reservoirs')).status, 200);
});
test('ingestão exige token por dispositivo e preserva validação do firmware', async () => {
  const token = randomBytes(32).toString('base64url');
  await configure();
  const client = browser();
  await client.register();
  const reservoir = await connect(client, await provision());
  await db
    .prepare('INSERT INTO device_credentials(device_id,token_hash,created_at,updated_at) VALUES (1,?,?,?)')
    .bind(digest(token), seconds(), seconds())
    .run();
  const data = { ID: '1', D: '25.5', NIVEL: '15', VOLUME: '300', RSSI_WIFI: '-61' };
  assert.equal((await client.request('/api/device/ingest', { method: 'POST', data })).status, 401);
  assert.equal(
    (await client.request('/api/device/ingest?token=' + token, { method: 'POST', data })).status,
    401,
  );
  const valid = await client.request('/api/device/ingest', {
    method: 'POST',
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(valid.status, 200);
  const snapshot = await (await client.request('/api/device/snapshot?reservoir_id=' + reservoir.id)).json();
  assert.equal(snapshot.data.nivel, 15);
  assert.equal(snapshot.alerts[0].type, 'critical');
  assert.equal((await client.request('/api/device/current.php?reservoir_id=' + reservoir.id)).status, 200);
  assert.equal(
    (
      await client.request('/api/device/ingest', {
        method: 'POST',
        data: { ...data, distancia: 20 },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await client.request('/api/device/ingest', {
        method: 'POST',
        data: { ...data, NIVEL: 101 },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    422,
  );
  await configure();
});
test('mocks funcionam somente em desenvolvimento local e snapshot usa cache', async () => {
  await configure({ APP_ENV: 'development', MONITORIE_MODE: 'mock', MAIL_MODE: 'disabled' });
  assert.equal((await mf.dispatchFetch(base + '/login')).status, 503);
  const client = browser('http://127.0.0.1');
  await client.register();
  const reservoir = await connect(client, await provision(1, 'mock'));
  const first = await (await client.request('/api/device/snapshot?reservoir_id=' + reservoir.id)).json();
  assert.equal(first.simulated, true);
  await new Promise((r) => setTimeout(r, 1100));
  const second = await (await client.request('/api/device/snapshot?reservoir_id=' + reservoir.id)).json();
  assert.equal(second.data.timestamp, first.data.timestamp);
  const page = await client.request('/');
  assert.equal(page.status, 302);
  const frontendHtml = await readFile('dist/frontend/index.html', 'utf8');
  assert.match(frontendHtml, /Demonstração local/);
  await configure();
});
test('URL de recuperação local é rejeitada e modo de e-mail desativado não envia', async () => {
  await configure({ APP_URL: 'http://127.0.0.1:8788' });
  const client = browser();
  const user = await client.register('local-url@example.test');
  await client.request('/api/auth/forgot-password', { method: 'POST', data: { email: user.email } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').first()).n, 0);
  await configure({ MAIL_MODE: 'disabled' });
  await client.request('/api/auth/forgot-password', { method: 'POST', data: { email: user.email } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.length, 0);
  await configure();
});
test('compartilhamento Basic preserva leitura e impede mutação/reuso do cookie', async () => {
  const client = browser();
  const user = await client.register('share@example.test');
  const sharePassword = randomBytes(32).toString('base64url');
  await configure({
    DASHBOARD_SHARE_USERNAME: 'viewer',
    DASHBOARD_SHARE_PASSWORD: sharePassword,
    DASHBOARD_SHARE_USER_EMAIL: user.email,
  });
  const viewer = browser();
  const challenge = await viewer.request('/');
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('WWW-Authenticate'), /Basic/);
  const header = { Authorization: 'Basic ' + Buffer.from('viewer:' + sharePassword).toString('base64') };
  const sharedRes = await viewer.request('/', { headers: header });
  assert.equal(sharedRes.status, 302);
  assert.equal(sharedRes.headers.get('Location'), frontend + '/');
  assert.equal((await viewer.request('/api/reservoirs', { headers: header })).status, 200);
  assert.equal(
    (await viewer.request('/api/devices/connect', { method: 'POST', data: {}, headers: header })).status,
    403,
  );
  await configure();
  const me = await (await viewer.request('/api/auth/me')).json();
  assert.equal(
    (
      await viewer.request('/api/devices/connect', {
        method: 'POST',
        data: {},
        headers: { 'X-CSRF-Token': me.csrf_token },
      })
    ).status,
    403,
  );
});
test('artefato de publicação contém apenas frontend e Worker, sem PHP/segredos', async () => {
  const files = await readdir('dist', { recursive: true });
  for (const path of files) {
    assert.doesNotMatch(path, /(?:\.php$|\.env|dev\.vars|\.sql$|vendor\/autoload|node_modules)/);
    if (!/\.(?:js|html|css|json)$/.test(path)) continue;
    const text = await readFile('dist/' + path, 'utf8');
    assert.doesNotMatch(text, /xkeysib-[A-Za-z0-9-]{20,}/);
    for (const value of Object.values(keys)) assert.ok(!text.includes(value));
    if (!path.includes('worker')) assert.doesNotMatch(text, /\/api\/[\w/-]+\.php|<\?php/);
  }
});

test('perfil admin, restrição de acesso e bloqueio de autopromoção', async () => {
  const client = browser();
  const user = await client.register('normal@example.test', 'Normal User');
  assert.equal(user.role, 'user');
  const me = await (await client.request('/api/auth/me')).json();
  assert.equal(me.user.role, 'user');

  const anon = browser();
  const resAnon = await anon.request('/api/admin/devices');
  assert.equal(resAnon.status, 404);

  const resNormal = await client.request('/api/admin/devices');
  assert.equal(resNormal.status, 404);

  await configure({ INITIAL_ADMIN_EMAIL: 'primeiro-admin@example.test' });
  const adminClient = browser();
  const adminUser = await adminClient.register('primeiro-admin@example.test', 'Admin Bootstrap');
  assert.equal(adminUser.role, 'user');
  assert.equal((await (await adminClient.request('/api/auth/me')).json()).user.role, 'user');
  assert.equal((await adminClient.login('primeiro-admin@example.test')).payload.user.role, 'user');
  await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(adminUser.id).run();

  const adminMe = await (await adminClient.request('/api/auth/me')).json();
  assert.equal(adminMe.user.role, 'admin');

  const adminRes = await adminClient.request('/api/admin/devices');
  assert.equal(adminRes.status, 200);
  await configure();
});

test('cadastro administrativo de SM-WU e SM-WA, validação de unicidade e modelo obrigatório', async () => {
  await configure({ INITIAL_ADMIN_EMAIL: 'admin-cad@example.test' });
  const admin = browser();
  await admin.register('admin-cad@example.test', 'Admin');
  await db.prepare("UPDATE users SET role='admin' WHERE email=?").bind('admin-cad@example.test').run();

  const resWU = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: '8c:4f:00:e4:8a:23', source: 'monitorie' },
  });
  assert.equal(resWU.status, 201);
  const wu = (await resWU.json()).device;
  assert.equal(wu.device_type, 'SM-WU');
  assert.equal(wu.device_code, 'SMWU-8C4F00E48A23');
  assert.equal(wu.mac_address, '8C:4F:00:E4:8A:23');
  assert.equal(wu.external_id, undefined);

  const resWA = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WA', mac_address: 'AA-BB-CC-DD-EE-01', source: 'monitorie' },
  });
  assert.equal(resWA.status, 201);
  const wa = (await resWA.json()).device;
  assert.equal(wa.device_type, 'SM-WA');
  assert.equal(wa.device_code, 'SMWA-AABBCCDDEE01');

  const resInvalidType = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'OUTRO', mac_address: 'AA:BB:CC:DD:EE:02' },
  });
  assert.equal(resInvalidType.status, 422);

  const resDupCode = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WA', mac_address: '8C4F00E48A23' },
  });
  assert.equal(resDupCode.status, 409);

  const resDupExt = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WA', mac_address: '8C:4F:00:E4:8A' },
  });
  assert.equal(resDupExt.status, 422);

  const legacyId = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', device_code: 'inventado', mac_address: 'AA:BB:CC:DD:EE:03' },
  });
  assert.equal(legacyId.status, 422);

  await configure();
});
test('admin cadastra e desvincula dispositivo por ID; ID inexistente preserva o vínculo', async () => {
  const admin = browser();
  const adminUser = await admin.register('admin-unlink@example.test');
  await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(adminUser.id).run();
  const owner = browser();
  await owner.register('owner-unlink@example.test');

  const created = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: '02:00:00:00:00:01', source: 'monitorie' },
  });
  assert.equal(created.status, 201);
  const device = (await created.json()).device;
  assert.equal(device.mac_address, '02:00:00:00:00:01');
  const duplicate = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: '02:00:00:00:00:01', source: 'monitorie' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'RESOURCE_CONFLICT');
  const generated = await admin.request(`/api/admin/devices/${device.id}/generate-code`, {
    method: 'POST',
    data: {},
  });
  assert.equal(generated.status, 200);
  const code = (await generated.json()).activation_code;
  const reservoir = await connect(owner, code, 'Vínculo de teste', device.mac_address);

  const missing = await admin.request(`/api/admin/devices/${device.id + 10000}/unlink`, {
    method: 'POST',
    data: {},
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'DEVICE_NOT_FOUND');
  assert.equal(
    (await db.prepare('SELECT unlinked_at FROM reservoirs WHERE id=?').bind(reservoir.id).first())
      .unlinked_at,
    null,
  );
  const unlinked = await admin.request(`/api/admin/devices/${device.id}/unlink`, {
    method: 'POST',
    data: {},
  });
  assert.equal(unlinked.status, 200);
  assert.equal((await unlinked.json()).success, true);
  assert.ok(
    (await db.prepare('SELECT unlinked_at FROM reservoirs WHERE id=?').bind(reservoir.id).first())
      .unlinked_at,
  );
  assert.equal(
    (await db.prepare('SELECT owner_user_id FROM devices WHERE id=?').bind(device.id).first()).owner_user_id,
    null,
  );
  const listed = await (await admin.request('/api/admin/devices')).json();
  assert.equal(listed.data.find((entry) => entry.id === device.id).owner, null);
});


test('migração aditiva preserva códigos, ativação e vínculo legados sem supor MAC', async () => {
  const legacy = new Miniflare({ ...options(), d1Databases: { DB: 'migration-only' } });
  try {
    const legacyDb = await legacy.getD1Database('DB');
    for (const file of (await readdir('cloudflare/migrations'))
      .filter((f) => f.endsWith('.sql') && f < '0006')
      .sort())
      await legacyDb.batch(
        unstable_splitSqlQuery(await readFile(`cloudflare/migrations/${file}`, 'utf8')).map((q) =>
          legacyDb.prepare(q),
        ),
      );
    const time = seconds();
    await legacyDb
      .prepare(
        "INSERT INTO users(id,name,email,password_hash,created_at,updated_at) VALUES (1,'Legado','legado@example.test','hash',?,?)",
      )
      .bind(time, time)
      .run();
    await legacyDb
      .prepare(
        "INSERT INTO devices(id,device_code,source,external_id,created_at,updated_at) VALUES (1,'LEGACY-ONE','monitorie','11111111-2222-3333-4444-555555555555',?,?),(2,'LEGACY-TWO','local',NULL,?,?)",
      )
      .bind(time, time, time, time)
      .run();
    await legacyDb
      .prepare(
        'INSERT INTO activation_codes(device_id,code_hash,created_by_user_id,expires_at,created_at) VALUES (2,?,?,?,?)',
      )
      .bind(digest('legacy-code'), 1, time + 86400, time)
      .run();
    await legacyDb
      .prepare(
        "INSERT INTO reservoirs(user_id,device_id,name,linked_at,created_at,updated_at) VALUES (1,1,'Legado',?,?,?)",
      )
      .bind(time, time, time)
      .run();
    await legacyDb.batch(
      unstable_splitSqlQuery(await readFile('cloudflare/migrations/0006_device_mac.sql', 'utf8')).map((q) =>
        legacyDb.prepare(q),
      ),
    );
    const records = (
      await legacyDb
        .prepare('SELECT id,device_code,external_id,mac_address,owner_user_id FROM devices ORDER BY id')
        .all()
    ).results;
    assert.deepEqual(
      records.map((r) => r.mac_address),
      [null, null],
    );
    assert.deepEqual(
      records.map((r) => r.device_code),
      ['LEGACY-ONE', 'LEGACY-TWO'],
    );
    assert.equal(records[0].external_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(records[0].owner_user_id, 1);
    assert.equal(
      (await legacyDb.prepare('SELECT code_hash FROM activation_codes WHERE device_id=2').first()).code_hash,
      digest('legacy-code'),
    );
    assert.equal(
      (
        await legacyDb
          .prepare('SELECT COUNT(*) n FROM reservoirs WHERE device_id=1 AND unlinked_at IS NULL')
          .first()
      ).n,
      1,
    );
    await assert.rejects(
      legacyDb.prepare("UPDATE devices SET mac_address='invalid' WHERE id=2").run(),
      /CHECK constraint/i,
    );
    await legacyDb.prepare("UPDATE devices SET mac_address='AA:BB:CC:DD:EE:20' WHERE id=2").run();
    assert.equal(
      (await legacyDb.prepare('SELECT device_code FROM devices WHERE id=2').first()).device_code,
      'LEGACY-TWO',
    );
    assert.equal(
      (await legacyDb.prepare('SELECT code_hash FROM activation_codes WHERE device_id=2').first()).code_hash,
      digest('legacy-code'),
    );
  } finally {
    await legacy.dispose();
  }
});

test('pareamento por MAC e código; associação só por telemetria mac exata libera leitura', async () => {
  const admin = await adminBrowser();
  const created = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: '02:11:22:33:44:55', source: 'monitorie' },
  });
  assert.equal(created.status, 201);
  const deviceId = (await created.json()).device.id;
  const code = (
    await (
      await admin.request(`/api/admin/devices/${deviceId}/generate-code`, { method: 'POST', data: {} })
    ).json()
  ).activation_code;
  const client = browser();
  await client.register('sem-id@example.test');
  const wrongMac = await client.request('/api/devices/validate-pairing', {
    method: 'POST', data: { pairing_code: code, mac_address: '02:11:22:33:44:56' },
  });
  assert.equal(wrongMac.status, 422);
  const invalidMac = await client.request('/api/devices/validate-pairing', {
    method: 'POST', data: { pairing_code: code, mac_address: '02:11:22:33:44' },
  });
  assert.equal(invalidMac.status, 422);
  const validation = await (
    await client.request('/api/devices/validate-pairing', {
      method: 'POST', data: { pairing_code: code, mac_address: '021122334455' },
    })
  ).json();
  assert.equal(validation.data.telemetry_linked, false);
  const reservoir = await connect(client, code, 'Caixa principal', '02:11:22:33:44:55');
  assert.equal(reservoir.device.telemetry_linked, false);
  const empty = await client.request(`/api/device/snapshot?reservoir_id=${reservoir.id}`);
  assert.equal(empty.status, 200);
  const emptyPayload = await empty.json();
  assert.equal(emptyPayload.data, null);
  assert.equal(emptyPayload.device.telemetry_linked, false);
  assert.deepEqual(emptyPayload.alerts, []);
  assert.equal(
    (await (await client.request(`/api/device/history?reservoir_id=${reservoir.id}`)).json()).count,
    0,
  );
  assert.equal(monitorieRequests.length, 0);

  const id = '11111111-2222-3333-4444-555555555555';
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp: seconds() + 3600 })).toString('base64url')}.sig`;
  monitorieFixture = { id, jwt, mac: null, type: 'SM-WU' };
  await configure({
    MONITORIE_MODE: 'live',
    MONITORIE_JWT: jwt,
    MONITORIE_SMWU_MAPPING: JSON.stringify({
      distancia: { key: 'd', unit: 'cm' },
      nivel: { key: 'nivel', unit: '%' },
      volume: { key: 'volume', unit: 'L' },
      rssi_wifi: { key: 'rssi_wifi', unit: 'dBm' },
    }),
    MONITORIE_SMWA_MAPPING: JSON.stringify({
      vazao: { key: 'vazao', unit: 'L/h' },
      consumo_acumulado: { key: 'consumo', unit: 'L' },
      rssi_wifi: { key: 'rssi_wifi', unit: 'dBm' },
    }),
  });
  const noManual = await admin.request(`/api/admin/devices/${deviceId}/monitorie-associate`, {
    method: 'POST', data: { external_id: id },
  });
  assert.equal(noManual.status, 404);
  const first = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal((await first.json()).status, 'scanning');
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  const noMac = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal((await noMac.json()).status, 'scanning');
  const unlinked = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal((await unlinked.json()).status, 'unlinked');
  assert.equal(
    (await db.prepare('SELECT external_id FROM devices WHERE id=?').bind(deviceId).first()).external_id,
    null,
  );
  monitorieFixture.mac = '02-11-22-33-44-55';
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, { method: 'POST', data: {} });
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, { method: 'POST', data: {} });
  const associated = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal((await associated.json()).status, 'linked');
  const second = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WA', mac_address: '02:11:22:33:44:66' },
  });
  const secondId = (await second.json()).device.id;
  monitorieFixture.mac = '02:11:22:33:44:66';
  monitorieFixture.type = 'SM-WA';
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, { method: 'POST', data: {} });
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, { method: 'POST', data: {} });
  const alreadyUsed = await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal(alreadyUsed.status, 409);
  assert.equal((await db.prepare('SELECT external_id FROM devices WHERE id=?').bind(secondId).first()).external_id, null);
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  const snapshot = await client.request(`/api/device/snapshot?reservoir_id=${reservoir.id}`);
  assert.equal(snapshot.status, 200, JSON.stringify(await snapshot.clone().json()));
  const payload = await snapshot.json();
  assert.equal(payload.device.telemetry_linked, true);
  assert.equal(payload.data.nivel, 50);
  assert.equal(monitorieRequests.length, 7);
  assert.ok(monitorieRequests[6].includes(id));
  assert.ok(!monitorieRequests[6].includes('02:11:22:33:44:55'));

  const waId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  monitorieFixture.id = waId;
  const waCode = (
    await (
      await admin.request(`/api/admin/devices/${secondId}/generate-code`, { method: 'POST', data: {} })
    ).json()
  ).activation_code;
  const waReservoir = await connect(client, waCode, 'Hidrômetro', '02:11:22:33:44:66');
  assert.equal(waReservoir.device.telemetry_linked, false);
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, { method: 'POST', data: {} });
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, { method: 'POST', data: {} });
  const waAssociated = await admin.request(`/api/admin/devices/${secondId}/monitorie-discover`, { method: 'POST', data: {} });
  assert.equal((await waAssociated.json()).status, 'linked');
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  const waSnapshot = await client.request(`/api/device/snapshot?reservoir_id=${waReservoir.id}`);
  assert.equal(waSnapshot.status, 200, JSON.stringify(await waSnapshot.clone().json()));
  const waPayload = await waSnapshot.json();
  assert.equal(waPayload.device.telemetry_linked, true);
  assert.equal(waPayload.data.vazao, 12);
  assert.equal(waPayload.data.consumo_acumulado, 345);
  assert.ok(monitorieRequests.at(-1).includes(waId));
  const correctedMac = await admin.request(`/api/admin/devices/${deviceId}/update`, {
    method: 'POST', data: { mac_address: '02:11:22:33:44:77', confirm_linked_modification: true },
  });
  assert.equal(correctedMac.status, 200);
  assert.equal((await db.prepare('SELECT external_id FROM devices WHERE id=?').bind(deviceId).first()).external_id, null);
  assert.equal((await (await client.request(`/api/device/snapshot?reservoir_id=${reservoir.id}`)).json()).device.telemetry_linked, false);
  monitorieFixture.mac = '02:11:22:33:44:77';
  monitorieFixture.type = 'SM-WA';
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, { method: 'POST', data: {} });
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, { method: 'POST', data: {} });
  const wrongModel = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {
    method: 'POST', data: {},
  });
  assert.equal((await wrongModel.json()).status, 'unlinked');
  assert.equal((await db.prepare('SELECT external_id FROM devices WHERE id=?').bind(deviceId).first()).external_id, null);
  await configure();
});

test('primeiro titular vê último estado real; transferência oculta leitura anterior ao novo vínculo', async () => {
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp: seconds() + 3600 })).toString('base64url')}.sig`;
  monitorieFixture = { id: 'external-1', jwt, readingTs: Date.now() - 3600000 };
  await configure({
    MONITORIE_MODE: 'live', MONITORIE_JWT: jwt,
    MONITORIE_SMWU_MAPPING: JSON.stringify({
      distancia: { key: 'd', unit: 'cm' }, nivel: { key: 'nivel', unit: '%' },
      volume: { key: 'volume', unit: 'L' }, rssi_wifi: { key: 'rssi_wifi', unit: 'dBm' },
    }),
  });
  const code = await provision(1, 'monitorie');
  const first = browser();
  await first.register('primeiro-titular@example.test');
  const reservoir = await connect(first, code);
  const initial = await first.request(`/api/device/snapshot?reservoir_id=${reservoir.id}`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).data.nivel, 50);

  const admin = await adminBrowser();
  const transfer = await admin.request('/api/admin/devices/1/transfer', { method: 'POST', data: {} });
  assert.equal(transfer.status, 200);
  const second = browser();
  await second.register('novo-titular@example.test');
  const next = await connect(second, (await transfer.json()).activation_code);
  await db.prepare("UPDATE settings SET value='0' WHERE key='monitorie:next-request-ms'").run();
  const afterTransfer = await second.request(`/api/device/snapshot?reservoir_id=${next.id}`);
  assert.equal(afterTransfer.status, 200);
  assert.equal((await afterTransfer.json()).data, null);
  await configure();
});

test('código de ativação puro de uso único, armazenamento apenas de hash e revogação', async () => {
  await configure({ INITIAL_ADMIN_EMAIL: 'admin-code@example.test' });
  const admin = browser();
  await admin.register('admin-code@example.test', 'Admin');
  await db.prepare("UPDATE users SET role='admin' WHERE email=?").bind('admin-code@example.test').run();

  const resDev = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: 'AA:BB:CC:DD:EE:11' },
  });
  const devId = (await resDev.json()).device.id;

  const resCode = await admin.request(`/api/admin/devices/${devId}/generate-code`, {
    method: 'POST',
    data: {},
  });
  assert.equal(resCode.status, 200);
  const codePayload = await resCode.json();
  const plainCode = codePayload.activation_code;
  assert.match(plainCode, /^HIDRA-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/);

  const codeRow = await db.prepare('SELECT * FROM activation_codes WHERE device_id=?').bind(devId).first();
  assert.ok(codeRow);
  assert.equal(codeRow.code_hash, digest(plainCode));
  assert.ok(!JSON.stringify(codeRow).includes(plainCode));

  const devRow = await db.prepare('SELECT pairing_code_hash FROM devices WHERE id=?').bind(devId).first();
  assert.equal(devRow.pairing_code_hash, digest(plainCode));

  const resRevoke = await admin.request(`/api/admin/devices/${devId}/revoke-code`, {
    method: 'POST',
    data: {},
  });
  assert.equal(resRevoke.status, 200);

  const devAfter = await db.prepare('SELECT pairing_code_hash FROM devices WHERE id=?').bind(devId).first();
  assert.equal(devAfter.pairing_code_hash, null);

  const client = browser();
  await client.register('client-rev@example.test', 'Client Rev');
  const resPair = await client.request('/api/devices/validate-pairing', {
    method: 'POST',
    data: { pairing_code: plainCode },
  });
  assert.equal(resPair.status, 422);

  await configure();
});

test('ativação pelo cliente, isolamento completo na transferência e impedimento de alteração silenciosa', async () => {
  await configure({ INITIAL_ADMIN_EMAIL: 'admin-trans@example.test' });
  const admin = browser();
  await admin.register('admin-trans@example.test', 'Admin');
  await db.prepare("UPDATE users SET role='admin' WHERE email=?").bind('admin-trans@example.test').run();

  const resDev = await admin.request('/api/admin/devices', {
    method: 'POST',
    data: { device_type: 'SM-WU', mac_address: 'AA:BB:CC:DD:EE:12', source: 'local' },
  });
  const devId = (await resDev.json()).device.id;

  const codeA = (
    await (
      await admin.request(`/api/admin/devices/${devId}/generate-code`, { method: 'POST', data: {} })
    ).json()
  ).activation_code;

  const clientA = browser();
  await clientA.register('client-a@example.test', 'Cliente A');
  const pairA = await clientA.request('/api/devices/connect', {
    method: 'POST',
    data: { pairing_code: codeA, mac_address: 'AA:BB:CC:DD:EE:12', reservoir_name: 'Reservatório Cliente A' },
  });
  assert.equal(pairA.status, 201);
  const resIdA = (await pairA.json()).data.id;

  await db
    .prepare(
      'INSERT INTO smwu_readings(id, reservoir_id, distancia, nivel, volume, rssi_wifi, created_at) VALUES (?, ?, 20, 80, 800, -60, ?)',
    )
    .bind(devId, resIdA, seconds())
    .run();

  const histA = await (await clientA.request(`/api/device/history?reservoir_id=${resIdA}`)).json();
  assert.equal(histA.data.length, 1);
  assert.equal(histA.data[0].nivel, 80);

  const resSilent = await admin.request(`/api/admin/devices/${devId}/update`, {
    method: 'POST',
    data: { mac_address: 'AA:BB:CC:DD:EE:13' },
  });
  assert.equal(resSilent.status, 422);

  const resConfirmed = await admin.request(`/api/admin/devices/${devId}/update`, {
    method: 'POST',
    data: { mac_address: 'AA:BB:CC:DD:EE:13', confirm_linked_modification: true },
  });
  assert.equal(resConfirmed.status, 200);

  const clientB = browser();
  await clientB.register('client-b@example.test', 'Cliente B');
  const pairBAttempt = await clientB.request('/api/devices/connect', {
    method: 'POST',
    data: { pairing_code: codeA, mac_address: 'AA:BB:CC:DD:EE:13', reservoir_name: 'Tentativa B' },
  });
  assert.equal(pairBAttempt.status, 422);

  const resTransfer = await admin.request(`/api/admin/devices/${devId}/transfer`, {
    method: 'POST',
    data: {},
  });
  assert.equal(resTransfer.status, 200);
  const codeB = (await resTransfer.json()).activation_code;

  const pairB = await clientB.request('/api/devices/connect', {
    method: 'POST',
    data: { pairing_code: codeB, mac_address: 'AA:BB:CC:DD:EE:13', reservoir_name: 'Novo Reservatório Cliente B' },
  });
  assert.equal(pairB.status, 201);
  const resIdB = (await pairB.json()).data.id;
  assert.notEqual(resIdA, resIdB);

  const histB = await (await clientB.request(`/api/device/history?reservoir_id=${resIdB}`)).json();
  assert.equal(histB.data.length, 0);

  const attemptSneak = await clientB.request(`/api/device/history?reservoir_id=${resIdA}`);
  assert.equal(attemptSneak.status, 404);

  const audit = await (await admin.request(`/api/admin/audit-logs?device_id=${devId}`)).json();
  const actions = audit.data.map((a) => a.action);
  assert.ok(actions.includes('device_created'));
  assert.ok(actions.includes('code_generated'));
  assert.ok(actions.includes('device_activated'));
  assert.ok(actions.includes('device_updated'));
  assert.ok(actions.includes('transfer_initiated'));
  assert.ok(actions.includes('transfer_completed'));

  await configure();
});

test('interface do cliente exibe texto de ativação fornecido pelo instalador e modelos SM-WU / SM-WA', async () => {
  const indexHtml = await readFile('web/index.html', 'utf8');
  assert.match(indexHtml, /Código de ativação fornecido pelo instalador/);
  const adminHtml = await readFile('web/admin.html', 'utf8');
  assert.match(adminHtml, /SM-WU/);
  assert.match(adminHtml, /SM-WA/);
});

test('seletor de tema (Automático, Claro, Escuro), assets compartilhados e anti-FOUC em todas as páginas', async () => {
  const themeJs = await readFile('dist/frontend/static/js/theme.js', 'utf8');
  assert.ok(themeJs.includes('hidra_theme'));
  assert.ok(themeJs.includes('prefers-color-scheme'));
  assert.ok(themeJs.includes('data-theme'));

  const themeCss = await readFile('dist/frontend/static/css/theme.css', 'utf8');
  assert.ok(themeCss.includes('[data-theme="light"]'));
  assert.ok(themeCss.includes('[data-theme="dark"]'));
  assert.ok(themeCss.includes('.theme-selector'));

  for (const page of [
    'index.html',
    'login.html',
    'register.html',
    'forgot-password.html',
    'reset-password.html',
    'admin.html',
  ]) {
    const html = await readFile(`dist/frontend/${page}`, 'utf8');
    assert.ok(html.includes('theme.css'), `${page} deve incluir theme.css`);
    assert.ok(html.includes('theme.js'), `${page} deve incluir theme.js no head`);
    assert.ok(html.includes('theme-selector'), `${page} deve incluir o seletor de tema`);
    assert.ok(html.includes('data-theme-value="auto"'), `${page} deve conter a opção auto`);
    assert.ok(html.includes('data-theme-value="light"'), `${page} deve conter a opção light`);
    assert.ok(html.includes('data-theme-value="dark"'), `${page} deve conter a opção dark`);
  }

  const indexHtml = await readFile('dist/frontend/index.html', 'utf8');
  assert.ok(indexHtml.includes('id="account-modal"'));
  assert.ok(indexHtml.includes('Aparência do sistema'));
  assert.ok(indexHtml.includes('id="configuracoes"'));
});

async function adminBrowser() {
  const client = browser();
  const user = await client.register();
  await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(user.id).run();
  return client;
}
async function credential(id, token = randomBytes(32).toString('base64url')) {
  await db
    .prepare('INSERT INTO device_credentials(device_id,token_hash,created_at,updated_at) VALUES (?,?,?,?)')
    .bind(id, digest(token), seconds(), seconds())
    .run();
  return token;
}
test('frontend origin refuses redirect loops and readiness validates exact CORS', async () => {
  await configure({ APP_URL: base });
  assert.equal((await browser().request('/')).status, 503);
  assert.equal((await browser().request('/static/js/auth.js')).status, 503);
  assert.equal((await browser().request('/api/ready')).status, 503);
  await configure();
  assert.equal((await browser().request('/api/ready')).status, 200);
  const good = await browser().request('/api/auth/csrf', { headers: { Origin: frontend } });
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), frontend);
  for (const origin of ['https://evil.test', frontend + '.evil.test', 'https://hidra-r3b.vercel.app']) {
    const res = await browser().request('/api/auth/csrf', { headers: { Origin: origin } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
});
test('ingestion WU and WA concurrency returns one insertion and correct stable reading ID', async () => {
  for (const [id, type, fields] of [
    [11, 'SM-WU', { distancia: 20, nivel: 80, volume: 800 }],
    [12, 'SM-WA', { vazao: 12, consumo_acumulado: 600, volume: null }],
  ]) {
    await provision(id);
    await db.prepare('UPDATE devices SET device_type=? WHERE id=?').bind(type, id).run();
    const token = await credential(id);
    const data = { id, device_type: type, ...fields, rssi_wifi: -50 };
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'sample-1' };
    const client = browser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.request('/api/device/ingest', { method: 'POST', data, headers }),
      ),
    );
    for (const response of results) assert.equal(response.status, 200);
    const payloads = await Promise.all(results.map((r) => r.json()));
    assert.equal(payloads.filter((p) => p.stored).length, 1);
    assert.equal(new Set(payloads.map((p) => p.reading_id)).size, 1);
    const table = type === 'SM-WA' ? 'smwa_readings' : 'smwu_readings';
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first();
    assert.equal(payloads[0].reading_id, row.reading_id);
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 1);
    const conflict = await client.request('/api/device/ingest', {
      method: 'POST',
      data: { ...data, rssi_wifi: -55 },
      headers,
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (
        await client.request('/api/device/ingest', {
          method: 'POST',
          data: { ...data, device_type: type === 'SM-WA' ? 'SM-WU' : 'SM-WA' },
          headers,
        })
      ).status,
      409,
    );
  }
});
test('credential generation rotation revocation and rate limits per device and IP', async () => {
  const admin = await adminBrowser();
  await provision(9);
  const first = await (
    await admin.request('/api/admin/devices/9/rotate-token', { method: 'POST', data: {} })
  ).json();
  const second = await (
    await admin.request('/api/admin/devices/9/rotate-token', { method: 'POST', data: {} })
  ).json();
  const stored = await db.prepare('SELECT * FROM device_credentials WHERE device_id=9').first();
  assert.equal(stored.token_hash, digest(second.device_token));
  assert.equal(stored.version, 2);
  assert.ok(!JSON.stringify(stored).includes(second.device_token));
  const data = { id: 9, distancia: 1, nivel: 1, volume: 1, rssi_wifi: -50 };
  const send = (token, ip) =>
    admin.request('/api/device/ingest', {
      method: 'POST',
      data,
      headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip },
    });
  assert.equal((await send(first.device_token, '198.51.100.200')).status, 401);
  await configure({ INGEST_DEVICE_LIMIT: '1' });
  assert.equal((await send(second.device_token, '198.51.100.201')).status, 200);
  assert.equal((await send(second.device_token, '198.51.100.202')).status, 429);
  await admin.request('/api/admin/devices/9/revoke-token', { method: 'POST', data: {} });
  assert.equal((await send(second.device_token, '198.51.100.203')).status, 401);
  await configure();
  const invalid = browser();
  let last;
  for (let i = 0; i < 121; i++) last = await invalid.request('/api/device/ingest', { method: 'POST', data });
  assert.equal(last.status, 429);
});
test('deterministic fallback deduplication and source conflicts', async () => {
  await provision(4);
  const token = await credential(4);
  const client = browser();
  const headers = { Authorization: `Bearer ${token}` },
    data = { id: 4, distancia: 1, nivel: 2, volume: 3, rssi_wifi: -50 };
  const a = await (await client.request('/api/device/ingest', { method: 'POST', data, headers })).json();
  const b = await (
    await client.request('/api/device/ingest', {
      method: 'POST',
      data: { rssi_wifi: -50, volume: 3, nivel: 2, distancia: 1, id: 4 },
      headers,
    })
  ).json();
  assert.equal(a.stored, true);
  assert.equal(b.stored, false);
  assert.equal(a.reading_id, b.reading_id);
  await db.prepare("UPDATE devices SET source='monitorie' WHERE id=4").run();
  assert.equal((await client.request('/api/device/ingest', { method: 'POST', data, headers })).status, 409);
});
test('30 days downsampling represents the entire window for both models with metadata', async () => {
  const client = browser();
  await client.register();
  for (const [id, type] of [
    [31, 'SM-WU'],
    [32, 'SM-WA'],
  ]) {
    const reservoir = await connect(client, await provision(id));
    await db.prepare('UPDATE devices SET device_type=? WHERE id=?').bind(type, id).run();
    const start = seconds() - 30 * 86400;
    await db.prepare('UPDATE reservoirs SET linked_at=? WHERE id=?').bind(start, reservoir.id).run();
    const table = type === 'SM-WU' ? 'smwu_readings' : 'smwa_readings';
    const fields = type === 'SM-WU' ? 'distancia,nivel,volume' : 'vazao,consumo_acumulado,volume';
    await db.batch(
      Array.from({ length: 60 }, (_, i) =>
        db
          .prepare(
            `INSERT INTO ${table}(id,reservoir_id,${fields},rssi_wifi,created_at) VALUES (?,?,1,2,3,-50,?)`,
          )
          .bind(id, reservoir.id, start + i * 12 * 3600 + 10),
      ),
    );
    const payload = await (
      await client.request(`/api/device/history?reservoir_id=${reservoir.id}&hours=720&limit=10`)
    ).json();
    assert.equal(payload.meta.truncated, false);
    assert.equal(payload.meta.total_readings, 60);
    assert.equal(payload.meta.aggregation, 'mean');
    assert.ok(payload.data.length <= 10);
    assert.ok(Date.parse(payload.data[0].timestamp) < (start + 86400) * 1000);
    assert.ok(Date.parse(payload.data.at(-1).timestamp) > (start + 26 * 86400) * 1000);
    assert.equal(
      payload.data.reduce((sum, row) => sum + row.sample_count, 0),
      60,
    );
  }
});
test('capacity authorization validation and atomic audit rollback', async () => {
  const a = browser(),
    b = browser();
  await a.register();
  await b.register();
  const reservoir = await connect(a, await provision());
  assert.equal(
    (
      await b.request('/api/reservoirs/capacity', {
        method: 'POST',
        data: { reservoir_id: reservoir.id, capacity_liters: 100 },
      })
    ).status,
    404,
  );
  for (const value of [-1, 0, '100', 1e13])
    assert.equal(
      (
        await a.request('/api/reservoirs/capacity', {
          method: 'POST',
          data: { reservoir_id: reservoir.id, capacity_liters: value },
        })
      ).status,
      422,
    );
  assert.equal(
    (
      await a.request('/api/reservoirs/capacity', {
        method: 'POST',
        data: { reservoir_id: reservoir.id, capacity_liters: 1000 },
      })
    ).status,
    200,
  );
  await db.exec(
    "CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='capacity_updated' BEGIN SELECT RAISE(ABORT,'test'); END",
  );
  assert.equal(
    (
      await a.request('/api/reservoirs/capacity', {
        method: 'POST',
        data: { reservoir_id: reservoir.id, capacity_liters: 2000 },
      })
    ).status,
    503,
  );
  assert.equal(
    (await db.prepare('SELECT capacity_liters FROM reservoirs WHERE id=?').bind(reservoir.id).first())
      .capacity_liters,
    1000,
  );
});
test('creation uniqueness, active code uniqueness and immutable audit under concurrency', async () => {
  const admin = await adminBrowser();
  const data = { device_type: 'SM-WU', mac_address: 'AA:BB:CC:DD:EE:31', source: 'local' };
  const results = await Promise.all([
    admin.request('/api/admin/devices', { method: 'POST', data }),
    admin.request('/api/admin/devices', { method: 'POST', data }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const device = await db.prepare("SELECT id FROM devices WHERE mac_address='AA:BB:CC:DD:EE:31'").first();
  const codes = await Promise.all(
    Array.from({ length: 4 }, () =>
      admin.request(`/api/admin/devices/${device.id}/generate-code`, { method: 'POST', data: {} }),
    ),
  );
  codes.forEach((r) => assert.equal(r.status, 200));
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM activation_codes WHERE used_at IS NULL AND revoked_at IS NULL')
        .first()
    ).n,
    1,
  );
  await assert.rejects(db.prepare("UPDATE audit_logs SET action='forged'").run(), /AUDIT_IMMUTABLE/);
  await assert.rejects(db.prepare('DELETE FROM audit_logs').run(), /AUDIT_IMMUTABLE/);
});
test('device creation rolls back when the audit insertion fails', async () => {
  const admin = await adminBrowser();
  await db.exec(
    "CREATE TRIGGER test_failure BEFORE INSERT ON audit_logs WHEN NEW.action='device_created' BEGIN SELECT RAISE(ABORT,'test'); END",
  );
  assert.equal(
    (
      await admin.request('/api/admin/devices', {
        method: 'POST',
        data: { device_type: 'SM-WU', mac_address: 'AA:BB:CC:DD:EE:32', source: 'local' },
      })
    ).status,
    503,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM devices WHERE mac_address='AA:BB:CC:DD:EE:32'").first()).n,
    0,
  );
});
test('account erasure cascades both models and revokes device credentials', async () => {
  const client = browser();
  const user = await client.register();
  for (const id of [41, 42]) {
    const reservoir = await connect(client, await provision(id));
    await credential(id);
    const table = id === 41 ? 'smwu_readings' : 'smwa_readings';
    const fields = id === 41 ? 'distancia,nivel,volume' : 'vazao,consumo_acumulado,volume';
    await db
      .prepare(
        `INSERT INTO ${table}(id,reservoir_id,${fields},rssi_wifi,created_at) VALUES (?,?,1,2,3,-50,?)`,
      )
      .bind(id, reservoir.id, seconds())
      .run();
  }
  assert.equal(
    (await client.request('/api/auth/delete-account', { method: 'POST', data: { confirmation: true } }))
      .status,
    200,
  );
  for (const table of ['users', 'reservoirs', 'smwu_readings', 'smwa_readings'])
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM device_credentials WHERE revoked_at IS NULL').first()).n,
    0,
  );
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='account_deleted' AND user_id=?")
        .bind(user.id)
        .first()
    ).n,
    1,
  );
});
test('retention deletes bounded batches for both models', async () => {
  await provision();
  const old = seconds() - 100 * 86400;
  for (const [table, fields] of [
    ['smwu_readings', 'distancia,nivel,volume'],
    ['smwa_readings', 'vazao,consumo_acumulado,volume'],
  ]) {
    await db.batch(
      Array.from({ length: 5 }, () =>
        db
          .prepare(`INSERT INTO ${table}(id,${fields},rssi_wifi,created_at) VALUES (1,1,2,3,-50,?)`)
          .bind(old),
      ),
    );
  }
  await configure({ READINGS_RETENTION_DAYS: '90', RETENTION_BATCH_SIZE: '2' });
  await browser().init();
  await waitFor(async () => (await db.prepare('SELECT COUNT(*) n FROM smwu_readings').first()).n === 3);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM smwa_readings').first()).n, 3);
});
test('Basic sharing bounds headers, rate limits and never reveals which credential matched', async () => {
  const owner = browser();
  await owner.register('basic@example.test');
  await configure({
    DASHBOARD_SHARE_USERNAME: 'viewer',
    DASHBOARD_SHARE_PASSWORD: 'fake-password',
    DASHBOARD_SHARE_USER_EMAIL: 'basic@example.test',
  });
  const client = browser();
  for (const value of ['viewer:wrong', 'wrong:fake-password', ':', 'x'.repeat(2049)]) {
    const response = await client.request('/', {
      headers: {
        Authorization: value.length > 2048 ? value : 'Basic ' + Buffer.from(value).toString('base64'),
      },
    });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'Acesso restrito.');
  }
  let last;
  for (let i = 0; i < 31; i++) last = await client.request('/');
  assert.equal(last.status, 429);
});
test('request ID is generated server-side and attached on success and errors', async () => {
  for (const path of ['/api/health', '/missing']) {
    const response = await browser().request(path, { headers: { 'X-Request-ID': 'untrusted' } });
    assert.match(response.headers.get('X-Request-ID'), /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});
