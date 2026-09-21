import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { safeRedirect } from '../../static/js/redirects.js';
import { configuration } from '../../scripts/cloudflare/config.mjs';

test('redirect resolves same origin, rejects slashes, controls, malformed escapes and external URLs', () => {
  for (const value of [
    '//evil.test',
    '/\\evil.test',
    '/\n/evil.test',
    'https://evil.test',
    'javascript:alert(1)',
    '/%5cevil.test',
    '/%2f%2fevil.test',
    '/%00',
    '/%zz',
    null,
  ])
    assert.equal(safeRedirect(value, 'https://app.test'), '/');
  assert.equal(safeRedirect('/admin?view=1#x', 'https://app.test'), '/admin?view=1#x');
});
test('production build fails closed for missing, equal or malformed origins', () => {
  for (const env of [
    {},
    { PUBLIC_API_URL: 'https://api.test' },
    { PUBLIC_API_URL: 'https://same.test', PUBLIC_APP_URL: 'https://same.test' },
    { PUBLIC_API_URL: 'https://api.test/path', PUBLIC_APP_URL: 'https://app.test' },
    { PUBLIC_API_URL: 'http://api.test', PUBLIC_APP_URL: 'https://app.test' },
  ])
    assert.throws(() => configuration(true, env));
  const config = configuration(true, {
    PUBLIC_API_URL: 'https://api.test',
    PUBLIC_APP_URL: 'https://app.test',
  });
  assert.match(config.headers['Content-Security-Policy'], /connect-src 'self' https:\/\/api.test;/);
});
test('Vercel artifact carries strict security headers and contains no executable inline attributes', async () => {
  const project = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.equal(project.buildCommand, 'npm run build:production');
  assert.equal(project.outputDirectory, undefined);
  assert.equal(project.headers, undefined);
  const config = JSON.parse(await readFile('.vercel/output/config.json', 'utf8'));
  const headers = config.routes[0].headers;
  for (const name of [
    'Content-Security-Policy',
    'Strict-Transport-Security',
    'Permissions-Policy',
    'Referrer-Policy',
  ])
    assert.ok(headers[name]);
  assert.doesNotMatch(headers['Content-Security-Policy'], /unsafe-inline|unsafe-eval/);
  for (const file of (await readdir('dist/frontend')).filter((f) => f.endsWith('.html'))) {
    const html = await readFile('dist/frontend/' + file, 'utf8');
    assert.doesNotMatch(html, /\s(?:on\w+|style)\s*=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  }
  const admin = await readFile('dist/frontend/static/js/admin.js', 'utf8');
  assert.doesNotMatch(admin, /onclick=|style="/);
});
test('dashboard uses snapshot, clamps cadence and never requests parallel compatibility endpoints', async () => {
  const script = await readFile('dist/frontend/static/js/dashboard.js', 'utf8');
  assert.match(script, /\/api\/device\/snapshot/);
  assert.doesNotMatch(script, /\/api\/device\/(current|status|alerts)/);
  const html = await readFile('dist/frontend/index.html', 'utf8');
  assert.doesNotMatch(html, /<option value="(?:5000|15000|30000)"/);
  assert.match(script, /refreshMilliseconds: 6(?:0000|e4)/);
});
