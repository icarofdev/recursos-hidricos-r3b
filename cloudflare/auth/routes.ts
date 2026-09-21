import type { Context, User } from '../types';
import { body, HttpError, isLocal, json, method, now, safePath, sameOrigin, string } from '../http';
import { hashPassword, randomToken, sha256, validatePassword, verifyPassword } from './crypto';
import { csrf, ensureSession, logout, newSession, publicUser, requireUser } from './sessions';
import { clientIP, rateLimit } from './rate-limit';
import { resetURL, sendPasswordReset } from '../mail/brevo';

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const tokenShape = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export async function authRoute(c: Context, route: string): Promise<Response> {
  const ip = clientIP(c);
  if (route === 'me') {
    method(c, ['GET']);
    return json({ success: true, user: publicUser(requireUser(c)), csrf_token: c.session!.csrf_token });
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
    csrf(c);
    await body(c, []);
    await logout(c);
    return json({ success: true, redirect: '/login' });
  }
  csrf(c);
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
    const user = await c.env.DB.prepare(
      `INSERT INTO users(name,email,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?)
   ON CONFLICT(email) DO NOTHING RETURNING *`,
    )
      .bind(name, email, hash, role, time, time)
      .first<User>();
    if (!user) throw new HttpError(409, 'EMAIL_IN_USE', 'Já existe uma conta com este e-mail.');
    await newSession(c, user);
    return json(
      { success: true, user: publicUser(user), csrf_token: c.session!.csrf_token, redirect: '/' },
      201,
    );
  }
  if (route === 'login') {
    const data = await body(c, ['email', 'password', 'remember', 'next']);
    const email = normalizeEmail(string(data, 'email', 254));
    const password = string(data, 'password', 128);
    if (data.remember !== undefined && typeof data.remember !== 'boolean')
      throw new HttpError(422, 'INVALID_FIELD', 'Opção lembrar de mim inválida.');
    await rateLimit(c, 'login-ip', ip, isLocal(c) ? 200 : 20, 900);
    await rateLimit(c, 'login-identity', `${ip}|${email}`, 10, 900);
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<User>();
    const valid = await verifyPassword(password, user?.password_hash, c.env);
    if (!user || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    await newSession(c, user, data.remember === true);
    await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), user.id).run();
    return json({
      success: true,
      user: publicUser(user),
      csrf_token: c.session!.csrf_token,
      redirect: safePath(data.next),
    });
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
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').bind(
      time,
      user.id,
    ),
    c.env.DB.prepare(
      'INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
    ).bind(hash, user.id, time + 1200, time),
  ]);
  try {
    await sendPasswordReset(c.env, user.name, user.email, url);
  } catch {
    await c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE token_hash=?').bind(hash).run();
    throw new Error('reset unavailable');
  }
}
