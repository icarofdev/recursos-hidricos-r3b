import type { Context } from '../types';

const WINDOW_SECONDS = 300;
const paths = new Set([
  '/',
  '/login',
  '/cadastro',
  '/esqueci-senha',
  '/redefinir-senha',
  '/admin',
  '/api/health',
  '/api/ready',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/csrf',
  '/api/auth/delete-account',
  '/api/auth/admin-totp/setup',
  '/api/auth/admin-totp/confirm',
  '/api/auth/admin-totp/verify',
  '/api/auth/admin-totp/reauth',
  '/api/device/current',
  '/api/device/history',
  '/api/device/status',
  '/api/device/alerts',
  '/api/device/snapshot',
  '/api/device/ingest',
  '/api/reservoirs',
  '/api/reservoirs/rename',
  '/api/reservoirs/capacity',
  '/api/reservoirs/configuration',
  '/api/devices/users',
  '/api/devices/users/add',
  '/api/devices/users/remove',
  '/api/devices/validate-pairing',
  '/api/devices/connect',
  '/api/devices/unlink',
  '/api/admin/devices',
  '/api/admin/audit-logs',
]);
const aliases: Record<string, string> = {
  '/index.php': '/',
  '/index.html': '/',
  '/login.php': '/login',
  '/register.php': '/cadastro',
  '/forgot-password.php': '/esqueci-senha',
  '/reset-password.php': '/redefinir-senha',
  '/admin.php': '/admin',
  '/admin.html': '/admin',
  '/health.php': '/api/health',
  '/api/reservoirs/index': '/api/reservoirs',
  '/api/reservoirs/': '/api/reservoirs',
};
const adminActions = new Set([
  'generate-code',
  'revoke-code',
  'unlink',
  'transfer',
  'update',
  'rotate-token',
  'revoke-token',
  'delete',
  'monitorie-discover',
]);

function endpoint(pathname: string): string {
  if (pathname.startsWith('/static/')) return '/static/*';
  const path = aliases[pathname] ?? pathname.replace(/^\/api\/(.*)\.php$/, '/api/$1');
  if (paths.has(path)) return path;
  const match = /^\/api\/admin\/devices\/\d+\/([a-z-]+)$/.exec(path);
  if (match && adminActions.has(match[1])) return `/api/admin/devices/:id/${match[1]}`;
  return '/unmatched';
}

function country(request: Request): string {
  const value = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : 'XX';
}

/** Observe only. All dimensions are bounded; no URL query, body, headers or IP is stored. */
export async function observeEndpoint(c: Context, status: number): Promise<void> {
  const path = endpoint(c.url.pathname);
  const method = ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(c.request.method)
    ? c.request.method
    : 'OTHER';
  const location = country(c.request);
  const time = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(time / WINDOW_SECONDS) * WINDOW_SECONDS;
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO endpoint_requests(window_start,path,method,country,request_count,last_status,last_request_id,updated_at)
       VALUES (?,?,?,?,1,?,?,?)
       ON CONFLICT(window_start,path,method,country) DO UPDATE SET
       request_count=endpoint_requests.request_count+1,
       last_status=excluded.last_status,
       last_request_id=excluded.last_request_id,
       updated_at=excluded.updated_at
       RETURNING request_count`,
    )
      .bind(windowStart, path, method, location, status, c.requestId, time)
      .first<{ request_count: number }>();
    if (!row) throw new Error('observation failed');
    console.log(
      JSON.stringify({
        event: 'endpoint_request',
        path,
        method,
        status,
        request_id: c.requestId,
        country: location,
        window_start: windowStart,
        window_seconds: WINDOW_SECONDS,
        window_count: row.request_count,
      }),
    );
  } catch {
    // Observability cannot turn a successful application request into an error.
    console.warn('ENDPOINT_OBSERVATION_UNAVAILABLE');
  }
}
