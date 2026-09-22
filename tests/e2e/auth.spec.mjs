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

  test('deve atualizar o checklist de requisitos de senha em tempo real no cadastro', async ({ page }) => {
    await page.goto('/cadastro');

    const lengthRule = page.locator('.password-checklist .checklist-item[data-rule="length"]');
    const uppercaseRule = page.locator('.password-checklist .checklist-item[data-rule="uppercase"]');
    const lowercaseRule = page.locator('.password-checklist .checklist-item[data-rule="lowercase"]');
    const numberRule = page.locator('.password-checklist .checklist-item[data-rule="number"]');
    const specialRule = page.locator('.password-checklist .checklist-item[data-rule="special"]');

    // Inicialmente, nenhuma regra cumprida
    await expect(lengthRule).not.toHaveClass(/is-valid/);
    await expect(uppercaseRule).not.toHaveClass(/is-valid/);
    await expect(lowercaseRule).not.toHaveClass(/is-valid/);
    await expect(numberRule).not.toHaveClass(/is-valid/);
    await expect(specialRule).not.toHaveClass(/is-valid/);

    const passwordInput = page.locator('input[name="password"]');

    // Digita apenas minúscula 'abc'
    await passwordInput.fill('abc');
    await expect(lowercaseRule).toHaveClass(/is-valid/);
    await expect(uppercaseRule).not.toHaveClass(/is-valid/);
    await expect(numberRule).not.toHaveClass(/is-valid/);
    await expect(specialRule).not.toHaveClass(/is-valid/);
    await expect(lengthRule).not.toHaveClass(/is-valid/);

    // Adiciona maiúscula 'abcA'
    await passwordInput.fill('abcA');
    await expect(uppercaseRule).toHaveClass(/is-valid/);

    // Adiciona número 'abcA1'
    await passwordInput.fill('abcA1');
    await expect(numberRule).toHaveClass(/is-valid/);

    // Adiciona caractere especial 'abcA1!'
    await passwordInput.fill('abcA1!');
    await expect(specialRule).toHaveClass(/is-valid/);
    await expect(lengthRule).not.toHaveClass(/is-valid/); // 6 chars ainda

    // Completa 8 caracteres 'abcA1!xy'
    await passwordInput.fill('abcA1!xy');
    await expect(lengthRule).toHaveClass(/is-valid/);
    await expect(uppercaseRule).toHaveClass(/is-valid/);
    await expect(lowercaseRule).toHaveClass(/is-valid/);
    await expect(numberRule).toHaveClass(/is-valid/);
    await expect(specialRule).toHaveClass(/is-valid/);
  });

  test('deve alternar a visibilidade da senha ao clicar no botão de olho', async ({ page }) => {
    await page.goto('/cadastro');

    const passwordInput = page.locator('input[name="password"]');
    const toggleBtn = page.locator('.password-toggle-btn').first();

    await expect(passwordInput).toHaveAttribute('type', 'password');
    await expect(toggleBtn).toHaveAttribute('aria-label', 'Mostrar senha');

    // Clicar para mostrar a senha
    await toggleBtn.click();
    await expect(passwordInput).toHaveAttribute('type', 'text');
    await expect(toggleBtn).toHaveAttribute('aria-label', 'Ocultar senha');
    await expect(toggleBtn).toHaveClass(/is-visible/);

    // Clicar novamente para ocultar a senha
    await toggleBtn.click();
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await expect(toggleBtn).toHaveAttribute('aria-label', 'Mostrar senha');
    await expect(toggleBtn).not.toHaveClass(/is-visible/);
  });
});
