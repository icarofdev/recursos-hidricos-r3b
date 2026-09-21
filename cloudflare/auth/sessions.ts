import type { Context, Session, User } from '../types';
import { equal, randomToken, sha256 } from './crypto';
import { HttpError, isCrossSite, isLocal, now, sameOrigin } from '../http';
import { clientIP, rateLimit } from './rate-limit';

function cookieName(c: Context): string {
  return isLocal(c) ? 'HIDRAR3B_DEV' : '__Host-HIDRAR3B';
}
function setCookie(c: Context, token: string, maxAge?: number): void {
  const cross = !isLocal(c) && isCrossSite(c);
  const sameSite = cross
    ? 'SameSite=None; Secure; Partitioned'
    : `SameSite=Lax${isLocal(c) ? '' : '; Secure'}`;
  c.cookies.push(
    `${cookieName(c)}=${token}; Path=/; HttpOnly; ${sameSite}${maxAge === undefined ? '' : `; Max-Age=${Math.max(0, maxAge)}`}`,
  );
}
export async function loadSession(c: Context): Promise<void> {
  const token = c.request.headers
    .get('Cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName(c) + '='))
    ?.slice(cookieName(c).length + 1);
  if (!token || !/^[\w-]{43}$/.test(token)) return;
  const hash = await sha256(token);
  const time = now();
  const session = await c.env.DB.prepare(
    'SELECT * FROM sessions WHERE token_hash=? OR (previous_hash=? AND previous_until>?) LIMIT 1',
  )
    .bind(hash, hash, time)
    .first<Session>();
  if (!session) {
    setCookie(c, '', 0);
    return;
  }
  const idle = session.user_id === null ? 3600 : session.remember ? 30 * 86400 : 7200;
  if (session.expires_at <= time || session.last_seen + idle <= time) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash).run();
    setCookie(c, '', 0);
    return;
  }
  let user: User | null = null;
  if (session.user_id !== null) {
    user = await c.env.DB.prepare(
      'SELECT id,name,email,password_hash,session_version,role FROM users WHERE id=?',
    )
      .bind(session.user_id)
      .first<User>();
    if (!user || user.session_version !== session.session_version) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash).run();
      setCookie(c, '', 0);
      return;
    }
  }
  c.session = session;
  c.user = user;
  if (session.rotated_at + 900 <= time && hash === session.token_hash) {
    const next = randomToken();
    const nextHash = await sha256(next);
    const result = await c.env.DB.prepare(
      `UPDATE sessions SET previous_hash=token_hash, previous_until=?, token_hash=?, rotated_at=?, last_seen=? WHERE token_hash=?`,
    )
      .bind(time + 30, nextHash, time, time, hash)
      .run();
    // Requisições concorrentes usam a sessão anterior por 30s; só a vencedora muda o cookie.
    if (result.meta.changes === 1) {
      session.token_hash = nextHash;
      session.last_seen = time;
      session.rotated_at = time;
      setCookie(c, next, session.remember ? session.expires_at - time : undefined);
    }
  } else if (session.last_seen + 60 <= time) {
    await c.env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?')
      .bind(time, session.token_hash)
      .run();
  }
}
export async function newSession(
  c: Context,
  user: User | null,
  remember = false,
  readOnly = false,
): Promise<void> {
  const time = now();
  const token = randomToken();
  const session: Session = {
    token_hash: await sha256(token),
    previous_hash: null,
    previous_until: null,
    user_id: user?.id ?? null,
    session_version: user?.session_version ?? 1,
    csrf_token: randomToken(),
    remember: Number(remember),
    read_only: Number(readOnly),
    created_at: time,
    last_seen: time,
    rotated_at: time,
    expires_at: time + (user === null ? 3600 : remember ? 30 * 86400 : 12 * 3600),
  };
  const statements = [];
  if (c.session)
    statements.push(
      c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=? OR previous_hash=?').bind(
        c.session.token_hash,
        c.session.token_hash,
      ),
    );
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO sessions(token_hash,user_id,session_version,csrf_token,remember,read_only,created_at,last_seen,rotated_at,expires_at)
 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      session.token_hash,
      session.user_id,
      session.session_version,
      session.csrf_token,
      session.remember,
      session.read_only,
      time,
      time,
      time,
      session.expires_at,
    ),
  );
  await c.env.DB.batch(statements);
  c.session = session;
  c.user = user;
  setCookie(c, token, remember ? session.expires_at - time : undefined);
}
export async function ensureSession(c: Context): Promise<Session> {
  if (!c.session) {
    await rateLimit(c, 'anonymous', clientIP(c), 60, 900);
    await newSession(c, null);
  }
  return c.session!;
}
export function requireUser(c: Context): User {
  if (!c.user) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Sua sessão expirou. Entre novamente.');
  return c.user;
}
export function requireAdmin(c: Context): User {
  if (!c.user || c.user.role !== 'admin') throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
  return c.user;
}
export function csrf(c: Context): void {
  sameOrigin(c);
  if (c.session?.read_only)
    throw new HttpError(403, 'READ_ONLY_SESSION', 'Este acesso compartilhado permite apenas visualização.');
  const value = c.request.headers.get('X-CSRF-Token') ?? '';
  if (!c.session || !value || !equal(value, c.session.csrf_token))
    throw new HttpError(419, 'INVALID_CSRF_TOKEN', 'A página expirou. Atualize e tente novamente.');
}
export async function logout(c: Context): Promise<void> {
  if (c.session)
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=? OR previous_hash=?')
      .bind(c.session.token_hash, c.session.token_hash)
      .run();
  c.session = null;
  c.user = null;
  setCookie(c, '', 0);
}
export const publicUser = (user: User) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
});
