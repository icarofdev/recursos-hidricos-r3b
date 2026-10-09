import { test, expect } from '@playwright/test';
import { createPairingCodeForDevice } from './helpers.mjs';

test.describe('Dashboard e Visualização de Telemetria', () => {
  test('deve exibir métricas, alternar temas e salvar capacidade do reservatório', async ({ page }) => {
    const unique = Date.now();
    const email = `dash_${unique}@example.test`;
    const password = 'Senha-Segura-E2E-12345';
    const deviceCode = `DASH-${unique}`;

    // Cadastrar usuário
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/cadastro');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.fill('input[name="name"]', 'Usuário Dashboard');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="password_confirmation"]', password);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-success-message]')).toContainText('Entre para continuar');
    await page.goto('/login');
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
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
    await expect(page.locator('#consumption-reading')).toBeVisible();
    await expect(page.locator('#flow-reading')).toBeVisible();
    await expect(page.locator('#chart-stage')).toBeVisible();

    // Testar seletor de tema (Auto, Claro, Escuro)
    await page.click('.nav-link[href="/configuracoes"]');
    await expect(page.locator('#screen-configuracoes')).toBeVisible();
    const darkThemeButton = page.locator('.theme-selector button[data-theme-value="dark"]').first();
    await darkThemeButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const lightThemeButton = page.locator('.theme-selector button[data-theme-value="light"]').first();
    await lightThemeButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Testar atualização da capacidade do reservatório
    await page.click('.nav-link[href="/reservatorios"]');
    await expect(page).toHaveURL(/\/reservatorios$/);
    await page.fill('#capacity-input', '5000');
    await page.click('#capacity-form button[type="submit"]');
    await expect(page.locator('#capacity-feedback')).toHaveText('Capacidade salva.');
    await expect(page.locator('#capacity-reading')).toContainText('5.000');
    await page.click('.nav-link[href="/dispositivos"]');
    await expect(page.locator('#members-feedback')).toContainText('1 de 5');
    await expect(page.locator('#geometry-form')).toBeHidden();
    await page.reload();
    await expect(page.locator('#members-list')).toContainText('Proprietário');
    await page.click('.nav-link[href="/historico"]');
    await expect(page.locator('#screen-historico')).toBeVisible();
    await expect(page.locator('#dispositivos')).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/dispositivos$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/historico$/);
    await page.click('.nav-link[href="/configuracoes"]');
    await expect(page.locator('#screen-configuracoes')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.screenshot({ path: '.runtime/release/settings-light.png', fullPage: true });
    await page.click('.nav-link[href="/"]');
    await page.screenshot({ path: '.runtime/release/dashboard-light.png', fullPage: true });
    await page.click('.nav-link[href="/configuracoes"]');
    await darkThemeButton.click();
    await page.click('.nav-link[href="/"]');
    await page.screenshot({ path: '.runtime/release/dashboard-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: '.runtime/release/dashboard-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
    ).toBeTruthy();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.screenshot({
      path: '.runtime/release/dashboard-mobile-320.png',
      fullPage: true,
      animations: 'disabled',
    });
    const overflow = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('main *')]
        .filter((node) => node.getBoundingClientRect().right > globalThis.innerWidth + 1)
        .map((node) => ({
          tag: node.tagName,
          id: node.id,
          class: node.className,
          right: node.getBoundingClientRect().right,
        }))
        .slice(0, 20),
    );
    expect(overflow).toEqual([]);
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
    ).toBeTruthy();
    await page.click('#menu-button');
    await expect(page.locator('#menu-button')).toHaveAttribute('aria-expanded', 'true');
    await page.click('.nav-link[href="/reservatorios"]');
    await expect(page.locator('#menu-button')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#geometry-form')).toBeVisible();
    await page.route('**/api/reservoirs', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'API indisponível no teste' },
        }),
      }),
    );
    await page.reload();
    await expect(page.locator('#welcome-title')).toHaveText('Não foi possível carregar sua conta');
    await expect(page.locator('#dashboard-content')).toBeHidden();
    await page.unroute('**/api/reservoirs');
    await page.reload();
    await expect(page.locator('#geometry-form')).toBeVisible();
  });
});
