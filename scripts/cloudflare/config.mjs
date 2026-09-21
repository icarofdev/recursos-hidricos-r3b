export function origin(value, local = false) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /[\\\x00-\x20\x7f]/.test(value) ||
    (url.protocol !== 'https:' &&
      !(local && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  )
    throw new Error('Origem inválida');
  return url.origin;
}
export function configuration(production = false, env = process.env) {
  const api = origin(env.PUBLIC_API_URL || (production ? '' : 'http://127.0.0.1:8787'), !production);
  const app = origin(env.PUBLIC_APP_URL || (production ? '' : 'http://127.0.0.1:8788'), !production);
  if (api === app) throw new Error('API e frontend precisam de origens distintas');
  const headers = {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'; connect-src 'self' ${api}; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  const pages = {
    '/': 'index.html',
    '/login': 'login.html',
    '/cadastro': 'register.html',
    '/esqueci-senha': 'forgot-password.html',
    '/redefinir-senha': 'reset-password.html',
    '/admin': 'admin.html',
  };
  return { api, app, headers, pages };
}
