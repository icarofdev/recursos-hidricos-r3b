import type { Context, Env, User } from './types';
import { HttpError, isAllowedOrigin, isLocal, json, method, secureResponse } from './http';
import { authRoute } from './auth/routes';
import { loadSession, newSession } from './auth/sessions';
import { equal } from './auth/crypto';
import { clientIP, rateLimit } from './auth/rate-limit';
import { reservoirsRoute } from './db/reservoirs';
import { maintenance } from './db/maintenance';
import { telemetryRoute } from './telemetry';
import { adminRoute } from './admin/routes';

const frontendPages = new Set(['/', '/login', '/cadastro', '/esqueci-senha', '/redefinir-senha', '/admin']);
const pageAliases: Record<string,string> = {'/index.php':'/', '/index.html':'/', '/login.php':'/login', '/register.php':'/cadastro', '/forgot-password.php':'/esqueci-senha', '/reset-password.php':'/redefinir-senha', '/admin.php':'/admin', '/admin.html':'/admin'};
const authRoutes = new Set(['register','login','logout','me','forgot-password','reset-password','csrf']);
const deviceRoutes = new Set(['current','history','status','alerts','snapshot','ingest']);
const reservoirRoutes = new Set(['/api/reservoirs','/api/reservoirs/rename','/api/devices/validate-pairing','/api/devices/connect','/api/devices/unlink']);

export default {
 async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c: Context = {request,env,ctx,url:new URL(request.url),session:null,user:null,cookies:[]};
  if (request.method === 'OPTIONS') {
   const origin = request.headers.get('Origin');
   if (origin && isAllowedOrigin(c, origin)) {
    return new Response(null, {
     status: 204,
     headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Authorization, X-Device-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
     }
    });
   }
   return new Response(null, { status: 403 });
  }
  try { return secureResponse(await route(c), c); }
  catch (error) {
   // Não registrar request, headers, URLs com tokens, corpo, erro D1 ou erro externo.
   const known = error instanceof HttpError;
   if (!known) console.error('REQUEST_FAILED');
   const response = json({success:false,error:{code:known ? error.code : 'SERVICE_UNAVAILABLE', message:known ? error.message : 'Serviço temporariamente indisponível. Tente novamente.'}}, known ? error.status : 503);
   if (known && error.retryAfter) response.headers.set('Retry-After',String(error.retryAfter));
   return secureResponse(response,c);
  }
 }
} satisfies ExportedHandler<Env>;

async function route(c: Context): Promise<Response> {
 let path = c.url.pathname;
 if (path.startsWith('/static/')) {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.request);
  const appBase = (c.env.APP_URL || '').replace(/\/+$/, '');
  if (appBase) return new Response(null, { status: 302, headers: { Location: `${appBase}${path}` } });
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
 }
 // Estes valores nunca devem habilitar mocks em uma URL pública.
 if (c.env.MONITORIE_MODE === 'mock' && !isLocal(c)) throw new HttpError(503,'INVALID_ENVIRONMENT','Configuração de ambiente inválida.');
 if (!isLocal(c) && c.url.protocol !== 'https:') throw new HttpError(400,'HTTPS_REQUIRED','Use HTTPS.');
 await loadSession(c);
 const share = await sharedAccess(c);
 if (share) return share;
 if (pageAliases[path] || frontendPages.has(path)) {
  method(c, ['GET', 'HEAD']);
  const target = pageAliases[path] || path;
  const appBase = (c.env.APP_URL || '').replace(/\/+$/, '');
  const location = appBase ? `${appBase}${target}${c.url.search}` : `${target}${c.url.search}`;
  return new Response(null, { status: 302, headers: { Location: location } });
 }
 if (path.startsWith('/api/') && path.endsWith('.php')) path = path.slice(0,-4);
 if (path === '/api/reservoirs/index' || path === '/api/reservoirs/') path='/api/reservoirs';
 if (path === '/health.php') path='/api/health';
 if (path === '/api/health') {
  method(c,['GET']);
  try { await c.env.DB.prepare('SELECT 1').first(); return json({status:'ok',database:'connected',timestamp:new Date().toISOString()}); }
  catch { return json({status:'degraded',database:'unavailable'},503); }
 }
 if (path === '/api/device/ingest') return telemetryRoute(c,'ingest');
 if (path.startsWith('/api/admin/')) return adminRoute(c, path);
 if (!reservoirRoutes.has(path) && !authRoutes.has(path.replace('/api/auth/','')) && !deviceRoutes.has(path.replace('/api/device/','')))
  throw new HttpError(404,'NOT_FOUND','Recurso não encontrado.');
 c.ctx.waitUntil(maintenance(c).catch(() => { console.warn('MAINTENANCE_UNAVAILABLE'); }));
 if (path.startsWith('/api/auth/') && authRoutes.has(path.slice(10))) return authRoute(c,path.slice(10));
 if (reservoirRoutes.has(path)) return reservoirsRoute(c,path);
 if (path.startsWith('/api/device/') && deviceRoutes.has(path.slice(12))) return telemetryRoute(c,path.slice(12));
 throw new HttpError(404,'NOT_FOUND','Recurso não encontrado.');
}

async function sharedAccess(c: Context): Promise<Response | null> {
 if (!c.env.DASHBOARD_SHARE_USERNAME && !c.env.DASHBOARD_SHARE_PASSWORD && !c.env.DASHBOARD_SHARE_USER_EMAIL) return null;
 if (!c.env.DASHBOARD_SHARE_USERNAME || !c.env.DASHBOARD_SHARE_PASSWORD || !c.env.DASHBOARD_SHARE_USER_EMAIL)
  throw new HttpError(503,'SHARE_NOT_CONFIGURED','Compartilhamento ainda não configurado.');
 let username='',password='';
 try {
  const decoded=atob(c.request.headers.get('Authorization')?.match(/^Basic (.+)$/i)?.[1] ?? '');
  const separator=decoded.indexOf(':'); username=decoded.slice(0,separator); password=decoded.slice(separator+1);
 } catch { return unauthorized(); }
 if (!equal(username, c.env.DASHBOARD_SHARE_USERNAME) || !equal(password, c.env.DASHBOARD_SHARE_PASSWORD)) return unauthorized();
 const email = c.env.DASHBOARD_SHARE_USER_EMAIL.trim().toLowerCase();
 const user = await c.env.DB.prepare('SELECT id,name,email,password_hash,session_version,role FROM users WHERE email=?').bind(email).first<User>();
 if (!user) throw new HttpError(503,'SHARE_USER_UNAVAILABLE','Conta do compartilhamento indisponível.');
 await newSession(c, user, false, true);
 return null;
}
function unauthorized(): Response {
 return new Response('Acesso restrito.', {status: 401, headers: {'WWW-Authenticate': 'Basic realm="Hidra R3B", charset="UTF-8"'}});
}
