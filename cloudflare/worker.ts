import { domainError } from './db/errors';
import { auditStatement } from './admin/audit';
import { body, now } from './http';
import { csrf, requireUser, logout } from './auth/sessions';
import type { Context, Env, User } from './types';
import { HttpError, isAllowedOrigin, isLocal, json, method, secureResponse, frontendOrigin } from './http';
import { authRoute } from './auth/routes';
import { loadSession, newSession } from './auth/sessions';
import { equal, sha256 } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { reservoirsRoute } from './db/reservoirs';
import { maintenance } from './db/maintenance';
import { telemetryRoute } from './telemetry';
import { adminRoute } from './admin/routes';

const frontendPages = new Set(['/', '/login', '/cadastro', '/esqueci-senha', '/redefinir-senha', '/admin']);
const pageAliases: Record<string, string> = {
  '/index.php': '/',
  '/index.html': '/',
  '/login.php': '/login',
  '/register.php': '/cadastro',
  '/forgot-password.php': '/esqueci-senha',
  '/reset-password.php': '/redefinir-senha',
  '/admin.php': '/admin',
  '/admin.html': '/admin',
};
const authRoutes = new Set([
  'register',
  'login',
  'logout',
  'me',
  'forgot-password',
  'reset-password',
  'csrf',
]);
const deviceRoutes = new Set(['current', 'history', 'status', 'alerts', 'snapshot', 'ingest']);
const reservoirRoutes = new Set([
  '/api/reservoirs',
  '/api/reservoirs/rename',
  '/api/reservoirs/capacity',
  '/api/devices/validate-pairing',
  '/api/devices/connect',
  '/api/devices/unlink',
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const c: Context = {
      request,
      env,
      ctx,
      url: new URL(request.url),
      session: null,
      user: null,
      cookies: [],
      requestId: crypto.randomUUID(),
    };
    let response: Response;
    try {
      if (request.method === 'OPTIONS') {
        const origin = request.headers.get('Origin');
        response = new Response(null, {
          status: origin && isAllowedOrigin(c, origin) ? 204 : 403,
          headers: {
            'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
            'Access-Control-Allow-Headers':
              'Content-Type, X-CSRF-Token, Authorization, X-Device-Token, Idempotency-Key',
            'Access-Control-Max-Age': '600',
          },
        });
      } else {
        try {
          response = await route(c);
        } catch (error) {
          domainError(error);
        }
      }
    } catch (error) {
      const known = error instanceof HttpError;
      response = json(
        {
          success: false,
          request_id: c.requestId,
          error: {
            code: known ? error.code : 'SERVICE_UNAVAILABLE',
            message: known ? error.message : 'Servi�o temporariamente indispon�vel.',
          },
        },
        known ? error.status : 503,
      );
      if (known && error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
    }
    // Fixed categories only: never log URL/query, arbitrary path, headers, body or exceptions.
    const category = c.url.pathname.startsWith('/api/auth/')
      ? 'auth'
      : c.url.pathname.startsWith('/api/admin/')
        ? 'admin'
        : c.url.pathname.startsWith('/api/device/')
          ? 'telemetry'
          : 'application';
    const duration = Date.now() - started;
    console.log(
      JSON.stringify({
        event: 'request',
        request_id: c.requestId,
        category,
        status: response.status,
        duration_ms: duration,
      }),
    );
    env.METRICS?.writeDataPoint({ blobs: [category, String(response.status)], doubles: [1, duration] });
    return secureResponse(response, c);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await maintenance({
      env,
      ctx,
      request: new Request('https://maintenance.invalid'),
      url: new URL('https://maintenance.invalid'),
      session: null,
      user: null,
      cookies: [],
      requestId: crypto.randomUUID(),
    });
  },
} satisfies ExportedHandler<Env>;

async function route(c: Context): Promise<Response> {
  let path = c.url.pathname;
  if (path.startsWith('/static/'))
    return new Response(null, { status: 302, headers: { Location: frontendOrigin(c) + path } });
  if (path === '/api/health') {
    method(c, ['GET']);
    return json({ status: 'ok' });
  }
  if (path === '/api/ready') {
    method(c, ['GET']);
    try {
      frontendOrigin(c);
      if (
        !c.env.SESSION_SECRET ||
        c.env.SESSION_SECRET.length < 32 ||
        !c.env.PASSWORD_PEPPER ||
        c.env.PASSWORD_PEPPER.length < 32 ||
        !isAllowedOrigin(c, c.env.APP_URL ?? '')
      )
        throw new Error('config');
      await c.env.DB.prepare('SELECT token_hash FROM device_credentials LIMIT 1').first();
      return json({ status: 'ready', monitorie: 'blocked' });
    } catch {
      return json({ status: 'not_ready' }, 503);
    }
  }
  // Estes valores nunca devem habilitar mocks em uma URL pública.
  if (c.env.MONITORIE_MODE === 'mock' && !isLocal(c))
    throw new HttpError(503, 'INVALID_ENVIRONMENT', 'Configuração de ambiente inválida.');
  if (!isLocal(c) && c.url.protocol !== 'https:') throw new HttpError(400, 'HTTPS_REQUIRED', 'Use HTTPS.');
  await loadSession(c);
  const share = path === '/api/device/ingest' ? null : await sharedAccess(c);
  if (share) return share;
  if (pageAliases[path] || frontendPages.has(path)) {
    method(c, ['GET', 'HEAD']);
    const target = pageAliases[path] || path;
    return new Response(null, {
      status: 302,
      headers: { Location: frontendOrigin(c) + target + c.url.search },
    });
  }
  if (path.startsWith('/api/') && path.endsWith('.php')) path = path.slice(0, -4);
  if (path === '/api/reservoirs/index' || path === '/api/reservoirs/') path = '/api/reservoirs';
  if (path === '/health.php') path = '/api/health';
  if (path === '/api/health') {
    method(c, ['GET']);
    try {
      await c.env.DB.prepare('SELECT 1').first();
      return json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch {
      return json({ status: 'degraded', database: 'unavailable' }, 503);
    }
  }
  if (path === '/api/auth/delete-account') {
    method(c, ['POST']);
    const user = requireUser(c);
    csrf(c);
    const data = await body(c, ['confirmation']);
    if (data.confirmation !== true)
      throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Confirme a exclus�o da conta.');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id),
      auditStatement(c, 'account_deleted', null),
    ]);
    await logout(c);
    return json({ success: true, redirect: '/login' });
  }
  if (path === '/api/device/ingest') return telemetryRoute(c, 'ingest');
  if (path.startsWith('/api/admin/')) return adminRoute(c, path);
  if (
    !reservoirRoutes.has(path) &&
    !authRoutes.has(path.replace('/api/auth/', '')) &&
    !deviceRoutes.has(path.replace('/api/device/', ''))
  )
    throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
  c.ctx.waitUntil(
    maintenance(c).catch(() => {
      console.warn('MAINTENANCE_UNAVAILABLE');
    }),
  );
  if (path.startsWith('/api/auth/') && authRoutes.has(path.slice(10))) return authRoute(c, path.slice(10));
  if (reservoirRoutes.has(path)) return reservoirsRoute(c, path);
  if (path.startsWith('/api/device/') && deviceRoutes.has(path.slice(12)))
    return telemetryRoute(c, path.slice(12));
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}

async function sharedAccess(c: Context): Promise<Response | null> {
  if (!c.env.DASHBOARD_SHARE_USERNAME && !c.env.DASHBOARD_SHARE_PASSWORD && !c.env.DASHBOARD_SHARE_USER_EMAIL)
    return null;
  if (!c.env.DASHBOARD_SHARE_USERNAME || !c.env.DASHBOARD_SHARE_PASSWORD || !c.env.DASHBOARD_SHARE_USER_EMAIL)
    throw new HttpError(503, 'SHARE_NOT_CONFIGURED', 'Compartilhamento ainda não configurado.');
  await rateLimit(c, 'share-ip', clientIP(c), 30, 60);
  const authorization = c.request.headers.get('Authorization') ?? '';
  if (authorization.length > 2048) return unauthorized();
  let username = '',
    password = '';
  try {
    const decoded = atob(c.request.headers.get('Authorization')?.match(/^Basic (.+)$/i)?.[1] ?? '');
    const separator = decoded.indexOf(':');
    username = decoded.slice(0, separator);
    password = decoded.slice(separator + 1);
  } catch {
    return unauthorized();
  }
  const supplied = await sha256(JSON.stringify([username, password]));
  const expected = await sha256(
    JSON.stringify([c.env.DASHBOARD_SHARE_USERNAME, c.env.DASHBOARD_SHARE_PASSWORD]),
  );
  if (!equal(supplied, expected)) return unauthorized();
  const email = c.env.DASHBOARD_SHARE_USER_EMAIL.trim().toLowerCase();
  const user = await c.env.DB.prepare(
    'SELECT id,name,email,password_hash,session_version,role FROM users WHERE email=?',
  )
    .bind(email)
    .first<User>();
  if (!user) throw new HttpError(503, 'SHARE_USER_UNAVAILABLE', 'Conta do compartilhamento indisponível.');
  if (c.session?.read_only !== 1 || c.user?.id !== user.id) await newSession(c, user, false, true);
  return null;
}
function unauthorized(): Response {
  return new Response('Acesso restrito.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Hidra R3B", charset="UTF-8"' },
  });
}
