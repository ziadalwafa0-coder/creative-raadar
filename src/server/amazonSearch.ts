import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { fetchAmazonHtml, AmazonBlockError, AMAZON_CHROME_USER_AGENT } from './amazonHttp.ts';
import { evaluateStrictProductTitleMatch } from './queryBuilder.ts';

export function isValidAmazonAsin(asin: string): boolean {
  if (!asin || typeof asin !== 'string') return false;
  const clean = asin.trim().toUpperCase();
  if (clean.length !== 10) return false;
  if (
    clean.includes('EXACT') ||
    clean.includes('COLOR') ||
    clean.includes('TEST') ||
    clean.includes('MOCK') ||
    clean.includes('FAKE') ||
    clean.includes('SAMPLE')
  ) {
    return false;
  }
  return /^[B0-9][A-Z0-9]{9}$/.test(clean);
}

export interface AmazonUsProductCandidate {
  asin: string;
  title: string;
  url: string;
  marketplace?: AmazonMarketplaceCode;
  imageUrl?: string;
  ratingCount: number;
  reviewOrSalesScore?: number;
  matchScore?: number;
  matchCategory?: 'exact_design' | 'permitted_variation' | 'mismatched';
  isSponsored?: boolean;
  provenanceData?: {
    source: 'live' | 'fixture';
    marketplace: string;
    asin: string;
    fetchedAt: string;
    httpStatus: number;
    finalUrl: string;
    responseSnippetHash: string;
  };
}

export const AMAZON_QUERY_CACHE_VERSION = 3;

interface QueryCacheEntry {
  version: number;
  key: string;
  marketplace: AmazonMarketplaceCode;
  candidates: AmazonUsProductCandidate[];
  cachedAt: number;
  expiresAt: number;
  responseSnippetHash?: string;
}

const QUERY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL
const QUERY_CACHE_FILE = path.join(DATA_DIR, 'amazon_query_cache.json');
const queryCacheMap = new Map<string, QueryCacheEntry>();

function loadQueryCacheFromDisk(): void {
  try {
    if (fs.existsSync(QUERY_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUERY_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      // Requirement 2: Purge cache if missing/old schema version
      if (raw && raw.version === AMAZON_QUERY_CACHE_VERSION && Array.isArray(raw.entries)) {
        for (const item of raw.entries) {
          if (
            item &&
            item.key &&
            Array.isArray(item.candidates) &&
            item.candidates.length > 0 &&
            !item.key.includes('B0EXACT') &&
            !item.key.includes('B0COLOR')
          ) {
            // Strictly validate every candidate ASIN and strip lazy-load .svg placeholder URLs
            const validCandidates = item.candidates
              .filter((c: any) => c && isValidAmazonAsin(c.asin))
              .map((c: any) => ({
                ...c,
                imageUrl:
                  typeof c.imageUrl === 'string' && !c.imageUrl.toLowerCase().endsWith('.svg')
                    ? c.imageUrl
                    : undefined,
              }));
            if (validCandidates.length > 0) {
              queryCacheMap.set(item.key, {
                ...item,
                candidates: validCandidates,
                expiresAt: Math.max(Number(item.expiresAt) || 0, now + QUERY_CACHE_TTL_MS),
              });
            }
          }
        }
      } else {
        console.log('[AmazonSearchCache] Old or unversioned query cache found. Purging for integrity.');
        try {
          fs.unlinkSync(QUERY_CACHE_FILE);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[AmazonSearchCache] Failed to load query cache:', (err as Error)?.message);
  }
}

function findFuzzyCachedPage(normalizedQuery: string, pageNumber: number): AmazonUsProductCandidate[] | null {
  const queryTokens = normalizedQuery
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (queryTokens.length === 0) return null;

  let bestCandidates: AmazonUsProductCandidate[] | null = null;
  let bestScore = 0;
  const pageSuffix = `::p${pageNumber}`;

  for (const [k, entry] of queryCacheMap.entries()) {
    if (!k.endsWith(pageSuffix) || !entry.candidates?.length) continue;
    const keyQuery = k.slice(0, k.length - pageSuffix.length).replace(/^[A-Z]{2}::/, '');
    const keyTokens = keyQuery.split(/\s+/).filter((w) => w.length >= 3);
    if (keyTokens.length === 0) continue;
    const overlap = keyTokens.filter((kt) => queryTokens.includes(kt)).length;
    const ratio = overlap / Math.min(keyTokens.length, queryTokens.length);
    if (overlap >= 2 && ratio >= 0.65 && ratio > bestScore) {
      bestScore = ratio;
      bestCandidates = entry.candidates;
    }
  }
  return bestCandidates;
}

function saveQueryCacheToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const now = Date.now();
    const active: QueryCacheEntry[] = [];
    for (const [k, v] of queryCacheMap.entries()) {
      if (v.expiresAt > now) {
        active.push(v);
      } else {
        queryCacheMap.delete(k);
      }
    }
    fs.writeFileSync(
      QUERY_CACHE_FILE,
      JSON.stringify({ version: AMAZON_QUERY_CACHE_VERSION, entries: active }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('[AmazonSearchCache] Failed to save query cache:', (err as Error)?.message);
  }
}

loadQueryCacheFromDisk();

function decodeHtmlEntities(str: string): string {
  return (str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCompactNumber(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g, '').trim().toUpperCase();
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*([KM])?\+?$/);
  if (!m) {
    const digits = parseInt(cleaned.replace(/\D+/g, ''), 10);
    return Number.isFinite(digits) ? digits : 0;
  }
  const num = parseFloat(m[1]);
  const suffix = m[2];
  if (suffix === 'K') return Math.round(num * 1_000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  return Math.round(num);
}

/**
 * Extracts the customer rating count from an Amazon search card HTML block.
 */
export function extractRatingCountFromCardHtml(cardHtml: string): number {
  let maxRatings = 0;

  const ariaRatingRegex = /aria-label="([\d,]+)\s+ratings?"/gi;
  let m: RegExpExecArray | null;
  while ((m = ariaRatingRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  const underlineRegex = /s-underline-text[^>]*>\s*\(?([\d,]+(?:\.\d+)?[KM]?\+?)\)?\s*<\/span>/gi;
  while ((m = underlineRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  const reviewLinkRegex = /#customerReviews[^>]*>\s*<span[^>]*>\s*\(?([\d,]+)\)?\s*<\/span>/gi;
  while ((m = reviewLinkRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  if (maxRatings === 0) {
    const boughtMatch = cardHtml.match(/(\d+(?:\.\d+)?[KM]?\+?)\s+bought\s+in\s+past\s+month/i);
    if (boughtMatch) {
      maxRatings = parseCompactNumber(boughtMatch[1]);
    }
  }

  return maxRatings;
}

/**
 * Parses Amazon search results HTML page into product candidates.
 * URLs are strictly tied to the search marketplace domain.
 */
export function parseAmazonSearchResultsHtml(
  html: string,
  marketplace: AmazonMarketplaceCode = 'US',
  fetchMeta?: { httpStatus?: number; fetchedAt?: string; finalUrl?: string; snippetHash?: string }
): AmazonUsProductCandidate[] {
  const results: AmazonUsProductCandidate[] = [];
  const seenAsins = new Set<string>();
  const domain = AMAZON_MARKETPLACE_DOMAINS[marketplace] || 'www.amazon.com';

  const cardRegex = /<div[^>]+data-asin="([B0-9][A-Z0-9]{9})"[^>]*>([\s\S]*?)(?=<div[^>]+data-asin="[B0-9][A-Z0-9]{9}"|<\/div>\s*<div[^>]+class="[^"]*s-pagination|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = cardRegex.exec(html)) !== null) {
    const asin = match[1].toUpperCase();
    if (!asin || !isValidAmazonAsin(asin) || seenAsins.has(asin)) continue;
    const block = match[2];

    const imgAltMatch = block.match(/<img[^>]+class="[^"]*s-image[^"]*"[^>]+alt="([^"]+)"/i);
    const h2TextMatch =
      block.match(/<h2[^>]*aria-label="([^"]+)"/i) ||
      block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/i);

    const rawTitle = decodeHtmlEntities(
      (h2TextMatch ? h2TextMatch[1] : imgAltMatch ? imgAltMatch[1] : '').replace(/<[^>]+>/g, '')
    ).replace(/^Sponsored\s+Ad\s*[-–—]\s*/i, '');

    if (!rawTitle || rawTitle.length < 5) continue;

    const allImgUrls = block.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[^\s"'<>\\]+/gi) || [];
    let realImgUrl: string | undefined;
    for (const rawUrl of allImgUrls) {
      const clean = rawUrl.replace(/[,;]+$/, '');
      if (clean.toLowerCase().endsWith('.svg')) continue;
      if (/\.(?:jpg|jpeg|png|webp)$/i.test(clean)) {
        realImgUrl = clean;
        break;
      }
    }
    const ratingCount = extractRatingCountFromCardHtml(block);

    seenAsins.add(asin);
    const finalUrl = `https://${domain}/dp/${asin}`;
    results.push({
      asin,
      title: rawTitle,
      url: finalUrl,
      marketplace,
      imageUrl: realImgUrl,
      ratingCount,
      reviewOrSalesScore: ratingCount,
      provenanceData: {
        source: 'live',
        marketplace,
        asin,
        fetchedAt: fetchMeta?.fetchedAt || new Date().toISOString(),
        httpStatus: fetchMeta?.httpStatus || 200,
        finalUrl,
        responseSnippetHash: fetchMeta?.snippetHash || crypto.createHash('sha256').update(asin).digest('hex').slice(0, 16),
      },
    });
  }

  return results;
}

/**
 * Sorts product candidates by rating COUNT descending as the primary key (then match score descending).
 */
export function sortCandidatesByRatingCountDesc<
  T extends { ratingCount?: number; reviewOrSalesScore?: number; matchScore?: number }
>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const rA = a.ratingCount ?? a.reviewOrSalesScore ?? 0;
    const rB = b.ratingCount ?? b.reviewOrSalesScore ?? 0;
    if (rB !== rA) return rB - rA;
    return (b.matchScore ?? 0) - (a.matchScore ?? 0);
  });
}

export type AmazonMarketplaceCode = 'US' | 'UK' | 'CA' | 'AE' | 'SA' | 'EG' | 'DE';

export const AMAZON_MARKETPLACE_DOMAINS: Record<AmazonMarketplaceCode, string> = {
  US: 'www.amazon.com',
  UK: 'www.amazon.co.uk',
  CA: 'www.amazon.ca',
  AE: 'www.amazon.ae',
  SA: 'www.amazon.sa',
  EG: 'www.amazon.eg',
  DE: 'www.amazon.de',
};

export const ENABLED_VIDEO_MARKETPLACES: readonly AmazonMarketplaceCode[] = ['US', 'UK', 'CA'] as const;
export const DISABLED_VIDEO_MARKETPLACES: readonly AmazonMarketplaceCode[] = ['DE', 'AE', 'SA', 'EG'] as const;

export interface MarketplaceVideoProbeResult {
  marketplace: AmazonMarketplaceCode;
  domain: string;
  testUrl: string;
  httpStatus: number;
  htmlBytes: number;
  exposesReviewVideosJson: boolean;
  vseStreamCount: number;
  enabledForVideoExtraction: boolean;
  reason: string;
}

/**
 * Live test helper for Phase 4.4: probes US, UK, CA, DE, AE, SA, EG
 * and checks whether product pages expose review videos in VSE JSON.
 */
export async function probeAmazonMarketplacesLive(
  testAsin: string
): Promise<MarketplaceVideoProbeResult[]> {
  const codes: AmazonMarketplaceCode[] = ['US', 'UK', 'CA', 'DE', 'AE', 'SA', 'EG'];
  const results: MarketplaceVideoProbeResult[] = [];

  for (const code of codes) {
    const domain = AMAZON_MARKETPLACE_DOMAINS[code];
    const testUrl = `https://${domain}/dp/${testAsin}`;
    try {
      const html = await fetchAmazonHtml(testUrl, {
        timeoutMs: 9000,
        minHtmlChars: 3000,
      });
      const vseMatches =
        html.match(/vse-vms-transcoding-artifact|vsemetrics|vse-cards-vw-dp/gi) || [];
      const m3u8Matches =
        html.match(/https?:(?:\\\/\\\/|\/\/)m\.media-amazon\.com[^\s"'<>\\]+\.(?:m3u8|mp4)/gi) || [];
      const exposesReviewVideosJson = vseMatches.length > 0 || m3u8Matches.length > 0;
      const enabled = ENABLED_VIDEO_MARKETPLACES.includes(code) && exposesReviewVideosJson;

      results.push({
        marketplace: code,
        domain,
        testUrl,
        httpStatus: 200,
        htmlBytes: html.length,
        exposesReviewVideosJson,
        vseStreamCount: m3u8Matches.length,
        enabledForVideoExtraction: enabled,
        reason: exposesReviewVideosJson
          ? `Exposes VSE review video JSON (${m3u8Matches.length} streams in ${html.length} bytes)`
          : `Disabled: Product page (${html.length} bytes) does not expose VSE review video JSON`,
      });
    } catch (err) {
      const status = err instanceof AmazonBlockError ? err.status : 0;
      results.push({
        marketplace: code,
        domain,
        testUrl,
        httpStatus: status,
        htmlBytes: 0,
        exposesReviewVideosJson: false,
        vseStreamCount: 0,
        enabledForVideoExtraction: false,
        reason: `Disabled: ${(err as Error)?.message || String(err)}`,
      });
    }
  }
  return results;
}

/**
 * Discovers Amazon catalog candidates within the specified regional marketplace.
 * Never overrides domain cross-catalog.
 */
export async function discoverGlobalAmazonCatalogCandidates(
  query: string,
  pageNumber: number,
  marketplace: AmazonMarketplaceCode = 'SA',
  signal?: AbortSignal
): Promise<AmazonUsProductCandidate[]> {
  const encoded = encodeURIComponent(query.trim()).replace(/%20/g, '+');
  const domain = AMAZON_MARKETPLACE_DOMAINS[marketplace] || 'www.amazon.sa';
  const catalogUrl =
    pageNumber <= 1
      ? `https://${domain}/s?k=${encoded}&language=en_AE`
      : `https://${domain}/s?k=${encoded}&language=en_AE&page=${pageNumber}`;

  const html = await fetchAmazonHtml(catalogUrl, {
    signal,
    timeoutMs: 9000,
    minHtmlChars: 5000,
  });

  const snippetHash = crypto.createHash('sha256').update(html.slice(0, 10000)).digest('hex').slice(0, 16);
  const parsed = parseAmazonSearchResultsHtml(html, marketplace, {
    httpStatus: 200,
    fetchedAt: new Date().toISOString(),
    finalUrl: catalogUrl,
    snippetHash,
  });

  return parsed;
}

export type AmazonSortVariant = 'relevance' | 'review-rank' | 'popularity-rank';

function mapSortVariantToParam(sortVariant?: AmazonSortVariant): string {
  if (sortVariant === 'review-rank') return '&s=review-rank';
  if (sortVariant === 'popularity-rank') return '&s=exact-aware-popularity-rank';
  return '';
}

/**
 * Fetches a single Amazon search page for an enabled video marketplace ('US', 'UK', 'CA').
 * Supports sortVariant ('relevance', 'review-rank', 'popularity-rank') for deeper diversity.
 */
export async function fetchAmazonSearchPage(
  query: string,
  pageNumber = 1,
  signal?: AbortSignal,
  marketplace: AmazonMarketplaceCode = 'US',
  sortVariant: AmazonSortVariant = 'relevance'
): Promise<{ candidates: AmazonUsProductCandidate[]; fromCache: boolean; marketplace: AmazonMarketplaceCode }> {
  if (!ENABLED_VIDEO_MARKETPLACES.includes(marketplace)) {
    throw new AmazonBlockError(
      `https://${AMAZON_MARKETPLACE_DOMAINS[marketplace] || 'www.amazon.com'}/s`,
      403,
      `Marketplace ${marketplace} is disabled because its product pages do not expose VSE customer review videos JSON`
    );
  }

  const domain = AMAZON_MARKETPLACE_DOMAINS[marketplace] || 'www.amazon.com';
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const sortSuffix = sortVariant && sortVariant !== 'relevance' ? `::s_${sortVariant}` : '';
  const cacheKey =
    marketplace === 'US'
      ? `${normalizedQuery}::p${pageNumber}${sortSuffix}`
      : `${marketplace}::${normalizedQuery}::p${pageNumber}${sortSuffix}`;
  const now = Date.now();

  const cached = queryCacheMap.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.candidates.length > 0) {
    return { candidates: cached.candidates, fromCache: true, marketplace };
  }

  const encoded = encodeURIComponent(query.trim()).replace(/%20/g, '+');
  const sortParam = mapSortVariantToParam(sortVariant);
  const url =
    pageNumber <= 1
      ? `https://${domain}/s?k=${encoded}${sortParam}`
      : `https://${domain}/s?k=${encoded}&page=${pageNumber}${sortParam}`;

  let parsed: AmazonUsProductCandidate[] = [];

  const html = await fetchAmazonHtml(url, {
    signal,
    timeoutMs: 8500,
    minHtmlChars: 5000,
  });

  const snippetHash = crypto.createHash('sha256').update(html.slice(0, 10000)).digest('hex').slice(0, 16);
  parsed = parseAmazonSearchResultsHtml(html, marketplace, {
    httpStatus: 200,
    fetchedAt: new Date().toISOString(),
    finalUrl: url,
    snippetHash,
  });

  for (const item of parsed) {
    const verdict = evaluateStrictProductTitleMatch(item.title, query);
    item.matchScore = verdict.matchScore;
    item.matchCategory = verdict.matchCategory;
  }

  const sorted = sortCandidatesByRatingCountDesc(parsed);

  if (sorted.length > 0) {
    queryCacheMap.set(cacheKey, {
      version: AMAZON_QUERY_CACHE_VERSION,
      key: cacheKey,
      marketplace,
      candidates: sorted,
      cachedAt: now,
      expiresAt: now + QUERY_CACHE_TTL_MS,
      responseSnippetHash: snippetHash,
    });
    saveQueryCacheToDisk();
  }

  return { candidates: sorted, fromCache: false, marketplace };
}

/**
 * Phase 4.5 Anchor + Snowball Expansion:
 * Given a high-confidence verified anchor ASIN, fetches its product page and extracts
 * variation siblings and carousel similar/related products (complete with title & thumbnail when embedded)
 * so they can be verified by image.
 */
export async function extractAnchorAndSiblingCandidates(
  anchorAsin: string,
  anchorTitle: string,
  marketplace: AmazonMarketplaceCode = 'US',
  maxSiblings = 12,
  signal?: AbortSignal
): Promise<AmazonUsProductCandidate[]> {
  if (!isValidAmazonAsin(anchorAsin)) return [];
  const domain = AMAZON_MARKETPLACE_DOMAINS[marketplace] || 'www.amazon.com';
  const dpUrl = `https://${domain}/dp/${anchorAsin}`;

  try {
    const html = await fetchAmazonHtml(dpUrl, {
      signal,
      timeoutMs: 9000,
      minHtmlChars: 4000,
    });

    const snippetHash = crypto.createHash('sha256').update(html.slice(0, 10000)).digest('hex').slice(0, 16);
    const results: AmazonUsProductCandidate[] = [];
    const seen = new Set<string>([anchorAsin.toUpperCase()]);

    const cardRegex = /<li[^>]*>[\s\S]*?data-asin="([B0-9][A-Z0-9]{9})"[\s\S]*?<\/li>|<div[^>]+data-asin="([B0-9][A-Z0-9]{9})"[^>]*>([\s\S]{100,2500}?)<\/div>/gi;
    let m: RegExpExecArray | null;
    while ((m = cardRegex.exec(html)) !== null && results.length < maxSiblings) {
      const asin = (m[1] || m[2] || '').toUpperCase();
      if (!asin || !isValidAmazonAsin(asin) || seen.has(asin)) continue;
      const chunk = m[0];
      const allUrls = chunk.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[^\s"'<>\\]+/gi) || [];
      let imgUrl: string | undefined;
      for (const rawUrl of allUrls) {
        const clean = rawUrl.replace(/[,;]+$/, '');
        if (!clean.toLowerCase().endsWith('.svg') && /\.(?:jpg|jpeg|png|webp)$/i.test(clean)) {
          imgUrl = clean;
          break;
        }
      }
      if (!imgUrl) continue;
      const altMatch = chunk.match(/alt="([^"]{10,220})"/i) || chunk.match(/title="([^"]{10,220})"/i);
      const title = altMatch ? decodeHtmlEntities(altMatch[1]) : `${anchorTitle} (Related ${asin})`;

      seen.add(asin);
      const finalUrl = `https://${domain}/dp/${asin}`;
      results.push({
        asin,
        title,
        url: finalUrl,
        marketplace,
        imageUrl: imgUrl,
        ratingCount: extractRatingCountFromCardHtml(chunk),
        provenanceData: {
          source: 'live',
          marketplace,
          asin,
          fetchedAt: new Date().toISOString(),
          httpStatus: 200,
          finalUrl,
          responseSnippetHash: snippetHash,
        },
      });
    }

    return results;
  } catch {
    return [];
  }
}

const SNOWBALL_STOPWORDS = new Set([
  'with',
  'for',
  'and',
  'the',
  'from',
  'into',
  'pack',
  'pcs',
  'set',
  'new',
  'upgraded',
  'home',
  'room',
  'indoor',
  'outdoor',
  'black',
  'white',
  'blue',
  'green',
  'red',
  'gray',
  'grey',
  'silver',
  'yellow',
]);

/**
 * Phase D Snowball Round helper:
 * Extracts frequent 3-word commercial product n-grams from listings that PASSED Stage-2 visual verification.
 */
export function extractSnowballQueriesFromVerifiedTitles(
  verifiedTitles: string[],
  alreadyTried: Set<string>,
  maxQueries = 4
): string[] {
  if (verifiedTitles.length === 0) return [];
  const ngramCounts = new Map<string, { display: string; count: number }>();

  for (const rawTitle of verifiedTitles) {
    const tokens = rawTitle
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !SNOWBALL_STOPWORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));

    const seenInTitle = new Set<string>();
    for (let i = 0; i <= tokens.length - 3; i++) {
      const phrase = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      const lower = phrase.toLowerCase();
      if (alreadyTried.has(lower) || seenInTitle.has(lower)) continue;
      seenInTitle.add(lower);
      const prev = ngramCounts.get(lower);
      if (prev) {
        prev.count++;
      } else {
        ngramCounts.set(lower, { display: phrase, count: 1 });
      }
    }
  }

  return Array.from(ngramCounts.values())
    .sort((a, b) => b.count - a.count)
    .map((x) => x.display)
    .slice(0, maxQueries);
}

/**
 * Convenience helper to fetch up to `maxResults` product candidates across pages,
 * sorted by rating count descending.
 */
export async function searchAmazonUsProductPages(
  query: string,
  maxResults = 48,
  signal?: AbortSignal
): Promise<AmazonUsProductCandidate[]> {
  const maxPages = Math.min(4, Math.max(1, Math.ceil(maxResults / 20)));
  const seenAsins = new Set<string>();
  const collected: AmazonUsProductCandidate[] = [];
  let blockedError: AmazonBlockError | null = null;

  for (let p = 1; p <= maxPages; p++) {
    if (signal?.aborted || collected.length >= maxResults) break;
    try {
      const { candidates } = await fetchAmazonSearchPage(query, p, signal);
      for (const c of candidates) {
        if (!seenAsins.has(c.asin)) {
          seenAsins.add(c.asin);
          collected.push(c);
        }
      }
      if (candidates.length < 6) break;
    } catch (err: unknown) {
      if (err instanceof AmazonBlockError) {
        blockedError = err;
      }
      console.warn(`[AmazonSearch] Page ${p} for "${query}" error:`, (err as Error)?.message || err);
      break;
    }
  }

  if (collected.length === 0 && blockedError) {
    throw blockedError;
  }

  return sortCandidatesByRatingCountDesc(collected).slice(0, maxResults);
}
