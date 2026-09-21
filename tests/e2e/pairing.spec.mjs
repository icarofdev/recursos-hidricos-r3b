import { test, expect } from '@playwright/test';
import { createPairingCodeForDevice } from './helpers.mjs';

test.describe('Fluxo de Pareamento de Dispositivo', () => {
  test('deve conectar um dispositivo utilizando código de ativação válido', async ({ page }) => {
    const unique = Date.now();
    const email = `pairing_${unique}@example.test`;
    const password = 'Senha-Segura-E2E-12345';
    const deviceCode = `PAIR-${unique}`;

    // 1. Cadastrar usuário
    await page.goto('/cadastro');
    await page.fill('input[name="name"]', 'Usuário Pareamento');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="password_confirmation"]', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/(?:#.*)?$/);

    // 2. Criar código de pareamento válido
    const { code } = await createPairingCodeForDevice(deviceCode, 'SM-WU');

    // 3. Abrir modal de conexão (botão na tela inicial ou topbar)
    const connectButton = page.locator('#connect-first-device, #connect-device-top').first();
    await connectButton.click();
    await expect(page.locator('#pairing-modal')).toBeVisible();

    // 4. Preencher código de ativação
    await page.fill('#pairing-code', code);
    await page.click('#pairing-code-form button[type="submit"]');

    // 5. Confirmar etapa de nomeação do reservatório
    await expect(page.locator('#pairing-step-confirm')).toBeVisible();
    await page.fill('#pairing-reservoir-name', 'Caixa D’Água Principal');
    await page.click('#pairing-confirm-form button[type="submit"]');

    // 6. Verificar que o reservatório foi conectado com sucesso
    await expect(page.locator('#pairing-modal')).toBeHidden();
    await expect(page.locator('#topbar-reservoir-name')).toHaveText('Caixa D’Água Principal');
    await expect(page.locator('#dashboard-content')).toBeVisible();
  });
});
