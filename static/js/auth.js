import { safeRedirect } from './redirects.js';
import QRCode from 'qrcode';
import { createLoginChallenge } from './login-challenge.js';
(() => {
  'use strict';

  const apiBase = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content || '';
  function apiUrl(endpoint) {
    if (!apiBase || endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
    return `${apiBase.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  }

  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  if (csrfToken === '{{csrf}}') csrfToken = '';

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    try {
      const response = await fetch(apiUrl('/api/auth/csrf'), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json();
      if (payload?.csrf_token) {
        csrfToken = payload.csrf_token;
        let meta = document.querySelector('meta[name="csrf-token"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'csrf-token';
          document.head.append(meta);
        }
        meta.content = csrfToken;
      }
    } catch {
      /* fallback */
    }
    return csrfToken;
  }

  async function request(url, options = {}) {
    const token = options.method === 'POST' ? await getCsrfToken() : '';
    const response = await fetch(apiUrl(url), {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.method === 'POST' && token ? { 'X-CSRF-Token': token } : {}),
      },
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* resposta inválida tratada abaixo */
    }
    if (!response.ok || !payload?.success) {
      const error = new Error(payload?.error?.message || 'Não foi possível concluir. Tente novamente.');
      error.code = payload?.error?.code || 'REQUEST_FAILED';
      error.turnstile = payload?.turnstile;
      throw error;
    }
    if (payload?.csrf_token) {
      csrfToken = payload.csrf_token;
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) meta.content = csrfToken;
    }
    return payload;
  }

  function formPayload(form) {
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      data[input.name] = input.checked;
    });
    return data;
  }

  document.querySelectorAll('.auth-form[data-endpoint]').forEach((form) => {
    if (form.id === 'login-form') return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector('[data-form-error]');
      if (error) error.textContent = '';
      button.disabled = true;
      button.classList.add('is-submitting');
      try {
        const result = await request(form.dataset.endpoint, {
          method: 'POST',
          body: JSON.stringify(formPayload(form)),
        });
        if (form.dataset.success === 'message') {
          form.querySelectorAll('label, button[type="submit"]').forEach((element) => {
            element.hidden = true;
          });
          const panel = form.querySelector('[data-success-panel]');
          panel.hidden = false;
          panel.querySelector('[data-success-message]').textContent = result.message;
        } else {
          window.location.assign(safeRedirect(result.redirect));
        }
      } catch (requestError) {
        if (error) error.textContent = requestError.message;
      } finally {
        button.disabled = false;
        button.classList.remove('is-submitting');
      }
    });
  });

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    const loginChallenge = createLoginChallenge(
      document.getElementById('login-challenge-panel'),
      document.getElementById('login-challenge-widget'),
      document.getElementById('login-challenge-status'),
    );
    loginForm.elements.email.addEventListener('input', () => loginChallenge.clear());
    document.getElementById('login-challenge-retry').addEventListener('click', async () => {
      try {
        await loginChallenge.refresh();
      } catch (failure) {
        loginForm.querySelector('[data-form-error]').textContent = failure.message;
      }
    });
    const verifyPanel = document.getElementById('totp-panel');
    const setupPanel = document.getElementById('totp-setup-panel');
    const codesPanel = document.getElementById('totp-codes-panel');
    const restart = document.getElementById('totp-restart');
    let challenge = '';
    let nextPath = '/';
    function stage(name) {
      loginForm.hidden = name !== 'login';
      verifyPanel.hidden = name !== 'verify';
      setupPanel.hidden = name !== 'setup';
      codesPanel.hidden = name !== 'codes';
      restart.hidden = name === 'login' || name === 'codes';
    }
    async function submit(form, action, payload, onSuccess) {
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      const error = form.querySelector('[data-form-error]');
      error.textContent = '';
      button.disabled = true;
      button.classList.add('is-submitting');
      let turnstileToken = '';
      try {
        if (form === loginForm) {
          turnstileToken = loginChallenge.takeToken();
          if (turnstileToken) payload.turnstile_token = turnstileToken;
        }
        const result = await request(action, { method: 'POST', body: JSON.stringify(payload) });
        if (form === loginForm) loginChallenge.clear();
        await onSuccess(result);
      } catch (failure) {
        error.textContent = failure.message;
        if (form === loginForm) {
          try {
            if (failure.turnstile) await loginChallenge.show(failure.turnstile);
            else if (turnstileToken) await loginChallenge.refresh();
          } catch (unavailable) {
            error.textContent = unavailable.message;
          }
        }
      } finally {
        button.disabled = false;
        button.classList.remove('is-submitting');
      }
    }
    async function setup() {
      stage('setup');
      const error = setupPanel.querySelector('[data-form-error]');
      const loading = document.getElementById('totp-setup-loading');
      loading.hidden = false;
      error.textContent = '';
      try {
        const result = await request('/api/auth/admin-totp/setup', {
          method: 'POST',
          body: JSON.stringify({ challenge }),
        });
        document.getElementById('totp-secret').textContent = result.secret;
        await QRCode.toCanvas(document.getElementById('totp-qr'), result.uri, {
          width: 220,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        loading.hidden = true;
      }
    }
    loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!loginForm.reportValidity()) return;
      return submit(loginForm, '/api/auth/login', formPayload(loginForm), async (result) => {
        if (!result.stage) {
          window.location.assign(safeRedirect(result.redirect));
          return;
        }
        challenge = result.challenge;
        nextPath = safeRedirect(loginForm.elements.next.value || '/');
        if (result.stage === 'totp_setup') await setup();
        else stage('verify');
      });
    });
    document.getElementById('totp-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      submit(form, '/api/auth/admin-totp/verify', { challenge, code: form.elements.code.value }, (result) => {
        window.location.assign(safeRedirect(result.redirect));
      });
    });
    document.getElementById('recovery-toggle').addEventListener('click', () => {
      document.getElementById('recovery-form').hidden = false;
      document.getElementById('totp-form').hidden = true;
    });
    document.getElementById('recovery-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      submit(
        form,
        '/api/auth/admin-totp/verify',
        { challenge, recovery_code: form.elements.recovery_code.value.trim() },
        async () => {
          await setup();
        },
      );
    });
    document.getElementById('totp-confirm-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      submit(
        form,
        '/api/auth/admin-totp/confirm',
        { challenge, code: form.elements.code.value },
        (result) => {
          challenge = '';
          document.getElementById('totp-secret').textContent = '';
          document.getElementById('totp-qr').getContext('2d').clearRect(0, 0, 220, 220);
          const list = document.getElementById('totp-codes');
          list.replaceChildren(
            ...result.recovery_codes.map((code) => {
              const item = document.createElement('li');
              item.textContent = code;
              return item;
            }),
          );
          nextPath = safeRedirect(result.redirect || nextPath);
          stage('codes');
        },
      );
    });
    document
      .getElementById('totp-continue')
      .addEventListener('click', () => window.location.assign(nextPath));
    restart.addEventListener('click', () => {
      challenge = '';
      document.getElementById('totp-secret').textContent = '';
      document.getElementById('totp-qr').getContext('2d').clearRect(0, 0, 220, 220);
      document.getElementById('totp-setup-panel').querySelector('[data-form-error]').textContent = '';
      document.getElementById('recovery-form').hidden = true;
      document.getElementById('totp-form').hidden = false;
      stage('login');
    });
  }

  const nextInput = document.querySelector('input[name="next"]');
  if (nextInput) {
    const urlNext = new URLSearchParams(window.location.search).get('next');
    if (urlNext) nextInput.value = safeRedirect(urlNext);
  }

  const resetForm = document.getElementById('reset-form');
  if (resetForm) {
    const urlToken = new URLSearchParams(window.location.search).get('token') || '';
    const tokenInput = resetForm.elements.token;
    const token =
      tokenInput && tokenInput.value && tokenInput.value !== '{{token}}' ? tokenInput.value : urlToken;
    if (tokenInput) tokenInput.value = token;
    // O formulário retém o token; removê-lo da barra evita compartilhamento acidental.
    if (urlToken) window.history.replaceState(null, '', '/redefinir-senha');
    request(`/api/auth/reset-password?token=${encodeURIComponent(token)}`)
      .then((result) => {
        document.getElementById('token-status').textContent = result.valid
          ? 'O link é válido. Defina uma senha forte para continuar.'
          : 'Não foi possível validar este link.';
        resetForm.hidden = !result.valid;
        document.getElementById('invalid-token').hidden = result.valid;
      })
      .catch(() => {
        document.getElementById('token-status').textContent = 'Não foi possível validar este link.';
        document.getElementById('invalid-token').hidden = false;
      });
  }

  if (
    document.getElementById('reset-success') &&
    new URLSearchParams(location.search).get('reset') === 'success'
  ) {
    document.getElementById('reset-success').hidden = false;
  }

  // Alternar visualização da senha (ícone de olho)
  document.querySelectorAll('.password-toggle-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const wrapper = button.closest('.password-field-wrapper');
      const input = wrapper?.querySelector('input');
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      button.classList.toggle('is-visible', isPassword);
      button.setAttribute('aria-label', isPassword ? 'Ocultar senha' : 'Mostrar senha');
      button.title = isPassword ? 'Ocultar senha' : 'Mostrar senha';
    });
  });

  // Checklist de requisitos de senha em tempo real
  document.querySelectorAll('input[name="password"]').forEach((input) => {
    const form = input.closest('form');
    const checklist = form?.querySelector('.password-checklist');
    if (!checklist) return;

    const rules = {
      length: (val) => [...val].length >= 8 && new TextEncoder().encode(val).length <= 128,
      uppercase: (val) => /[A-Z]/.test(val),
      lowercase: (val) => /[a-z]/.test(val),
      number: (val) => /[0-9]/.test(val),
      special: (val) => /[^A-Za-z0-9]/.test(val),
    };

    function updateChecklist() {
      const val = input.value || '';
      for (const [rule, validator] of Object.entries(rules)) {
        const item = checklist.querySelector(`[data-rule="${rule}"]`);
        if (item) {
          item.classList.toggle('is-valid', validator(val));
        }
      }
    }

    input.addEventListener('input', updateChecklist);
    input.addEventListener('change', updateChecklist);
    updateChecklist();
  });

  const pathname = window.location.pathname;
  if (['/login', '/cadastro'].some((p) => pathname === p || pathname.endsWith(p))) {
    fetch(apiUrl('/api/auth/me'), { credentials: 'include', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.user && !data.admin_mfa_required) {
          const next = new URLSearchParams(window.location.search).get('next') || '/';
          window.location.assign(safeRedirect(next));
        }
      })
      .catch(() => {});
  }
})();
