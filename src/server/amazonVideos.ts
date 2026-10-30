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
} from './amazonHttp.ts';
import { extractAsinFromUrl } from './queryBuilder.ts';

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

interface AsinVideoCacheEntry {
  asin: string;
  videos: ExtractedAmazonVideo[];
  isNegative: boolean;
  cachedAt: number;
  expiresAt: number;
}

const ASIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL (positive & negative cache)
const ASIN_CACHE_FILE = path.join(DATA_DIR, 'amazon_asin_videos_cache.json');
const asinVideoCache = new Map<string, AsinVideoCacheEntry>();

function loadAsinCacheFromDisk(): void {
  try {
    if (fs.existsSync(ASIN_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ASIN_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item?.asin && Array.isArray(item.videos) && item.expiresAt > now) {
            asinVideoCache.set(item.asin, item);
          }
        }
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
    fs.writeFileSync(ASIN_CACHE_FILE, JSON.stringify(active, null, 2), 'utf-8');
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
    const hasCustomerReviewLink = /customer-reviews|review/i.test(item.reviewLink || '');
    const isSellerOrInfluencer = ['seller', 'vendor', 'brand', 'manufacturer', 'influencer'].includes(cType);
    if (isSellerOrInfluencer && !hasCustomerReviewLink) return;

    const isCustomer = cType === 'customer' || hasCustomerReviewLink || Boolean(item.isCustomerSection) || !cType;
    if (!isCustomer) return;

    const streamUuid = extractStreamUuid(rawUrl);
    if (seenUuids.has(streamUuid)) return;
    seenUuids.add(streamUuid);

    let reviewId = `amz-${streamUuid.slice(0, 16)}`;
    const revMatch = (item.reviewLink || '').match(/customer-reviews\/([A-Z0-9]+)/i);
    if (revMatch && revMatch[1].toUpperCase() !== targetAsin) {
      reviewId = revMatch[1].toUpperCase();
    }

    const cleanTitle = decodeEntities(item.title || '').replace(/\s+/g, ' ').trim() || 'مراجعة عميل أمازون';
    const cleanReviewer = decodeEntities(item.reviewer || '').replace(/\s+/g, ' ').trim() || 'عميل أمازون';
    const fullSourceUrl = item.reviewLink
      ? item.reviewLink.startsWith('http')
        ? item.reviewLink
        : `https://www.amazon.com${item.reviewLink.startsWith('/') ? '' : '/'}${item.reviewLink}`
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
      provenance: 'unverified_customer_review',
      isCustomerReview: true,
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
    const thumbMatch = block.match(/(https?:\/\/m\.media-amazon\.com\/images\/I\/[^"'\s\\]+\.jpg)/i);

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

export async function fetchAmazonUsProductVideos(
  productUrlOrAsin: string,
  signal?: AbortSignal,
  ..._legacyArgs: unknown[]
): Promise<ExtractedAmazonVideo[]> {
  const asin = extractAsinFromUrl(productUrlOrAsin) || productUrlOrAsin.trim().toUpperCase();
  const isAsinValid = /^[B0-9][A-Z0-9]{9}$/.test(asin);
  const now = Date.now();

  if (isAsinValid) {
    const cached = asinVideoCache.get(asin);
    if (cached && cached.expiresAt > now) return cached.videos;
  }

  const dpUrl = isAsinValid ? `https://www.amazon.com/dp/${asin}` : productUrlOrAsin;
  const reviewsMediaUrl = isAsinValid
    ? `https://www.amazon.com/product-reviews/${asin}?mediaType=media_reviews_only`
    : null;

  let blockError: AmazonBlockError | null = null;
  const [dpHtml, reviewsHtml] = await Promise.all([
    fetchAmazonHtml(dpUrl, { signal, timeoutMs: 8000, minHtmlChars: 4000, referer: 'https://www.amazon.com/' }).catch((err: unknown) => {
      if (err instanceof AmazonBlockError) blockError = err;
      console.warn(`[AmazonVideos] Product page fetch error (${dpUrl}):`, (err as Error)?.message || err);
      return '';
    }),
    reviewsMediaUrl
      ? fetchAmazonHtml(reviewsMediaUrl, { signal, timeoutMs: 8000, minHtmlChars: 2500, referer: dpUrl }).catch((err: unknown) => {
          if (err instanceof AmazonBlockError && !blockError) blockError = err;
          console.warn(`[AmazonVideos] Media reviews fetch error (${reviewsMediaUrl}):`, (err as Error)?.message || err);
          return '';
        })
      : Promise.resolve(''),
  ]);

  if (!dpHtml && !reviewsHtml && blockError) throw blockError;

  const fromDp = dpHtml ? parseAmazonUsVideosFromHtml(dpHtml, dpUrl) : [];
  const fromReviews = reviewsHtml && reviewsMediaUrl ? parseAmazonUsVideosFromHtml(reviewsHtml, dpUrl) : [];

  const mergedByUuid = new Map<string, ExtractedAmazonVideo>();
  for (const v of [...fromReviews, ...fromDp]) {
    if (!mergedByUuid.has(v.streamUuid)) mergedByUuid.set(v.streamUuid, v);
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

  if (isAsinValid && !signal?.aborted) {
    asinVideoCache.set(asin, {
      asin,
      videos: merged,
      isNegative: merged.length === 0,
      cachedAt: now,
      expiresAt: now + ASIN_CACHE_TTL_MS,
    });
    saveAsinCacheToDisk();
  }

  return merged;
}
