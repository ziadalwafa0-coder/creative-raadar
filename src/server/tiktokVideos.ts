import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { VisualAttribute } from '../types/index.ts';
import { isSafeExternalUrl } from '../utils/security.server.ts';
import { DATA_DIR } from './config.ts';
import { AMAZON_CHROME_USER_AGENT } from './amazonHttp.ts';
import { evaluateStrictProductTitleMatch, type TitleMatchVerdict } from './queryBuilder.ts';

export interface ExtractedTikTokVideo {
  videoId: string;
  canonicalUrl: string;
  title: string;
  playAddr: string;
  thumbnailUrl?: string;
  authorHandle: string;
  authorNickname?: string;
  durationSeconds?: number;
  playCount: number;
  diggCount: number;
  commentCount: number;
  cookieHeader: string;
}

interface TikTokStreamAuthEntry {
  playAddr: string;
  cookieHeader: string;
  canonicalUrl: string;
  expiresAt: number;
}

interface PersistedTikTokSearchCacheEntry {
  urls: string[];
  expiresAt: number;
}

const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const STREAM_AUTH_TTL_MS = 45 * 60 * 1000; // 45 minutes for signed playAddr + tt_chain_token
const SEARCH_CACHE_FILE = path.join(DATA_DIR, 'tiktok_search_cache.json');

const tiktokSearchCache = new Map<string, PersistedTikTokSearchCacheEntry>();
const tiktokStreamAuthCache = new Map<string, TikTokStreamAuthEntry>();
const tiktokVideoMetaCache = new Map<string, { video: ExtractedTikTokVideo; expiresAt: number }>();

function loadTikTokSearchCache(): void {
  try {
    if (fs.existsSync(SEARCH_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          const entry = v as PersistedTikTokSearchCacheEntry;
          if (entry && Array.isArray(entry.urls) && entry.expiresAt > now) {
            tiktokSearchCache.set(k, entry);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[TikTokVideos] Failed to load search cache:', (err as Error)?.message);
  }
}

function saveTikTokSearchCache(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const now = Date.now();
    const out: Record<string, PersistedTikTokSearchCacheEntry> = {};
    for (const [k, v] of tiktokSearchCache.entries()) {
      if (v.expiresAt > now) {
        out[k] = v;
      }
    }
    fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(out, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[TikTokVideos] Failed to save search cache:', (err as Error)?.message);
  }
}

loadTikTokSearchCache();

const TIKTOK_HOST_SUFFIXES = [
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokv.com',
  'byteoversea.com',
  'ibytedtos.com',
  'musical.ly',
  'ttwstatic.com',
];

export function isTikTokUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    return TIKTOK_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

export function isTikTokVideoPageUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  return /^https?:\/\/(?:www\.|m\.|vt\.|vm\.)?tiktok\.com\//i.test(rawUrl.trim());
}

const STOP_WORDS = new Set([
  'with',
  'for',
  'and',
  'the',
  'from',
  'that',
  'this',
  'into',
  'onto',
  'pack',
  'set',
  'new',
  'pro',
  'max',
  'plus',
  'upgraded',
  'version',
]);

const GENERIC_MODIFIER_WORDS = new Set([
  'heavy',
  'duty',
  'portable',
  'compact',
  'mini',
  'micro',
  'small',
  'large',
  'big',
  'auto',
  'automatic',
  'digital',
  'cordless',
  'wireless',
  'electric',
  'electronic',
  'power',
  'powerful',
  'dual',
  'double',
  'single',
  'fast',
  'quick',
  'rapid',
  'smart',
  'super',
  'best',
  'high',
  'pressure',
  'steel',
  'metal',
  'plastic',
  'black',
  'silver',
  'white',
  'red',
  'blue',
  '12v',
  '24v',
  '150psi',
  'psi',
  'led',
  'usb',
]);

/**
 * Builds up to 6 focused 3-to-5-word English commercial query variants optimized for TikTok video discovery,
 * always keeping the product's head nouns (e.g., "Tire Inflator Air Compressor", "Cordless Drill", "Spin Scrubber").
 */
export function buildTikTokSearchVariants(
  primaryQuery: string,
  amazonVariants: string[],
  fallbackName: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const addVariant = (q: string) => {
    const cleaned = q
      .replace(/[^\w\s\u0600-\u06FF-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 3) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  const extractCleanTokens = (text: string): string[] =>
    text
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()));

  const combinedLower = `${primaryQuery} ${amazonVariants.join(' ')} ${fallbackName}`.toLowerCase();

  // If searching for a car air compressor / tire inflator, prioritize high-recall TikTok consumer phrases
  // so search engines return car tire inflator review videos instead of industrial factory machinery
  if (/\b(air\s+compressor|tire\s+inflator)\b/i.test(combinedLower)) {
    addVariant('Tire Inflator Air Compressor');
    addVariant('12V Portable Air Compressor Tire');
    addVariant('Dual Cylinder Air Compressor');
    addVariant('Car Tire Pump Inflator');
    addVariant('Portable Tire Inflator');
  }

  // Add clean 3-to-5 word queries from all amazonVariants first
  for (const v of [primaryQuery, ...amazonVariants]) {
    const toks = extractCleanTokens(v);
    if (toks.length > 0) {
      if (toks.length <= 5) {
        addVariant(toks.join(' '));
      } else {
        addVariant(toks.slice(-4).join(' '));
      }
      const vNouns = toks.filter((t) => !GENERIC_MODIFIER_WORDS.has(t.toLowerCase()));
      if (vNouns.length >= 2) {
        addVariant(vNouns.slice(-4).join(' '));
      }
    }
  }

  const primaryTokens = extractCleanTokens(primaryQuery);
  const coreNouns = primaryTokens.filter((t) => !GENERIC_MODIFIER_WORDS.has(t.toLowerCase()));

  if (primaryTokens.length > 0) {
    addVariant(primaryTokens.slice(-4).join(' '));
    if (coreNouns.length >= 2) {
      addVariant(coreNouns.slice(-4).join(' '));
      addVariant(coreNouns.slice(0, 4).join(' '));
    }
  }

  if (out.length === 0 && fallbackName.trim()) {
    addVariant(fallbackName.trim());
  }

  return out.slice(0, 6);
}

function extractTikTokVideoLinksFromText(rawText: string): string[] {
  const safeReplaced = rawText.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  let decoded = safeReplaced
    .replace(/\\u002F/gi, '/')
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/')
    .replace(/%40/gi, '@');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}

  const regex = /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+\/video\/\d{18,20}/gi;
  const matches = decoded.match(regex) || [];
  const unique = new Set<string>();
  for (const m of matches) {
    const normalized = m
      .replace(/^http:/i, 'https:')
      .replace(/^https:\/\/tiktok\.com/i, 'https://www.tiktok.com');
    unique.add(normalized);
  }
  return Array.from(unique);
}

export type TikTokSerpEngineName =
  | 'naver'
  | 'duckduckgo-lite'
  | 'duckduckgo-html'
  | 'bing-rss'
  | 'yahoo'
  | 'brave'
  | 'searxng'
  | 'google-cse';

export const ALL_TIKTOK_SERP_ENGINES: readonly TikTokSerpEngineName[] = [
  'naver',
  'duckduckgo-lite',
  'duckduckgo-html',
  'bing-rss',
  'yahoo',
  'brave',
  'searxng',
  'google-cse',
] as const;

export interface SearchEngineRouteReport {
  engine: TikTokSerpEngineName;
  httpStatus: number;
  latencyMs: number;
  rawResultsCount: number;
  urlsFound: number;
  sampleUrls: string[];
  circuitOpen: boolean;
  error?: string;
}

const engineCircuitMap = new Map<string, { failures: number; openUntil: number; lastError?: string }>();

function isEngineCircuitOpen(engine: string): boolean {
  const st = engineCircuitMap.get(engine);
  return Boolean(st && st.openUntil > Date.now());
}

function recordEngineSuccess(engine: string): void {
  engineCircuitMap.set(engine, { failures: 0, openUntil: 0 });
}

function recordEngineFailure(engine: string, reason: string): void {
  const prev = engineCircuitMap.get(engine) || { failures: 0, openUntil: 0 };
  const failures = prev.failures + 1;
  const openUntil = failures >= 4 ? Date.now() + 3 * 60 * 1000 : 0;
  engineCircuitMap.set(engine, { failures, openUntil, lastError: reason });
}

let cachedYtDlpVersion: string | null | undefined = undefined;

export async function checkYtDlpVersion(): Promise<{ installed: boolean; version?: string; error?: string }> {
  if (cachedYtDlpVersion !== undefined) {
    return cachedYtDlpVersion
      ? { installed: true, version: cachedYtDlpVersion }
      : { installed: false, error: 'yt-dlp binary not found in PATH' };
  }
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--version'], { timeout: 4000 }, (err: Error | null, stdout: string) => {
      if (err) {
        cachedYtDlpVersion = null;
        resolve({ installed: false, error: err.message || 'yt-dlp not installed' });
      } else {
        const ver = (stdout || '').trim() || 'unknown';
        cachedYtDlpVersion = ver;
        resolve({ installed: true, version: ver });
      }
    });
  });
}

export async function tryYtDlpDirectPlayAddr(
  videoPageUrl: string
): Promise<{ playAddr?: string; error?: string }> {
  const ver = await checkYtDlpVersion();
  if (!ver.installed) {
    return { error: 'yt_dlp_not_installed' };
  }
  return new Promise((resolve) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '-f',
      'best[height<=720][ext=mp4]/best[ext=mp4]/best',
      '-g',
      videoPageUrl,
    ];
    if (process.env.TIKTOK_COOKIES_FILE && fs.existsSync(process.env.TIKTOK_COOKIES_FILE)) {
      args.unshift('--cookies', process.env.TIKTOK_COOKIES_FILE);
    }
    execFile('yt-dlp', args, { timeout: 12000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        const msg = (stderr || err.message || 'yt_dlp_failed').trim().slice(0, 140);
        resolve({ error: `yt_dlp_error:${msg}` });
        return;
      }
      const firstLine = (stdout || '')
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .find((l: string) => l.startsWith('http'));
      if (firstLine) {
        resolve({ playAddr: firstLine });
      } else {
        resolve({ error: 'yt_dlp_empty_url' });
      }
    });
  });
}

async function querySingleTikTokSearchEngine(
  engine: TikTokSerpEngineName,
  queryVariant: string,
  signal?: AbortSignal,
  bypassCache = false,
  page = 1
): Promise<SearchEngineRouteReport> {
  const t0 = Date.now();
  if (engine === 'google-cse') {
    const apiKey = (process.env.GOOGLE_CSE_API_KEY || '').trim();
    const cx = (process.env.GOOGLE_CSE_CX || '').trim();
    if (!apiKey || !cx) {
      return {
        engine,
        httpStatus: 0,
        latencyMs: 0,
        rawResultsCount: 0,
        urlsFound: 0,
        sampleUrls: [],
        circuitOpen: false,
        error: 'GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX not configured',
      };
    }
  }

  if (isEngineCircuitOpen(engine) && !bypassCache) {
    const st = engineCircuitMap.get(engine);
    return {
      engine,
      httpStatus: 0,
      latencyMs: 0,
      rawResultsCount: 0,
      urlsFound: 0,
      sampleUrls: [],
      circuitOpen: true,
      error: `Circuit open (${st?.lastError || 'previous failures'})`,
    };
  }

  const pageSuffix = page > 1 ? `:p${page}` : '';
  const cacheKey = `${engine}:${queryVariant.toLowerCase()}${pageSuffix}`;
  const now = Date.now();
  if (!bypassCache) {
    const cached = tiktokSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > now && cached.urls.length > 0) {
      return {
        engine,
        httpStatus: 200,
        latencyMs: 1,
        rawResultsCount: cached.urls.length,
        urlsFound: cached.urls.length,
        sampleUrls: cached.urls.slice(0, 3),
        circuitOpen: false,
      };
    }
  }

  const searchQuery = queryVariant.includes('site:tiktok.com')
    ? queryVariant
    : `site:tiktok.com/@ ${queryVariant}`;
  let url = '';
  const startOffset = (page - 1) * 10 + 1;

  if (engine === 'naver') {
    url =
      page <= 1
        ? `https://search.naver.com/search.naver?query=${encodeURIComponent(`site:tiktok.com ${queryVariant}`)}`
        : `https://search.naver.com/search.naver?query=${encodeURIComponent(`site:tiktok.com ${queryVariant}`)}&start=${startOffset}`;
  } else if (engine === 'duckduckgo-lite') {
    url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(`site:tiktok.com ${queryVariant}`)}`;
  } else if (engine === 'duckduckgo-html') {
    url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  } else if (engine === 'bing-rss') {
    url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(searchQuery)}&first=${startOffset}`;
  } else if (engine === 'yahoo') {
    url = `https://search.yahoo.com/search?p=${encodeURIComponent(searchQuery)}&b=${startOffset}`;
  } else if (engine === 'brave') {
    url = `https://search.brave.com/search?q=${encodeURIComponent(searchQuery)}`;
  } else if (engine === 'searxng') {
    const base = (process.env.SEARXNG_BASE_URL || 'https://searx.be').replace(/\/+$/, '');
    url = `${base}/search?q=${encodeURIComponent(searchQuery)}&pageno=${page}`;
  } else if (engine === 'google-cse') {
    const apiKey = (process.env.GOOGLE_CSE_API_KEY || '').trim();
    const cx = (process.env.GOOGLE_CSE_CX || '').trim();
    url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(searchQuery)}&start=${startOffset}`;
  }

  const timeoutSig = AbortSignal.timeout(7500);
  const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;

  try {
    const res = await fetch(url, {
      signal: combinedSig,
      headers: {
        'User-Agent': AMAZON_CHROME_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const text = await res.text();
    const latencyMs = Date.now() - t0;
    const rawLinksCount = (text.match(/https?:\/\//gi) || []).length;

    if (!res.ok) {
      const errMsg = `HTTP ${res.status} (${text.length} bytes)`;
      recordEngineFailure(engine, errMsg);
      return {
        engine,
        httpStatus: res.status,
        latencyMs,
        rawResultsCount: 0,
        urlsFound: 0,
        sampleUrls: [],
        circuitOpen: isEngineCircuitOpen(engine),
        error: errMsg,
      };
    }

    const urls = extractTikTokVideoLinksFromText(text);
    if (urls.length > 0) {
      recordEngineSuccess(engine);
      tiktokSearchCache.set(cacheKey, { urls, expiresAt: now + SEARCH_CACHE_TTL_MS });
      saveTikTokSearchCache();
      return {
        engine,
        httpStatus: res.status,
        latencyMs,
        rawResultsCount: Math.max(urls.length, Math.min(50, rawLinksCount)),
        urlsFound: urls.length,
        sampleUrls: urls.slice(0, 3),
        circuitOpen: false,
      };
    }

    const emptyReason =
      res.status === 202
        ? 'HTTP 202 bot challenge / empty body'
        : /captcha|robot|challenge|verify you are human/i.test(text)
          ? `HTTP ${res.status} bot challenge / CAPTCHA (${text.length} bytes)`
          : `HTTP ${res.status} returned 0 TikTok video URLs (${text.length} bytes)`;
    return {
      engine,
      httpStatus: res.status,
      latencyMs,
      rawResultsCount: Math.min(20, rawLinksCount),
      urlsFound: 0,
      sampleUrls: [],
      circuitOpen: false,
      error: emptyReason,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errMsg = (err as Error)?.message || String(err);
    recordEngineFailure(engine, errMsg);
    return {
      engine,
      httpStatus: 0,
      latencyMs,
      rawResultsCount: 0,
      urlsFound: 0,
      sampleUrls: [],
      circuitOpen: isEngineCircuitOpen(engine),
      error: errMsg,
    };
  }
}

export async function discoverTikTokVideoUrlsWithDiagnostics(
  queryVariants: string[],
  signal?: AbortSignal,
  bypassCache = false,
  maxPagesPerEngine = 2
): Promise<{
  urls: string[];
  engineReports: Record<TikTokSerpEngineName, SearchEngineRouteReport>;
}> {
  const engines: readonly TikTokSerpEngineName[] = ALL_TIKTOK_SERP_ENGINES;
  const engineReports = {} as Record<TikTokSerpEngineName, SearchEngineRouteReport>;
  const perEngineSet = {} as Record<TikTokSerpEngineName, Set<string>>;

  for (const eng of engines) {
    engineReports[eng] = {
      engine: eng,
      httpStatus: 0,
      latencyMs: 0,
      rawResultsCount: 0,
      urlsFound: 0,
      sampleUrls: [],
      circuitOpen: isEngineCircuitOpen(eng),
    };
    perEngineSet[eng] = new Set();
  }

  const uniqueUrls = new Set<string>();
  // When running normal search (not bypassCache full probe), query primary fast engines for all variants + secondary engines for first variant
  const primaryEngines: TikTokSerpEngineName[] = ['naver', 'duckduckgo-lite', 'duckduckgo-html', 'bing-rss'];
  const secondaryEngines: TikTokSerpEngineName[] = ['yahoo', 'brave', 'searxng', 'google-cse'];

  await Promise.all(
    queryVariants.map(async (variant, vIdx) => {
      if (signal?.aborted) return;
      const enginesForVariant =
        bypassCache || vIdx === 0 ? [...primaryEngines, ...secondaryEngines] : primaryEngines;

      await Promise.all(
        enginesForVariant.map(async (eng) => {
          if (signal?.aborted) return;
          const pagesToFetch = eng === 'naver' ? Math.max(1, Math.min(2, maxPagesPerEngine)) : 1;
          for (let page = 1; page <= pagesToFetch; page++) {
            if (signal?.aborted) break;
            const rep = await querySingleTikTokSearchEngine(eng, variant, signal, bypassCache, page);
            if (rep.httpStatus > 0) {
              engineReports[eng].httpStatus = rep.httpStatus;
            }
            if (rep.latencyMs > 0) {
              engineReports[eng].latencyMs = Math.max(engineReports[eng].latencyMs, rep.latencyMs);
            }
            engineReports[eng].rawResultsCount += rep.rawResultsCount;
            if (rep.error && !engineReports[eng].urlsFound) {
              engineReports[eng].error = rep.error;
            }
            engineReports[eng].circuitOpen = rep.circuitOpen;
            if (rep.urlsFound > 0) {
              const pageSuffix = page > 1 ? `:p${page}` : '';
              const cacheKey = `${eng}:${variant.toLowerCase()}${pageSuffix}`;
              const urls = tiktokSearchCache.get(cacheKey)?.urls || rep.sampleUrls;
              for (const u of urls) {
                uniqueUrls.add(u);
                perEngineSet[eng].add(u);
              }
            }
          }
        })
      );
    })
  );

  for (const eng of engines) {
    const list = Array.from(perEngineSet[eng]);
    engineReports[eng].urlsFound = list.length;
    engineReports[eng].sampleUrls = list.slice(0, 3);
    if (list.length > 0) {
      delete engineReports[eng].error;
    }
  }

  return {
    urls: Array.from(uniqueUrls),
    engineReports,
  };
}

/**
 * Discovers candidate TikTok video URLs (https://www.tiktok.com/@username/video/...)
 * across all search engine discovery routes behind per-route circuit breakers.
 */
export async function discoverTikTokVideoUrls(
  queryVariants: string[],
  signal?: AbortSignal
): Promise<string[]> {
  const { urls } = await discoverTikTokVideoUrlsWithDiagnostics(queryVariants, signal, false, 2);
  return urls;
}

/**
 * Fetches a TikTok video page, parses __UNIVERSAL_DATA_FOR_REHYDRATION__,
 * extracts the direct MP4 playAddr, cover thumbnail, caption, author, stats,
 * and caches the required session cookies (tt_chain_token) for direct MP4 download.
 */
export async function fetchTikTokVideoDetail(
  rawUrl: string,
  signal?: AbortSignal
): Promise<ExtractedTikTokVideo | null> {
  if (!isSafeExternalUrl(rawUrl).safe) return null;

  const now = Date.now();
  const cachedMeta = tiktokVideoMetaCache.get(rawUrl);
  const cachedAuth = tiktokStreamAuthCache.get(rawUrl);
  if (cachedMeta && cachedMeta.expiresAt > now && cachedAuth && cachedAuth.expiresAt > now) {
    return {
      ...cachedMeta.video,
      playAddr: cachedAuth.playAddr,
      cookieHeader: cachedAuth.cookieHeader,
    };
  }

  const timeoutSig = AbortSignal.timeout(10_000);
  const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;

  try {
    let targetUrl = rawUrl.trim();
    const collectedCookies: string[] = [];

    // Follow up to 3 redirects manually so we capture Set-Cookie headers on every hop
    for (let hop = 0; hop < 3; hop++) {
      if (!isSafeExternalUrl(targetUrl).safe) return null;
      const res = await fetch(targetUrl, {
        redirect: 'manual',
        signal: combinedSig,
        headers: {
          'User-Agent': AMAZON_CHROME_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(collectedCookies.length > 0 ? { Cookie: collectedCookies.join('; ') } : {}),
        },
      });

      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const pair = sc.split(';')[0]?.trim();
        if (pair && !collectedCookies.includes(pair)) {
          collectedCookies.push(pair);
        }
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        targetUrl = new URL(loc, targetUrl).href;
        continue;
      }

      if (!res.ok) return null;
      const html = await res.text();
      const match = html.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
      );
      if (!match) return null;

      const parsed = JSON.parse(match[1]);
      const item =
        parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (!item || !item.id) return null;

      const playAddr: string =
        item.video?.playAddr ||
        item.video?.downloadAddr ||
        item.video?.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0] ||
        '';
      if (!playAddr || !isSafeExternalUrl(playAddr).safe) return null;

      const authorUniqueId = String(item.author?.uniqueId || 'tiktok_creator').trim();
      const authorNickname = String(item.author?.nickname || authorUniqueId).trim();
      const videoId = String(item.id).trim();
      const canonicalUrl = `https://www.tiktok.com/@${authorUniqueId}/video/${videoId}`;
      const rawDesc = String(item.desc || '').trim();
      const coverUrl =
        item.video?.originCover || item.video?.cover || item.video?.dynamicCover || undefined;
      const durationSeconds = Number(item.video?.duration) || undefined;
      const playCount = Number(item.stats?.playCount || item.statsV2?.playCount) || 0;
      const diggCount = Number(item.stats?.diggCount || item.statsV2?.diggCount) || 0;
      const commentCount = Number(item.stats?.commentCount || item.statsV2?.commentCount) || 0;

      const cookieHeader = collectedCookies.join('; ');
      const authEntry: TikTokStreamAuthEntry = {
        playAddr,
        cookieHeader,
        canonicalUrl,
        expiresAt: Date.now() + STREAM_AUTH_TTL_MS,
      };

      tiktokStreamAuthCache.set(canonicalUrl, authEntry);
      tiktokStreamAuthCache.set(rawUrl, authEntry);
      tiktokStreamAuthCache.set(playAddr, authEntry);

      const videoObj: ExtractedTikTokVideo = {
        videoId,
        canonicalUrl,
        title: rawDesc || `فيديو تيك توك (@${authorUniqueId})`,
        playAddr,
        thumbnailUrl: coverUrl,
        authorHandle: `@${authorUniqueId}`,
        authorNickname,
        durationSeconds,
        playCount,
        diggCount,
        commentCount,
        cookieHeader,
      };

      tiktokVideoMetaCache.set(canonicalUrl, {
        video: videoObj,
        expiresAt: Date.now() + STREAM_AUTH_TTL_MS,
      });
      tiktokVideoMetaCache.set(rawUrl, {
        video: videoObj,
        expiresAt: Date.now() + STREAM_AUTH_TTL_MS,
      });

      return videoObj;
    }
  } catch (err) {
    console.warn(`[TikTokVideos] Detail fetch failed for ${rawUrl}:`, (err as Error)?.message);
  }
  return null;
}

/**
 * Resolves a TikTok URL (either canonical video page URL or CDN playAddr) into a direct
 * playable MP4 stream URL plus the required Cookie + Referer headers.
 */
export async function resolveTikTokPlayableStream(
  url: string,
  signal?: AbortSignal
): Promise<{ streamUrl: string; headers: Record<string, string> } | null> {
  const trimmed = url.trim();
  const now = Date.now();
  const cached = tiktokStreamAuthCache.get(trimmed);
  if (cached && cached.expiresAt > now && cached.playAddr) {
    return {
      streamUrl: cached.playAddr,
      headers: {
        'User-Agent': AMAZON_CHROME_USER_AGENT,
        Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        Referer: 'https://www.tiktok.com/',
        ...(cached.cookieHeader ? { Cookie: cached.cookieHeader } : {}),
      },
    };
  }

  // If it's a TikTok video page URL or if we know its canonical URL from an expired cache entry, re-fetch
  const pageUrlToFetch =
    cached?.canonicalUrl || (isTikTokVideoPageUrl(trimmed) ? trimmed : '');
  if (pageUrlToFetch) {
    const detail = await fetchTikTokVideoDetail(pageUrlToFetch, signal);
    if (detail && detail.playAddr) {
      return {
        streamUrl: detail.playAddr,
        headers: {
          'User-Agent': AMAZON_CHROME_USER_AGENT,
          Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          Referer: 'https://www.tiktok.com/',
          ...(detail.cookieHeader ? { Cookie: detail.cookieHeader } : {}),
        },
      };
    }
  }

  return null;
}

function normalizeTikTokTextForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/#?tireinflator/g, ' tire inflator ')
    .replace(/#?aircompressor/g, ' air compressor ')
    .replace(/#?carcompressor/g, ' car compressor ')
    .replace(/#?carpump/g, ' car pump ')
    .replace(/#?tirepump/g, ' tire pump ')
    .replace(/#?spinscrubber/g, ' spin scrubber ')
    .replace(/#?powerdrill/g, ' power drill ')
    .replace(/#?cordlessdrill/g, ' cordless drill ')
    .replace(/#?airfryer/g, ' air fryer ')
    .replace(/\bcompresser\b/g, 'compressor')
    .replace(/\binflating\b|\binflate\b|\binflates\b/g, 'inflator')
    .replace(/\btires\b|\btyre\b|\btyres\b/g, 'tire')
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Evaluates whether a discovered TikTok video caption/metadata matches the target commercial product
 * and does not violate cross-category filters.
 */
export function evaluateTikTokVideoMatch(
  video: ExtractedTikTokVideo,
  primaryQuery: string,
  fallbackName: string,
  mustMatchAttributes?: string[],
  excludeKeywords?: string[],
  additionalQueries: string[] = []
): TitleMatchVerdict {
  const combinedText = `${video.title} ${video.authorHandle} ${video.authorNickname || ''}`.trim();
  const normText = normalizeTikTokTextForMatching(combinedText);
  const fullQueryContext = [primaryQuery, fallbackName, ...additionalQueries].join(' ').toLowerCase();

  // 1. Enforce excludeKeywords from Gemini Vision or explicit parameter
  if (Array.isArray(excludeKeywords) && excludeKeywords.length > 0) {
    for (const rawEx of excludeKeywords) {
      const ex = (rawEx || '').trim().toLowerCase();
      if (ex.length >= 3 && normText.includes(ex)) {
        return {
          approved: false,
          matchCategory: 'mismatched',
          matchScore: 10,
          userFacingLabelAr: 'فئة مستبعدة (تيك توك)',
          reasonAr: `فيديو مستبعد لاحتوائه على نوع مختلف (${rawEx})`,
        };
      }
    }
  }

  // 2. Reject mismatched tool sub-types when searching for specific tools:
  // Interchangeable plier sets vs Locking Pliers (Vise-Grips) / Water Pump / Slip Joint
  if (/\b(interchangeable|replaceable\s+head|detachable|5\s*in\s*1)\b/i.test(fullQueryContext)) {
    if (/\b(locking|vise\s*grip|vice\s*grip|water\s*pump|slip\s*joint|groove\s*joint|channellock|pipe\s*wrench)\b/i.test(normText)) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 10,
        userFacingLabelAr: 'نوع كماشة مختلف (مستبعد)',
        reasonAr: 'فيديو كماشة من نوع مختلف (Locking / Vise-Grip / Water Pump) وليس طقم الرؤوس القابلة للتبديل.',
      };
    }
  }

  // 3. Reject industrial welding / mining / factory machinery when searching for consumer products
  if (
    /\b(welder|welding|miller|lincoln|diesel|bobcat|trailblazer|rock\s+drill|dredge|mining|industrial\s+air\s+compressor|rotary\s+screw|2hp|5hp|10hp|lawn\s+edger|edger|grassedger)\b/.test(
      normText
    ) &&
    !/\b(welder|welding|mining|edger|industrial)\b/i.test(fullQueryContext)
  ) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 10,
      userFacingLabelAr: 'منتج مختلف',
      reasonAr: 'فيديو معدات صناعية أو زراعية مختلفة وليس المنتج المطلوب.',
    };
  }

  // 4. Reject nail drills / manicure tools unless searching for them
  if (
    /\b(nail\s+drill|manicure|pedicure|acrylic\s+nail|cuticle)\b/.test(normText) &&
    !/\b(nail|manicure|pedicure)\b/i.test(fullQueryContext)
  ) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 10,
      userFacingLabelAr: 'فئة مستبعدة',
      reasonAr: 'فيديو أدوات تجميل وأظافر وليس المنتج المطلوب.',
    };
  }

  // 5. Expand query vocabulary with common synonym pairs for compressor/inflator
  let expandedQuerySource = `${primaryQuery} ${fallbackName} ${additionalQueries.join(' ')}`;
  if (/\b(air\s+compressor|tire\s+inflator)\b/i.test(expandedQuerySource)) {
    expandedQuerySource += ' tire inflator air compressor car pump';
  }

  const allQueryWords = normalizeTikTokTextForMatching(expandedQuerySource)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && /^[a-z0-9]+$/i.test(w));

  const uniqueCoreNouns = Array.from(
    new Set(allQueryWords.filter((w) => !GENERIC_MODIFIER_WORDS.has(w)))
  );
  const uniqueAllWords = Array.from(new Set(allQueryWords));

  const normTokens = new Set(normText.split(/\s+/));

  let matchedCoreNouns = 0;
  for (const noun of uniqueCoreNouns) {
    const stem = noun.length > 5 && noun.endsWith('s') ? noun.slice(0, -1) : noun;
    if (normTokens.has(noun) || normTokens.has(stem) || normText.includes(stem)) {
      matchedCoreNouns++;
    }
  }

  let matchedTotal = 0;
  for (const qw of uniqueAllWords) {
    const stem = qw.length > 5 && qw.endsWith('s') ? qw.slice(0, -1) : qw;
    if (normTokens.has(qw) || normTokens.has(stem) || normText.includes(stem)) {
      matchedTotal++;
    }
  }

  // 6. Check mustMatchAttributes if provided
  let hasAttributeMatch = true;
  if (Array.isArray(mustMatchAttributes) && mustMatchAttributes.length > 0) {
    hasAttributeMatch = false;
    for (const attr of mustMatchAttributes) {
      const cleanAttr = (attr || '').trim().toLowerCase();
      if (!cleanAttr) continue;
      if (normText.includes(cleanAttr)) {
        hasAttributeMatch = true;
        break;
      }
      const words = cleanAttr.split(/\s+/).filter((w) => w.length > 2);
      if (words.length > 0 && words.every((w) => normText.includes(w))) {
        hasAttributeMatch = true;
        break;
      }
    }
  }

  // If the target is an interchangeable head plier set or modular tool, strictly require the modular attribute match
  const isInterchangeableSetQuery = /\b(interchangeable|replaceable\s+head|detachable|5\s*in\s*1)\b/i.test(fullQueryContext);
  if (isInterchangeableSetQuery && !hasAttributeMatch) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 20,
      userFacingLabelAr: 'كماشة غير قابلة للتبديل (مستبعد)',
      reasonAr: 'فيديو تيك توك يفتقر للرؤوس القابلة للتبديل المميزة لطقم الكماشة المطلوب.',
    };
  }

  // Require at least 1 core product head noun AND at least 2 total query words (or 1 if query only has 1 word)
  const minTotal = uniqueAllWords.length >= 2 ? 2 : 1;
  if (matchedCoreNouns >= 1 && matchedTotal >= minTotal) {
    const isExact = hasAttributeMatch && matchedCoreNouns >= 2;
    return {
      approved: true,
      matchCategory: isExact ? 'exact_design' : 'permitted_variation',
      matchScore: Math.min(96, (hasAttributeMatch ? 85 : 75) + matchedCoreNouns * 4 + matchedTotal * 2),
      userFacingLabelAr: 'فيديو تيك توك مطابق للمنتج',
      reasonAr: 'وصف فيديو تيك توك والوسوم تطابق المنتج المطلوب.',
    };
  }

  // Fallback to strict title match if needed
  const strictVerdict = evaluateStrictProductTitleMatch(
    combinedText,
    primaryQuery,
    fallbackName,
    mustMatchAttributes,
    excludeKeywords
  );
  if (strictVerdict.approved) {
    return {
      ...strictVerdict,
      userFacingLabelAr: 'فيديو تيك توك مطابق للمنتج',
    };
  }

  return strictVerdict;
}
