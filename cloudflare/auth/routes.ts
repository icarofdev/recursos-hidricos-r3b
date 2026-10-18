import type { Context, User } from '../types';
import { body, HttpError, isLocal, json, method, now, safePath, sameOrigin, string } from '../http';
import {
  hashPassword,
  passwordNeedsUpgrade,
  randomToken,
  sha256,
  validatePassword,
  verifyPassword,
} from './crypto';
import { csrf, ensureSession, logout, newSession, publicUser, requireUser } from './sessions';
import { clearFailureLimit, clientIP, rateLimit } from './rate-limit';
import { checkLoginChallenge, recordLoginFailure } from './turnstile';
import { emailVerification } from './email-verification';
import { resetURL, sendPasswordReset } from '../mail';
import { startAdminChallenge, totpRoute } from './totp-routes';
import { securityEvent } from './security-events';

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const tokenShape = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export async function authRoute(c: Context, route: string): Promise<Response> {
  const ip = clientIP(c);
  if (route === 'me') {
    method(c, ['GET']);
    const user = requireUser(c);
    return json({
      success: true,
      user: publicUser(user),
      csrf_token: c.session!.csrf_token,
      admin_mfa_required: user.role === 'admin' && !c.session?.admin_mfa_at,
      read_only: !!c.session?.read_only,
    });
  }
  if (route === 'csrf') {
    method(c, ['GET']);
    sameOrigin(c);
    return json({ success: true, csrf_token: (await ensureSession(c)).csrf_token });
  }
  if (route === 'reset-password' && c.request.method === 'GET') {
    await rateLimit(c, 'reset-validation', ip, 20, 900);
    const token = c.url.searchParams.get('token') ?? '';
    const valid =
      tokenShape(token) &&
      !!(await c.env.DB.prepare(
        'SELECT 1 FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
      )
        .bind(await sha256(token), now())
        .first());
    return json({ success: true, valid });
  }
  method(c, ['POST']);
  if (route === 'logout') {
    requireUser(c);
    csrf(c, true);
    await body(c, []);
    await logout(c);
    return json({ success: true, redirect: '/login' });
  }
  csrf(c);
  if (route === 'verify-email' || route === 'request-email-verification') return emailVerification(c, route);
  if (
    route === 'admin-totp/setup' ||
    route === 'admin-totp/confirm' ||
    route === 'admin-totp/verify' ||
    route === 'admin-totp/reauth'
  )
    return totpRoute(c, route.split('/')[1]);
  if (route === 'register') {
    const data = await body(c, ['name', 'email', 'password', 'password_confirmation']);
    const name = string(data, 'name', 120).trim().replace(/\s+/g, ' ');
    const email = normalizeEmail(string(data, 'email', 254));
    const password = string(data, 'password', 128);
    validatePassword(password, string(data, 'password_confirmation', 128));
    if ([...name].length < 2)
      throw new HttpError(422, 'INVALID_NAME', 'Informe um nome entre 2 e 120 caracteres.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(422, 'INVALID_EMAIL', 'Informe um e-mail válido.');
    await rateLimit(c, 'register-ip', ip, isLocal(c) ? 100 : 5, 3600);
    await rateLimit(c, 'register-email', email, 3, 3600);
    const time = now();
    const hash = await hashPassword(password, c.env);
    const role = 'user';
    await c.env.DB.prepare(
      `INSERT INTO users(name,email,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)
   ON CONFLICT(email) DO NOTHING`,
    )
      .bind(name, email, hash, role, time, time)
      .run();
    return json({
      success: true,
      message: 'Se este e-mail ainda não estava cadastrado, a conta foi criada. Entre para continuar.',
      redirect: '/login',
    });
  }
  if (route === 'login') {
    const data = await body(c, ['email', 'password', 'remember', 'next', 'turnstile_token']);
    const email = normalizeEmail(string(data, 'email', 254));
    const password = string(data, 'password', 128);
    if (data.remember !== undefined && typeof data.remember !== 'boolean')
      throw new HttpError(422, 'INVALID_FIELD', 'Opção lembrar de mim inválida.');
    let user: User | null = null;
    try {
      await rateLimit(c, 'login-ip', ip, isLocal(c) ? 200 : 20, 900);
      await rateLimit(c, 'login-identity', `${ip}|${email}`, 10, 900);
      await checkLoginChallenge(c, email, data.turnstile_token);
      user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<User>();
      const valid = await verifyPassword(password, user?.password_hash, c.env);
      if (!user || !valid) {
        await recordLoginFailure(c, email);
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
      }
      await clearFailureLimit(c, 'login-account-failure', email);
      if (passwordNeedsUpgrade(user.password_hash, c.env)) {
        const updated = await c.env.DB.prepare(
          'UPDATE users SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=? AND password_hash=? RETURNING *',
        )
          .bind(await hashPassword(password, c.env), now(), user.id, user.password_hash)
          .first<User>();
        if (!updated) throw new HttpError(409, 'AUTH_STATE_CHANGED', 'Reinicie o login.');
        user = updated;
        // The password-change trigger revoked this account's sessions, including
        // the one loaded for this request. MFA needs a live pre-auth session.
        if (user.role === 'admin' && c.session?.user_id === user.id) await newSession(c, null);
      }
      if (user.role === 'admin') {
        const response = await startAdminChallenge(c, user, data.remember === true, data.next);
        await securityEvent(c, 'login_password', 'success', user.id, email);
        return response;
      }
      await newSession(c, user, data.remember === true);
      await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), user.id).run();
      await securityEvent(c, 'login', 'success', user.id, email);
      return json({
        success: true,
        user: publicUser(user),
        csrf_token: c.session!.csrf_token,
        redirect: safePath(data.next),
      });
    } catch (error) {
      await securityEvent(c, 'login', 'failure', user?.id ?? null, email);
      throw error;
    }
  }
  if (route === 'forgot-password') {
    const data = await body(c, ['email']);
    const email = normalizeEmail(string(data, 'email', 254));
    await rateLimit(c, 'reset-ip', ip, 8, 900);
    await rateLimit(c, 'reset-email', email, 3, 900);
    // Resposta e latência HTTP independentes de conta existente/envio do provedor.
    c.ctx.waitUntil(
      requestReset(c, email).catch((error) => {
        console.warn(error instanceof HttpError ? error.code : 'PASSWORD_RESET_UNAVAILABLE');
      }),
    );
    return json({
      success: true,
      message: 'Se existir uma conta com este e-mail, enviaremos as instruções para redefinir sua senha.',
    });
  }
  if (route === 'reset-password') {
    const data = await body(c, ['token', 'password', 'password_confirmation']);
    await rateLimit(c, 'reset-validation', ip, 20, 900);
    const token = string(data, 'token', 128);
    const password = string(data, 'password', 128);
    validatePassword(password, string(data, 'password_confirmation', 128));
    if (!tokenShape(token)) throw invalidToken();
    const hash = await sha256(token);
    const time = now();
    if (
      !(await c.env.DB.prepare(
        'SELECT 1 FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
      )
        .bind(hash, time)
        .first())
    )
      throw invalidToken();
    const passwordHash = await hashPassword(password, c.env);
    // Trigger da migration revoga todas as sessões e tokens, dentro do UPDATE atômico.
    const updated = await c.env.DB.prepare(
      `UPDATE users SET password_hash=?,session_version=session_version+1,updated_at=?
   WHERE id=(SELECT user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?) RETURNING id`,
    )
      .bind(passwordHash, now(), hash, now())
      .first();
    if (!updated) throw invalidToken();
    await logout(c);
    return json({
      success: true,
      message: 'Senha redefinida com segurança. Entre novamente.',
      redirect: '/login?reset=success',
    });
  }
  throw new HttpError(404, 'NOT_FOUND', 'Recurso não encontrado.');
}
function invalidToken() {
  return new HttpError(422, 'INVALID_RESET_TOKEN', 'Este link é inválido, expirou ou já foi utilizado.');
}
async function requestReset(c: Context, email: string): Promise<void> {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<User>();
  if (!user) return;
  const token = randomToken();
  const hash = await sha256(token);
  const time = now();
  const url = resetURL(c.env, token);
  const inserted = await c.env.DB.prepare(
    'INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) SELECT ?,id,?,? FROM users WHERE id=? AND email=? AND password_hash=? AND session_version=?',
  )
    .bind(hash, time + 1200, time, user.id, user.email, user.password_hash, user.session_version)
    .run();
  if (inserted.meta.changes !== 1) return;
  try {
    await sendPasswordReset(c.env, user.name, user.email, url);
    // A failed resend must not invalidate the last delivered reset link. Recheck
    // credentials after delivery, and supersede only proofs issued before this
    // one so a slow earlier delivery cannot cancel a newer in-flight request.
    await c.env.DB.prepare(
      'UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL AND rowid<(SELECT rowid FROM password_reset_tokens issued WHERE issued.token_hash=? AND issued.used_at IS NULL) AND EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND password_hash=? AND session_version=?)',
    )
      .bind(now(), user.id, hash, user.id, user.email, user.password_hash, user.session_version)
      .run();
  } catch {
    await c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE token_hash=?').bind(hash).run();
    throw new Error('reset unavailable');
  }
}
