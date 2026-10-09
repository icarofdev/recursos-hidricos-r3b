import { test, expect } from '@playwright/test';
import { expireAdminMfaForTest, promoteUserToAdmin } from './helpers.mjs';
import { createHmac } from 'node:crypto';

function totpCode(secret) {
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
  counter.writeUInt32BE(Math.floor(Date.now() / 30000), 4);
  const hash = createHmac('sha1', Buffer.from(decoded)).update(counter).digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test.describe('Painel Administrativo', () => {
  test('deve permitir cadastro de dispositivos e geração de código de ativação', async ({ page }) => {
    test.setTimeout(90_000);
    const unique = Date.now();
    const email = `admin_${unique}@example.test`;
    const password = 'Senha-Segura-E2E-12345';
    const newDeviceMac = `02:00:${[(unique >>> 24) & 255, (unique >>> 16) & 255, (unique >>> 8) & 255, unique & 255].map((n) => n.toString(16).padStart(2, '0')).join(':')}`;

    // 1. Cadastrar usuário
    await page.goto('/cadastro');
    await page.fill('input[name="name"]', 'Administrador E2E');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="password_confirmation"]', password);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-success-message]')).toContainText('Entre para continuar');

    // 2. Promover usuário a admin no banco de dados local
    await promoteUserToAdmin(email);

    // 3. Cadastrar o autenticador antes de acessar o painel administrativo.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await expect(page.locator('#totp-setup-panel')).toBeVisible();
    await expect(page.locator('#totp-secret')).not.toBeEmpty();
    await expect(page.locator('#totp-setup-loading')).toBeHidden();
    const secret = await page.locator('#totp-secret').innerText();
    await expect(page.locator('#totp-qr')).toBeVisible();
    await page.fill('#totp-confirm-form input[name="code"]', totpCode(secret));
    await page.click('#totp-confirm-form button[type="submit"]');
    await expect(page.locator('#totp-codes-panel')).toBeVisible();
    await expect(page.locator('#totp-codes li')).toHaveCount(10);
    // Evita incluir códigos de recuperação em snapshots de falhas posteriores.
    await page.locator('#totp-codes').evaluate((list) => list.replaceChildren());
    await page.locator('#totp-continue').click({ noWaitAfter: true });
    await expect(page).toHaveTitle(/Painel Administrativo/);
    await expect(page.locator('#admin-content')).toBeVisible();

    // 4. Uma sessão antiga exige TOTP recente e retoma a ação após confirmação.
    await expireAdminMfaForTest(email);
    await page.selectOption('#device-type', 'SM-WA');
    await page.fill('#device-mac', newDeviceMac);
    await page.selectOption('#device-source', 'monitorie');
    await page.click('#btn-create-device');
    await expect(page.locator('#admin-reauth-modal')).toBeVisible();
    await page.fill('#admin-reauth-code', '000000');
    await page.click('#admin-reauth-form button[type="submit"]');
    await expect(page.locator('#admin-reauth-error')).toContainText('inválido');
    await page.fill('#admin-reauth-code', totpCode(secret));
    await page.click('#admin-reauth-form button[type="submit"]');
    await expect(page.locator('#admin-reauth-modal')).toBeHidden();

    // 5. Verificar feedback de sucesso e presença na tabela
    await expect(page.locator('#create-feedback')).toContainText('com sucesso');
    const deviceRow = page.locator('#devices-table-body tr', { hasText: newDeviceMac.toUpperCase() });
    await expect(deviceRow).toBeVisible();

    // 6. Gerar código de ativação para o dispositivo recém-criado
    const generateCodeButton = deviceRow.locator('button[data-action="generateCode"]');
    await generateCodeButton.click();

    // 7. Verificar que o modal do código de ativação foi exibido
    await expect(page.locator('#code-modal')).toBeVisible();
    await expect(page.locator('#display-activation-code')).toContainText('HIDRA-');
    const activationCode = await page.locator('#display-activation-code').innerText();

    // O equipamento sem vínculo de telemetria continua pareável pelo MAC e código.
    await page.goto('/');
    await page.locator('#connect-first-device, #connect-device-top').first().click();
    await page.fill('#pairing-code', activationCode);
    await page.fill('#pairing-mac', newDeviceMac);
    await page.click('#pairing-code-form button[type="submit"]');
    await expect(page.locator('#pairing-device-status')).toHaveText('Telemetria não vinculada à MonitorIE');
    await page.fill('#pairing-reservoir-name', 'Hidrômetro pendente');
    await page.click('#pairing-confirm-form button[type="submit"]');
    await expect(page.locator('#system-status-title')).toHaveText('Telemetria não vinculada');
  });
});
