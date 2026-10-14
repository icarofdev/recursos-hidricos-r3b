import { test, expect } from '@playwright/test';
/* global document, innerWidth */

test('confirmation removes the link token, requires the same session and works on mobile', async ({
  page,
}) => {
  let confirmed = false;
  await page.route('http://127.0.0.1:18887/api/auth/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Origin': 'http://127.0.0.1:18888',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/api/auth/me')
      return route.fulfill({
        json: { user: { email_verified: false }, csrf_token: 'synthetic-csrf', read_only: false },
        headers,
      });
    if (path === '/api/auth/verify-email') {
      expect(request.headers()['x-csrf-token']).toBe('synthetic-csrf');
      expect(typeof request.postDataJSON().token).toBe('string');
      confirmed = true;
      return route.fulfill({ json: { success: true, message: 'E-mail confirmado.' }, headers });
    }
    throw new Error('Unexpected API request in email UI test');
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/confirmar-email?token=' + encodeURIComponent('A'.repeat(43)));
  await expect(page).toHaveURL(/\/confirmar-email$/);
  await expect(page.locator('#verify-email-form')).toBeVisible();
  await expect(page.locator('#verification-login')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#verify-email-form button').click();
  await expect(page.locator('#email-proof-feedback')).toHaveText('E-mail confirmado.');
  await expect(page.locator('#verify-email-form')).toBeHidden();
  expect(confirmed).toBe(true);
});

test('confirmation requires login and keeps the next path within this site', async ({ page }) => {
  await page.route('http://127.0.0.1:18887/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'AUTHENTICATION_REQUIRED' } },
      headers: {
        'Access-Control-Allow-Origin': 'http://127.0.0.1:18888',
        'Access-Control-Allow-Credentials': 'true',
      },
    }),
  );
  await page.goto('/confirmar-email?token=' + encodeURIComponent('B'.repeat(43)));
  await expect(page).toHaveURL(/\/confirmar-email$/);
  await expect(page.locator('#verification-login')).toHaveAttribute(
    'href',
    /^\/login\?next=%2Fconfirmar-email/,
  );
  await expect(page.locator('#verify-email-form')).toBeHidden();
});
