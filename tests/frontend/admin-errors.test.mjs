import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../static/js/admin.js', import.meta.url), 'utf8');

function harness(replies) {
  const calls = [];
  const redirects = [];
  const context = vm.createContext({
    document: { querySelector: () => null, addEventListener: () => {} },
    location: { pathname: '/admin' },
    window: { __API_BASE__: '', location: { assign: (path) => redirects.push(path) } },
    fetch: async (url, options) => {
      calls.push({ url, method: options.method ?? 'GET' });
      const reply = replies.shift();
      assert.ok(reply, `Resposta inesperada para ${url}`);
      return {
        status: reply.status,
        ok: reply.status >= 200 && reply.status < 300,
        json: async () => reply.body,
      };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, redirects };
}

test('admin 404 genérico revalida sessão e pede MFA quando a sessão perdeu a confirmação', async () => {
  const { context, calls, redirects } = harness([
    { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } } },
    { status: 200, body: { user: { role: 'admin' }, admin_mfa_required: true } },
  ]);
  await assert.rejects(
    vm.runInContext("request('/api/admin/devices/42/unlink', { method: 'POST' })", context),
    /Confirme o código do autenticador/,
  );
  assert.deepEqual(calls, [
    { url: '/api/admin/devices/42/unlink', method: 'POST' },
    { url: '/api/auth/me', method: 'GET' },
  ]);
  assert.deepEqual(redirects, ['/login?next=%2Fadmin']);
});

test('ID de dispositivo inexistente preserva DEVICE_NOT_FOUND sem reclassificar o erro', async () => {
  const { context, calls, redirects } = harness([
    { status: 404, body: { error: { code: 'DEVICE_NOT_FOUND', message: 'Dispositivo não encontrado.' } } },
  ]);
  await assert.rejects(
    vm.runInContext("request('/api/admin/devices/999999/unlink', { method: 'POST' })", context),
    /Dispositivo não encontrado/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(redirects, []);
});

test('404 de rota com admin autenticado continua visível como erro de rota', async () => {
  const { context, calls, redirects } = harness([
    { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } } },
    { status: 200, body: { user: { role: 'admin' }, admin_mfa_required: false } },
  ]);
  await assert.rejects(
    vm.runInContext("request('/api/admin/rota-inexistente')", context),
    /Recurso não encontrado/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(redirects, []);
});
