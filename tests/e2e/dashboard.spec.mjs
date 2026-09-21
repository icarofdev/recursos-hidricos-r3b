import { test, expect } from '@playwright/test';
import { createPairingCodeForDevice } from './helpers.mjs';

test.describe('Dashboard e Visualização de Telemetria', () => {
  test('deve exibir métricas, alternar temas e salvar capacidade do reservatório', async ({ page }) => {
    const unique = Date.now();
    const email = `dash_${unique}@example.test`;
    const password = 'Senha-Segura-E2E-12345';
    const deviceCode = `DASH-${unique}`;

    // Cadastrar usuário
    await page.goto('/cadastro');
    await page.fill('input[name="name"]', 'Usuário Dashboard');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="password_confirmation"]', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/(?:#.*)?$/);

    // Conectar dispositivo
    const { code } = await createPairingCodeForDevice(deviceCode, 'SM-WU');
    const connectButton = page.locator('#connect-first-device, #connect-device-top').first();
    await connectButton.click();
    await page.fill('#pairing-code', code);
    await page.click('#pairing-code-form button[type="submit"]');
    await expect(page.locator('#pairing-step-confirm')).toBeVisible();
    await page.fill('#pairing-reservoir-name', 'Reservatório Monitorado');
    await page.click('#pairing-confirm-form button[type="submit"]');
    await expect(page.locator('#pairing-modal')).toBeHidden();

    // Verificar exibição dos KPIs e painéis
    await expect(page.locator('#dashboard-content')).toBeVisible();
    await expect(page.locator('#ppl-reading')).toBeVisible();
    await expect(page.locator('#consumption-metric')).toBeVisible();
    await expect(page.locator('#chart-stage')).toBeVisible();

    // Testar seletor de tema (Auto, Claro, Escuro)
    const darkThemeButton = page.locator('.theme-selector button[data-theme-value="dark"]').first();
    await darkThemeButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const lightThemeButton = page.locator('.theme-selector button[data-theme-value="light"]').first();
    await lightThemeButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Testar atualização da capacidade do reservatório
    await page.fill('#capacity-input', '5000');
    await page.click('#capacity-form button[type="submit"]');
    await expect(page.locator('#capacity-feedback')).toHaveText('Capacidade salva.');
    await expect(page.locator('#capacity-reading')).toContainText('5.000');
  });
});
