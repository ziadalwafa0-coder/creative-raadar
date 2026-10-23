import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const SESSIONS_FILE = path.join(DATA_DIR, 'auth_sessions.json');

const SERVER_PEPPER_SALT =
  process.env.CREATIVE_RADAAR_PEPPER || 'creative_radaar_v1_hmac_salt_9f8e7d6c5b4a3210';
const PBKDF2_ITERATIONS = 15000;

/**
 * Only PBKDF2-SHA256 digests of the 16 authorized access codes are stored here.
 * Plaintext codes are never stored in code, logs, client bundles, or responses.
 */
const ALLOWED_CODE_DIGESTS: readonly string[] = [
  '49df6742a19cfb94d2b217ed78283e8bc9829e7c8e435eeb7982dd8badb85805',
  'bbe306ae6d1322716e124c1c2a5640d5246caa9cbc02f74e6f450ed3b6f6e8b8',
  'bc0baad48f83aec2a74046276c928c5198008c91b38350b54f9c9d68239f00fa',
  'd3a12bcfe2f7faa8be79cea700fd46375cfa2da812513264391c7f9241ce920f',
  'cab24a5dc82354231865b1961832669046dbfaa72dc2643f6426eb75fcc318d6',
  'b665b722afed8371d94c4008e6254141cf6030899628617429ac9e90ebb88c86',
  'da1aa887ac4dfb42528182785af4b9f5f6b5663f2bc23969e220c33e67f19e9b',
  'ea1fa0ba0472ed5034d7a7fae264b2f203ac6e503b2caf4d41db6d88798f33e5',
  '2d2764995156f667ce84f42b03d2ef4ac688b0a2e194bd3b1bfd6688fd14d1ec',
  'be81f1652528608e182a0ad7555548832836764ba2a3e923e49b8f6b8180e20e',
  '01912c999c0bdc5fecb15825a3bd4fccffabd2a72dc53b20c6cba8131618e446',
  '204654da50f797b4068f1a8b738b2fe06835fd406543be03becaab0755eb148f',
  'dee9a0c01511257cbe97c1dc59de54bbf0265c15f4007bafe8deb433e51c33fc',
  'e2451d28c3efdf159c13acb252623a85ddd57a55a2909891cbd6014b70657791',
  '5f5842008f0ddc77946ad28c5a19e65d002ecfb839d3fd9ac70184a4cb4a50d2',
  '3c1a0deb1cf91f309272882be66c4a006249eefdaacbc83ec0a31f31b5670223',
];

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

export function issueAuthSession(
  ownerId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): { token: string; expiresAt: number } {
  const rawToken = `crs_${crypto.randomBytes(28).toString('hex')}`;
  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const expiresAt = now + ttlMs;

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
  const record = sessionsByTokenHash.get(tokenHash);
  if (!record) {
    return { valid: false };
  }
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

export function revokeAuthSession(rawToken: string | undefined): boolean {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const tokenHash = hashToken(rawToken);
  const existed = sessionsByTokenHash.delete(tokenHash);
  if (existed) {
    saveSessionsToDisk();
  }
  return existed;
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

  return undefined;
}
