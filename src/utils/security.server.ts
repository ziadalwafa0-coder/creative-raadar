import crypto from 'node:crypto';
import { isSafeExternalUrl, sanitizeCsvField } from './security.client.ts';

export { isSafeExternalUrl, sanitizeCsvField };

/**
 * Computes SHA-256 hash from a buffer or string (Server-only).
 */
export function computeSha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
