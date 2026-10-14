import './build.mjs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { localRuntime } from './local-runtime.mjs';
import { frontendServer } from './dev-frontend.mjs';
import { createHmac } from 'node:crypto';

const mac = process.argv[2];
const model = process.argv[3];
if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac || '') || !['SM-WU', 'SM-WA'].includes(model)) {
  console.error('Uso: node scripts/cloudflare/monitorie-live-smoke.mjs AA:BB:CC:DD:EE:FF SM-WU|SM-WA');
  process.exit(2);
}

const origin = 'http://127.0.0.1:8788';
const password = 'Smoke-Local-42!Hydra';
let runtime, frontend, browser;

function authenticatorCode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    decoded = [];
  let bits = 0,
    value = 0;
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 30000), 4);
  const hash = createHmac('sha1', Buffer.from(decoded)).update(counter).digest(),
    offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function client(mf) {
  let cookie = '',
    csrf = '',
    adminSecret = '';
  return {
    async request(path, data, reauthenticated = false) {
      const response = await mf.dispatchFetch(`http://127.0.0.1:8787${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          Cookie: cookie,
          'CF-Connecting-IP': '127.0.0.1',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      for (const item of response.headers.getSetCookie()) cookie = item.split(';')[0];
      const payload = await response.json();
      if (payload.csrf_token) csrf = payload.csrf_token;
      if (
        !response.ok &&
        path.startsWith('/api/admin/') &&
        payload.error?.code === 'ADMIN_REAUTH_REQUIRED' &&
        adminSecret &&
        !reauthenticated
      ) {
        await this.request('/api/auth/admin-totp/reauth', { code: authenticatorCode(adminSecret) });
        return this.request(path, data, true);
      }
      if (!response.ok) throw new Error(`${path}: ${response.status} ${payload.error?.code || 'UNKNOWN'}`);
      return payload;
    },
    async register(email) {
      await this.request('/api/auth/csrf');
      await this.request('/api/auth/register', {
        name: 'Teste local MonitorIE',
        email,
        password,
        password_confirmation: password,
      });
    },
    async enrollAdmin(email) {
      const login = await this.request('/api/auth/login', { email, password });
      assert.equal(login.stage, 'totp_setup');
      const setup = await this.request('/api/auth/admin-totp/setup', { challenge: login.challenge });
      adminSecret = setup.secret;
      await this.request('/api/auth/admin-totp/confirm', {
        challenge: login.challenge,
        code: authenticatorCode(adminSecret),
      });
    },
  };
}

async function waitForProvider(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key='monitorie:next-request-ms'").first();
  const delay = Math.max(0, Number(row?.value || 0) - Date.now() + 2000);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}

try {
  const { mf, db } = await localRuntime({ port: 8787, ephemeral: true, monitorie: true });
  runtime = mf;
  await mf.ready;
  frontend = await frontendServer();
  const admin = client(mf);
  const customer = client(mf);
  const adminEmail = `smoke-admin-${Date.now()}@example.test`;
  const customerEmail = `smoke-client-${Date.now()}@example.test`;
  await admin.register(adminEmail);
  // Synthetic fixture in this hard-coded ephemeral LOCAL DB only. No mailbox
  // attestation or promotion of an existing production account is performed.
  await db
    .prepare(
      "UPDATE users SET email_verified_at=unixepoch() WHERE email=? AND email LIKE 'smoke-admin-%@example.test'",
    )
    .bind(adminEmail)
    .run();
  await db
    .prepare("UPDATE users SET role='admin' WHERE email=? AND email_verified_at IS NOT NULL")
    .bind(adminEmail)
    .run();
  await admin.enrollAdmin(adminEmail);

  const created = await admin.request('/api/admin/devices', {
    device_type: model,
    mac_address: mac,
    source: 'monitorie',
  });
  const deviceId = created.device.id;
  const generated = await admin.request(`/api/admin/devices/${deviceId}/generate-code`, {});
  await customer.register(customerEmail);
  await customer.request('/api/devices/validate-pairing', {
    pairing_code: generated.activation_code,
    mac_address: mac,
  });
  const connected = await customer.request('/api/devices/connect', {
    pairing_code: generated.activation_code,
    mac_address: mac,
    reservoir_name: `Teste ${model} real`,
  });
  const reservoirId = connected.data.id;
  const before = await customer.request(`/api/device/snapshot?reservoir_id=${reservoirId}`);
  if (before.device.telemetry_linked || before.data !== null) throw new Error('Estado inicial inesperado.');
  console.log('Cadastro e pareamento local por MAC: OK; telemetria inicial não vinculada.');

  let discovery;
  for (let step = 0; step < 101; step++) {
    discovery = await admin.request(`/api/admin/devices/${deviceId}/monitorie-discover`, {});
    if (discovery.status !== 'scanning') break;
    console.log(`Descoberta: etapa ${step + 1}, ${discovery.checked} dispositivo(s) verificado(s).`);
    await waitForProvider(db);
  }
  if (discovery?.status !== 'linked') {
    console.log(JSON.stringify({ status: discovery?.status, reason: discovery?.reason }));
    process.exitCode = 1;
  } else {
    console.log('MAC idêntico e modelo correspondente confirmados em toda a lista.');
    await waitForProvider(db);
    const snapshot = await customer.request(`/api/device/snapshot?reservoir_id=${reservoirId}`);
    if (!snapshot.device.telemetry_linked || !snapshot.data)
      throw new Error('Snapshot real indisponível após associação.');

    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage();
    await page.goto(`${origin}/login`);
    await page.fill('input[name="email"]', customerEmail);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(origin + '/', { timeout: 15000 });
    await page.waitForFunction(
      () => {
        const value = globalThis.document.querySelector('#consumption-metric')?.textContent?.trim();
        return value && value !== '—';
      },
      null,
      { timeout: 15000 },
    );
    if (model === 'SM-WA') {
      assert.equal(await page.locator('#reservoir-title').innerText(), 'Leitura do hidrômetro');
      assert.equal(await page.locator('#chart-title').innerText(), 'Histórico do hidrômetro');
      assert.equal(await page.locator('#tank-area').isVisible(), false);
      assert.equal(await page.locator('#capacity-form').isVisible(), false);
      assert.equal(await page.locator('#primary-chart-tab-label').innerText(), 'Acumulado');
      assert.equal((await page.locator('#reservoir-select-label').textContent()).trim(), 'Equipamento');
      assert.equal((await page.locator('#rename-reservoir').textContent()).trim(), 'Renomear equipamento');
      assert.equal(await page.locator('#daily-consumption-context').innerText(), 'Volume não informado');
      assert.equal(
        await page.locator('#consumption-metric').innerText(),
        new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(snapshot.data.consumo_acumulado),
      );
    }
    const dashboard = {
      consumption: await page.locator('#consumption-metric').innerText(),
      flow: await page.locator('#flow-metric').innerText(),
      status: await page.locator('#system-status-title').innerText(),
    };
    await page.screenshot({ path: '.runtime/local/monitorie-live-smoke.png', fullPage: true });
    console.log(
      JSON.stringify(
        {
          telemetry_linked: snapshot.device.telemetry_linked,
          has_reading: !!snapshot.data,
          has_dashboard_values: !!dashboard.consumption,
          screenshot: '.runtime/local/monitorie-live-smoke.png',
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(`Teste real falhou: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => frontend?.close(resolve) ?? resolve());
  await runtime?.dispose();
}
