import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { fetchAmazonHtml, AmazonBlockError } from './amazonHttp.ts';
import { evaluateStrictProductTitleMatch } from './queryBuilder.ts';

export interface AmazonUsProductCandidate {
  asin: string;
  title: string;
  url: string;
  imageUrl?: string;
  ratingCount: number;
  reviewOrSalesScore?: number;
  matchScore?: number;
  matchCategory?: 'exact_design' | 'permitted_variation' | 'mismatched';
  isSponsored?: boolean;
}

interface QueryCacheEntry {
  key: string;
  candidates: AmazonUsProductCandidate[];
  cachedAt: number;
  expiresAt: number;
}

const QUERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const QUERY_CACHE_FILE = path.join(DATA_DIR, 'amazon_query_cache_v2.json');
const queryCacheMap = new Map<string, QueryCacheEntry>();

function loadQueryCacheFromDisk(): void {
  try {
    if (fs.existsSync(QUERY_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUERY_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.key && Array.isArray(item.candidates) && item.expiresAt > now) {
            queryCacheMap.set(item.key, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[AmazonSearchCache] Failed to load query cache:', (err as Error)?.message);
  }
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
    fs.writeFileSync(QUERY_CACHE_FILE, JSON.stringify(active, null, 2), 'utf-8');
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

  // Pattern 1: aria-label="4,521 ratings" or "1,203" next to review link
  const ariaRatingRegex = /aria-label="([\d,]+)\s+ratings?"/gi;
  let m: RegExpExecArray | null;
  while ((m = ariaRatingRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  // Pattern 2: <span class="a-size-base s-underline-text">(1,234)</span> or >1,234<
  const underlineRegex = /s-underline-text[^>]*>\s*\(?([\d,]+(?:\.\d+)?[KM]?\+?)\)?\s*<\/span>/gi;
  while ((m = underlineRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  // Pattern 3: customerReviews link with count
  const reviewLinkRegex = /#customerReviews[^>]*>\s*<span[^>]*>\s*\(?([\d,]+)\)?\s*<\/span>/gi;
  while ((m = reviewLinkRegex.exec(cardHtml)) !== null) {
    const val = parseCompactNumber(m[1]);
    if (val > maxRatings) maxRatings = val;
  }

  // Pattern 4: Fallback to "2K+ bought in past month" if rating count wasn't matched
  if (maxRatings === 0) {
    const boughtMatch = cardHtml.match(/(\d+(?:\.\d+)?[KM]?\+?)\s+bought\s+in\s+past\s+month/i);
    if (boughtMatch) {
      maxRatings = parseCompactNumber(boughtMatch[1]);
    }
  }

  return maxRatings;
}

/**
 * Parses an Amazon US search results HTML page into product candidates.
 */
export function parseAmazonSearchResultsHtml(html: string): AmazonUsProductCandidate[] {
  const results: AmazonUsProductCandidate[] = [];
  const seenAsins = new Set<string>();

  const cardRegex = /<div[^>]+data-asin="([B0-9][A-Z0-9]{9})"[^>]*>([\s\S]*?)(?=<div[^>]+data-asin="[B0-9][A-Z0-9]{9}"|<\/div>\s*<div[^>]+class="[^"]*s-pagination|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = cardRegex.exec(html)) !== null) {
    const asin = match[1].toUpperCase();
    if (!asin || seenAsins.has(asin)) continue;
    const block = match[2];

    const imgAltMatch = block.match(/<img[^>]+class="[^"]*s-image[^"]*"[^>]+alt="([^"]+)"/i);
    const h2TextMatch =
      block.match(/<h2[^>]*aria-label="([^"]+)"/i) ||
      block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/i);

    const rawTitle = decodeHtmlEntities(
      (h2TextMatch ? h2TextMatch[1] : imgAltMatch ? imgAltMatch[1] : '').replace(/<[^>]+>/g, '')
    ).replace(/^Sponsored\s+Ad\s*[-–—]\s*/i, '');

    if (!rawTitle || rawTitle.length < 5) continue;

    const imgSrcMatch = block.match(/<img[^>]+class="[^"]*s-image[^"]*"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i);
    const ratingCount = extractRatingCountFromCardHtml(block);

    seenAsins.add(asin);
    results.push({
      asin,
      title: rawTitle,
      url: `https://www.amazon.com/dp/${asin}`,
      imageUrl: imgSrcMatch ? imgSrcMatch[1] : undefined,
      ratingCount,
      reviewOrSalesScore: ratingCount,
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

/**
 * Fetches a single Amazon US search page with 1-hour persistent caching in DATA_DIR.
 * Throws AmazonBlockError if Amazon blocks the request.
 */
export async function fetchAmazonSearchPage(
  query: string,
  pageNumber = 1,
  signal?: AbortSignal
): Promise<{ candidates: AmazonUsProductCandidate[]; fromCache: boolean }> {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = `${normalizedQuery}::p${pageNumber}`;
  const now = Date.now();

  const cached = queryCacheMap.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.candidates.length > 0) {
    return { candidates: cached.candidates, fromCache: true };
  }

  const encoded = encodeURIComponent(query.trim()).replace(/%20/g, '+');
  const url =
    pageNumber <= 1
      ? `https://www.amazon.com/s?k=${encoded}`
      : `https://www.amazon.com/s?k=${encoded}&page=${pageNumber}`;

  let html = await fetchAmazonHtml(url, {
    signal,
    timeoutMs: 8000,
    minHtmlChars: 5000,
  });

  let parsed = parseAmazonSearchResultsHtml(html);

  if (parsed.length === 0 && !/no results for\s/i.test(html) && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 350));
    html = await fetchAmazonHtml(url, {
      signal,
      timeoutMs: 8000,
      minHtmlChars: 5000,
    });
    parsed = parseAmazonSearchResultsHtml(html);
    if (parsed.length === 0 && !/no results for\s/i.test(html)) {
      throw new AmazonBlockError(url, 200, 'Search shell page contained 0 product cards');
    }
  }

  // Annotate matchScore & sort by ratingCount descending
  for (const item of parsed) {
    const verdict = evaluateStrictProductTitleMatch(item.title, query);
    item.matchScore = verdict.matchScore;
    item.matchCategory = verdict.matchCategory;
  }

  const sorted = sortCandidatesByRatingCountDesc(parsed);

  if (sorted.length > 0) {
    queryCacheMap.set(cacheKey, {
      key: cacheKey,
      candidates: sorted,
      cachedAt: now,
      expiresAt: now + QUERY_CACHE_TTL_MS,
    });
    saveQueryCacheToDisk();
  }

  return { candidates: sorted, fromCache: false };
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
