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

export class AmazonDeadListingError extends Error {
  public readonly code = 'AMAZON_DEAD_LISTING';
  public readonly status: number;
  public readonly url: string;
  public readonly reason: string;

  constructor(url: string, status: number, reason: string) {
    super(`Amazon dead listing (${status}) for ${url}: ${reason}`);
    this.name = 'AmazonDeadListingError';
    this.status = status;
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Safari macOS profiles without Sec-Ch-Ua headers avoid CloudFront JA3/Client-Hints mismatch 503s.
 */
const BROWSER_PROFILES = [
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    acceptLanguage: 'en-US,en;q=0.9',
  },
] as const;

let profileRotationCursor = 0;

export const AMAZON_CHROME_USER_AGENT = BROWSER_PROFILES[0].userAgent;

export const AMAZON_US_HEADERS: Record<string, string> = {
  'User-Agent': AMAZON_CHROME_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

export const AMAZON_US_PRODUCT_PAGE_HEADERS: Record<string, string> = {
  ...AMAZON_US_HEADERS,
  Referer: 'https://www.amazon.com/',
};

// Lightweight per-domain Cookie Jar (only stores cookies from verified 200 OK unblocked responses)
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

function storeResponseCookies(
  urlStr: string,
  headers: { getSetCookie?: () => string[]; get: (k: string) => string | null }
): void {
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

function getCookieHeader(urlStr: string): string | undefined {
  const domain = getDomainKey(urlStr);
  const domainCookies = cookieJar.get(domain);
  if (!domainCookies || domainCookies.size === 0) {
    return undefined;
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
    lower.includes("sorry, we just need to make sure you're not a robot") ||
    lower.includes('<title dir="ltr">robot check</title>')
  ) {
    return { blocked: true, reason: 'CAPTCHA / Robot Check page' };
  }
  if (html.trim().length < minHtmlChars) {
    return {
      blocked: true,
      reason: `HTML body too short (${html.trim().length} < ${minHtmlChars} chars)`,
    };
  }
  return { blocked: false };
}

export function isAmazonCaptchaOrRobot(html: string): boolean {
  const lower = (html || '').toLowerCase();
  return (
    lower.includes('validatecaptcha') ||
    lower.includes('api-services-support@amazon.com') ||
    lower.includes('type the characters you see in this image') ||
    lower.includes('enter the characters you see below') ||
    lower.includes("sorry, we just need to make sure you're not a robot") ||
    lower.includes('<title dir="ltr">robot check</title>')
  );
}

/**
 * Checks if the fetched HTML body contains real Amazon product page markers.
 */
export function hasAmazonProductMarker(html: string): boolean {
  if (!html) return false;
  return (
    html.includes('id="productTitle"') ||
    html.includes("id='productTitle'") ||
    html.includes('id="title"') ||
    html.includes('id="dp-container"') ||
    html.includes('id="centerCol"') ||
    html.includes('id="ppd"') ||
    html.includes('data-asin=') ||
    /<h1[^>]*id="title"/i.test(html) ||
    /<span[^>]*id="productTitle"/i.test(html)
  );
}

/**
 * Detects whether an Amazon page response is dead (404, Dogs of Amazon, Page Not Found, or non-product redirect).
 */
export function isAmazonDeadListing(
  status: number,
  html: string,
  url?: string
): { isDead: boolean; reason?: string } {
  // HTTP 429 / 503 are rate-limit / bot blocks (even when Amazon serves the cs_503 Dogs of Amazon page)
  if (status === 429 || status === 503) {
    return { isDead: false };
  }
  const isSearchUrl = Boolean(url && (/\/s\?/i.test(url) || /\/s\/ref=/i.test(url)));
  if (isSearchUrl && status !== 404 && status !== 410) {
    return { isDead: false };
  }
  if (status === 404 || status === 410) {
    return { isDead: true, reason: `HTTP ${status} Not Found` };
  }
  const lower = (html || '').toLowerCase();
  if (
    lower.includes('cs_503') ||
    lower.includes('500_503.png') ||
    lower.includes('something went wrong on our end')
  ) {
    return { isDead: false };
  }
  if (
    lower.includes("we couldn't find that page") ||
    lower.includes("we couldn't find this page") ||
    lower.includes('looking for something?') ||
    lower.includes('page not found') ||
    lower.includes('the web address you entered is not a functioning page on our site') ||
    ((lower.includes('dogs of amazon') || lower.includes('dogs-of-amazon') || lower.includes('meet the dogs of amazon')) &&
      !isAmazonCaptchaOrRobot(html))
  ) {
    return { isDead: true, reason: 'Amazon 404 Dog Page (Page Not Found)' };
  }

  // If this is expected to be a product page (/dp/ or /gp/product/):
  const isProductUrl = url && (url.includes('/dp/') || url.includes('/gp/product/'));
  if (isProductUrl && status >= 200 && status < 300) {
    if (isAmazonCaptchaOrRobot(html)) {
      return { isDead: false };
    }
    if (!hasAmazonProductMarker(html)) {
      return { isDead: true, reason: 'Missing product markers (#productTitle, #dp-container)' };
    }
  }

  return { isDead: false };
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
 * Fetches an Amazon HTML page using the shared undici Agent and Safari macOS headers.
 * Never pollutes the cookie jar with 503/CAPTCHA responses.
 */
export async function fetchAmazonHtml(
  url: string,
  options: FetchAmazonHtmlOptions = {}
): Promise<string> {
  const safeCheck = isSafeExternalUrl(url);
  if (!safeCheck.safe) {
    throw new AmazonNetworkError(url, `Unsafe URL: ${safeCheck.reason}`);
  }

  const timeoutMs = options.timeoutMs ?? 9000;
  const minHtmlChars = options.minHtmlChars ?? 5000;

  const attemptFetch = async (
    targetUrl: string,
    uaIndex: number,
    dispatcher: Dispatcher,
    useCookies: boolean
  ): Promise<{ status: number; html: string }> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const profile = BROWSER_PROFILES[uaIndex % BROWSER_PROFILES.length];
    const cookieHeader = useCookies ? getCookieHeader(url) : undefined;

    const headers: Record<string, string> = {
      'User-Agent': profile.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': profile.acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    if (options.referer) {
      headers.Referer = options.referer;
    }

    const res = await undiciFetch(targetUrl, {
      method: 'GET',
      headers,
      dispatcher,
      signal,
      redirect: 'follow',
    });

    const html = await res.text();
    const check = detectAmazonBlock(res.status, html, minHtmlChars);
    if (!check.blocked && res.status >= 200 && res.status < 400 && html.length >= 10000) {
      storeResponseCookies(url, res.headers as any);
    }
    return { status: res.status, html };
  };

  let lastBlockReason = '';
  let lastStatus = 0;
  const startProfileIdx = profileRotationCursor++;

  // Attempt 1..4: Rotate across diverse desktop Firefox/Safari profiles
  for (let attempt = 0; attempt < 4; attempt++) {
    if (options.signal?.aborted) break;
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 180 * attempt + Math.floor(Math.random() * 140)));
      }
      const { status, html } = await attemptFetch(
        url,
        startProfileIdx + attempt,
        amazonUndiciAgent,
        attempt % 2 === 0
      );
      lastStatus = status;
      const deadCheck = isAmazonDeadListing(status, html, url);
      if (deadCheck.isDead) {
        throw new AmazonDeadListingError(url, status, deadCheck.reason || 'Dead listing');
      }
      const check = detectAmazonBlock(status, html, minHtmlChars);
      if (!check.blocked && status >= 200 && status < 400) {
        return html;
      }
      lastBlockReason = check.reason || `HTTP ${status}`;
    } catch (err: unknown) {
      if (err instanceof AmazonDeadListingError) throw err;
      if (options.signal?.aborted) throw err;
      lastBlockReason = (err as Error)?.message || 'Network failure';
    }
  }

  // Optional proxy fallback if configured
  const scraperApiUrl = buildScraperApiUrl(url);
  const proxyAgent = getProxyAgent();
  if (scraperApiUrl || proxyAgent) {
    try {
      const target = scraperApiUrl || url;
      const dispatcher = proxyAgent || amazonUndiciAgent;
      const { status, html } = await attemptFetch(target, startProfileIdx + 3, dispatcher, false);
      lastStatus = status;
      const check = detectAmazonBlock(status, html, minHtmlChars);
      if (!check.blocked && status >= 200 && status < 400) {
        return html;
      }
      lastBlockReason = check.reason || `Proxy HTTP ${status}`;
    } catch (err: unknown) {
      if (options.signal?.aborted) throw err;
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
