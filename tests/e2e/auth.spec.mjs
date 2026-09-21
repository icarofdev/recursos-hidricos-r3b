import { test, expect } from '@playwright/test';

test.describe('Autenticação de Usuários', () => {
  const unique = Date.now();
  const testUser = {
    name: 'Usuário E2E',
    email: `e2e_${unique}@example.test`,
    password: 'Senha-Segura-E2E-12345',
  };

  test('deve registrar um novo usuário e redirecionar para a dashboard', async ({ page }) => {
    await page.goto('/cadastro');
    await expect(page).toHaveTitle(/Criar conta/);

    await page.fill('input[name="name"]', testUser.name);
    await page.fill('input[name="email"]', testUser.email);
    await page.fill('input[name="password"]', testUser.password);
    await page.fill('input[name="password_confirmation"]', testUser.password);

    await page.click('button[type="submit"]');

    // Após registro com sucesso, é redirecionado para a dashboard (/)
    await expect(page).toHaveURL(/\/(?:#.*)?$/);
    await expect(page.locator('#topbar-reservoir-name')).toBeVisible();
  });

  test('deve realizar logout e depois login com sucesso', async ({ page }) => {
    // Fazer login com o usuário criado
    await page.goto('/login');
    await expect(page).toHaveTitle(/Entrar/);

    await page.fill('input[name="email"]', testUser.email);
    await page.fill('input[name="password"]', testUser.password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/(?:#.*)?$/);

    // Abrir menu da conta e clicar em Sair
    await page.click('#account-trigger');
    await expect(page.locator('#account-dropdown')).toBeVisible();
    await page.click('#logout-button');

    // Deve redirecionar para /login
    await expect(page).toHaveURL(/\/login/);
  });
});
