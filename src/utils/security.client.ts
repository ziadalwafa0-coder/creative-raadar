/**
 * Browser-safe security utilities (no Node.js built-ins).
 * Validates external URLs against SSRF and sanitizes CSV fields against formula injection.
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

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  if (parsed.username || parsed.password) {
    return { safe: false, reason: 'URL contains userinfo authentication credentials' };
  }

  const hostname = parsed.hostname.toLowerCase();

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

  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Regex);
  if (match) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((oct) => oct < 0 || oct > 255)) {
      return { safe: false, reason: 'Invalid IP address' };
    }

    const [a, b] = octets;
    if (a === 127) return { safe: false, reason: 'Loopback IP prohibited' };
    if (a === 10) return { safe: false, reason: 'Private network (10.0.0.0/8) prohibited' };
    if (a === 172 && b >= 16 && b <= 31) {
      return { safe: false, reason: 'Private network (172.16.0.0/12) prohibited' };
    }
    if (a === 192 && b === 168) {
      return { safe: false, reason: 'Private network (192.168.0.0/16) prohibited' };
    }
    if (a === 169 && b === 254) {
      return { safe: false, reason: 'Cloud metadata / Link-local address prohibited' };
    }
    if (a === 0) return { safe: false, reason: 'Invalid destination IP (0.0.0.0)' };
  }

  if (hostname.includes('metadata.google.internal') || hostname.includes('169.254.169.254')) {
    return { safe: false, reason: 'Cloud metadata service access prohibited' };
  }

  return { safe: true };
}

export function sanitizeCsvField(field: unknown): string {
  if (field === null || field === undefined) {
    return '""';
  }

  let text = String(field);

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}
