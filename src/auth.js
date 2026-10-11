import { HttpError, randomToken, sha256Hex } from './util.js';

const ITERATIONS = 100000; // Workers' WebCrypto caps PBKDF2 at 100k iterations
const SESSION_DAYS = 14;
export const MIN_PASSWORD = 10;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Used so unknown emails cost the same as wrong passwords.
const DUMMY_HASH = `pbkdf2$${ITERATIONS}$${b64(new Uint8Array(16))}$${b64(new Uint8Array(32))}`;

export async function verifyPassword(password, stored) {
  const [scheme, iters, salt, hash] = (stored || DUMMY_HASH).split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = await derive(password, unb64(salt), Number(iters));
  const ok = timingSafeEqual(new Uint8Array(bits), unb64(hash));
  return ok && stored !== undefined && stored !== null;
}

export function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD)
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
}

export async function createSession(env, userId) {
  const token = randomToken(32);
  await env.DB
    .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(await sha256Hex(token), userId, `+${SESSION_DAYS} days`)
    .run();
  return token;
}

export function sessionCookie(token, url, maxAge = SESSION_DAYS * 86400) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export const sessionToken = (request) => cookieValue(request, 'sid');

/** Returns the signed-in user (or null). Also opportunistically purges expired sessions. */
export async function currentUser(env, request) {
  const token = sessionToken(request);
  if (!token) return null;
  const row = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled = 0`,
    )
    .bind(await sha256Hex(token))
    .first();
  return row || null;
}

export async function destroySession(env, token) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export async function purgeExpired(env) {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  await env.DB.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')`).run();
}

const MAX_FAILED = 8;

export async function assertNotThrottled(env, email) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND created_at > datetime('now', '-15 minutes')`)
    .bind(email)
    .first();
  if (row.n >= MAX_FAILED) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
}

export const recordFailure = (env, email) =>
  env.DB.prepare('INSERT INTO login_attempts (email) VALUES (?)').bind(email).run();

export const clearFailures = (env, email) =>
  env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();

