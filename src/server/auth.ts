import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { DATA_DIR, CREATIVE_RADAAR_PEPPER, ACCESS_CODE_DIGESTS } from './config.ts';

const SESSIONS_FILE = path.join(DATA_DIR, 'auth_sessions.json');
const SERVER_PEPPER_SALT = CREATIVE_RADAAR_PEPPER;
const PBKDF2_ITERATIONS = 15000;
const ALLOWED_CODE_DIGESTS: readonly string[] = ACCESS_CODE_DIGESTS;

/**
 * Deterministic owner ID for the primary user's normalized code (derived from digest index 1).
 */
export const PRIMARY_USER_OWNER_ID = 'owner_bbe306ae6d1322716e124c1c';

export interface AuthSessionRecord {
  tokenHash: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_FAILED_ATTEMPTS = 5;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const sessionsByTokenHash = new Map<string, AuthSessionRecord>();

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(`${SERVER_PEPPER_SALT}:${rawToken}`).digest('hex');
}

function loadSessionsFromDisk(): void {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(parsed)) {
        for (const rec of parsed) {
          if (rec && rec.tokenHash && rec.ownerId && rec.expiresAt > now) {
            sessionsByTokenHash.set(rec.tokenHash, rec);
          }
        }
      }
    }
  } catch {
    // ignore corrupt session store
  }
}

function saveSessionsToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const now = Date.now();
    const active: AuthSessionRecord[] = [];
    for (const [k, v] of sessionsByTokenHash.entries()) {
      if (v.expiresAt > now) {
        active.push(v);
      } else {
        sessionsByTokenHash.delete(k);
      }
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(active, null, 2), { mode: 0o600 });
  } catch {
    // ignore write errors
  }
}

loadSessionsFromDisk();

export function computeCodeDigest(rawCode: string): Buffer {
  const normalized = String(rawCode || '').trim().toLowerCase();
  return crypto.pbkdf2Sync(normalized, SERVER_PEPPER_SALT, PBKDF2_ITERATIONS, 32, 'sha256');
}

export function verifyAccessCode(rawCode: unknown): { valid: boolean; ownerId?: string } {
  if (typeof rawCode !== 'string') return { valid: false };
  const normalized = rawCode.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 32) {
    return { valid: false };
  }

  const candidateBuf = computeCodeDigest(normalized);
  let matchedDigest: string | null = null;

  for (const hexDigest of ALLOWED_CODE_DIGESTS) {
    const targetBuf = Buffer.from(hexDigest, 'hex');
    if (
      targetBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(targetBuf, candidateBuf)
    ) {
      matchedDigest = hexDigest;
    }
  }

  if (!matchedDigest) {
    return { valid: false };
  }

  return {
    valid: true,
    ownerId: `owner_${matchedDigest.slice(0, 24)}`,
  };
}

export function getRateLimitKey(req: Request): string {
  const customKey = req.headers['x-rate-limit-key'];
  if (typeof customKey === 'string' && customKey.trim()) {
    return `rl_${customKey.trim().slice(0, 64)}`;
  }
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    'unknown';
  return `ip_${ip}`;
}

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt <= now) {
    return { allowed: true };
  }
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true };
}

export function recordFailedLoginAttempt(key: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function resetLoginAttempts(key: string): void {
  rateLimitMap.delete(key);
}

export function clearAllRateLimitsForTests(): void {
  rateLimitMap.clear();
}

const revokedTokenHashes = new Set<string>();

function createSignedToken(ownerId: string, expiresAt: number): string {
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${ownerId}.${expiresAt}.${nonce}`;
  const payloadB64 = Buffer.from(payload, 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SERVER_PEPPER_SALT)
    .update(payloadB64)
    .digest('base64url');
  return `crs_${payloadB64}.${sig}`;
}

function verifySignedToken(rawToken: string): { valid: boolean; ownerId?: string; expiresAt?: number } {
  if (!rawToken.startsWith('crs_') || !rawToken.includes('.')) {
    return { valid: false };
  }
  const body = rawToken.slice(4);
  const dotIdx = body.lastIndexOf('.');
  if (dotIdx <= 0) return { valid: false };
  const payloadB64 = body.slice(0, dotIdx);
  const sig = body.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', SERVER_PEPPER_SALT)
    .update(payloadB64)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false };
  }
  try {
    const decoded = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const [ownerId, expStr] = decoded.split('.');
    const expiresAt = Number(expStr);
    if (!ownerId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { valid: false };
    }
    return { valid: true, ownerId, expiresAt };
  } catch {
    return { valid: false };
  }
}

export function issueAuthSession(
  ownerId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): { token: string; expiresAt: number } {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const rawToken = createSignedToken(ownerId, expiresAt);
  const tokenHash = hashToken(rawToken);

  sessionsByTokenHash.set(tokenHash, {
    tokenHash,
    ownerId,
    createdAt: now,
    expiresAt,
  });
  saveSessionsToDisk();

  return { token: rawToken, expiresAt };
}

export function verifyAuthSession(rawToken: string | undefined): {
  valid: boolean;
  ownerId?: string;
  expiresAt?: number;
} {
  if (!rawToken || typeof rawToken !== 'string' || !rawToken.startsWith('crs_')) {
    return { valid: false };
  }
  const tokenHash = hashToken(rawToken);
  if (revokedTokenHashes.has(tokenHash)) {
    return { valid: false };
  }

  const record = sessionsByTokenHash.get(tokenHash);
  if (record) {
    const now = Date.now();
    if (record.expiresAt <= now) {
      sessionsByTokenHash.delete(tokenHash);
      saveSessionsToDisk();
      return { valid: false };
    }
    return {
      valid: true,
      ownerId: record.ownerId,
      expiresAt: record.expiresAt,
    };
  }

  // Fallback to stateless HMAC verification (for serverless instances / cold starts)
  return verifySignedToken(rawToken);
}

export function revokeAuthSession(rawToken: string | undefined): boolean {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const tokenHash = hashToken(rawToken);
  revokedTokenHashes.add(tokenHash);
  const existed = sessionsByTokenHash.delete(tokenHash);
  if (existed) {
    saveSessionsToDisk();
  }
  return existed || rawToken.includes('.');
}

export function extractAuthToken(req: Request): string | undefined {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }

  // 2. X-Auth-Token header (for iframe / header-only environments)
  const xAuth = req.headers['x-auth-token'];
  if (typeof xAuth === 'string' && xAuth.trim()) {
    return xAuth.trim();
  }

  // 3. HttpOnly Cookie cr_auth_token
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)cr_auth_token=([^;]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  // 4. Signed crs_ token in query parameter (for native <a href> / <video src> in cross-origin iframes)
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim().startsWith('crs_')) {
    return queryToken.trim();
  }

  return undefined;
}
