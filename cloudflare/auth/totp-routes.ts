import type { Context, User } from '../types';
import { body, HttpError, json, now, safePath, string } from '../http';
import { randomToken, sha256 } from './crypto';
import { csrf, newSession, requireAdmin } from './sessions';
import { clientIP, rateLimit, reserveTotpAttempt } from './rate-limit';
import { securityEvent } from './security-events';
import {
  decryptTotp,
  encryptTotp,
  newRecoveryCodes,
  newTotpSecret,
  recoveryHash,
  requireTotpKey,
  verifyTotp,
} from './totp';

type Stage = 'setup' | 'verify' | 'recovery_setup';
type Challenge = {
  challenge_hash: string;
  user_id: number;
  session_hash: string;
  session_version: number;
  stage: Stage;
  pending_secret_encrypted: string | null;
  remember: number;
  next_path: string;
  attempts: number;
  expires_at: number;
  consumed_at: number | null;
};
type Credential = { secret_encrypted: string; last_used_step: number };
const invalid = () =>
  new HttpError(
    401,
    'INVALID_TOTP_CHALLENGE',
    'Etapa de autenticação inválida ou expirada. Reinicie o login.',
  );
const invalidCode = () => new HttpError(422, 'INVALID_TOTP_CODE', 'Código inválido ou já utilizado.');

export async function startAdminChallenge(
  c: Context,
  user: User,
  remember: boolean,
  next: unknown,
): Promise<Response> {
  await requireTotpKey(c.env);
  const token = randomToken();
  const hash = await sha256(token);
  const session = c.session;
  if (!session) throw invalid();
  const credential = await c.env.DB.prepare('SELECT 1 FROM admin_totp WHERE user_id=?').bind(user.id).first();
  const stage: Stage = credential ? 'verify' : 'setup';
  const time = now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM admin_totp_challenges WHERE user_id=? OR session_hash=?').bind(
      user.id,
      session.token_hash,
    ),
    c.env.DB.prepare(
      `INSERT INTO admin_totp_challenges(challenge_hash,user_id,session_hash,session_version,stage,remember,next_path,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(
      hash,
      user.id,
      session.token_hash,
      user.session_version,
      stage,
      Number(remember),
      safePath(next),
      time + 300,
      time,
    ),
  ]);
  return json({
    success: true,
    stage: stage === 'setup' ? 'totp_setup' : 'totp',
    challenge: token,
    expires_in: 300,
  });
}

async function challenge(
  c: Context,
  token: string,
  allowed: Stage[],
): Promise<{ row: Challenge; user: User }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !c.session || c.session.read_only) throw invalid();
  const row = await c.env.DB.prepare('SELECT * FROM admin_totp_challenges WHERE challenge_hash=?')
    .bind(await sha256(token))
    .first<Challenge>();
  if (
    !row ||
    row.session_hash !== c.session.token_hash ||
    row.expires_at <= now() ||
    row.consumed_at !== null ||
    row.attempts >= 5 ||
    !allowed.includes(row.stage)
  )
    throw invalid();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(row.user_id).first<User>();
  if (!user || user.role !== 'admin' || user.session_version !== row.session_version) throw invalid();
  return { row, user };
}

async function failure(c: Context, row: Challenge): Promise<never> {
  await c.env.DB.prepare(
    'UPDATE admin_totp_challenges SET attempts=attempts+1 WHERE challenge_hash=? AND consumed_at IS NULL',
  )
    .bind(row.challenge_hash)
    .run();
  throw invalidCode();
}

async function complete(c: Context, row: Challenge, user: User): Promise<Response> {
  await newSession(c, user, row.remember === 1, false, now());
  await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), user.id).run();
  return json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    csrf_token: c.session!.csrf_token,
    redirect: row.next_path,
  });
}

export async function totpRoute(c: Context, route: string): Promise<Response> {
  let accountId: number | null = null;
  let eventType = `totp_${route}`;
  try {
    const response = await totpRouteInner(
      c,
      route,
      (id) => {
        accountId = id;
      },
      (type) => {
        eventType = type;
      },
    );
    await securityEvent(c, eventType, 'success', accountId);
    return response;
  } catch (error) {
    await securityEvent(c, eventType, 'failure', accountId);
    throw error;
  }
}

async function totpRouteInner(
  c: Context,
  route: string,
  onAccount: (id: number) => void,
  onEvent: (type: string) => void,
): Promise<Response> {
  csrf(c);
  await rateLimit(c, 'admin-totp-ip', clientIP(c), 30, 900);
  if (route === 'reauth') {
    const user = requireAdmin(c);
    onAccount(user.id);
    await reserveTotpAttempt(c, user.id);
    const data = await body(c, ['code']);
    const code = string(data, 'code', 8);
    const credential = await c.env.DB.prepare('SELECT * FROM admin_totp WHERE user_id=?')
      .bind(user.id)
      .first<Credential>();
    if (!credential) throw invalid();
    const secret = await decryptTotp(c.env, user.id, credential.secret_encrypted);
    const step = await verifyTotp(secret, code, credential.last_used_step);
    if (step === null) throw invalidCode();
    const updated = await c.env.DB.prepare(
      'UPDATE admin_totp SET last_used_step=? WHERE user_id=? AND last_used_step<? RETURNING user_id',
    )
      .bind(step, user.id, step)
      .first();
    if (!updated) throw invalidCode();
    const time = now();
    const session = await c.env.DB.prepare(
      'UPDATE sessions SET admin_mfa_at=? WHERE token_hash=? AND user_id=? AND admin_mfa_at IS NOT NULL RETURNING token_hash',
    )
      .bind(time, c.session!.token_hash, user.id)
      .first();
    if (!session) throw invalid();
    c.session!.admin_mfa_at = time;
    return json({ success: true, expires_in: 300 });
  }
  const data = await body(
    c,
    route === 'setup'
      ? ['challenge']
      : route === 'confirm'
        ? ['challenge', 'code']
        : ['challenge', 'code', 'recovery_code'],
  );
  const token = string(data, 'challenge', 128);
  const { row, user } = await challenge(
    c,
    token,
    route === 'setup' || route === 'confirm' ? ['setup', 'recovery_setup'] : ['verify'],
  );
  onAccount(user.id);
  await rateLimit(c, 'admin-totp-user', String(user.id), 30, 900);
  if (route !== 'setup') await reserveTotpAttempt(c, user.id);
  if (route === 'setup') {
    if (row.pending_secret_encrypted) throw invalid();
    const existing = await c.env.DB.prepare('SELECT 1 FROM admin_totp WHERE user_id=?').bind(user.id).first();
    if (Boolean(existing) !== (row.stage === 'recovery_setup')) throw invalid();
    const secret = newTotpSecret();
    const encrypted = await encryptTotp(c.env, user.id, secret);
    const updated = await c.env.DB.prepare(
      'UPDATE admin_totp_challenges SET pending_secret_encrypted=? WHERE challenge_hash=? AND pending_secret_encrypted IS NULL AND consumed_at IS NULL RETURNING challenge_hash',
    )
      .bind(encrypted, row.challenge_hash)
      .first();
    if (!updated) throw invalid();
    const label = encodeURIComponent(`Hidra R3B:${user.email}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Hidra R3B')}&algorithm=SHA1&digits=6&period=30`;
    return json({ success: true, secret, uri });
  }
  if (route === 'confirm') {
    if (!row.pending_secret_encrypted) throw invalid();
    const code = string(data, 'code', 8);
    const secret = await decryptTotp(c.env, user.id, row.pending_secret_encrypted);
    const step = await verifyTotp(secret, code);
    if (step === null) return failure(c, row);
    const existing = await c.env.DB.prepare('SELECT 1 FROM admin_totp WHERE user_id=?').bind(user.id).first();
    if (Boolean(existing) !== (row.stage === 'recovery_setup')) throw invalid();
    const consumed = await c.env.DB.prepare(
      'UPDATE admin_totp_challenges SET consumed_at=? WHERE challenge_hash=? AND consumed_at IS NULL AND attempts<5 RETURNING challenge_hash',
    )
      .bind(now(), row.challenge_hash)
      .first();
    if (!consumed) throw invalid();
    const codes = newRecoveryCodes();
    const time = now();
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO admin_totp(user_id,secret_encrypted,last_used_step,created_at) VALUES (?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,last_used_step=excluded.last_used_step,created_at=excluded.created_at`,
      ).bind(user.id, row.pending_secret_encrypted, step, time),
      c.env.DB.prepare('DELETE FROM admin_totp_recovery WHERE user_id=?').bind(user.id),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
    ];
    for (const recovery of codes)
      statements.push(
        c.env.DB.prepare('INSERT INTO admin_totp_recovery(code_hash,user_id,created_at) VALUES (?,?,?)').bind(
          await recoveryHash(user.id, recovery),
          user.id,
          time,
        ),
      );
    await c.env.DB.batch(statements);
    await newSession(c, user, row.remember === 1, false, time);
    await c.env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(time, user.id).run();
    return json({
      success: true,
      recovery_codes: codes,
      csrf_token: c.session!.csrf_token,
      redirect: row.next_path,
    });
  }
  const code = data.code === undefined ? '' : string(data, 'code', 8);
  const recovery = data.recovery_code === undefined ? '' : string(data, 'recovery_code', 64);
  if (recovery) onEvent('totp_recovery');
  if (Boolean(code) === Boolean(recovery)) return failure(c, row);
  const credential = await c.env.DB.prepare('SELECT * FROM admin_totp WHERE user_id=?')
    .bind(user.id)
    .first<Credential>();
  if (!credential) throw invalid();
  if (recovery) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(recovery)) return failure(c, row);
    const used = await c.env.DB.prepare(
      'UPDATE admin_totp_recovery SET used_at=? WHERE code_hash=? AND user_id=? AND used_at IS NULL RETURNING code_hash',
    )
      .bind(now(), await recoveryHash(user.id, recovery), user.id)
      .first();
    if (!used) return failure(c, row);
    await c.env.DB.prepare(
      "UPDATE admin_totp_challenges SET stage='recovery_setup',attempts=0 WHERE challenge_hash=? AND consumed_at IS NULL",
    )
      .bind(row.challenge_hash)
      .run();
    return json({
      success: true,
      stage: 'totp_setup',
      challenge: token,
      expires_in: Math.max(0, row.expires_at - now()),
    });
  }
  const secret = await decryptTotp(c.env, user.id, credential.secret_encrypted);
  const step = await verifyTotp(secret, code, credential.last_used_step);
  if (step === null) return failure(c, row);
  const updated = await c.env.DB.prepare(
    'UPDATE admin_totp SET last_used_step=? WHERE user_id=? AND last_used_step<? RETURNING user_id',
  )
    .bind(step, user.id, step)
    .first();
  if (!updated) return failure(c, row);
  const consumed = await c.env.DB.prepare(
    'UPDATE admin_totp_challenges SET consumed_at=? WHERE challenge_hash=? AND consumed_at IS NULL AND attempts<5 RETURNING challenge_hash',
  )
    .bind(now(), row.challenge_hash)
    .first();
  if (!consumed) throw invalid();
  return complete(c, row, user);
}
