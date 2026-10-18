import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { configuration } from '../../scripts/cloudflare/config.mjs';

const bundle = await build({
  entryPoints: ['static/js/auth.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'synthetic-qr-only',
      setup(builder) {
        builder.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qr', namespace: 'synthetic' }));
        builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
          contents: 'export default {toCanvas:async()=>{}};',
        }));
      },
    },
  ],
});
const details = { site_key: 'synthetic_site_key', action: 'login', cdata: 'a'.repeat(64) };
const required = () =>
  Response.json(
    {
      success: false,
      error: { code: 'TURNSTILE_REQUIRED', message: 'Conclua a verificação.' },
      turnstile: details,
    },
    { status: 403 },
  );

function harness({ autoLoad = true } = {}) {
  const elements = new Map(),
    scripts = [],
    widgets = [],
    calls = [],
    redirects = [];
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        value: '',
        textContent: '',
        disabled: false,
        classList: { add() {}, remove() {} },
        handlers: {},
        addEventListener(event, fn) {
          this.handlers[event] = fn;
        },
      });
    return elements.get(id);
  };
  const ids = [
    'login-form',
    'login-challenge-panel',
    'login-challenge-widget',
    'login-challenge-status',
    'login-challenge-retry',
    'totp-panel',
    'totp-setup-panel',
    'totp-codes-panel',
    'totp-restart',
    'totp-form',
    'recovery-toggle',
    'recovery-form',
    'totp-confirm-form',
    'totp-continue',
  ];
  ids.forEach(element);
  const form = element('login-form'),
    button = element('submit'),
    error = element('error');
  button.disabled = false;
  form.hidden = false;
  form.elements = { email: element('email'), password: element('password'), next: element('next') };
  form.elements.email.value = 'owner@example.test';
  form.elements.password.value = 'Synthetic-Test-8124!';
  form.elements.next.value = '/reservatorios';
  form.reportValidity = () => true;
  form.querySelector = (selector) => (selector === 'button[type="submit"]' ? button : error);
  form.querySelectorAll = () => [{ name: 'remember', checked: true }];
  const meta = { content: 'synthetic-csrf' };
  const api = {
    render(container, options) {
      const id = String(widgets.length);
      widgets.push({ id, container, options, removed: false, resets: 0 });
      return id;
    },
    remove(id) {
      widgets[Number(id)].removed = true;
    },
    reset(id) {
      widgets[Number(id)].resets++;
    },
  };
  const window = {
    __API_BASE__: 'https://api.synthetic.test',
    location: {
      pathname: '/test',
      search: '',
      assign: (value) => redirects.push(value),
      origin: 'https://app.synthetic.test',
    },
    setTimeout,
    clearTimeout,
  };
  const document = {
    querySelector: (selector) => (selector === 'meta[name="csrf-token"]' ? meta : null),
    querySelectorAll: (selector) => (selector === '.auth-form[data-endpoint]' ? [form] : []),
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => ({ remove() {} }),
    head: {
      append(script) {
        assert.equal(script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
        scripts.push(script);
        if (autoLoad)
          queueMicrotask(() => {
            window.turnstile = api;
            script.onload();
          });
      },
    },
  };
  let response = required;
  const sandbox = {
    document,
    window,
    URL,
    URLSearchParams,
    FormData: class {
      constructor(form) {
        this.form = form;
      }
      *[Symbol.iterator]() {
        for (const [name, input] of Object.entries(this.form.elements)) yield [name, input.value];
      }
    },
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.synthetic.test/api/auth/login');
      assert.equal(options.headers['X-CSRF-Token'], 'synthetic-csrf');
      calls.push(JSON.parse(options.body));
      return response();
    },
  };
  vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
  return {
    form,
    button,
    error,
    scripts,
    widgets,
    calls,
    redirects,
    window,
    api,
    element,
    submit: () => form.handlers.submit({ preventDefault() {} }),
    setResponse: (value) => {
      response = value;
    },
  };
}

test('login loads Turnstile only when challenged; consumes one token per POST and keeps credentials/MFA flow', async () => {
  const h = harness();
  assert.equal(h.scripts.length, 0);
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].turnstile_token, undefined);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.element('login-challenge-panel').hidden, false);
  assert.equal(h.widgets[0].options.cData, details.cdata);
  assert.equal(h.widgets[0].options['response-field'], false);
  await h.submit();
  assert.equal(h.calls.length, 1, 'Pending widget does not send credentials repeatedly');
  h.widgets[0].options.callback('first-synthetic-token');
  h.setResponse(() =>
    Response.json(
      { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Credencial inválida.' } },
      { status: 401 },
    ),
  );
  await h.submit();
  assert.equal(h.calls[1].turnstile_token, 'first-synthetic-token');
  assert.equal(h.calls[1].email, h.form.elements.email.value);
  assert.equal(h.calls[1].password, h.form.elements.password.value);
  assert.equal(h.calls[1].remember, true);
  assert.equal(h.calls[1].next, '/reservatorios');
  assert.equal(h.widgets[0].removed, true);
  h.widgets[0].options.callback('stale-callback-token');
  await h.submit();
  assert.equal(h.calls.length, 2, 'Callback from removed widget cannot supply a reusable token');
  h.widgets[1].options.callback('fresh-synthetic-token');
  h.setResponse(() => Response.json({ success: true, stage: 'totp', challenge: 'synthetic-mfa' }));
  await h.submit();
  assert.equal(h.calls[2].turnstile_token, 'fresh-synthetic-token');
  assert.equal(h.form.hidden, true);
  assert.equal(h.element('totp-panel').hidden, false);
  assert.equal(h.element('login-challenge-panel').hidden, true);
  assert.deepEqual(h.redirects, []);
});

test('expired/error/timeout callbacks clear tokens; identity changes clear the previous challenge', async () => {
  const h = harness();
  await h.submit();
  const widget = h.widgets[0];
  for (const callback of ['expired-callback', 'error-callback', 'timeout-callback']) {
    widget.options.callback('synthetic-to-clear');
    widget.options[callback]();
    await h.submit();
    assert.equal(h.calls.length, 1);
  }
  assert.equal(widget.resets, 1);
  h.form.elements.email.value = 'another@example.test';
  h.form.elements.email.handlers.input();
  assert.equal(widget.removed, true);
  h.setResponse(() => Response.json({ success: true, redirect: '/reservatorios' }));
  await h.submit();
  assert.equal(h.calls[1].turnstile_token, undefined);
  assert.deepEqual(h.redirects, ['/reservatorios']);
});

test('widget script failure is recoverable through explicit retry without resending credentials', async () => {
  const h = harness({ autoLoad: false });
  const pending = h.submit();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  h.scripts[0].onerror();
  await pending;
  assert.equal(h.button.disabled, false);
  assert.match(h.error.textContent, /Não foi possível carregar/);
  const retry = h.element('login-challenge-retry').handlers.click();
  assert.equal(h.scripts.length, 2);
  h.window.turnstile = h.api;
  h.scripts[1].onload();
  await retry;
  assert.equal(h.calls.length, 1);
  assert.equal(h.widgets.length, 1);
});

test('frontend CSP permits only the required Turnstile script/frame origin and retains strict directives', () => {
  const csp = configuration(true, { PUBLIC_API_URL: 'https://api.test', PUBLIC_APP_URL: 'https://app.test' })
    .headers['Content-Security-Policy'];
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:\/\/\*/);
});
