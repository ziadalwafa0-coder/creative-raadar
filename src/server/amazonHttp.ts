import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { SCRAPER_PROXY_URL, SCRAPER_API_KEY } from './config.ts';
import { isSafeExternalUrl } from '../utils/security.server.ts';

/**
 * Shared undici Agent with keep-alive and connection pool for all Amazon HTTP requests.
 */
export const amazonUndiciAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  pipelining: 1,
  connect: {
    timeout: 8_000,
  },
});

let proxyAgentInstance: ProxyAgent | null = null;
function getProxyAgent(): ProxyAgent | null {
  if (!SCRAPER_PROXY_URL) return null;
  if (!proxyAgentInstance) {
    try {
      proxyAgentInstance = new ProxyAgent(SCRAPER_PROXY_URL);
    } catch (err) {
      console.warn('[AmazonHttp] Invalid SCRAPER_PROXY_URL:', (err as Error)?.message);
      return null;
    }
  }
  return proxyAgentInstance;
}

export class AmazonBlockError extends Error {
  public readonly code = 'AMAZON_BLOCKED';
  public readonly status: number;
  public readonly url: string;
  public readonly arabicReason = 'أمازون حظر الطلب';

  constructor(url: string, status: number, detail: string) {
    super(`Amazon blocked request (${status}) for ${url}: ${detail}`);
    this.name = 'AmazonBlockError';
    this.status = status;
    this.url = url;
  }
}

export class AmazonNetworkError extends Error {
  public readonly code = 'AMAZON_NETWORK_ERROR';
  public readonly url: string;

  constructor(url: string, causeMessage: string) {
    super(`Amazon network error for ${url}: ${causeMessage}`);
    this.name = 'AmazonNetworkError';
    this.url = url;
  }
}

const CHROME_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
] as const;

export const AMAZON_CHROME_USER_AGENT = CHROME_USER_AGENTS[0];

export const AMAZON_US_HEADERS: Record<string, string> = {
  'User-Agent': AMAZON_CHROME_USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export const AMAZON_US_PRODUCT_PAGE_HEADERS: Record<string, string> = {
  ...AMAZON_US_HEADERS,
  Referer: 'https://www.amazon.com/',
  'Sec-Fetch-Site': 'same-origin',
};

// Lightweight per-domain Cookie Jar
const cookieJar = new Map<string, Map<string, string>>();

function getDomainKey(urlStr: string): string {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    const parts = host.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : host;
  } catch {
    return 'amazon.com';
  }
}

function storeResponseCookies(urlStr: string, headers: { getSetCookie?: () => string[]; get: (k: string) => string | null }): void {
  const domain = getDomainKey(urlStr);
  let domainCookies = cookieJar.get(domain);
  if (!domainCookies) {
    domainCookies = new Map<string, string>();
    cookieJar.set(domain, domainCookies);
  }

  let rawCookies: string[] = [];
  if (typeof headers.getSetCookie === 'function') {
    rawCookies = headers.getSetCookie();
  } else {
    const single = headers.get('set-cookie');
    if (single) rawCookies = [single];
  }

  for (const cookieStr of rawCookies) {
    const firstPart = cookieStr.split(';')[0]?.trim();
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (name && val && val !== '""' && val !== 'deleted') {
        domainCookies.set(name, val);
      }
    }
  }
}

function getCookieHeader(urlStr: string): string {
  const domain = getDomainKey(urlStr);
  const domainCookies = cookieJar.get(domain);
  if (!domainCookies || domainCookies.size === 0) {
    return 'i18n-prefs=USD; lc-main=en_US';
  }
  const pairs: string[] = ['i18n-prefs=USD', 'lc-main=en_US'];
  for (const [k, v] of domainCookies.entries()) {
    if (k !== 'i18n-prefs' && k !== 'lc-main') {
      pairs.push(`${k}=${v}`);
    }
  }
  return pairs.join('; ');
}

export function detectAmazonBlock(
  status: number,
  html: string,
  minHtmlChars = 5000
): { blocked: boolean; reason?: string } {
  if (status === 429 || status === 503) {
    return { blocked: true, reason: `HTTP status ${status}` };
  }
  const lower = html.toLowerCase();
  if (
    lower.includes('validatecaptcha') ||
    lower.includes('api-services-support@amazon.com') ||
    lower.includes('type the characters you see in this image') ||
    lower.includes('enter the characters you see below') ||
    lower.includes('sorry, we just need to make sure you\'re not a robot') ||
    lower.includes('<title dir="ltr">robot check</title>')
  ) {
    return { blocked: true, reason: 'CAPTCHA / Robot Check page' };
  }
  if (html.trim().length < minHtmlChars) {
    return { blocked: true, reason: `HTML body too short (${html.trim().length} < ${minHtmlChars} chars)` };
  }
  return { blocked: false };
}

function buildScraperApiUrl(targetUrl: string): string | null {
  if (!SCRAPER_API_KEY) return null;
  if (SCRAPER_API_KEY.startsWith('http://') || SCRAPER_API_KEY.startsWith('https://')) {
    return `${SCRAPER_API_KEY}${encodeURIComponent(targetUrl)}`;
  }
  return `https://api.scraperapi.com/?api_key=${encodeURIComponent(SCRAPER_API_KEY)}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
}

export interface FetchAmazonHtmlOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  minHtmlChars?: number;
  referer?: string;
}

/**
 * Fetches an Amazon HTML page using the shared undici Agent, realistic Chrome headers, and cookie jar.
 * Automatically detects blocks (503/429/CAPTCHA/html<5000 chars) and retries via SCRAPER_PROXY_URL / SCRAPER_API_KEY if configured.
 */
export async function fetchAmazonHtml(
  url: string,
  options: FetchAmazonHtmlOptions = {}
): Promise<string> {
  const safeCheck = isSafeExternalUrl(url);
  if (!safeCheck.safe) {
    throw new AmazonNetworkError(url, `Unsafe URL: ${safeCheck.reason}`);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const minHtmlChars = options.minHtmlChars ?? 5000;

  const attemptFetch = async (
    targetUrl: string,
    uaIndex: number,
    dispatcher: Dispatcher
  ): Promise<{ status: number; html: string }> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const domainCookies = cookieJar.get(getDomainKey(url));
    const hasSessionCookies = Boolean(domainCookies && domainCookies.size > 0);

    const headers: Record<string, string> = {
      ...AMAZON_US_HEADERS,
      'User-Agent': CHROME_USER_AGENTS[uaIndex % CHROME_USER_AGENTS.length],
      Cookie: getCookieHeader(url),
    };
    if (options.referer && hasSessionCookies) {
      headers.Referer = options.referer;
      headers['Sec-Fetch-Site'] = 'same-origin';
    }

    const res = await undiciFetch(targetUrl, {
      method: 'GET',
      headers,
      dispatcher,
      signal,
      redirect: 'follow',
    });

    storeResponseCookies(url, res.headers as any);
    const html = await res.text();
    return { status: res.status, html };
  };

  let lastBlockReason = '';
  let lastStatus = 0;

  // Attempt 1: Direct with shared keep-alive undici agent
  try {
    const { status, html } = await attemptFetch(url, 0, amazonUndiciAgent);
    lastStatus = status;
    const check = detectAmazonBlock(status, html, minHtmlChars);
    if (!check.blocked && status >= 200 && status < 400) {
      return html;
    }
    lastBlockReason = check.reason || `HTTP ${status}`;
    console.warn(`[AmazonHttp] Direct attempt blocked on ${url}: ${lastBlockReason}`);
  } catch (err: unknown) {
    if (options.signal?.aborted) throw err;
    console.warn(`[AmazonHttp] Direct fetch error on ${url}:`, (err as Error)?.message || err);
    lastBlockReason = (err as Error)?.message || 'Network failure';
  }

  // Attempt 2: Retry through SCRAPER_API_KEY or SCRAPER_PROXY_URL if configured
  const scraperApiUrl = buildScraperApiUrl(url);
  const proxyAgent = getProxyAgent();

  if (scraperApiUrl || proxyAgent) {
    try {
      const target = scraperApiUrl || url;
      const dispatcher = proxyAgent || amazonUndiciAgent;
      const { status, html } = await attemptFetch(target, 1, dispatcher);
      lastStatus = status;
      const check = detectAmazonBlock(status, html, minHtmlChars);
      if (!check.blocked && status >= 200 && status < 400) {
        return html;
      }
      lastBlockReason = check.reason || `Proxy HTTP ${status}`;
      console.warn(`[AmazonHttp] Proxy retry blocked on ${url}: ${lastBlockReason}`);
    } catch (err: unknown) {
      if (options.signal?.aborted) throw err;
      console.warn(`[AmazonHttp] Proxy retry error on ${url}:`, (err as Error)?.message || err);
    }
  } else {
    // Warm session cookies and retry with alternate Chrome profile after short jitter
    try {
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 200)));
      const { status, html } = await attemptFetch(url, 1, amazonUndiciAgent);
      lastStatus = status;
      const check = detectAmazonBlock(status, html, minHtmlChars);
      if (!check.blocked && status >= 200 && status < 400) {
        return html;
      }
      lastBlockReason = check.reason || `Retry HTTP ${status}`;
    } catch (err: unknown) {
      if (options.signal?.aborted) throw err;
      throw new AmazonNetworkError(url, (err as Error)?.message || String(err));
    }
  }

  throw new AmazonBlockError(url, lastStatus || 503, lastBlockReason || 'Blocked by Amazon');
}

export async function fetchProductImageAsBase64(
  imageUrl?: string,
  signal?: AbortSignal
): Promise<{ base64: string; mimeType: string } | null> {
  if (!imageUrl || !isSafeExternalUrl(imageUrl).safe) return null;
  try {
    const timeoutSig = AbortSignal.timeout(4000);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await undiciFetch(imageUrl, {
      headers: {
        'User-Agent': AMAZON_CHROME_USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      dispatcher: amazonUndiciAgent,
      signal: combinedSig,
    });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength < 100 || arrayBuffer.byteLength > 8 * 1024 * 1024) return null;
    return {
      base64: Buffer.from(arrayBuffer).toString('base64'),
      mimeType,
    };
  } catch (err: unknown) {
    console.warn(`[AmazonHttp] Failed to fetch image ${imageUrl}:`, (err as Error)?.message || err);
    return null;
  }
}
