import { test, expect } from '@playwright/test';
import { promoteUserToAdmin } from './helpers.mjs';

test.describe('Painel Administrativo', () => {
  test('deve permitir cadastro de dispositivos e geração de código de ativação', async ({ page }) => {
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
    await expect(page).toHaveURL(/\/(?:#.*)?$/);

    // 2. Promover usuário a admin no banco de dados local
    await promoteUserToAdmin(email);

    // 3. Acessar o painel administrativo (/admin)
    await page.goto('/admin');
    await expect(page).toHaveTitle(/Painel Administrativo/);
    await expect(page.locator('#admin-content')).toBeVisible();

    // 4. Cadastrar um novo dispositivo SM-WA
    await page.selectOption('#device-type', 'SM-WA');
    await page.fill('#device-mac', newDeviceMac);
    await page.selectOption('#device-source', 'monitorie');
    await page.click('#btn-create-device');

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
