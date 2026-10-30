import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { ZipArchive } from 'archiver';
import type {
  SourcePlatform,
  Project,
  CandidateAsset,
  JobState,
  ProvenanceClassification,
} from '../types/index.ts';
import { isSafeExternalUrl, sanitizeCsvField, computeSha256 } from '../utils/security.server.ts';
import { normalizeUrl, isDuplicateCandidate } from '../utils/rules.ts';
import { StorageService } from './storage.ts';
import {
  AmazonBlockError,
  AMAZON_CHROME_USER_AGENT,
  AMAZON_US_HEADERS,
  fetchAmazonHtml,
} from './amazonHttp.ts';
import {
  buildAmazonUsQueries,
  evaluateStrictProductTitleMatch,
  resolveProductIdentityFromUrl,
  type TitleMatchVerdict,
} from './queryBuilder.ts';
import {
  fetchAmazonSearchPage,
  sortCandidatesByRatingCountDesc,
  type AmazonUsProductCandidate,
} from './amazonSearch.ts';
import {
  fetchAmazonUsProductVideos,
  parseAmazonUsVideosFromHtml,
  type ExtractedAmazonVideo,
} from './amazonVideos.ts';
import { DATA_DIR } from './config.ts';
import { downloadMedia, prewarmMediaInBackground, DOWNLOADS_DIR } from './downloader.ts';
import { analyzeProductImage, isGeminiConfigured } from './gemini.ts';
import {collectVerifiedListings} from './verifiedCollection.ts';

export interface EphemeralAsset {
  id: string;
  searchId: string;
  title: string;
  mediaUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  sourceUrl: string;
  productListingUrl: string;
  reviewerOrChannel?: string;
  reviewId?: string;
  mediaType: 'video' | 'photo';
  platform?: SourcePlatform;
  durationSeconds?: number;
  provenance: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  matchCategory: 'exact_design' | 'permitted_variation';
  matchScore: number;
  userFacingMatchLabel: string;
  isCustomerReview: boolean;
  ratingCount?: number;
  collectedAt: string;
}

export type StreamSearchEvent =
  | {
      type: 'started';
      searchId: string;
      productName: string;
      mediaType: 'video' | 'photo' | 'both';
      targetCount: number;
      targetVideoCount: number;
      targetPhotoCount: number;
      timestamp: string;
    }
  | {
      type: 'progress';
      searchId: string;
      message: string;
      pagesInspected?: number;
      foundCount: number;
      resolvedProductName?: string;
      timestamp: string;
    }
  | {
      type: 'warning';
      searchId: string;
      message: string;
      code: string;
      timestamp: string;
    }
  | {
      type: 'result';
      searchId: string;
      asset: EphemeralAsset;
      timestamp: string;
    }
  | {
      type: 'completed';
      searchId: string;
      requestedCount: number;
      foundCount: number;
      downloadableCount: number;
      reasonIfPartial?: string;
      timestamp: string;
    }
  | {
      type: 'failed';
      searchId: string;
      error: string;
      timestamp: string;
    };

export interface ExtractedPhotoCandidate {
  mediaUrl: string;
  sourceUrl: string;
  title: string;
  provenance: ProvenanceClassification;
  verifiedPurchaseEvidence?: string;
}

const EXTRACTION_CACHE_TTL_MS = 15 * 60 * 1000;
const videoResolveCache = new Map<string, { value: string | undefined; expiresAt: number }>();
const photoResolveCache = new Map<string, { value: ExtractedPhotoCandidate[]; expiresAt: number }>();

export function isDirectMediaLink(url?: string): boolean {
  if (!url) return false;
  return /\.(mp4|m3u8|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(url.trim());
}

function isIgnoredThumbnailOrStock(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('unsplash.com') || lower.includes('picsum.photos') || lower.includes('placehold')) {
    return true;
  }
  return (
    lower.includes('sprite') ||
    lower.includes('transparent-pixel') ||
    lower.includes('grey-pixel') ||
    lower.includes('/g/01/') ||
    lower.includes('icon') ||
    lower.includes('badge') ||
    lower.includes('logo') ||
    lower.includes('nav-') ||
    lower.includes('._ss40_') ||
    lower.includes('._sx38_') ||
    lower.includes('._sy38_') ||
    lower.includes('._us40_') ||
    lower.includes('._cr0,0,')
  );
}

function upgradeAmazonImageResolution(url: string): string {
  if (url.includes('m.media-amazon.com/images/I/')) {
    return url.replace(/\._[A-Z0-9,_-]+_\.(jpg|jpeg|png|webp)/i, '._SL1500_.$1');
  }
  return url;
}

export async function resolvePublicVideo(
  source: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!isSafeExternalUrl(source).safe) return undefined;
  if (/\.(mp4|m3u8)(?:[?#]|$)/i.test(source)) return source;

  const now = Date.now();
  const cached = videoResolveCache.get(source);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const isAmz = source.toLowerCase().includes('amazon.');
    if (isAmz) {
      const vids = await fetchAmazonUsProductVideos(source, signal);
      if (vids.length > 0) {
        const best = vids[0].downloadUrl || vids[0].mediaUrl;
        videoResolveCache.set(source, { value: best, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
        return best;
      }
    }
    const html = await fetchAmazonHtml(source, { signal, timeoutMs: 8000, minHtmlChars: 1000 });
    const amzVideos = parseAmazonUsVideosFromHtml(html, source);
    if (amzVideos.length > 0) {
      const best = amzVideos[0].downloadUrl || amzVideos[0].mediaUrl;
      videoResolveCache.set(source, { value: best, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
      return best;
    }
    const cleaned = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const media =
      cleaned.match(/https:\/\/m\.media-amazon\.com\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi) ||
      cleaned.match(/https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi) ||
      [];
    const found = media.find((link) => isSafeExternalUrl(link).safe);
    videoResolveCache.set(source, { value: found, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
    return found;
  } catch (err) {
    console.warn('[ResolvePublicVideo] Failed:', (err as Error)?.message);
    return undefined;
  }
}

export async function resolvePublicPhotos(
  source: string,
  maxPhotos = 10,
  signal?: AbortSignal
): Promise<ExtractedPhotoCandidate[]> {
  if (!isSafeExternalUrl(source).safe || isIgnoredThumbnailOrStock(source)) return [];

  if (/\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.test(source)) {
    return [
      {
        mediaUrl: source,
        sourceUrl: source,
        title: 'صورة منتج مباشرة',
        provenance: 'unresolved_source',
      },
    ];
  }

  const now = Date.now();
  const cached = photoResolveCache.get(source);
  if (cached && cached.expiresAt > now) {
    return cached.value.slice(0, maxPhotos);
  }

  let url = source;
  for (let hop = 0; hop < 4; hop++) {
    if (!isSafeExternalUrl(url).safe) return [];
    const timeoutSig = AbortSignal.timeout(10000);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const isAmz = url.toLowerCase().includes('amazon.');
    const response = await fetch(url, {
      redirect: 'manual',
      signal: combinedSig,
      headers: isAmz
        ? AMAZON_US_HEADERS
        : { 'User-Agent': AMAZON_CHROME_USER_AGENT, Accept: 'text/html,image/*' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return [];
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) return [];
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('image/')) {
      if (isIgnoredThumbnailOrStock(url)) return [];
      const single: ExtractedPhotoCandidate[] = [
        {
          mediaUrl: url,
          sourceUrl: source,
          title: 'صورة منتج مباشرة',
          provenance: 'unresolved_source',
        },
      ];
      photoResolveCache.set(source, { value: single, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
      return single;
    }
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return [];
    const html = (await response.text()).replace(/\\\//g, '/').replace(/&amp;/g, '&');

    const results: ExtractedPhotoCandidate[] = [];
    const seen = new Set<string>();
    const maxToCollect = Math.max(50, maxPhotos * 2);

    const addCandidate = (cand: ExtractedPhotoCandidate) => {
      if (results.length >= maxToCollect) return;
      if (!isSafeExternalUrl(cand.mediaUrl).safe || isIgnoredThumbnailOrStock(cand.mediaUrl)) return;
      const cleanKey = cand.mediaUrl.split('?')[0];
      if (seen.has(cleanKey)) return;
      seen.add(cleanKey);
      results.push(cand);
    };

    const reviewTileRegex =
      /<img[^>]+(?:data-hook="review-image-tile"|class="[^"]*review-image-tile[^"]*"|class="[^"]*cr-lightbox-image-thumbnail[^"]*")[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = reviewTileRegex.exec(html)) !== null) {
      addCandidate({
        mediaUrl: upgradeAmazonImageResolution(match[1]),
        sourceUrl: source,
        title: 'صورة مراجعة عميل',
        provenance: 'unverified_customer_review',
      });
    }

    const hiResRegex = /"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    while ((match = hiResRegex.exec(html)) !== null) {
      addCandidate({
        mediaUrl: match[1],
        sourceUrl: source,
        title: 'صورة المنتج (عرض البائع)',
        provenance: 'seller_manufacturer_demo',
      });
    }

    photoResolveCache.set(source, { value: results, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
    return results.slice(0, maxPhotos);
  }
  return [];
}

const ALLOWED_DOWNLOAD_HOST_SUFFIXES = [
  'media-amazon.com',
  'ssl-images-amazon.com',
  'images-amazon.com',
  'amazonaws.com',
  'cloudfront.net',
];

export function isAllowedDownloadHost(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

const activeOwnerStreams = new Map<string, { searchId: string; abort: () => void }>();

interface QueuedProductInspection {
  page: AmazonUsProductCandidate;
  titleVerdict: TitleMatchVerdict;
}

interface RecentStreamSearchRecord {
  ownerId: string;
  productName: string;
  assets: EphemeralAsset[];
  updatedAt: number;
}

const RECENT_SEARCHES_FILE = path.join(DATA_DIR, 'recent_searches.json');
const recentSearchResults = new Map<string, RecentStreamSearchRecord>();

function loadRecentSearchesFromDisk(): void {
  try {
    if (fs.existsSync(RECENT_SEARCHES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(RECENT_SEARCHES_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const rec = v as RecentStreamSearchRecord;
          if (rec && Array.isArray(rec.assets)) {
            recentSearchResults.set(k, rec);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[StreamSearch] Failed to load recent searches:', (err as Error)?.message);
  }
}

function saveRecentSearchesToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const obj: Record<string, RecentStreamSearchRecord> = {};
    for (const [k, v] of recentSearchResults.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(RECENT_SEARCHES_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[StreamSearch] Failed to save recent searches:', (err as Error)?.message);
  }
}

loadRecentSearchesFromDisk();

function recordStreamSearchAsset(
  ownerId: string,
  searchId: string,
  productName: string,
  asset: EphemeralAsset
): void {
  const cleanId = searchId.replace(/^ephemeral-/, '');
  let rec = recentSearchResults.get(cleanId);
  if (!rec) {
    if (recentSearchResults.size >= 40) {
      const oldestKey = recentSearchResults.keys().next().value;
      if (oldestKey) recentSearchResults.delete(oldestKey);
    }
    rec = { ownerId, productName, assets: [], updatedAt: Date.now() };
    recentSearchResults.set(cleanId, rec);
  }
  rec.updatedAt = Date.now();
  if (!rec.assets.some((a) => a.id === asset.id)) {
    rec.assets.push(asset);
    saveRecentSearchesToDisk();
  }
}

/**
 * Streaming Pipeline Search Handler (POST /api/stream-search):
 * 1. Runs Gemini query translation + optional image booster analysis in parallel.
 * 2. Fetches Page 1 of top 2 query variants in parallel; pushes products into a priority work queue sorted by rating COUNT descending.
 * 3. Runs a 6-worker concurrent pool pulling highest-rating products first and streaming customer review videos immediately.
 * 4. Lazily fetches additional search pages only if the target video count has not yet been reached.
 */
export async function handleStreamSearch(
  req: Request,
  res: Response,
  ownerId: string
): Promise<void> {
  const searchId =
    typeof req.body?.searchId === 'string' && req.body.searchId.trim()
      ? req.body.searchId.trim()
      : crypto.randomUUID();

  if (ownerId) {
    const prevStream = activeOwnerStreams.get(ownerId);
    if (prevStream && prevStream.searchId !== searchId) {
      try {
        prevStream.abort();
      } catch (err) {
        console.warn('[StreamSearch] Error aborting previous stream:', (err as Error)?.message);
      }
      activeOwnerStreams.delete(ownerId);
    }
  }

  const rawProductUrl =
    typeof req.body?.productUrl === 'string' && req.body.productUrl.trim()
      ? req.body.productUrl.trim()
      : '';
  const rawProductName =
    typeof req.body?.productName === 'string' && req.body.productName.trim()
      ? req.body.productName.trim()
      : typeof req.body?.name === 'string'
      ? req.body.name.trim()
      : rawProductUrl;
  const requestedType = req.body?.mediaType || req.body?.mediaTypeRequested;
  const mediaType: 'video' | 'photo' | 'both' =
    requestedType === 'photo' || requestedType === 'both' ? requestedType : 'video';

  const clampedVideo = Math.min(500, Math.max(1, Number(req.body?.targetVideoCount) || 10));
  const clampedPhoto = Math.min(500, Math.max(1, Number(req.body?.targetPhotoCount) || 10));
  const targetVideoCount = mediaType === 'photo' ? 0 : clampedVideo;
  const targetPhotoCount = mediaType === 'video' ? 0 : clampedPhoto;
  const totalTarget = targetVideoCount + targetPhotoCount;

  const rawReferenceImage =
    typeof req.body?.referenceImage === 'string' &&
    req.body.referenceImage.trim().startsWith('data:image/')
      ? req.body.referenceImage.trim()
      : undefined;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let isAborted = false;
  const abortController = new AbortController();

  const cleanupAndAbort = () => {
    if (!isAborted) {
      isAborted = true;
      abortController.abort();
    }
  };

  if (ownerId) {
    activeOwnerStreams.set(ownerId, { searchId, abort: cleanupAndAbort });
  }

  req.on('aborted', cleanupAndAbort);
  res.on('close', () => {
    if (!res.writableEnded) {
      cleanupAndAbort();
    }
  });

  const timeoutId = setTimeout(() => {
    cleanupAndAbort();
  }, 180_000);

  const sendEvent = (event: StreamSearchEvent) => {
    if (event.type === 'result' && event.asset) {
      recordStreamSearchAsset(
        ownerId,
        searchId,
        rawProductName || rawProductUrl || 'Creative_Radaar',
        event.asset
      );
    }
    if (res.writableEnded || isAborted) return;
    try {
      res.write(JSON.stringify(event) + '\n');
    } catch (err) {
      console.warn('[StreamSearch] Write error:', (err as Error)?.message);
    }
  };

  if (!rawProductName && !rawProductUrl && !rawReferenceImage) {
    clearTimeout(timeoutId);
    sendEvent({
      type: 'failed',
      searchId,
      error: 'اسم المنتج أو صورته أو رابط صفحة المنتج مطلوب لبدء البحث',
      timestamp: new Date().toISOString(),
    });
    res.end();
    return;
  }

  sendEvent({
    type: 'started',
    searchId,
    productName: rawProductName || rawProductUrl || 'بحث بالصورة',
    mediaType,
    targetCount: totalTarget,
    targetVideoCount,
    targetPhotoCount,
    timestamp: new Date().toISOString(),
  });

  if (rawReferenceImage && !isGeminiConfigured()) {
    sendEvent({
      type: 'warning', searchId, code: 'IMAGE_ANALYSIS_UNAVAILABLE',
      message: 'مطابقة الصورة غير متاحة حاليًا؛ البحث يعتمد على اسم المنتج فقط، ولا يؤكد تطابق الشكل بالصورة.',
      timestamp: new Date().toISOString(),
    });
  }

  const seenStreamUuids = new Set<string>();
  const seenMediaUrls = new Set<string>();
  const seenAsins = new Set<string>();
  let foundVideos = 0;
  let foundPhotos = 0;
  let assetCounter = 0;
  let inspectedCount = 0;
  let pagesBlockedCount = 0;
  let reviewAccessLimited = false;
  let totalProductsDiscovered = 0;

  try {
    if (rawReferenceImage && !isGeminiConfigured() && !rawProductUrl) {
      throw new Error('حدّد المنتج أولًا بتحليل الصورة المحلي أو أضف رابط صفحته. لن نكمل البحث بالاسم وحده مع تجاهل الصورة.');
    }
    const linkCandidate =
      rawProductUrl ||
      (/^https?:\/\//i.test(rawProductName) || /\b(?:\/dp\/|B0[A-Z0-9]{8})\b/i.test(rawProductName)
        ? rawProductName
        : '');

    const userTypedNonUrlName =
      rawProductName &&
      !/^https?:\/\//i.test(rawProductName) &&
      rawProductName.trim() !== 'بحث بالصورة'
        ? rawProductName.trim()
        : '';

    const [initialQueries, resolvedImageProfile, resolvedLinkIdentity] = await Promise.all([
      userTypedNonUrlName
        ? buildAmazonUsQueries(userTypedNonUrlName, undefined, undefined, abortController.signal).catch(
            (err: unknown) => {
              console.warn('[StreamSearch] Query translation error:', (err as Error)?.message || err);
              return null;
            }
          )
        : Promise.resolve(null),
      rawReferenceImage && isGeminiConfigured()
        ? (async () => {
            sendEvent({
              type: 'progress',
              searchId,
              message: 'جاري تحليل الاسم والصورة المرفوعة بالتوازي لتعزيز دقة البحث...',
              foundCount: 0,
              timestamp: new Date().toISOString(),
            });
            let mime = 'image/jpeg';
            const m = rawReferenceImage.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i);
            if (m) mime = m[1];
            const base64Clean = rawReferenceImage.replace(/^data:[^;]+;base64,/, '');
            if (base64Clean.length <= 50) return null;
            return await analyzeProductImage(
              base64Clean,
              mime,
              undefined,
              rawProductUrl,
              userTypedNonUrlName,
              abortController.signal
            ).catch((err: unknown) => {
              console.warn('[StreamSearch] Image booster analysis failed:', (err as Error)?.message || err);
              return null;
            });
          })()
        : Promise.resolve(null),
      linkCandidate
        ? resolveProductIdentityFromUrl(linkCandidate, abortController.signal).catch((err: unknown) => {
            console.warn('[StreamSearch] URL identity resolution error:', (err as Error)?.message || err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    if (abortController.signal.aborted) return;

    const verifiedExpansion = req.body?.verifiedExpansion || (rawReferenceImage && resolvedImageProfile
      ? {referenceImage:rawReferenceImage,query:resolvedImageProfile.commercialNameEn || resolvedImageProfile.suggestedNameEn,profile:resolvedImageProfile}
      : undefined);

    const searchProductName =
      resolvedLinkIdentity?.canonicalSearchQuery ||
      userTypedNonUrlName ||
      resolvedImageProfile?.suggestedNameEn ||
      resolvedImageProfile?.suggestedNameAr ||
      rawProductName;

    const displayArabicName =
      resolvedImageProfile?.suggestedNameAr ||
      userTypedNonUrlName ||
      resolvedLinkIdentity?.extractedTitle ||
      rawProductName;

    const finalQueries =
      resolvedLinkIdentity?.directAmazonUsUrl
        ? { primaryQuery: resolvedLinkIdentity.extractedTitle || searchProductName, variants: [] }
        : initialQueries && !resolvedImageProfile && !resolvedLinkIdentity
        ? initialQueries
        : await buildAmazonUsQueries(
            searchProductName,
            resolvedImageProfile?.suggestedNameEn || initialQueries?.primaryQuery,
            [
              ...(initialQueries?.variants || []),
              ...(resolvedImageProfile?.multilingualQueries?.en || []),
            ],
            abortController.signal
          );

    // A selected product URL is a scope boundary, not a seed for unrelated listings.
    const topVariants = resolvedLinkIdentity?.directAmazonUsUrl ? [] : finalQueries.variants.slice(0, 2);

    sendEvent({
      type: 'progress',
      searchId,
      message: resolvedLinkIdentity?.directAmazonUsUrl
        ? verifiedExpansion
          ? 'نبدأ من صفحة المنتج المحددة، ثم نستكمل العدد من قوائم اجتازت مقارنة نفس التصميم بالصورة.'
          : 'تم تحديد صفحة المنتج؛ نجمع مراجعات هذه الصفحة فقط دون التوسع لمنتجات أخرى.'
        : `جاري البحث في أمازون أمريكا عن: "${finalQueries.primaryQuery}" مع إعطاء دقة التطابق الأولوية...`,
      foundCount: 0,
      resolvedProductName: displayArabicName,
      timestamp: new Date().toISOString(),
    });

    const workQueue: QueuedProductInspection[] = [];
    let producersFinished = false;
    const queueNotifiers: Array<() => void> = [];

    const notifyQueueListeners = () => {
      while (queueNotifiers.length > 0) {
        const fn = queueNotifiers.shift();
        fn?.();
      }
    };

    const waitForQueueActivity = (): Promise<void> => {
      if (workQueue.length > 0 || producersFinished || abortController.signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queueNotifiers.push(resolve);
      });
    };

    const enqueueCandidates = (candidates: AmazonUsProductCandidate[], queryForMatch: string) => {
      let added = 0;
      for (const page of candidates) {
        if (!page.asin || seenAsins.has(page.asin)) continue;
        seenAsins.add(page.asin);
        totalProductsDiscovered++;

        const titleVerdict = evaluateStrictProductTitleMatch(
          page.title,
          queryForMatch,
          searchProductName
        );
        if (!titleVerdict.approved) continue;

        page.matchScore = titleVerdict.matchScore;
        page.matchCategory = titleVerdict.matchCategory;
        workQueue.push({ page, titleVerdict });
        added++;
      }

      if (added > 0) {
        workQueue.sort((a, b) => {
          const matchDiff = (b.titleVerdict.matchScore || 0) - (a.titleVerdict.matchScore || 0);
          if (matchDiff !== 0) return matchDiff;
          return (b.page.ratingCount || 0) - (a.page.ratingCount || 0);
        });
        notifyQueueListeners();
      }
    };

    if (resolvedLinkIdentity?.directAmazonUsUrl) {
      const directAsin = resolvedLinkIdentity.asin || 'DIRECT';
      seenAsins.add(directAsin);
      totalProductsDiscovered++;
      workQueue.unshift({
        page: {
          asin: directAsin,
          url: resolvedLinkIdentity.directAmazonUsUrl,
          title: resolvedLinkIdentity.extractedTitle || searchProductName,
          imageUrl: resolvedLinkIdentity.imageUrl,
          ratingCount: 0,
          matchScore: 99,
          matchCategory: 'exact_design',
        },
        titleVerdict: {
          approved: true,
          matchCategory: 'exact_design',
          matchScore: 99,
          userFacingLabelAr: 'نفس المنتج (من الرابط المباشر)',
          reasonAr: 'تم التحديد عبر الرابط المباشر لصفحة المنتج',
        },
      });
      notifyQueueListeners();
    }

    const isGoalReached = () =>
      foundVideos >= targetVideoCount && foundPhotos >= targetPhotoCount;

    const emitVideo = (
      v: ExtractedAmazonVideo,
      page: AmazonUsProductCandidate,
      titleVerdict: TitleMatchVerdict
    ) => {
      if (foundVideos >= targetVideoCount || abortController.signal.aborted) return;
      if (seenStreamUuids.has(v.streamUuid)) return;
      const normUrl = normalizeUrl(v.mediaUrl);
      if (seenMediaUrls.has(normUrl)) return;

      seenStreamUuids.add(v.streamUuid);
      seenMediaUrls.add(normUrl);

      foundVideos++;
      assetCounter++;

      const bestDownloadUrl = v.downloadUrl || v.mediaUrl;
      const asset: EphemeralAsset = {
        id: `ast-${searchId}-${assetCounter}`,
        searchId,
        title: v.title || page.title,
        mediaUrl: v.mediaUrl,
        downloadUrl: bestDownloadUrl,
        thumbnailUrl: v.thumbnailUrl || page.imageUrl,
        sourceUrl: v.sourceUrl || page.url,
        productListingUrl: page.url,
        reviewerOrChannel: v.reviewerOrChannel || 'عميل أمازون',
        reviewId: v.reviewId,
        mediaType: 'video',
        platform: 'amazon',
        provenance: v.provenance || 'unverified_customer_review',
        sentiment: 'positive',
        matchCategory:
          titleVerdict.matchCategory === 'mismatched' ? 'exact_design' : titleVerdict.matchCategory,
        matchScore: titleVerdict.matchScore,
        userFacingMatchLabel: titleVerdict.userFacingLabelAr,
        isCustomerReview: true,
        ratingCount: page.ratingCount,
        collectedAt: new Date().toISOString(),
      };

      sendEvent({
        type: 'result',
        searchId,
        asset,
        timestamp: new Date().toISOString(),
      });

      prewarmMediaInBackground(bestDownloadUrl, 'video');

      sendEvent({
        type: 'progress',
        searchId,
        message: `تم سحب ${foundVideos + foundPhotos} من أصل ${totalTarget} فيديو مراجعة عميل...`,
        pagesInspected: inspectedCount,
        foundCount: foundVideos + foundPhotos,
        timestamp: new Date().toISOString(),
      });
    };

    const runWorker = async () => {
      while (!abortController.signal.aborted && !isGoalReached()) {
        const nextItem = workQueue.shift();
        if (!nextItem) {
          if (producersFinished) break;
          await waitForQueueActivity();
          continue;
        }

        const { page, titleVerdict } = nextItem;
        inspectedCount++;

        if (mediaType !== 'photo' && foundVideos < targetVideoCount) {
          try {
            const videos = await fetchAmazonUsProductVideos(page.url, abortController.signal, {
              limit:targetVideoCount-foundVideos,
              onVideo:video=>emitVideo(video,page,titleVerdict),
              onLimited:()=>{ reviewAccessLimited=true; },
            });
            for (const v of videos) {
              if (abortController.signal.aborted || foundVideos >= targetVideoCount) break;
              emitVideo(v, page, titleVerdict);
            }
          } catch (err: unknown) {
            if (err instanceof AmazonBlockError) {
              pagesBlockedCount++;
            }
            console.warn(
              `[StreamSearch] Worker video fetch failed for ${page.asin}:`,
              (err as Error)?.message || err
            );
          }
        }

        if (mediaType !== 'video' && foundPhotos < targetPhotoCount && !abortController.signal.aborted) {
          try {
            const neededPhotos = targetPhotoCount - foundPhotos;
            const photos = await resolvePublicPhotos(
              page.url,
              Math.min(15, neededPhotos),
              abortController.signal
            );
            for (const ph of photos) {
              if (foundPhotos >= targetPhotoCount || abortController.signal.aborted) break;
              const norm = normalizeUrl(ph.mediaUrl);
              if (seenMediaUrls.has(norm)) continue;
              seenMediaUrls.add(norm);

              foundPhotos++;
              assetCounter++;

              const asset: EphemeralAsset = {
                id: `ast-${searchId}-${assetCounter}`,
                searchId,
                title: ph.title || page.title,
                mediaUrl: ph.mediaUrl,
                downloadUrl: ph.mediaUrl,
                thumbnailUrl: ph.mediaUrl,
                sourceUrl: ph.sourceUrl || page.url,
                productListingUrl: page.url,
                mediaType: 'photo',
                platform: 'amazon',
                provenance: ph.provenance || 'unverified_customer_review',
                sentiment: 'positive',
                matchCategory:
                  titleVerdict.matchCategory === 'mismatched'
                    ? 'exact_design'
                    : titleVerdict.matchCategory,
                matchScore: titleVerdict.matchScore,
                userFacingMatchLabel: titleVerdict.userFacingLabelAr,
                isCustomerReview: true,
                ratingCount: page.ratingCount,
                collectedAt: new Date().toISOString(),
              };

              sendEvent({
                type: 'result',
                searchId,
                asset,
                timestamp: new Date().toISOString(),
              });
              prewarmMediaInBackground(asset.downloadUrl, 'photo');
            }
          } catch (err: unknown) {
            console.warn(
              `[StreamSearch] Worker photo fetch failed for ${page.asin}:`,
              (err as Error)?.message || err
            );
          }
        }

        if (isGoalReached()) {
          notifyQueueListeners();
          break;
        }
      }
    };

    const runProducer = async () => {
      try {
        if (resolvedLinkIdentity?.directAmazonUsUrl && verifiedExpansion) {
          for await (const matches of collectVerifiedListings(verifiedExpansion,rawProductName,seenAsins,abortController.signal,message=>{
            sendEvent({type:'progress',searchId,message,foundCount:foundVideos+foundPhotos,timestamp:new Date().toISOString()});
          },isGoalReached)) {
            if (isGoalReached() || abortController.signal.aborted) break;
            for (const {page,verdict} of matches) {
              if (seenAsins.has(page.asin)) continue;
              seenAsins.add(page.asin); totalProductsDiscovered++;
              workQueue.push({page,titleVerdict:{...verdict,matchCategory:'permitted_variation',userFacingLabelAr:'تطابق بصري للتصميم؛ الماركة والموديل غير مؤكدين'}});
            }
            workQueue.sort((a,b)=>b.page.ratingCount-a.page.ratingCount);
            notifyQueueListeners();
          }
          return;
        }
        await Promise.all(
          topVariants.map(async (qVariant) => {
            if (abortController.signal.aborted || isGoalReached()) return;
            try {
              const { candidates } = await fetchAmazonSearchPage(
                qVariant,
                1,
                abortController.signal
              );
              enqueueCandidates(candidates, qVariant);
            } catch (err: unknown) {
              if (err instanceof AmazonBlockError) {
                pagesBlockedCount++;
              }
              console.warn(
                `[StreamSearch] Search page 1 failed for "${qVariant}":`,
                (err as Error)?.message || err
              );
            }
          })
        );

        for (let pageNum = 2; pageNum <= 3; pageNum++) {
          if (abortController.signal.aborted || isGoalReached()) break;

          while (
            workQueue.length >= 8 &&
            !abortController.signal.aborted &&
            !isGoalReached()
          ) {
            await new Promise((r) => setTimeout(r, 250));
          }

          if (abortController.signal.aborted || isGoalReached()) break;

          await Promise.all(
            topVariants.map(async (qVariant) => {
              if (abortController.signal.aborted || isGoalReached()) return;
              try {
                const { candidates } = await fetchAmazonSearchPage(
                  qVariant,
                  pageNum,
                  abortController.signal
                );
                enqueueCandidates(candidates, qVariant);
              } catch (err: unknown) {
                if (err instanceof AmazonBlockError) {
                  pagesBlockedCount++;
                }
                console.warn(
                  `[StreamSearch] Search page ${pageNum} failed for "${qVariant}":`,
                  (err as Error)?.message || err
                );
              }
            })
          );
        }
      } catch (error) {
        if (!abortController.signal.aborted) sendEvent({type:'warning',searchId,code:'VERIFIED_EXPANSION_LIMITED',message:'تعذر إكمال فحص القوائم الإضافية؛ احتفظنا بالريفيوهات المستخرجة فقط.',timestamp:new Date().toISOString()});
      } finally {
        producersFinished = true;
        notifyQueueListeners();
      }
    };

    const WORKER_CONCURRENCY = 6;
    const workers = Array.from({ length: WORKER_CONCURRENCY }, () => runWorker());
    await Promise.all([runProducer(), ...workers]);

    const totalFound = foundVideos + foundPhotos;
    let reasonIfPartial: string | undefined;

    if (totalFound < totalTarget) {
      if (reviewAccessLimited) {
        reasonIfPartial='أمازون قيّد الوصول لبعض صفحات الريفيوهات. هذا عدد الفيديوهات التي استطعنا الوصول إليها، وليس كل الفيديوهات الموجودة.';
      } else if (pagesBlockedCount > 0 && totalProductsDiscovered === 0) {
        reasonIfPartial = 'أمازون حظر الطلب';
        sendEvent({
          type: 'warning',
          searchId,
          message: 'أمازون حظر الطلب',
          code: 'AMAZON_BLOCKED',
          timestamp: new Date().toISOString(),
        });
      } else if (totalProductsDiscovered === 0) {
        reasonIfPartial = 'لم نجد منتجات';
        sendEvent({
          type: 'warning',
          searchId,
          message: 'لم نجد منتجات',
          code: 'NO_PRODUCTS_FOUND',
          timestamp: new Date().toISOString(),
        });
      } else if (totalFound === 0) {
        reasonIfPartial = 'المنتجات لا تحتوي على فيديوهات';
        sendEvent({
          type: 'warning',
          searchId,
          message: 'المنتجات لا تحتوي على فيديوهات',
          code: 'NO_VIDEOS_IN_PRODUCTS',
          timestamp: new Date().toISOString(),
        });
      } else {
        reasonIfPartial = 'تم استخراج جميع الفيديوهات المتاحة للمنتجات المطابقة';
      }
    }

    sendEvent({
      type: 'completed',
      searchId,
      requestedCount: totalTarget,
      foundCount: totalFound,
      downloadableCount: totalFound,
      reasonIfPartial,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    if (!abortController.signal.aborted) {
      const isBlock = err instanceof AmazonBlockError;
      const errMsg = isBlock
        ? 'أمازون حظر الطلب'
        : (err as Error)?.message || 'حدث خطأ أثناء البحث';
      sendEvent({
        type: 'failed',
        searchId,
        error: errMsg,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    clearTimeout(timeoutId);
    if (ownerId) {
      const current = activeOwnerStreams.get(ownerId);
      if (current && current.searchId === searchId) {
        activeOwnerStreams.delete(ownerId);
      }
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Auth-protected diagnostic endpoint: GET /api/debug/amazon?q=...
 */
export async function handleDebugAmazon(req: Request, res: Response): Promise<void> {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!rawQuery) {
    res.status(400).json({ error: 'Query parameter ?q= is required' });
    return;
  }

  const tStart = Date.now();
  let pagesBlocked = 0;
  let searchStatus: 'ok' | 'blocked' | 'empty' | 'error' = 'ok';
  let arabicReason: string | undefined;

  const tTranslate0 = Date.now();
  const builtQueries = await buildAmazonUsQueries(rawQuery);
  const translationMs = Date.now() - tTranslate0;

  const tSearch0 = Date.now();
  const topVariants = builtQueries.variants.slice(0, 2);
  const seenAsins = new Set<string>();
  const allCandidates: AmazonUsProductCandidate[] = [];

  await Promise.all(
    topVariants.map(async (variant) => {
      try {
        const { candidates } = await fetchAmazonSearchPage(variant, 1);
        for (const c of candidates) {
          if (!seenAsins.has(c.asin)) {
            seenAsins.add(c.asin);
            allCandidates.push(c);
          }
        }
      } catch (err: unknown) {
        if (err instanceof AmazonBlockError) {
          pagesBlocked++;
        }
        console.warn(`[DebugAmazon] Search failed for "${variant}":`, (err as Error)?.message || err);
      }
    })
  );
  const searchPagesMs = Date.now() - tSearch0;

  const sortedCandidates = sortCandidatesByRatingCountDesc(allCandidates);

  if (sortedCandidates.length === 0) {
    searchStatus = pagesBlocked > 0 ? 'blocked' : 'empty';
    arabicReason = pagesBlocked > 0 ? 'أمازون حظر الطلب' : 'لم نجد منتجات';
  }

  const tInspect0 = Date.now();
  const topToInspect = sortedCandidates.slice(0, 5);
  const videosFoundPerAsin: Array<{
    asin: string;
    title: string;
    ratingCount: number;
    videoCount: number;
    sampleVideos: Array<{
      streamUuid: string;
      title: string;
      reviewer: string;
      downloadUrl: string;
    }>;
  }> = [];

  let totalVideosFound = 0;

  await Promise.all(
    topToInspect.map(async (cand) => {
      try {
        const vids = await fetchAmazonUsProductVideos(cand.url);
        totalVideosFound += vids.length;
        videosFoundPerAsin.push({
          asin: cand.asin,
          title: cand.title,
          ratingCount: cand.ratingCount,
          videoCount: vids.length,
          sampleVideos: vids.slice(0, 3).map((v) => ({
            streamUuid: v.streamUuid,
            title: v.title,
            reviewer: v.reviewerOrChannel,
            downloadUrl: v.downloadUrl,
          })),
        });
      } catch (err: unknown) {
        if (err instanceof AmazonBlockError) {
          pagesBlocked++;
        }
        videosFoundPerAsin.push({
          asin: cand.asin,
          title: cand.title,
          ratingCount: cand.ratingCount,
          videoCount: 0,
          sampleVideos: [],
        });
      }
    })
  );

  videosFoundPerAsin.sort((a, b) => b.ratingCount - a.ratingCount);
  const videoInspectionMs = Date.now() - tInspect0;
  const totalMs = Date.now() - tStart;

  if (sortedCandidates.length > 0 && totalVideosFound === 0) {
    arabicReason = 'المنتجات لا تحتوي على فيديوهات';
  }

  res.json({
    query: rawQuery,
    translatedQueries: builtQueries,
    searchStatus,
    arabicReason,
    productsFound: sortedCandidates.length,
    pagesBlocked,
    totalVideosFound,
    videosFoundPerAsin,
    timingsMs: {
      translationMs,
      searchPagesMs,
      videoInspectionMs,
      totalMs,
    },
  });
}

/**
 * Serves cached media files with full HTTP Range support (206 Partial Content),
 * or streams upstream media with backpressure via stream.pipeline.
 */
export async function handleStreamDownload(req: Request, res: Response): Promise<void> {
  const targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const mediaType = req.query.type === 'photo' ? 'photo' : 'video';
  const customTitle = typeof req.query.title === 'string' ? req.query.title.trim() : '';
  const isInline = req.query.inline === '1';

  if (!targetUrl) {
    res.status(400).json({ error: 'رابط الوسائط مطلوب' });
    return;
  }

  const safeCheck = isSafeExternalUrl(targetUrl);
  if (!safeCheck.safe) {
    res.status(403).json({ error: 'الرابط غير آمن أو غير مصرح به' });
    return;
  }

  if (!isAllowedDownloadHost(targetUrl)) {
    res.status(403).json({ error: 'نطاق الوسائط غير مصرح به للتنزيل المباشر' });
    return;
  }

  const safeBasename = (customTitle || 'media')
    .replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_')
    .slice(0, 80);
  const ext = mediaType === 'video' ? 'mp4' : 'jpg';
  const filename = `${safeBasename}_${Date.now()}.${ext}`;

  try {
    const cachedRes = await downloadMedia(
      targetUrl,
      'stream-cache',
      mediaType,
      60 * 1024 * 1024,
      undefined,
      true,
      'high'
    );
    if (
      cachedRes.status === 'verified_available' &&
      cachedRes.localFilePath &&
      fs.existsSync(cachedRes.localFilePath)
    ) {
      const stats = fs.statSync(cachedRes.localFilePath);
      const fileSize = stats.size;
      const fileExt = path.extname(cachedRes.localFilePath).slice(1).toLowerCase() || ext;
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
      };
      const contentType =
        mimeMap[fileExt] || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader(
        'Content-Disposition',
        isInline
          ? `inline; filename="${encodeURIComponent(filename)}"`
          : `attachment; filename="${encodeURIComponent(filename)}"`
      );

      const rangeHeader = req.headers.range;
      if (rangeHeader && fileSize > 0) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
          if (start >= 0 && start <= end && start < fileSize) {
            const chunkSize = end - start + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Content-Length', String(chunkSize));
            await pipeline(
              fs.createReadStream(cachedRes.localFilePath, { start, end }),
              res
            ).catch((err: unknown) => {
              if ((err as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                console.warn('[StreamDownload] Range stream error:', (err as Error)?.message);
              }
            });
            return;
          }
        }
      }

      res.setHeader('Content-Length', String(fileSize));
      await pipeline(fs.createReadStream(cachedRes.localFilePath), res).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.warn('[StreamDownload] File stream error:', (err as Error)?.message);
        }
      });
      return;
    }
  } catch (err: unknown) {
    console.warn('[StreamDownload] Cache download fallback:', (err as Error)?.message || err);
  }

  const isDirectFile = /\.(mp4|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(targetUrl);
  if (isDirectFile) {
    try {
      const upstream = await fetch(targetUrl, {
        signal: AbortSignal.timeout(30_000),
        headers: {
          'User-Agent': AMAZON_CHROME_USER_AGENT,
          Accept: mediaType === 'video' ? 'video/mp4,video/*;q=0.9,*/*;q=0.8' : 'image/*,*/*;q=0.8',
        },
      });

      if (!upstream.ok || !upstream.body) {
        res.status(502).json({ error: 'تعذر جلب ملف الميديا من المصدر' });
        return;
      }

      const contentType =
        upstream.headers.get('content-type') ||
        (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
      res.setHeader('Content-Type', contentType);
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader(
        'Content-Disposition',
        isInline
          ? `inline; filename="${encodeURIComponent(filename)}"`
          : `attachment; filename="${encodeURIComponent(filename)}"`
      );

      await pipeline(Readable.fromWeb(upstream.body as any), res);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.warn('[StreamDownload] Direct pipeline error:', (err as Error)?.message || err);
      }
      if (!res.headersSent) {
        res.status(504).json({ error: 'انتهت مهلة جلب الملف من المصدر' });
      }
      return;
    }
  }

  const tempId = crypto.randomBytes(8).toString('hex');
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
  const tempFilePath = path.join(DOWNLOADS_DIR, `temp_stream_${tempId}.mp4`);

  try {
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-user_agent',
          AMAZON_CHROME_USER_AGENT,
          '-i',
          targetUrl,
          '-c',
          'copy',
          '-bsf:a',
          'aac_adtstoasc',
          '-movflags',
          '+faststart',
          '-t',
          '180',
          tempFilePath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );

      let errOutput = '';
      ffmpeg.stderr.on('data', (d) => {
        errOutput += d.toString();
      });

      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('FFMPEG_TIMEOUT'));
      }, 45_000);

      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 && fs.existsSync(tempFilePath)) {
          resolve();
        } else {
          reject(new Error(`FFMPEG_FAILED: ${errOutput.slice(0, 200)}`));
        }
      });

      ffmpeg.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    if (fs.existsSync(tempFilePath)) {
      const stats = fs.statSync(tempFilePath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(stats.size));
      res.setHeader(
        'Content-Disposition',
        isInline
          ? `inline; filename="${encodeURIComponent(filename)}"`
          : `attachment; filename="${encodeURIComponent(filename)}"`
      );
      await pipeline(fs.createReadStream(tempFilePath), res);
    } else {
      res.status(502).json({ error: 'فشل تحويل بث الفيديو' });
    }
  } catch (err: unknown) {
    console.warn('[StreamDownload] HLS ffmpeg fallback failed:', (err as Error)?.message || err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'تعذر تنزيل البث، متاح للمشاهدة فقط' });
    }
  } finally {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (err) {
      console.warn('[StreamDownload] Temp cleanup failed:', (err as Error)?.message);
    }
  }
}

/**
 * Registers/updates the client's current ephemeral search assets on the server
 * so that server-streamed ZIP exports always work even after a server restart.
 */
export function handlePrepareExportZip(req: Request, res: Response, ownerId: string): void {
  const rawSearchId = String(req.body?.searchId || '')
    .trim()
    .replace(/^ephemeral-/, '');
  const productName = String(req.body?.productName || 'Creative_Radaar_Export').trim();
  const rawAssets = Array.isArray(req.body?.assets) ? req.body.assets : [];

  if (!rawSearchId || rawAssets.length === 0) {
    res.status(400).json({ error: 'بيانات جلسة البحث مطلوبة' });
    return;
  }

  const mappedAssets: EphemeralAsset[] = rawAssets
    .filter((a: any) => a && (a.downloadUrl || a.mediaUrl))
    .map((a: any) => ({
      id: String(a.id || `ast-${Date.now()}`),
      searchId: rawSearchId,
      title: String(a.title || productName),
      mediaUrl: String(a.mediaUrl || a.downloadUrl),
      downloadUrl: String(a.downloadUrl || a.mediaUrl),
      thumbnailUrl: a.thumbnailUrl ? String(a.thumbnailUrl) : undefined,
      sourceUrl: String(a.sourceUrl || a.productListingUrl || ''),
      productListingUrl: String(a.productListingUrl || a.sourceUrl || ''),
      reviewerOrChannel: a.reviewerOrChannel ? String(a.reviewerOrChannel) : 'عميل أمازون',
      reviewId: a.reviewId ? String(a.reviewId) : undefined,
      mediaType: a.mediaType === 'photo' ? 'photo' : 'video',
      platform: 'amazon',
      durationSeconds: typeof a.durationSeconds === 'number' ? a.durationSeconds : undefined,
      provenance: String(a.provenance || 'unverified_customer_review'),
      sentiment: 'positive',
      matchCategory: a.matchCategory === 'permitted_variation' ? 'permitted_variation' : 'exact_design',
      matchScore: typeof a.matchScore === 'number' ? a.matchScore : 92,
      userFacingMatchLabel: String(a.userFacingMatchLabel || 'مطابق للمنتج'),
      isCustomerReview: true,
      collectedAt: String(a.collectedAt || new Date().toISOString()),
    }));

  recentSearchResults.set(rawSearchId, {
    ownerId,
    productName,
    assets: mappedAssets,
    updatedAt: Date.now(),
  });
  saveRecentSearchesToDisk();

  res.json({ ok: true, searchId: rawSearchId, count: mappedAssets.length });
}

/**
 * Streams a server-side ZIP archive (using archiver with store: true) for an ephemeral stream search.
 * Sends ZIP response headers immediately and streams files into the archive as they resolve.
 */
export async function handleStreamExportZip(
  req: Request,
  res: Response,
  ownerId: string
): Promise<void> {
  const rawSearchId =
    (typeof req.query.searchId === 'string' ? req.query.searchId : req.body?.searchId || '')
      .trim()
      .replace(/^ephemeral-/, '');

  let rec = rawSearchId ? recentSearchResults.get(rawSearchId) : undefined;

  // Allow POST body fallback with inline assets if recentSearchResults didn't have rawSearchId
  if (!rec && Array.isArray(req.body?.assets) && req.body.assets.length > 0) {
    rec = {
      ownerId,
      productName: String(req.body.productName || 'Creative_Radaar_Export'),
      assets: req.body.assets,
      updatedAt: Date.now(),
    };
    if (rawSearchId) {
      recentSearchResults.set(rawSearchId, rec);
      saveRecentSearchesToDisk();
    }
  }

  // Fallback to the latest search belonging to ownerId if exact searchId wasn't found
  if (!rec && ownerId) {
    let newest: RecentStreamSearchRecord | undefined;
    for (const candidate of recentSearchResults.values()) {
      if (candidate.ownerId === ownerId && candidate.assets.length > 0) {
        if (!newest || candidate.updatedAt > newest.updatedAt) {
          newest = candidate;
        }
      }
    }
    rec = newest;
  }

  if (!rec || (rec.ownerId && ownerId && rec.ownerId !== ownerId)) {
    res.status(404).json({ error: 'لم يتم العثور على جلسة البحث المطلوبة لتصدير الحزمة' });
    return;
  }

  const assets = rec.assets;
  if (assets.length === 0) {
    res.status(400).json({ error: 'لا توجد ملفات ميديا في جلسة البحث الحالية' });
    return;
  }

  const safeName = (rec.productName || 'Creative_Radaar_Export')
    .replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_')
    .slice(0, 40);
  const dateStr = new Date().toISOString().split('T')[0];
  const rootDirName = `${safeName}_${dateStr}`;

  // Send response headers and pipe archive immediately so browser starts the download right away
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(rootDirName)}.zip"`
  );
  res.flushHeaders?.();

  const archive = new ZipArchive({ store: true });
  archive.on('error', (err: Error) => {
    console.error('[StreamExportZip] Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'فشل إنشاء حزمة ZIP' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  const csvHeaders = [
    'Asset ID',
    'Filename',
    'Media Type',
    'Platform',
    'Reviewer / Channel',
    'Product URL',
    'Review URL',
    'Provenance Classification',
    'Match Category',
    'Title',
    'Download URL',
  ];
  const csvRows: string[] = [csvHeaders.map(sanitizeCsvField).join(',')];

  const concurrency = 5;
  for (let i = 0; i < assets.length; i += concurrency) {
    const batch = assets.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (asset) => {
        const dlUrl = asset.downloadUrl || asset.mediaUrl;
        if (!dlUrl) return { asset, fileInfo: null };
        try {
          const dlRes = await downloadMedia(
            dlUrl,
            asset.id,
            asset.mediaType,
            60 * 1024 * 1024,
            AbortSignal.timeout(20_000),
            true,
            'high'
          );
          if (
            dlRes.status === 'verified_available' &&
            dlRes.localFilePath &&
            fs.existsSync(dlRes.localFilePath)
          ) {
            const ext =
              path.extname(dlRes.localFilePath).slice(1) ||
              (asset.mediaType === 'video' ? 'mp4' : 'jpg');
            return {
              asset,
              fileInfo: { localFilePath: dlRes.localFilePath, ext },
            };
          }
        } catch (err) {
          console.warn(
            `[StreamExportZip] Skipping failed asset ${asset.id}:`,
            (err as Error)?.message
          );
        }
        return { asset, fileInfo: null };
      })
    );

    for (const { asset, fileInfo } of batchResults) {
      const folder = asset.mediaType === 'photo' ? 'Photos' : 'Customer_Reviews';
      const fileName = fileInfo ? `${asset.id}_${asset.matchCategory}.${fileInfo.ext}` : '';
      if (fileInfo) {
        archive.file(fileInfo.localFilePath, {
          name: `${rootDirName}/${folder}/${fileName}`,
        });
      }
      csvRows.push(
        [
          asset.id,
          fileName,
          asset.mediaType,
          asset.platform || 'amazon',
          asset.reviewerOrChannel || '',
          asset.productListingUrl || '',
          asset.sourceUrl || '',
          asset.provenance,
          asset.matchCategory,
          asset.title,
          asset.downloadUrl || asset.mediaUrl,
        ]
          .map(sanitizeCsvField)
          .join(',')
      );
    }
  }

  const csvContent = '\uFEFF' + csvRows.join('\r\n');
  archive.append(csvContent, { name: `${rootDirName}/Sources.csv` });
  archive.append(JSON.stringify(assets, null, 2), { name: `${rootDirName}/Sources.json` });

  await archive.finalize();
}

export interface StageTimings {
  discoveryMs: number;
  extractionMs: number;
  downloadMs: number;
  verificationMs: number;
  totalMs: number;
}

/**
 * Unified JobWorker merged with streamSearch pipeline for persisted projects & manual links.
 */
export class JobWorker {
  private static instance: JobWorker;
  private activeJobs = new Set<string>();
  private cancelledJobs = new Set<string>();
  private jobAbortControllers = new Map<string, AbortController>();
  private sseClients = new Map<string, Set<Response>>();
  private lastTimings = new Map<string, StageTimings>();

  private constructor() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
  }

  public static getInstance(): JobWorker {
    if (!JobWorker.instance) {
      JobWorker.instance = new JobWorker();
    }
    return JobWorker.instance;
  }

  public getLastTimings(projectId: string): StageTimings | undefined {
    return this.lastTimings.get(projectId);
  }

  public registerSseClient(projectId: string, res: Response): void {
    if (!this.sseClients.has(projectId)) {
      this.sseClients.set(projectId, new Set());
    }
    this.sseClients.get(projectId)!.add(res);

    res.on('close', () => {
      this.sseClients.get(projectId)?.delete(res);
    });
  }

  public broadcast(projectId: string, data: Record<string, unknown>): void {
    const clients = this.sseClients.get(projectId);
    if (clients) {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          // ignore closed client
        }
      }
    }
  }

  public cancelJob(projectId: string): void {
    this.cancelledJobs.add(projectId);
    this.activeJobs.delete(projectId);
    const controller = this.jobAbortControllers.get(projectId);
    if (controller) {
      try {
        controller.abort();
      } catch {}
      this.jobAbortControllers.delete(projectId);
    }

    const storage = StorageService.getInstance();
    const proj = storage.getProject(projectId);
    if (proj) {
      proj.jobState = 'cancelled';
      proj.logs.push({
        timestamp: new Date().toISOString(),
        stage: 'cancelled',
        message: 'تم إيقاف عملية البحث بطلب من المستخدم مع الاحتفاظ بالنتائج المكتملة.',
        level: 'warn',
      });
      storage.upsertProject(proj);
      this.broadcast(projectId, { project: proj, state: 'cancelled' });
    }
  }

  public async addManualLink(
    projectId: string,
    payload: {
      sourceUrl: string;
      directMediaUrl?: string;
      title?: string;
      reviewerOrChannel?: string;
      provenance?: ProvenanceClassification;
      mediaType?: 'video' | 'photo';
    }
  ): Promise<CandidateAsset> {
    const storage = StorageService.getInstance();
    const project = storage.getProject(projectId);
    if (!project) {
      throw new Error('المشروع غير موجود');
    }

    const cleanSourceUrl = normalizeUrl(payload.sourceUrl);
    if (!cleanSourceUrl.startsWith('http://') && !cleanSourceUrl.startsWith('https://')) {
      throw new Error('يرجى إدخال رابط صالح يبدأ بـ http:// أو https://');
    }

    const ssrfCheck = isSafeExternalUrl(cleanSourceUrl);
    if (!ssrfCheck.safe) {
      throw new Error(`الرابط غير آمن: ${ssrfCheck.reason}`);
    }

    const isDup = isDuplicateCandidate(
      { sourceUrl: cleanSourceUrl, mediaUrl: payload.directMediaUrl },
      project.candidates
    );
    if (isDup.isDuplicate) {
      throw new Error('هذا الرابط مضاف مسبقاً في قائمة المشروع');
    }

    const assetId = `ast-${project.id}-${Date.now().toString(36)}`;
    const urlToInspect = (payload.directMediaUrl || cleanSourceUrl).toLowerCase();
    const looksLikePhoto = /\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.test(urlToInspect);
    const looksLikeVideo = /\.(mp4|m3u8)(?:[?#]|$)/i.test(urlToInspect);
    const resolvedMediaType: 'video' | 'photo' =
      payload.mediaType ||
      (looksLikePhoto
        ? 'photo'
        : looksLikeVideo
        ? 'video'
        : project.mediaTypeRequested === 'photo'
        ? 'photo'
        : 'video');

    const isAmazon = cleanSourceUrl.includes('amazon.');

    const candidate: CandidateAsset = {
      id: assetId,
      projectId: project.id,
      title:
        payload.title ||
        (resolvedMediaType === 'photo'
          ? 'صورة منتج (مدخلة يدوياً)'
          : isAmazon
          ? 'مراجعة من متجر أمازون (مدخلة يدويًا)'
          : 'رابط مراجعة مدخل يدويًا'),
      mediaType: resolvedMediaType,
      platform: isAmazon ? 'amazon' : 'direct_web',
      sourceUrl: cleanSourceUrl,
      productListingUrl: project.productListingUrl,
      reviewerOrChannel: payload.reviewerOrChannel || '',
      thumbnailUrl: resolvedMediaType === 'photo' ? payload.directMediaUrl || '' : '',
      mediaUrl: payload.directMediaUrl || undefined,
      provenance:
        payload.provenance === 'verified_purchase_review'
          ? 'unverified_customer_review'
          : payload.provenance || 'unresolved_source',
      verifiedPurchaseEvidence: undefined,
      matchCategory: 'insufficient_evidence',
      matchScore: 0,
      userFacingMatchLabel: 'المطابقة تحتاج مراجعة',
      visibleDifferences: [],
      supportingObservations: ['رابط تم إضافته يدويًا بواسطة المستخدم'],
      unknowns: [],
      contentDescription:
        resolvedMediaType === 'photo'
          ? 'صورة تم توفير رابطها يدوياً'
          : 'مراجعة فيديو تم توفير رابطها يدوياً',
      sentiment: 'neutral',
      downloadStatus: 'pending',
      collectedAt: new Date().toISOString(),
      rightsStatus: 'unknown',
      selectedForExport: true,
    };

    let targetDownloadUrl = payload.directMediaUrl;
    if (!targetDownloadUrl) {
      if (isDirectMediaLink(cleanSourceUrl)) {
        targetDownloadUrl = cleanSourceUrl;
      } else if (resolvedMediaType === 'photo') {
        try {
          const photos = await resolvePublicPhotos(cleanSourceUrl, 1);
          if (photos.length > 0) {
            targetDownloadUrl = photos[0].mediaUrl;
            if (candidate.provenance === 'unresolved_source') {
              candidate.provenance = photos[0].provenance;
            }
          }
        } catch (err) {
          console.warn('[ManualLink] Photo resolve failed:', (err as Error)?.message);
        }
      } else {
        try {
          targetDownloadUrl = await resolvePublicVideo(cleanSourceUrl);
        } catch (err) {
          console.warn('[ManualLink] Video resolve failed:', (err as Error)?.message);
        }
      }
    }
    candidate.mediaUrl = targetDownloadUrl;
    candidate.downloadUrl = targetDownloadUrl;
    if (resolvedMediaType === 'photo' && targetDownloadUrl) {
      candidate.thumbnailUrl = targetDownloadUrl;
    }

    if (targetDownloadUrl) {
      const dlResult = await downloadMedia(
        targetDownloadUrl,
        assetId,
        resolvedMediaType,
        60 * 1024 * 1024,
        undefined,
        false,
        'high'
      );
      candidate.downloadStatus = dlResult.status;
      candidate.localFilePath = dlResult.localFilePath;
      candidate.sha256 = dlResult.sha256 || computeSha256(cleanSourceUrl);
      candidate.fileSizeBytes = dlResult.fileSizeBytes;
      candidate.downloadError = dlResult.error;
      if (dlResult.durationSeconds) candidate.durationSeconds = dlResult.durationSeconds;
      if (dlResult.width && dlResult.height) {
        candidate.dimensions = { width: dlResult.width, height: dlResult.height };
      }
      if (dlResult.status === 'verified_available') {
        project.counters.downloadedAssets += 1;
        project.counters.verifiedAssets += 1;
        storage.incrementDownloads(1);
      }
    } else {
      candidate.downloadStatus = 'source_only';
      candidate.downloadError = 'رابط للمشاهدة على المصدر الأصلي - لا يتوفر رابط مباشر للتنزيل';
      candidate.sha256 = computeSha256(cleanSourceUrl);
    }

    project.candidates.unshift(candidate);
    project.counters.candidatesDiscovered = project.candidates.length;
    project.counters.sourcesInspected = project.candidates.length;

    project.logs.push({
      timestamp: new Date().toISOString(),
      stage: 'manual_input',
      message: `تمت إضافة الرابط بنجاح: ${cleanSourceUrl}`,
      level: 'success',
    });

    storage.upsertProject(project);
    this.broadcast(projectId, { project, assetAdded: candidate });

    return candidate;
  }

  public async runProjectSearch(projectId: string): Promise<void> {
    const storage = StorageService.getInstance();
    const project = storage.getProject(projectId);
    if (!project || this.activeJobs.has(projectId)) return;

    const abortController = new AbortController();
    this.activeJobs.add(projectId);
    this.cancelledJobs.delete(projectId);
    this.jobAbortControllers.set(projectId, abortController);

    const updateState = (
      state: JobState,
      message: string,
      level: 'info' | 'warn' | 'error' | 'success' = 'info'
    ) => {
      project.jobState = state;
      project.logs.push({
        timestamp: new Date().toISOString(),
        stage: state,
        message,
        level,
      });
      storage.upsertProject(project);
      this.broadcast(projectId, { project, state, message });
    };

    try {
      storage.incrementSearches();
      const wantVideo = project.mediaTypeRequested !== 'photo';
      const maxVideos = wantVideo ? Math.min(500, Math.max(1, Number(project.targetVideoCount) || 10)) : 0;
      const maxPhotos = project.mediaTypeRequested !== 'video' ? Math.min(500, Math.max(1, Number(project.targetPhotoCount) || 10)) : 0;
      const targetTotal = maxVideos + maxPhotos;

      project.candidates = [];
      project.counters = {
        candidatesDiscovered: 0,
        sourcesInspected: 0,
        visuallyMatchedAssets: 0,
        downloadedAssets: 0,
        verifiedAssets: 0,
        rejectedDuplicates: 0,
        targetCount: targetTotal,
      };
      updateState('searching', `جاري البحث في أمازون عن "${project.name}"...`);

      const queries = await buildAmazonUsQueries(project.name, undefined, undefined, abortController.signal);
      const { candidates } = await fetchAmazonSearchPage(queries.primaryQuery, 1, abortController.signal);
      const sorted = sortCandidatesByRatingCountDesc(candidates);

      let foundVideos = 0;
      for (const page of sorted) {
        if (abortController.signal.aborted || foundVideos >= maxVideos) break;
        const verdict = evaluateStrictProductTitleMatch(page.title, queries.primaryQuery, project.name);
        if (!verdict.approved) continue;

        project.counters.sourcesInspected++;
        const vids = await fetchAmazonUsProductVideos(page.url, abortController.signal);
        for (const v of vids) {
          if (abortController.signal.aborted || foundVideos >= maxVideos) break;
          foundVideos++;
          const assetId = `ast-${project.id}-${foundVideos}`;
          const dlRes = await downloadMedia(
            v.downloadUrl || v.mediaUrl,
            assetId,
            'video',
            60 * 1024 * 1024,
            abortController.signal
          );
          const candidate: CandidateAsset = {
            id: assetId,
            projectId: project.id,
            title: v.title || page.title,
            mediaType: 'video',
            platform: 'amazon',
            sourceUrl: v.sourceUrl || page.url,
            productListingUrl: page.url,
            reviewerOrChannel: v.reviewerOrChannel,
            reviewId: v.reviewId,
            thumbnailUrl: v.thumbnailUrl || page.imageUrl || '',
            mediaUrl: v.mediaUrl,
            downloadUrl: v.downloadUrl || v.mediaUrl,
            provenance: v.provenance,
            matchCategory: verdict.matchCategory === 'mismatched' ? 'exact_design' : verdict.matchCategory,
            matchScore: verdict.matchScore,
            userFacingMatchLabel: verdict.userFacingLabelAr,
            visibleDifferences: [],
            supportingObservations: [verdict.reasonAr],
            unknowns: [],
            contentDescription: v.title,
            sentiment: 'positive',
            downloadStatus: dlRes.status,
            localFilePath: dlRes.localFilePath,
            sha256: dlRes.sha256,
            fileSizeBytes: dlRes.fileSizeBytes,
            durationSeconds: dlRes.durationSeconds,
            collectedAt: new Date().toISOString(),
            rightsStatus: 'public_reference',
            selectedForExport: true,
          };
          project.candidates.push(candidate);
          project.counters.candidatesDiscovered = project.candidates.length;
          project.counters.visuallyMatchedAssets = project.candidates.length;
          const verifiedCount = project.candidates.filter((c) => c.downloadStatus === 'verified_available').length;
          project.counters.downloadedAssets = verifiedCount;
          project.counters.verifiedAssets = verifiedCount;
          storage.upsertProject(project);
          this.broadcast(projectId, { project, assetAdded: candidate });
        }
      }

      const finalVerified = project.candidates.filter((c) => c.downloadStatus === 'verified_available').length;
      updateState(
        finalVerified >= targetTotal ? 'completed' : 'completed_partial',
        `اكتمل البحث (${finalVerified} ملف جاهز للتنزيل).`,
        finalVerified > 0 ? 'success' : 'warn'
      );
    } catch (err) {
      updateState('failed', `فشلت العملية: ${(err as Error).message}`, 'error');
    } finally {
      this.activeJobs.delete(projectId);
      this.jobAbortControllers.delete(projectId);
    }
  }
}
