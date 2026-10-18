import type { Context } from '../types';
import { configInt, frontendOrigin, HttpError, secret } from '../http';
import { equal, hmac } from './crypto';
import { failureCount, reserveAttempt } from './rate-limit';

const scope = 'login-account-failure';
const action = 'login';
const siteverify = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface LoginChallenge {
  site_key: string;
  action: string;
  cdata: string;
}
export class LoginChallengeError extends HttpError {
  constructor(
    code: string,
    public challenge: LoginChallenge,
  ) {
    super(
      code === 'TURNSTILE_UNAVAILABLE' ? 503 : 403,
      code,
      code === 'TURNSTILE_UNAVAILABLE'
        ? 'Verificação temporariamente indisponível. Tente novamente.'
        : 'Conclua a verificação de segurança e tente entrar novamente.',
    );
  }
}

export function loginTurnstileConfiguration(c: Context) {
  const mode = c.env.LOGIN_TURNSTILE_MODE ?? 'disabled';
  if (mode === 'disabled') return null;
  const siteKey = c.env.TURNSTILE_SITE_KEY ?? '';
  const secretKey = c.env.TURNSTILE_SECRET_KEY ?? '';
  if (
    mode !== 'adaptive' ||
    !/^[A-Za-z0-9_-]{3,256}$/.test(siteKey) ||
    secretKey.length < 10 ||
    secretKey.length > 2048
  )
    throw new HttpError(503, 'TURNSTILE_CONFIGURATION_REQUIRED', 'Verificação de login não configurada.');
  return {
    siteKey,
    secretKey,
    hostname: new URL(frontendOrigin(c)).hostname,
    threshold: configInt(c.env.LOGIN_TURNSTILE_FAILURE_THRESHOLD, 5, 1, 100),
    seconds: configInt(c.env.LOGIN_TURNSTILE_WINDOW_SECONDS, 900, 60, 3600),
  };
}

/** Saturation asks for a challenge, never denies this identity a password check. */
export async function checkLoginChallenge(c: Context, email: string, token: unknown): Promise<void> {
  const config = loginTurnstileConfiguration(c);
  if (!config) return;
  const required = (await failureCount(c, scope, email)) >= config.threshold;
  if (!required && (token === undefined || token === '')) return;
  const challenge: LoginChallenge = {
    site_key: config.siteKey,
    action,
    // Correlate only within this challenge. No raw email/session identifier is
    // sent to the widget or Siteverify; CSRF survives ordinary cookie rotation.
    cdata: await hmac(`turnstile-login\0${email}\0${c.session!.csrf_token}`, secret(c.env, 'SESSION_SECRET')),
  };
  if (token === undefined || token === '') throw new LoginChallengeError('TURNSTILE_REQUIRED', challenge);
  if (typeof token !== 'string' || !/^[!-~]{1,2048}$/.test(token))
    throw new LoginChallengeError('TURNSTILE_INVALID', challenge);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(siteverify, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret: config.secretKey, response: token }),
      signal: controller.signal,
    });
    const result = await readVerification(response);
    if (typeof result.success !== 'boolean') throw new Error('invalid verification');
    if (result.success === false) {
      const codes = result['error-codes'];
      if (
        Array.isArray(codes) &&
        codes.some((code) =>
          ['internal-error', 'invalid-input-secret', 'missing-input-secret', 'bad-request'].includes(code),
        )
      )
        throw new Error('verification unavailable');
      throw new LoginChallengeError('TURNSTILE_INVALID', challenge);
    }
    const issued = typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN;
    const age = Date.now() - issued;
    if (
      result.hostname !== config.hostname ||
      result.action !== action ||
      typeof result.cdata !== 'string' ||
      !equal(result.cdata, challenge.cdata) ||
      !Number.isFinite(issued) ||
      age < -60000 ||
      age >= 300000
    )
      throw new LoginChallengeError('TURNSTILE_INVALID', challenge);
    // Never cache a successful token or issue a reusable bypass. Siteverify's
    // single-use check must pass for each password attempt carrying a token.
  } catch (error) {
    if (error instanceof LoginChallengeError) throw error;
    throw new LoginChallengeError('TURNSTILE_UNAVAILABLE', challenge);
  } finally {
    clearTimeout(timeout);
  }
}

async function readVerification(response: Response): Promise<Record<string, unknown>> {
  if (
    !response.ok ||
    !response.headers.get('Content-Type')?.toLowerCase().includes('application/json') ||
    Number(response.headers.get('Content-Length')) > 16384
  ) {
    await response.body?.cancel();
    throw new Error('invalid verification');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty verification');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0,
    text = '',
    done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > 16384) throw new Error('oversized verification');
      text += decoder.decode(chunk.value, { stream: true });
    }
    const result = JSON.parse(text + decoder.decode());
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('invalid verification');
    return result;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}

export async function recordLoginFailure(c: Context, email: string): Promise<void> {
  const config = loginTurnstileConfiguration(c);
  try {
    await reserveAttempt(c, scope, email, Math.max(10, config?.threshold ?? 10), config?.seconds ?? 60);
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'RATE_LIMIT_EXCEEDED')) throw error;
  }
}
