import crypto from 'node:crypto';

/**
 * Validates whether an external URL is safe to fetch, guarding against SSRF.
 * Blocks private IP ranges, loopback addresses, link-local addresses (e.g. AWS/GCP metadata),
 * non-http/https schemes, and credential embedding.
 */
export function isSafeExternalUrl(rawUrl: string): { safe: boolean; reason?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'Empty or invalid URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Only allow http and https protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  // Disallow userinfo (username:password@hostname)
  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URL contains userinfo authentication credentials' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Localhost checks
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    return { safe: false, reason: 'Localhost and loopback destinations are prohibited' };
  }

  // Check IPv4 numerical patterns
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Regex);
  if (match) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((oct) => oct < 0 || oct > 255)) {
      return { safe: false, reason: 'Invalid IP address' };
    }

    const [a, b] = octets;

    // 127.0.0.0/8 - Loopback
    if (a === 127) return { safe: false, reason: 'Loopback IP prohibited' };

    // 10.0.0.0/8 - Private Class A
    if (a === 10) return { safe: false, reason: 'Private network (10.0.0.0/8) prohibited' };

    // 172.16.0.0/12 - Private Class B
    if (a === 172 && b >= 16 && b <= 31) {
      return { safe: false, reason: 'Private network (172.16.0.0/12) prohibited' };
    }

    // 192.168.0.0/16 - Private Class C
    if (a === 192 && b === 168) {
      return { safe: false, reason: 'Private network (192.168.0.0/16) prohibited' };
    }

    // 169.254.0.0/16 - Link-local / Cloud metadata (e.g., 169.254.169.254)
    if (a === 169 && b === 254) {
      return { safe: false, reason: 'Cloud metadata / Link-local address prohibited' };
    }

    // 0.0.0.0/8
    if (a === 0) return { safe: false, reason: 'Invalid destination IP (0.0.0.0)' };
  }

  // Cloud metadata domain blocks
  if (hostname.includes('metadata.google.internal') || hostname.includes('169.254.169.254')) {
    return { safe: false, reason: 'Cloud metadata service access prohibited' };
  }

  return { safe: true };
}

/**
 * Sanitizes a field for CSV export to prevent CSV formula injection (CVE / CWE-1236).
 * Prepends a single quote if the field begins with '=', '+', '-', '@', tab, or carriage return.
 */
export function sanitizeCsvField(field: unknown): string {
  if (field === null || field === undefined) {
    return '""';
  }

  let text = String(field);

  // If text starts with dangerous formula characters, prefix with single quote
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  // Double up any quotes and wrap in quotes
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Computes SHA-256 hash from a buffer or string.
 */
export function computeSha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
