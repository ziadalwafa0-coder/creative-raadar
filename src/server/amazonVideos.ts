import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import type { ProvenanceClassification } from '../types/index.ts';
import { DATA_DIR } from './config.ts';
import {
  amazonUndiciAgent,
  AMAZON_CHROME_USER_AGENT,
  fetchAmazonHtml,
  AmazonBlockError,
  AmazonDeadListingError,
  isAmazonDeadListing,
} from './amazonHttp.ts';
import { extractAsinFromUrl } from './queryBuilder.ts';
import { isValidAmazonAsin } from './amazonSearch.ts';

export interface ExtractedAmazonVideo {
  title: string;
  mediaUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  sourceUrl: string;
  productListingUrl?: string;
  reviewerOrChannel: string;
  reviewId: string;
  streamUuid: string;
  provenance: ProvenanceClassification;
  isCustomerReview: boolean;
  incentiveDisclosure?: string;
  contentDescription: string;
  durationSeconds?: number;
}

export const ASIN_CACHE_SCHEMA_VERSION = 3;
export const DEAD_LISTING_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h negative cache TTL

interface AsinVideoCacheEntry {
  version: number;
  asin: string;
  marketplace?: string;
  videos: ExtractedAmazonVideo[];
  isNegative: boolean;
  isDead?: boolean;
  deadReason?: string;
  cachedAt: number;
  expiresAt: number;
  responseSnippetHash?: string;
}

const ASIN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL
const ASIN_CACHE_FILE = path.join(DATA_DIR, 'amazon_asin_videos_cache.json');
const asinVideoCache = new Map<string, AsinVideoCacheEntry>();

export function markAsinAsDead(asin: string, reason: string): void {
  const cleanAsin = (asin || '').toUpperCase().trim();
  if (!cleanAsin) return;
  asinVideoCache.set(cleanAsin, {
    version: ASIN_CACHE_SCHEMA_VERSION,
    asin: cleanAsin,
    videos: [],
    isNegative: true,
    isDead: true,
    deadReason: reason,
    cachedAt: Date.now(),
    expiresAt: Date.now() + DEAD_LISTING_NEGATIVE_CACHE_TTL_MS,
  });
  saveAsinCacheToDisk();
}

export function isAsinMarkedDead(asin: string): { isDead: boolean; reason?: string } {
  const cleanAsin = (asin || '').toUpperCase().trim();
  const cached = asinVideoCache.get(cleanAsin);
  if (cached && cached.isDead && cached.expiresAt > Date.now()) {
    return { isDead: true, reason: cached.deadReason || 'Dead listing' };
  }
  return { isDead: false };
}

function loadAsinCacheFromDisk(): void {
  try {
    if (fs.existsSync(ASIN_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ASIN_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (raw && raw.version === ASIN_CACHE_SCHEMA_VERSION && Array.isArray(raw.entries)) {
        for (const item of raw.entries) {
          if (
            item?.asin &&
            isValidAmazonAsin(item.asin) &&
            !item.asin.includes('EXACT') &&
            !item.asin.includes('COLOR')
          ) {
            asinVideoCache.set(item.asin, {
              ...item,
              expiresAt: Math.max(Number(item.expiresAt) || 0, now + (item.isDead ? DEAD_LISTING_NEGATIVE_CACHE_TTL_MS : ASIN_CACHE_TTL_MS)),
            });
          }
        }
      } else {
        console.log('[AmazonVideoCache] Old or unversioned ASIN cache found. Purging for integrity.');
        try {
          fs.unlinkSync(ASIN_CACHE_FILE);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[AmazonVideoCache] Failed to load ASIN video cache:', (err as Error)?.message);
  }
}

function saveAsinCacheToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const now = Date.now();
    const active: AsinVideoCacheEntry[] = [];
    for (const [k, v] of asinVideoCache.entries()) {
      if (v.expiresAt > now) active.push(v);
      else asinVideoCache.delete(k);
    }
    fs.writeFileSync(
      ASIN_CACHE_FILE,
      JSON.stringify({ version: ASIN_CACHE_SCHEMA_VERSION, entries: active }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('[AmazonVideoCache] Failed to save ASIN video cache:', (err as Error)?.message);
  }
}

loadAsinCacheFromDisk();

function decodeEntities(str: string): string {
  return (str || '')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;|\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .trim();
}

export function extractStreamUuid(videoUrl: string): string {
  const clean = decodeEntities(videoUrl).split('?')[0];
  const m = clean.match(/vse-vms-transcoding-artifact[^/]*\/([a-z0-9_-]{6,64})\//i);
  if (m) return m[1].toLowerCase();
  const tail = clean.match(/\/([A-Za-z0-9_-]{10,})\.(?:m3u8|mp4)$/i);
  return tail ? tail[1].toLowerCase() : clean.toLowerCase();
}

export function selectHighestQualityVariantFromM3u8(
  masterM3u8Content: string,
  masterUrl: string
): string | null {
  const lines = masterM3u8Content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let bestBandwidth = -1;
  let bestVariantUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/AVERAGE-BANDWIDTH=(\d+)/i) || line.match(/BANDWIDTH=(\d+)/i);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        try {
          const resolved = new URL(nextLine, masterUrl).href;
          if (bw >= bestBandwidth) {
            bestBandwidth = bw;
            bestVariantUrl = resolved;
          }
        } catch (err) {
          console.warn('[M3u8Parse] Invalid variant URL:', (err as Error)?.message);
        }
      }
    }
  }
  return bestVariantUrl;
}

async function confirmMp4ByHead(candidateUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSig = AbortSignal.timeout(2500);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await undiciFetch(candidateUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': AMAZON_CHROME_USER_AGENT },
      dispatcher: amazonUndiciAgent,
      signal: combinedSig,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || 0);
    if (res.ok && (ct.includes('video') || ct.includes('mp4') || ct.includes('octet-stream')) && len > 10_000) {
      return candidateUrl;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveBestVideoDownloadUrl(
  rawVideoUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const cleanUrl = decodeEntities(rawVideoUrl);
  if (/\.mp4(?:[?#]|$)/i.test(cleanUrl)) {
    const confirmed = await confirmMp4ByHead(cleanUrl, signal);
    if (confirmed) return confirmed;
  }

  const mp4Candidates: string[] = [];
  if (cleanUrl.includes('vse-vms-transcoding-artifact')) {
    const baseDir = cleanUrl.replace(/\/[^/]+\.m3u8.*$/i, '');
    mp4Candidates.push(
      `${baseDir}/default.jobtemplate.mp4.480.mp4`,
      `${baseDir}/default.vertical.jobtemplate.mp4.480.mp4`
    );
  }

  const [headResults, m3u8Variant] = await Promise.all([
    Promise.all(mp4Candidates.map((c) => confirmMp4ByHead(c, signal))),
    (async (): Promise<string | null> => {
      if (!/\.m3u8(?:[?#]|$)/i.test(cleanUrl)) return null;
      try {
        const timeoutSig = AbortSignal.timeout(3000);
        const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
        const res = await undiciFetch(cleanUrl, {
          method: 'GET',
          headers: { 'User-Agent': AMAZON_CHROME_USER_AGENT },
          dispatcher: amazonUndiciAgent,
          signal: combinedSig,
        });
        if (!res.ok) return null;
        const text = await res.text();
        return selectHighestQualityVariantFromM3u8(text, cleanUrl);
      } catch {
        return null;
      }
    })(),
  ]);

  return headResults.find(Boolean) || m3u8Variant || cleanUrl;
}

export function parseAmazonUsVideosFromHtml(
  html: string,
  pageUrl: string
): ExtractedAmazonVideo[] {
  const targetAsin = extractAsinFromUrl(pageUrl);
  const results: ExtractedAmazonVideo[] = [];
  const seenUuids = new Set<string>();
  const allowedAsinFamily = new Set<string>();
  if (targetAsin) allowedAsinFamily.add(targetAsin.toUpperCase());

  for (const pm of html.matchAll(/"parentAsin"\s*:\s*"([B0-9][A-Z0-9]{9})"/gi)) {
    allowedAsinFamily.add(pm[1].toUpperCase());
  }

  const pushCandidate = (item: {
    videoUrl: string;
    title?: string;
    reviewer?: string;
    thumb?: string;
    reviewLink?: string;
    creatorType?: string;
    segmentName?: string;
    productAsin?: string;
    parentAsin?: string;
    relatedAsins?: string;
    isCustomerSection?: boolean;
  }) => {
    const rawUrl = decodeEntities(item.videoUrl || '');
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl) || !/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(rawUrl)) return;

    const segLower = (item.segmentName || '').toLowerCase();
    if (segLower.includes('related product') || segLower.includes('other product')) return;

    const relatedList = (item.relatedAsins || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (relatedList.length > 2) return;

    const vAsin = (item.productAsin || '').trim().toUpperCase();
    const vParent = (item.parentAsin || '').trim().toUpperCase();
    if (vParent) allowedAsinFamily.add(vParent);
    if (targetAsin && vAsin && !allowedAsinFamily.has(vAsin) && vParent !== targetAsin) return;

    const cType = (item.creatorType || '').toLowerCase();
    const isForThisProduct =
      segLower.includes('this product') ||
      Boolean(targetAsin && vAsin === targetAsin.toUpperCase());
    const hasCustomerReviewLink = /customer-reviews|review/i.test(item.reviewLink || '');
    const isSellerOrVendor = ['seller', 'vendor', 'brand', 'manufacturer'].includes(cType);
    if (isSellerOrVendor && !hasCustomerReviewLink) return;

    const isCustomerOrCreator =
      ['customer', 'influencer'].includes(cType) ||
      hasCustomerReviewLink ||
      Boolean(item.isCustomerSection) ||
      !cType;
    if (!isCustomerOrCreator) return;

    const provenance: ProvenanceClassification =
      cType === 'influencer'
        ? 'affiliate_creator_demo'
        : isSellerOrVendor
        ? 'seller_manufacturer_demo'
        : 'unverified_customer_review';

    const streamUuid = extractStreamUuid(rawUrl);
    if (seenUuids.has(streamUuid)) return;
    seenUuids.add(streamUuid);

    let reviewId = `amz-${streamUuid.slice(0, 16)}`;
    const revMatch = (item.reviewLink || '').match(/customer-reviews\/([A-Z0-9]+)/i);
    if (revMatch && revMatch[1].toUpperCase() !== targetAsin) {
      reviewId = revMatch[1].toUpperCase();
    }

    const cleanTitle = decodeEntities(item.title || '').replace(/\s+/g, ' ').trim() || 'مراجعة عميل أمازون';
    const cleanReviewer =
      decodeEntities(item.reviewer || '').replace(/\s+/g, ' ').trim() ||
      (cType === 'influencer' ? 'مراجع أمازون (Creator Review)' : 'عميل أمازون');
    let pageDomain = 'www.amazon.com';
    try {
      if (pageUrl) pageDomain = new URL(pageUrl).hostname;
    } catch {}
    const fullSourceUrl = item.reviewLink
      ? item.reviewLink.startsWith('http')
        ? item.reviewLink
        : `https://${pageDomain}${item.reviewLink.startsWith('/') ? '' : '/'}${item.reviewLink}`
      : pageUrl;

    results.push({
      title: cleanTitle,
      mediaUrl: rawUrl,
      downloadUrl: rawUrl,
      thumbnailUrl: item.thumb ? decodeEntities(item.thumb) : undefined,
      sourceUrl: fullSourceUrl,
      productListingUrl: pageUrl,
      reviewerOrChannel: cleanReviewer,
      reviewId,
      streamUuid,
      provenance,
      isCustomerReview: !isSellerOrVendor,
      incentiveDisclosure: undefined,
      contentDescription: cleanTitle,
    });
  };

  const attrRegex = /data-video-items="(\[[\s\S]*?\])"/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    const objBlocks = attrMatch[1].match(/\{[^{}]*\}/g) || [];
    for (const rawObj of objBlocks) {
      const decoded = rawObj.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&amp;/g, '&');
      const getField = (name: string): string => {
        const m = decoded.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
        return m ? decodeEntities(m[1]) : '';
      };
      const videoUrl = getField('videoURL') || getField('url') || getField('hlsUrl');
      if (videoUrl) {
        pushCandidate({
          videoUrl,
          title: getField('title') || getField('reviewTitle'),
          reviewer: getField('publicName') || getField('profileName') || getField('creatorName'),
          thumb: getField('slateUrl') || getField('thumbnailUrl') || getField('imageUrl'),
          reviewLink: getField('fullReviewLink') || getField('reviewUrl'),
          creatorType: getField('creatorType') || getField('type'),
          segmentName: getField('segmentName'),
          productAsin: getField('productAsin') || getField('asin'),
          parentAsin: getField('parentAsin'),
          relatedAsins: getField('relatedProductsAsins'),
        });
      }
    }
  }

  const reviewBlockRegex = /id="customer_review-([A-Z0-9]+)"([\s\S]*?)(?=id="customer_review-[A-Z0-9]+"|<div[^>]+id="cm_cr-pagination|$)/gi;
  let revBlockMatch: RegExpExecArray | null;
  while ((revBlockMatch = reviewBlockRegex.exec(html)) !== null) {
    const reviewId = revBlockMatch[1];
    const block = revBlockMatch[2];
    const urlMatches = block.matchAll(
      /(https?:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact[^"'\s\\]+\.(?:m3u8|mp4))/gi
    );
    const titleMatch =
      block.match(/data-hook="review-title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
      block.match(/class="[^"]*review-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const profileMatch = block.match(/class="a-profile-name"[^>]*>([\s\S]*?)<\/span>/i);
    const thumbMatch =
      block.match(/(?:data-thumb-url|poster)="(https?:\/\/m\.media-amazon\.com\/images\/[^"'\s\\]+)"/i) ||
      block.match(/(https?:\/\/m\.media-amazon\.com\/images\/(?:I|S)\/[^"'\s\\]+\.(?:jpg|jpeg|png))/i);

    for (const um of urlMatches) {
      pushCandidate({
        videoUrl: um[1],
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'مراجعة فيديو من مشتري',
        reviewer: profileMatch ? profileMatch[1].replace(/<[^>]+>/g, '').trim() : 'عميل أمازون',
        thumb: thumbMatch ? thumbMatch[1] : undefined,
        reviewLink: `/gp/customer-reviews/${reviewId}`,
        creatorType: 'Customer',
        productAsin: targetAsin || undefined,
        isCustomerSection: true,
      });
    }
  }

  return results;
}

/**
 * Extracts parent/variation sibling ASINs (e.g. color or pack variations under the same parent listing)
 * from an Amazon product page HTML.
 */
export function extractVariationSiblingAsins(html: string, currentAsin?: string): string[] {
  const siblings = new Set<string>();
  const upperCurrent = (currentAsin || '').toUpperCase();

  // Match dimensionValuesDisplayData / dimensionToAsinMap / colorToAsin blocks
  const blockPatterns = [
    /"dimensionToAsinMap"\s*:\s*\{([^{}]{1,4000})\}/gi,
    /"dimensionValuesDisplayData"\s*:\s*\{([^{}]{1,6000})\}/gi,
    /"colorToAsin"\s*:\s*\{([\s\S]{1,4000}?)\}\s*[,}]/gi,
  ];

  for (const pat of blockPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(html)) !== null) {
      const asinMatches = m[1].matchAll(/"([B0-9][A-Z0-9]{9})"/gi);
      for (const am of asinMatches) {
        const cand = am[1].toUpperCase();
        if (cand !== upperCurrent) {
          siblings.add(cand);
        }
      }
    }
  }

  return Array.from(siblings).slice(0, 4);
}

function resolveAmazonDomainFromUrl(urlStr: string): string {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (host.includes('amazon.')) return host;
  } catch {}
  return 'www.amazon.com';
}

export async function fetchAmazonUsProductVideos(
  productUrlOrAsin: string,
  signal?: AbortSignal,
  ..._legacyArgs: unknown[]
): Promise<ExtractedAmazonVideo[]> {
  const asin = extractAsinFromUrl(productUrlOrAsin) || productUrlOrAsin.trim().toUpperCase();
  const isAsinValid = /^[B0-9][A-Z0-9]{9}$/.test(asin);
  const domain = resolveAmazonDomainFromUrl(productUrlOrAsin);
  const cacheKey = domain === 'www.amazon.com' ? asin : `${domain}::${asin}`;
  const now = Date.now();

  if (isAsinValid) {
    const cached = asinVideoCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.videos;
  }

  const dpUrl = isAsinValid ? `https://${domain}/dp/${asin}` : productUrlOrAsin;

  let blockError: AmazonBlockError | null = null;
  let deadError: AmazonDeadListingError | null = null;
  const dpHtml = await fetchAmazonHtml(dpUrl, {
    signal,
    timeoutMs: 8500,
    minHtmlChars: 4000,
    referer: `https://${domain}/`,
  }).catch((err: unknown) => {
    if (err instanceof AmazonDeadListingError) deadError = err;
    else if (err instanceof AmazonBlockError) {
      blockError = err;
      console.info(`[AmazonVideos] Product page challenge encountered (${dpUrl}); trying reviews fallback.`);
    } else {
      console.warn(`[AmazonVideos] Product page fetch error (${dpUrl}):`, (err as Error)?.message || err);
    }
    return '';
  });

  if (deadError) {
    const d = deadError as AmazonDeadListingError;
    markAsinAsDead(asin, d.reason);
    throw d;
  }

  let effectiveDpHtml = dpHtml;
  if (!effectiveDpHtml && blockError && isAsinValid) {
    // Attempt fallback to customer-reviews page before giving up
    const reviewsUrl = `https://${domain}/product-reviews/${asin}?pageNumber=1&sortBy=recent`;
    try {
      const reviewsHtml = await fetchAmazonHtml(reviewsUrl, {
        signal,
        timeoutMs: 8000,
        minHtmlChars: 2000,
        referer: `https://${domain}/`,
      });
      if (reviewsHtml) {
        effectiveDpHtml = reviewsHtml;
      }
    } catch (reviewErr) {
      console.info(`[AmazonVideos] Reviews fallback also challenged for ASIN ${asin}; skipping.`);
    }
  }

  if (!effectiveDpHtml && blockError) {
    console.info(`[AmazonVideos] ASIN ${asin} challenge triggered; continuing with next candidate.`);
    return [];
  }

  const fromDp = effectiveDpHtml ? parseAmazonUsVideosFromHtml(effectiveDpHtml, dpUrl) : [];

  // Phase D: Also inspect up to 2 variation sibling ASINs (e.g. color variations) on /dp/<sibAsin> if this listing has < 6 videos
  const siblingVideos: ExtractedAmazonVideo[] = [];
  if (dpHtml && fromDp.length < 6 && !signal?.aborted) {
    const siblingAsins = extractVariationSiblingAsins(dpHtml, asin).slice(0, 2);
    if (siblingAsins.length > 0) {
      const sibHtmls = await Promise.all(
        siblingAsins.map(async (sibAsin) => {
          const sibDpUrl = `https://${domain}/dp/${sibAsin}`;
          return await fetchAmazonHtml(sibDpUrl, {
            signal,
            timeoutMs: 7500,
            minHtmlChars: 4000,
            referer: dpUrl,
          }).catch(() => '');
        })
      );
      sibHtmls.forEach((sHtml, idx) => {
        if (sHtml) {
          const sibDp = `https://${domain}/dp/${siblingAsins[idx]}`;
          siblingVideos.push(...parseAmazonUsVideosFromHtml(sHtml, sibDp));
        }
      });
    }
  }

  const mergedByUuid = new Map<string, ExtractedAmazonVideo>();
  for (const v of [...fromDp, ...siblingVideos]) {
    const existing = mergedByUuid.get(v.streamUuid);
    if (!existing) {
      mergedByUuid.set(v.streamUuid, v);
    } else {
      if (!existing.thumbnailUrl && v.thumbnailUrl) existing.thumbnailUrl = v.thumbnailUrl;
      if (existing.title === 'مراجعة فيديو من مشتري' && v.title && v.title !== 'مراجعة فيديو من مشتري') {
        existing.title = v.title;
      }
      if (existing.reviewerOrChannel === 'عميل أمازون' && v.reviewerOrChannel && v.reviewerOrChannel !== 'عميل أمازون') {
        existing.reviewerOrChannel = v.reviewerOrChannel;
      }
    }
  }
  const merged = Array.from(mergedByUuid.values());

  const resolveBatchSize = 6;
  for (let i = 0; i < merged.length; i += resolveBatchSize) {
    if (signal?.aborted) break;
    const slice = merged.slice(i, i + resolveBatchSize);
    await Promise.all(
      slice.map(async (v) => {
        v.downloadUrl = await resolveBestVideoDownloadUrl(v.mediaUrl, signal);
      })
    );
  }

  if (isAsinValid && merged.length > 0 && !signal?.aborted) {
    asinVideoCache.set(cacheKey, {
      version: ASIN_CACHE_SCHEMA_VERSION,
      asin: cacheKey,
      videos: merged,
      isNegative: false,
      cachedAt: now,
      expiresAt: now + ASIN_CACHE_TTL_MS,
    });
    saveAsinCacheToDisk();
  }

  return merged;
}

