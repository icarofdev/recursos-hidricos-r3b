import { safeRedirect } from './redirects.js';
const base = window.__API_BASE__ || '';
const url = (path) => base.replace(/\/+$/, '') + path;
let csrf = '',
  token = new URLSearchParams(location.search).get('token') || '';
if (token && location.pathname === '/confirmar-email') history.replaceState(null, '', '/confirmar-email');
const feedback = () => document.getElementById('email-proof-feedback');
async function post(path, data) {
  const response = await fetch(url(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'Não foi possível concluir.');
  return result;
}
async function initialize() {
  const button = document.getElementById('request-email-verification');
  if (!button) return;
  try {
    const response = await fetch(url('/api/auth/me'), { credentials: 'include' });
    if (!response.ok) {
      const login = document.getElementById('verification-login');
      if (login && token)
        login.href =
          '/login?next=' +
          encodeURIComponent(safeRedirect('/confirmar-email?token=' + encodeURIComponent(token)));
      return;
    }
    const me = await response.json();
    csrf = me.csrf_token;
    const banner = document.getElementById('email-proof-banner');
    if (banner) banner.hidden = !!me.user.email_verified || !!me.read_only;
    button.hidden = !!me.user.email_verified || !!me.read_only;
    const form = document.getElementById('verify-email-form');
    const login = document.getElementById('verification-login');
    if (login) login.hidden = true;
    if (form) form.hidden = !token || !!me.user.email_verified || !!me.read_only;
    if (me.user.email_verified && feedback()) feedback().textContent = 'O endereço já está confirmado.';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        feedback().textContent = (await post('/api/auth/request-email-verification', {})).message;
      } catch (error) {
        feedback().textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      form.querySelector('button').disabled = true;
      try {
        feedback().textContent = (await post('/api/auth/verify-email', { token })).message;
        token = '';
        form.hidden = true;
        button.hidden = true;
      } catch (error) {
        feedback().textContent = error.message;
      } finally {
        form.querySelector('button').disabled = false;
      }
    });
  } catch {
    if (feedback()) feedback().textContent = 'Confirmação temporariamente indisponível.';
  }
}
void initialize();
