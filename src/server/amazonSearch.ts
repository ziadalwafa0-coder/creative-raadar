import {discoverIndexedListings} from './indexedListings.ts';
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
  recentPurchases?: number;
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
const OFFLINE_LISTING_WINDOW_MS = 7 * 24 * QUERY_CACHE_TTL_MS;
const QUERY_CACHE_FILE = path.join(DATA_DIR, 'amazon_query_cache_v2.json');
const queryCacheMap = new Map<string, QueryCacheEntry>();

function loadQueryCacheFromDisk(): void {
  try {
    if (fs.existsSync(QUERY_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUERY_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.key && Array.isArray(item.candidates) && now-item.cachedAt < OFFLINE_LISTING_WINDOW_MS) {
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
      if (now-v.cachedAt < OFFLINE_LISTING_WINDOW_MS) {
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

    const imageTag=block.match(/<img\b(?=[^>]*\bclass=["'][^"']*\bs-image\b[^"']*["'])[^>]*>/i)?.[0] || '';
    const imgAltMatch=imageTag.match(/\balt=["']([^"']+)["']/i);
    const h2TextMatch =
      block.match(/<h2\b[^>]*aria-label="([^"]+)"/i) ||
      block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);

    const rawTitle = decodeHtmlEntities(
      (h2TextMatch ? h2TextMatch[1] : imgAltMatch ? imgAltMatch[1] : '').replace(/<[^>]+>/g, '')
    ).replace(/^Sponsored\s+Ad\s*[-–—]\s*/i, '');

    if (!rawTitle || rawTitle.length < 5) continue;

    const imgSrcMatch=imageTag.match(/\ssrc=["'](https:\/\/m\.media-amazon\.com\/images\/I\/[^"']+)["']/i);
    const ratingCount = extractRatingCountFromCardHtml(block);
    const recentPurchases = parseCompactNumber(block.match(/([\d,.]+[KM]?\+?)\s+bought\s+in\s+(?:the\s+)?past\s+month/i)?.[1] || '');

    seenAsins.add(asin);
    results.push({
      asin,
      title: rawTitle,
      url: `https://www.amazon.com/dp/${asin}`,
      imageUrl: imgSrcMatch ? imgSrcMatch[1] : undefined,
      ratingCount,
      recentPurchases,
      reviewOrSalesScore: ratingCount,
    });
  }

  return results;
}

/**
 * Sorts product candidates by rating COUNT descending as the primary key (then match score descending).
 */
export function sortCandidatesByRatingCountDesc<
  T extends { ratingCount?: number; reviewOrSalesScore?: number; matchScore?: number; recentPurchases?: number }
>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const purchases = (b.recentPurchases || 0) - (a.recentPurchases || 0);
    if (purchases) return purchases;
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
async function fetchLiveSearchPage(
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
export async function fetchAmazonSearchPage(query:string,pageNumber=1,signal?:AbortSignal) {
  try { return await fetchLiveSearchPage(query,pageNumber,signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof AmazonBlockError)) throw error;
    const words=query.toLowerCase().trim().split(/\s+/);
    const entries=[...queryCacheMap.values()].filter(entry=>{
      const [term,page]=entry.key.split('::p');
      const terms=term.split(/\s+/);
      return Number(page)===pageNumber && Date.now()-entry.cachedAt<OFFLINE_LISTING_WINDOW_MS &&
        (term===words.join(' ') || (terms.length>=2 && terms.every(word=>words.includes(word))));
    }).sort((a,b)=>b.key.length-a.key.length);
    for(const entry of entries){
      const candidates=entry.candidates.filter(c=>evaluateStrictProductTitleMatch(c.title,query).approved);
      if(candidates.length)return {candidates,fromCache:true};
    }
    // A new wording can match listings from a previous search, including another page.
    if(pageNumber===1 && words.length>=2){
      const ranked=new Map<string,AmazonUsProductCandidate>();
      for(const entry of queryCacheMap.values()){
        if(Date.now()-entry.cachedAt>=OFFLINE_LISTING_WINDOW_MS)continue;
        for(const product of entry.candidates){
          const match=evaluateStrictProductTitleMatch(product.title,query);
          if(match.approved && match.matchScore>=90 && product.imageUrl)ranked.set(product.asin,product);
        }
      }
      if(ranked.size)return {candidates:sortCandidatesByRatingCountDesc([...ranked.values()]).slice(0,48),fromCache:true};
    }
    if(pageNumber===1){
      const candidates=await discoverIndexedListings(query,signal).catch(()=>{signal?.throwIfAborted();return [];});
      if(candidates.length){
        const now=Date.now(), key=words.join(' ')+'::p1';
        queryCacheMap.set(key,{key,candidates,cachedAt:now,expiresAt:now+5*60*1000});
        saveQueryCacheToDisk();
        return {candidates,fromCache:false};
      }
      if(error.status===503 && words.length>=5){
        const shorter=await fetchLiveSearchPage(words.slice(0,3).join(' '),1,signal);
        const matching=shorter.candidates.filter(c=>evaluateStrictProductTitleMatch(c.title,query).approved);
        if(matching.length)return {...shorter,candidates:matching};
      }
    }
    throw error;
  }
}

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
