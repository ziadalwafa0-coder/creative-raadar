import {enforceEvidenceGatedBadge} from './pipeline/linkState.ts';
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
  IdentityCardV2Client,
  RejectedCandidateItem,
  SearchBreakdownSummary,
  MatchMode,
  VerdictTier,
  AttributeStrength,
  EvidenceLevel,
  LinkState,
  DiscriminatorSpec,
  BoundingBox2D,
  BlindDiscriminatorObservation,
  OwnerFeedbackLabel,
} from '../types/index.ts';
import { isSafeExternalUrl, sanitizeCsvField, computeSha256 } from '../utils/security.server.ts';
import { normalizeUrl, isDuplicateCandidate } from '../utils/rules.ts';
import { StorageService } from './storage.ts';
import {
  AmazonBlockError,
  AmazonDeadListingError,
  AMAZON_CHROME_USER_AGENT,
  AMAZON_US_HEADERS,
  fetchAmazonHtml,
  fetchProductImageAsBase64,
} from './amazonHttp.ts';
import {
  buildAmazonUsQueries,
  buildProgressiveFallbackQueries,
  evaluateStrictProductTitleMatch,
  resolveProductIdentityFromUrl,
  type TitleMatchVerdict,
} from './queryBuilder.ts';
import {
  fetchAmazonSearchPage,
  sortCandidatesByRatingCountDesc,
  extractSnowballQueriesFromVerifiedTitles,
  extractAnchorAndSiblingCandidates,
  ENABLED_VIDEO_MARKETPLACES,
  type AmazonUsProductCandidate,
  type AmazonMarketplaceCode,
  type AmazonSortVariant,
} from './amazonSearch.ts';
import {
  fetchAmazonUsProductVideos,
  parseAmazonUsVideosFromHtml,
  type ExtractedAmazonVideo,
} from './amazonVideos.ts';
import { DATA_DIR } from './config.ts';
import { getRuntimeSettings } from './settings.ts';
import {
  downloadMedia,
  prewarmMediaInBackground,
  DOWNLOADS_DIR,
  pinCachedFile,
  resolveBestLocalMediaForAsset,
} from './downloader.ts';
import {
  makeSafeAsciiZipFilename,
  makeSafeAsciiRootDirName,
} from './exporter.ts';
import {
  ai,
  analyzeProductImage,
  generateAlternativeAmazonQueries,
  isGeminiConfigured,
  verifyAmazonProductsBatchVisually,
  type ProductMatchVerdict,
} from './gemini.ts';
import {
  ALL_TIKTOK_SERP_ENGINES,
  buildTikTokSearchVariants,
  discoverTikTokVideoUrls,
  discoverTikTokVideoUrlsWithDiagnostics,
  evaluateTikTokVideoMatch,
  fetchTikTokVideoDetail,
  isTikTokUrl,
  isTikTokVideoPageUrl,
  resolveTikTokPlayableStream,
  type ExtractedTikTokVideo,
} from './tiktokVideos.ts';
import {
  createSearchTrace,
  recordCandidateDecision,
  recordSearchRound,
  recordFetchedResponse,
  finalizeSearchTrace,
  getSearchTrace,
  listSearchTraces,
} from './pipeline/trace.ts';
import {
  resolveIdentityCardV2,
  updateCachedIdentityCard,
  upsertManualIdentityCard,
  classifyIdentityAttributeStrengths,
  buildDiscriminatorsForIdentityCard,
  IdentityResolutionFailedError,
  type IdentityCardV2,
} from './pipeline/identity.ts';
import {
  verifyListingCandidatesBatch,
  verifyVideoCandidateAttributes,
  recordVerificationFeedback,
  getVerificationFeedbackForImage,
  getDailyGeminiBudgetStatus,
  sortCandidatesByTierAndClip,
  type AttributeVerificationVerdict,
} from './pipeline/verify.ts';
import {
  recordOwnerFeedback,
  rescoreCandidatesWithOwnerFeedback,
  computeOwnerPrecisionStats,
  getFeedbackEntriesForHash,
} from './pipeline/ownerFeedback.ts';
import { buildIntelligentQueryPlan } from './pipeline/queryIntelligence.ts';
import { getCalibrationConfig } from './pipeline/calibrate.ts';
import {
  extractRealVideoFramePoster,
  hammingDistanceHex64,
  resolvePosterFilePathById,
} from './pipeline/thumbnails.ts';
import {
  searchTikTokProviders,
  expandTikTokCandidatesFromVerified,
} from './sources/tiktok/index.ts';
import type { TikTokVideoCandidate } from './sources/tiktok/types.ts';

export interface EphemeralAsset {
  id: string;
  searchId: string;
  title: string;
  mediaUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  posterSource?: 'real_video_frame' | 'amazon_slate' | 'tiktok_cover' | 'product_listing_image';
  verifiedByAi?: boolean;
  verificationStage?: string;
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  evidenceSummaryAr?: string;
  visibleFramesCount?: number;
  keyframesExtractedCount?: number;
  extractedFrameUrls?: string[];
  cropClipSimilarity?: number;
  boundingBoxes?: BoundingBox2D[];
  blindObservations?: BlindDiscriminatorObservation[];
  linkState?: LinkState;
  linkStateReasonAr?: string;
  ownerLabel?: OwnerFeedbackLabel;
  demotedByOwnerFeedback?: boolean;
  demotionReasonAr?: string;
  imageHash?: string;
  embedHtml?: string;
  downloadFailureReason?: string;
  sourceUrl: string;
  productListingUrl: string;
  reviewerOrChannel?: string;
  reviewId?: string;
  mediaType: 'video' | 'photo';
  platform?: SourcePlatform;
  durationSeconds?: number;
  provenance: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  matchCategory: 'exact_design' | 'permitted_variation' | 'similar_differences' | 'insufficient_evidence';
  matchScore: number;
  userFacingMatchLabel: string;
  isCustomerReview: boolean;
  ratingCount?: number;
  collectedAt: string;
  marketplace?: string;
  asin?: string;
  isDead?: boolean;
  provenanceData?: {
    source: 'live' | 'fixture' | 'manual';
    marketplace: string;
    asin: string;
    fetchedAt: string;
    httpStatus: number;
    finalUrl: string;
    responseSnippetHash: string;
  };
}

/**
 * Phase 5 Pure Helper: Global Target Allocation with Per-Source Max Caps (not quotas).
 * When one source yields fewer videos than half the target, the other source continues
 * filling up to global target `totalVideoTarget` (bounded only by its max cap).
 */
export function canSourceAcceptMoreVideos(params: {
  source: 'amazon' | 'tiktok';
  totalVideoTarget: number;
  foundAmazonVideos: number;
  foundTikTokVideos: number;
  amazonMaxCap: number;
  tiktokMaxCap: number;
  includeAmazon: boolean;
  includeTikTok: boolean;
}): boolean {
  const totalFound = params.foundAmazonVideos + params.foundTikTokVideos;
  if (totalFound >= params.totalVideoTarget) return false;
  if (params.source === 'amazon') {
    if (!params.includeAmazon) return false;
    return params.foundAmazonVideos < params.amazonMaxCap;
  }
  if (!params.includeTikTok) return false;
  return params.foundTikTokVideos < params.tiktokMaxCap;
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
      type: 'identity';
      searchId: string;
      identityCard: IdentityCardV2Client;
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
      type: 'rejected';
      searchId: string;
      rejected: RejectedCandidateItem;
      timestamp: string;
    }
  | {
      type: 'completed';
      searchId: string;
      requestedCount: number;
      foundCount: number;
      downloadableCount: number;
      reasonIfPartial?: string;
      breakdownSummary?: SearchBreakdownSummary;
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
    if (isTikTokVideoPageUrl(source)) {
      const tkDetail = await fetchTikTokVideoDetail(source, signal);
      if (tkDetail?.canonicalUrl) {
        videoResolveCache.set(source, {
          value: tkDetail.canonicalUrl,
          expiresAt: now + EXTRACTION_CACHE_TTL_MS,
        });
        return tkDetail.canonicalUrl;
      }
    }
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
  const rawSourcePlatform: 'amazon' | 'tiktok' | 'all' =
    req.body?.sourcePlatform === 'tiktok' || req.body?.sourcePlatform === 'all'
      ? req.body.sourcePlatform
      : 'amazon';

  const clampedVideo = Math.min(500, Math.max(1, Number(req.body?.targetVideoCount) || 10));
  const clampedPhoto = Math.min(500, Math.max(1, Number(req.body?.targetPhotoCount) || 10));
  const rawAmazonVideoCount = Number(req.body?.targetAmazonVideoCount);
  const rawTikTokVideoCount = Number(req.body?.targetTikTokVideoCount);

  const amazonVideoTarget =
    mediaType === 'photo'
      ? 0
      : rawSourcePlatform === 'tiktok'
      ? 0
      : rawSourcePlatform === 'all' && Number.isFinite(rawAmazonVideoCount) && rawAmazonVideoCount >= 1
      ? Math.min(500, Math.floor(rawAmazonVideoCount))
      : rawSourcePlatform === 'all'
      ? Math.max(1, Math.ceil(clampedVideo / 2))
      : clampedVideo;

  const tiktokVideoTarget =
    mediaType === 'photo'
      ? 0
      : rawSourcePlatform === 'amazon'
      ? 0
      : rawSourcePlatform === 'all' && Number.isFinite(rawTikTokVideoCount) && rawTikTokVideoCount >= 1
      ? Math.min(500, Math.floor(rawTikTokVideoCount))
      : rawSourcePlatform === 'all'
      ? Math.max(1, Math.floor(clampedVideo / 2))
      : clampedVideo;

  const targetVideoCount =
    mediaType === 'photo'
      ? 0
      : rawSourcePlatform === 'all'
      ? amazonVideoTarget + tiktokVideoTarget
      : clampedVideo;
  const targetPhotoCount = mediaType === 'video' ? 0 : clampedPhoto;
  const totalTarget = targetVideoCount + targetPhotoCount;

  const rawReferenceImage =
    typeof req.body?.referenceImage === 'string' &&
    req.body.referenceImage.trim().startsWith('data:image/')
      ? req.body.referenceImage.trim()
      : undefined;

  const matchMode: MatchMode =
    req.body?.matchMode === 'strict_color' ? 'strict_color' : 'same_design';
  const includeSimilar = Boolean(req.body?.includeSimilar);
  const customMustMatch = Array.isArray(req.body?.mustMatch)
    ? req.body.mustMatch.map((x: unknown) => String(x || '').trim()).filter(Boolean)
    : undefined;
  const customMustNotBe = Array.isArray(req.body?.mustNotBe)
    ? req.body.mustNotBe.map((x: unknown) => String(x || '').trim()).filter(Boolean)
    : undefined;
  const customAttributeStrengths =
    req.body?.attributeStrengths && typeof req.body.attributeStrengths === 'object'
      ? (req.body.attributeStrengths as Record<string, AttributeStrength>)
      : undefined;

  const settings = getRuntimeSettings();
  const calibration = getCalibrationConfig();
  const trace = createSearchTrace(searchId, {
    productName: rawProductName || rawProductUrl || 'بحث بالصورة',
    productUrl: rawProductUrl || undefined,
    mediaType,
    sourcePlatform: rawSourcePlatform,
    targetVideoCount: totalTarget,
    hasReferenceImage: Boolean(rawReferenceImage),
    matchMode,
  });
  trace.settingsUsed = settings as unknown as Record<string, unknown>;

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

  const seenStreamUuids = new Set<string>();
  const seenMediaUrls = new Set<string>();
  const seenFrameHashes: string[] = [];
  const seenAsins = new Set<string>();
  const emittedRejectedIds = new Set<string>();
  const marketplacesSearched = new Set<string>();

  let foundVideos = 0;
  let foundAmazonVideos = 0;
  let foundTikTokVideos = 0;
  let foundPhotos = 0;
  let assetCounter = 0;
  let inspectedCount = 0;
  let pagesBlockedCount = 0;
  let totalProductsDiscovered = 0;

  // Phase 1.1: Never cap emittedRejectedIds at 45 — every rejected item is emitted so UI counters & trace always match 100%!
  const emitRejectedCandidate = (item: RejectedCandidateItem) => {
    if (emittedRejectedIds.has(item.id)) return;
    emittedRejectedIds.add(item.id);
    sendEvent({
      type: 'rejected',
      searchId,
      rejected: item,
      timestamp: new Date().toISOString(),
    });
  };

  try {
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

    let refImageMime = 'image/jpeg';
    let refImageBase64Clean = '';
    if (rawReferenceImage) {
      const m = rawReferenceImage.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i);
      if (m) refImageMime = m[1];
      refImageBase64Clean = rawReferenceImage.replace(/^data:[^;]+;base64,/, '');
    }

    const simulateIdentityFailure = Boolean(req.body?.simulateIdentityFailure);
    const hasManualIdentityOverride = Boolean(
      userTypedNonUrlName &&
        customMustMatch &&
        customMustMatch.length > 0 &&
        customMustNotBe &&
        customMustNotBe.length > 0
    );

    const tIdentity0 = Date.now();
    let identityFailureError: IdentityResolutionFailedError | null =
      null as IdentityResolutionFailedError | null;

    const [resolvedIdentityCard, resolvedLinkIdentity] = await Promise.all([
      refImageBase64Clean.length > 50
        ? (async (): Promise<IdentityCardV2 | null> => {
            if (hasManualIdentityOverride && !simulateIdentityFailure) {
              const imgHash = crypto
                .createHash('sha256')
                .update(refImageBase64Clean.slice(0, 4096))
                .digest('hex')
                .slice(0, 24);
              return upsertManualIdentityCard({
                imageHash: imgHash,
                nameEn: userTypedNonUrlName,
                nameAr: userTypedNonUrlName,
                mustMatch: customMustMatch!,
                mustNotBe: customMustNotBe!,
              });
            }
            sendEvent({
              type: 'progress',
              searchId,
              message:
                'الخطوة 1/3 (بطاقة الهوية البصرية v2): جاري فحص صورة المنتج وتحديد الشكل الهندسي وآلية العمل وقوة الشروط (HARD/SOFT)...',
              foundCount: 0,
              timestamp: new Date().toISOString(),
            });
            try {
              let card = await resolveIdentityCardV2({
                base64Data: refImageBase64Clean,
                mimeType: refImageMime,
                productListingUrl: rawProductUrl,
                explicitProductName: userTypedNonUrlName,
                simulateFailure: simulateIdentityFailure,
              });
              if (customMustMatch || customMustNotBe || customAttributeStrengths) {
                const updated = updateCachedIdentityCard(card.imageHash, {
                  mustMatch: customMustMatch,
                  mustNotBe: customMustNotBe,
                  attributeStrengths: customAttributeStrengths,
                });
                if (updated) card = updated;
              }
              return card;
            } catch (err: unknown) {
              if (err instanceof IdentityResolutionFailedError) {
                identityFailureError = err;
              } else {
                identityFailureError = new IdentityResolutionFailedError(
                  (err as Error)?.message || String(err),
                  3
                );
              }
              trace.identityResolution.error = identityFailureError.message;
              trace.summary.timeoutsCount++;
              console.warn('[StreamSearch] Fail-Closed IdentityCard v2 error:', identityFailureError.message);
              return null;
            }
          })()
        : Promise.resolve(null),
      linkCandidate && !simulateIdentityFailure
        ? resolveProductIdentityFromUrl(linkCandidate, abortController.signal).catch((err: unknown) => {
            console.warn('[StreamSearch] URL identity resolution error:', (err as Error)?.message || err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    if (abortController.signal.aborted) return;

    // FAIL CLOSED: If reference image was provided (or failure simulated) and Identity Card failed or had empty mustMatch/mustNotBe, STOP immediately and do NOT search!
    if ((refImageBase64Clean.length > 50 || simulateIdentityFailure) && (!resolvedIdentityCard || identityFailureError)) {
      const arabicErr =
        identityFailureError?.arabicMessage ||
        'تعذر استخراج بطاقة الهوية البصرية للمنتج (mustMatch / mustNotBe) بعد 3 محاولات. تم إيقاف البحث تلقائياً لمنع ظهور منتجات خاطئة — يرجى تعبئة نموذج الهوية اليدوي للمتابعة.';
      trace.identityResolution.durationMs = Date.now() - tIdentity0;
      trace.identityResolution.profileResolved = false;
      trace.identityResolution.emergencyFallbackUsed = false;
      finalizeSearchTrace(trace, { identity_failed_closed: arabicErr }, [], getDailyGeminiBudgetStatus());
      sendEvent({
        type: 'failed',
        searchId,
        error: arabicErr,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const searchProductName =
      resolvedIdentityCard?.nameEn ||
      resolvedLinkIdentity?.canonicalSearchQuery ||
      userTypedNonUrlName ||
      resolvedIdentityCard?.nameAr ||
      (rawProductName !== 'بحث بالصورة' ? rawProductName : '');

    if (!searchProductName && !isTikTokVideoPageUrl(linkCandidate)) {
      const msg =
        'تعذر التعرف التلقائي على الصورة حالياً — يرجى إدخال بيانات بطاقة الهوية اليدوية (الاسم الإنجليزي، مواصفات التصميم mustMatch، والمستبعدات mustNotBe) ثم الضغط على ابدأ البحث.';
      finalizeSearchTrace(trace, { identity_missing: msg }, [], getDailyGeminiBudgetStatus());
      sendEvent({
        type: 'failed',
        searchId,
        error: msg,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const activeIdentityCard: IdentityCardV2 = resolvedIdentityCard || {
      imageHash: `text_${crypto.createHash('sha1').update(searchProductName).digest('hex').slice(0, 16)}`,
      nameEn: searchProductName,
      nameAr: userTypedNonUrlName || searchProductName,
      category: 'General',
      primaryColor: 'Standard',
      formFactor: {
        shape: searchProductName,
        approximateSize: 'Standard',
        orientationPlacement: 'Standard',
      },
      mechanism: {
        howItWorks: searchProductName,
        powerSource: 'Standard',
        keyComponents: [searchProductName],
      },
      mustMatch: customMustMatch || [],
      attributeStrengths: classifyIdentityAttributeStrengths(customMustMatch || [], {
        ...settings.attributeStrengthOverrides,
        ...(customAttributeStrengths || {}),
      }),
      variableAttributes: ['color', 'brand name', 'logo', 'retail box artwork', 'cable length'],
      mustNotBe: customMustNotBe || [],
      queries: {
        amazonEn: [searchProductName],
        amazonAr: [userTypedNonUrlName || searchProductName],
        tiktokEn: [searchProductName],
        tiktokAr: [userTypedNonUrlName || searchProductName],
        tradeNamesEn: [],
      },
      hashtags: [],
      confidence: 0.8,
      ambiguity: [],
      createdAt: new Date().toISOString(),
    };

    // Always ensure attributeStrengths and Identity v3 discriminators are populated
    activeIdentityCard.attributeStrengths = classifyIdentityAttributeStrengths(
      activeIdentityCard.mustMatch,
      {
        ...(activeIdentityCard.attributeStrengths || {}),
        ...settings.attributeStrengthOverrides,
        ...(customAttributeStrengths || {}),
      },
      { nameEn: activeIdentityCard.nameEn, category: activeIdentityCard.category }
    );
    if (!activeIdentityCard.discriminators || activeIdentityCard.discriminators.length === 0) {
      activeIdentityCard.discriminators = buildDiscriminatorsForIdentityCard(activeIdentityCard).discriminators;
    }

    trace.identityResolution = {
      durationMs: Date.now() - tIdentity0,
      profileResolved: Boolean(resolvedIdentityCard),
      emergencyFallbackUsed: false,
      suggestedNameEn: activeIdentityCard.nameEn,
      suggestedNameAr: activeIdentityCard.nameAr,
      formFactor: `${activeIdentityCard.formFactor.shape} (${activeIdentityCard.formFactor.approximateSize})`,
      mechanism: `${activeIdentityCard.mechanism.howItWorks} [${activeIdentityCard.mechanism.powerSource}]`,
      discriminators: activeIdentityCard.discriminators,
      mustMatch: activeIdentityCard.mustMatch,
      attributeStrengths: activeIdentityCard.attributeStrengths,
      mustNotBe: activeIdentityCard.mustNotBe,
      variableAttributes: activeIdentityCard.variableAttributes,
      queriesTried: [],
      error: trace.identityResolution.error,
    };

    if (resolvedIdentityCard) {
      sendEvent({
        type: 'identity',
        searchId,
        identityCard: activeIdentityCard,
        timestamp: new Date().toISOString(),
      });
      sendEvent({
        type: 'progress',
        searchId,
        message: `الخطوة 2/3: بطاقة الهوية البصرية v3 جاهزة: «${activeIdentityCard.nameAr}» — الاسم التجاري: "${activeIdentityCard.nameEn}" (${activeIdentityCard.discriminators?.length || 0} محددات تمييزية، استبعاد: ${activeIdentityCard.mustNotBe.slice(0, 3).join('، ')})`,
        foundCount: 0,
        resolvedProductName: activeIdentityCard.nameEn,
        timestamp: new Date().toISOString(),
      });
    }

    // Phase 4: Build Intelligent Query Plan (live Amazon autocomplete + OCR/feature variants + learned n-grams)
    const intelligentPlan = await buildIntelligentQueryPlan({
      identity: activeIdentityCard,
      signal: abortController.signal,
    });

    const finalQueries = await buildAmazonUsQueries(
      userTypedNonUrlName || searchProductName,
      activeIdentityCard.nameEn || resolvedLinkIdentity?.canonicalSearchQuery,
      [
        ...intelligentPlan.amazonEnQueries,
        ...activeIdentityCard.queries.amazonEn,
        ...activeIdentityCard.queries.tradeNamesEn,
      ],
      abortController.signal
    );

    const maxQueriesCap = Math.max(2, settings.searchDepth.maxQueries || 8);
    const round1Queries = Array.from(
      new Set([
        ...intelligentPlan.amazonEnQueries.slice(0, 3),
        ...(activeIdentityCard.queries.amazonEn || []),
        ...finalQueries.variants.slice(0, 3),
      ])
    ).slice(0, Math.min(4, maxQueriesCap));

    const round2TradeQueries = Array.from(
      new Set([
        ...intelligentPlan.autocompleteSuggestions.slice(0, 3),
        ...(activeIdentityCard.queries.tradeNamesEn || []),
        ...intelligentPlan.amazonEnQueries.slice(3),
        ...finalQueries.variants.slice(3),
      ])
    )
      .filter((q) => !round1Queries.some((r1) => r1.toLowerCase() === q.toLowerCase()))
      .slice(0, Math.max(3, maxQueriesCap - round1Queries.length));

    const isDirectTikTokLink = isTikTokVideoPageUrl(linkCandidate);
    const includeAmazon =
      !isDirectTikTokLink && (rawSourcePlatform === 'amazon' || rawSourcePlatform === 'all');
    const includeTikTok =
      isDirectTikTokLink || rawSourcePlatform === 'tiktok' || rawSourcePlatform === 'all';
    const platformLabelAr =
      includeAmazon && includeTikTok
        ? 'أمازون + تيك توك'
        : includeTikTok
        ? 'تيك توك'
        : 'أمازون';

    sendEvent({
      type: 'progress',
      searchId,
      message: `الخطوة 3/3: جاري البحث في (${platformLabelAr}) عن "${activeIdentityCard.nameEn}" والتحقق البصري بـ 5 مستويات (HARD/SOFT)...`,
      foundCount: 0,
      resolvedProductName: activeIdentityCard.nameEn,
      timestamp: new Date().toISOString(),
    });

    interface VerifiedQueueItem {
      page: AmazonUsProductCandidate & { roundIndex?: number };
      verdict: {
        linkState?:LinkState;linkStateReasonAr?:string;extractedFrameUrls?:string[];cropClipSimilarity?:number|null;boundingBoxes?:import("../types/index.ts").BoundingBox2D[];blindObservations?:import("../types/index.ts").BlindDiscriminatorObservation[];
        approved: boolean;
        verdictTier: VerdictTier;
        evidenceLevel?: EvidenceLevel;
        evidenceSummaryAr?: string;
        matchCategory: 'exact_design' | 'permitted_variation' | 'similar_differences' | 'insufficient_evidence';
        matchScore: number;
        userFacingLabelAr: string;
        reasonAr: string;
        verifiedByAi: boolean;
        stage: string;
      };
    }

    const workQueue: VerifiedQueueItem[] = [];
    const verifiedListingTitles: string[] = [];
    const deferredSimilarTikTokCandidates: Array<{
      video: TikTokVideoCandidate;
      verdict: AttributeVerificationVerdict;
    }> = [];
    let bestAnchorListing: { asin: string; title: string; marketplace: AmazonMarketplaceCode; similarity: number } | null =
      null;
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

    let totalApprovedAmazonProducts = 0;

    const scoreCandidateTitleRelevance = (title: string): number => {
      const lower = (title || '').toLowerCase();
      const targetWords = [
        activeIdentityCard.nameEn,
        ...activeIdentityCard.mustMatch,
        ...(activeIdentityCard.queries?.amazonEn || []).slice(0, 3),
      ]
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'set', 'kit', 'tool'].includes(w));
      const uniqueWords = Array.from(new Set(targetWords));
      let hits = 0;
      for (const w of uniqueWords) {
        if (lower.includes(w)) hits++;
      }
      if (/5[\s-]*in[\s-]*1/i.test(activeIdentityCard.nameEn) && /5[\s-]*in[\s-]*1/i.test(lower)) {
        hits += 4;
      }
      if (/interchangeable/i.test(activeIdentityCard.nameEn) && /interchangeable/i.test(lower)) {
        hits += 4;
      }
      if (/suction|photocatal|trap/i.test(activeIdentityCard.nameEn) && /suction|photocatal|trap|inhal/i.test(lower)) {
        hits += 3;
      }
      return hits;
    };

    const maxListingsLimit = Math.max(40, settings.searchDepth.maxListingsToInspect || 250);

    const verifyAndEnqueueListings = async (
      candidates: AmazonUsProductCandidate[],
      queryForMatch: string,
      roundIndex?: number
    ): Promise<{ verifiedCount: number; newCandidatesCount: number }> => {
      const unseenCandidates: AmazonUsProductCandidate[] = [];
      for (const page of candidates) {
        if (!page.asin) continue;
        if (seenAsins.has(page.asin)) {
          trace.summary.duplicateAsinsSkipped = (trace.summary.duplicateAsinsSkipped || 0) + 1;
          continue;
        }
        if (trace.summary.listingsInspected + unseenCandidates.length >= maxListingsLimit) break;
        unseenCandidates.push(page);
      }

      if (unseenCandidates.length === 0) return { verifiedCount: 0, newCandidatesCount: 0 };

      unseenCandidates.sort((a, b) => {
        const relA = scoreCandidateTitleRelevance(a.title);
        const relB = scoreCandidateTitleRelevance(b.title);
        if (relB !== relA) return relB - relA;
        return (b.ratingCount || 0) - (a.ratingCount || 0);
      });
      const toVerify = unseenCandidates.slice(0, 22);
      for (const page of toVerify) {
        seenAsins.add(page.asin);
        totalProductsDiscovered++;
        trace.summary.listingsInspected++;
      }

      if (refImageBase64Clean.length > 50) {
        const verdictsMap = await verifyListingCandidatesBatch({
          referenceImageBase64: refImageBase64Clean,
          referenceImageMimeType: refImageMime,
          identity: activeIdentityCard,
          candidates: toVerify.map((p) => ({
            id: p.asin,
            title: p.title,
            url: p.url,
            imageUrl: p.imageUrl,
            ratingCount: p.ratingCount,
          })),
          matchMode,
          includeSimilar,
          sourceType: 'amazon',
          signal: abortController.signal,
        });

        let approvedCount = 0;
        for (const page of toVerify) {
          const v = verdictsMap.get(page.asin.toUpperCase());

          // Phase 1.4 CRITICAL: verification_error and budget_exhausted are NOT rejections!
          if (
            v &&
            (v.verdict === 'unverified_ai_fallback' ||
              v.reasonCode === 'verification_error' ||
              v.reasonCode === 'budget_exhausted')
          ) {
            recordCandidateDecision(trace, {
              source: 'amazon',
              marketplace: page.marketplace || 'US',
              entityType: 'listing',
              id: page.asin,
              title: page.title,
              url: page.url,
              imageUrl: page.imageUrl,
              referenceSimilarity: v.referenceSimilarity ?? null,
              attributeVerdicts: {
                verdict: v.verdict,
                verdictTier: 'unverified',
                confidence: v.confidence,
                reasonAr: v.reasonAr,
              },
              stage: (v.stage as any) || 'visual_stage2_gemini',
              finalDecision: 'unverified',
              reasonCode: v.reasonCode || 'verification_error',
              verdictTier: 'unverified',
              rejectionReason: v.reasonCode || 'verification_error',
              rejectionReasonAr: v.reasonAr,
            });
            continue;
          }

          if (!v || !v.approved) {
            const reasonAr =
              v?.reasonAr || 'تم استبعاد المنتج لعدم اجتياز التحقق البصري من الهوية';
            const reasonCode = v?.reasonCode || 'rejected_other_type';
            recordCandidateDecision(trace, {
              source: 'amazon',
              marketplace: page.marketplace || 'US',
              entityType: 'listing',
              id: page.asin,
              title: page.title,
              url: page.url,
              imageUrl: page.imageUrl,
              referenceSimilarity: v?.referenceSimilarity ?? null,
              attributeVerdicts: {
                formFactorMatches: v?.formFactorMatches,
                mechanismMatches: v?.mechanismMatches,
                colorMatches: v?.colorMatches,
                mustNotBeHit: v?.mustNotBeHit,
                failedAttribute: v?.failedAttribute,
                verdict: v?.verdict,
                verdictTier: v?.verdictTier,
                confidence: v?.confidence,
                reasonAr,
              },
              stage: (v?.stage as any) || 'visual_stage2_gemini',
              finalDecision: 'rejected',
              reasonCode,
              failedAttribute: v?.failedAttribute,
              verdictTier: v?.verdictTier || 'other_type',
              rejectionReason: reasonCode,
              rejectionReasonAr: reasonAr,
            });

            emitRejectedCandidate({
              id: page.asin,
              source: 'amazon',
              entityType: 'listing',
              title: page.title,
              url: page.url,
              imageUrl: page.imageUrl,
              reasonAr,
              reasonCode,
              failedAttribute: v?.failedAttribute,
              verdict: v?.verdict || 'rejected',
              verdictTier: v?.verdictTier || 'other_type',
              mustNotBeHit: v?.mustNotBeHit,
              referenceSimilarity: v?.referenceSimilarity,
            });
            continue;
          }

          approvedCount++;
          totalApprovedAmazonProducts++;
          verifiedListingTitles.push(page.title);

          if (
            !bestAnchorListing ||
            (v.referenceSimilarity > bestAnchorListing.similarity &&
              (v.verdictTier === 'exact' || v.verdictTier === 'same_design_variant'))
          ) {
            bestAnchorListing = {
              asin: page.asin,
              title: page.title,
              marketplace: page.marketplace || 'US',
              similarity: v.referenceSimilarity,
            };
          }

          const matchCategory =
            v.verdictTier === 'exact' || v.verdict === 'same_design'
              ? 'exact_design'
              : v.verdictTier === 'same_design_variant' || v.verdict === 'variant'
              ? 'permitted_variation'
              : v.verdictTier === 'same_type_close_design' || v.verdict === 'similar_other_type'
              ? 'similar_differences'
              : 'insufficient_evidence';

          const userFacingLabelAr = !v.verifiedByAi
            ? 'غير متحقق بالذكاء الاصطناعي'
            : v.verdictTier === 'exact'
            ? 'مطابق تماماً (Exact)'
            : v.verdictTier === 'same_design_variant'
            ? 'نفس التصميم (لون/علامة مختلفة)'
            : 'نفس النوع بتصميم قريب (Close Design)';

          recordCandidateDecision(trace, {
            source: 'amazon',
            marketplace: page.marketplace || 'US',
            entityType: 'listing',
            id: page.asin,
            title: page.title,
            url: page.url,
            imageUrl: page.imageUrl,
            referenceSimilarity: v.referenceSimilarity,
            attributeVerdicts: {
              formFactorMatches: v.formFactorMatches,
              mechanismMatches: v.mechanismMatches,
              colorMatches: v.colorMatches,
              mustNotBeHit: v.mustNotBeHit,
              verdict: v.verdict,
              verdictTier: v.verdictTier,
              confidence: v.confidence,
              reasonAr: v.reasonAr,
            },
            stage: v.stage as any,
            finalDecision: v.verifiedByAi ? 'accepted' : 'unverified',
            verdictTier: v.verdictTier,
            rejectionReason: null,
            rejectionReasonAr: null,
          });

          workQueue.push({
            page: { ...page, roundIndex },
            verdict: {
              approved: true,
              verdictTier: v.verdictTier,
              matchCategory,
              matchScore: Math.round(v.referenceSimilarity * 100),
              userFacingLabelAr,
              reasonAr: v.reasonAr,
              verifiedByAi: v.verifiedByAi,
              stage: v.stage,
            },
          });
        }

        if (approvedCount > 0) {
          workQueue.sort((a, b) => (b.page.ratingCount || 0) - (a.page.ratingCount || 0));
          notifyQueueListeners();
        }
        return { verifiedCount: approvedCount, newCandidatesCount: toVerify.length };
      }

      // Text-only search (no reference image uploaded): enforce dynamic mustNotBe + head noun match
      let textApprovedCount = 0;
      for (const page of toVerify) {
        const tv = evaluateStrictProductTitleMatch(
          page.title,
          queryForMatch,
          searchProductName,
          activeIdentityCard.mustMatch,
          activeIdentityCard.mustNotBe
        );
        if (!tv.approved) {
          recordCandidateDecision(trace, {
            source: 'amazon',
            marketplace: page.marketplace || 'US',
            entityType: 'listing',
            id: page.asin,
            title: page.title,
            url: page.url,
            imageUrl: page.imageUrl,
            referenceSimilarity: tv.matchScore / 100,
            attributeVerdicts: { reasonAr: tv.reasonAr },
            stage: 'text_gate',
            finalDecision: 'rejected',
            reasonCode: 'rejected_other_type',
            verdictTier: 'other_type',
            rejectionReason: `text_gate: ${tv.reasonAr}`,
            rejectionReasonAr: tv.reasonAr,
          });
          emitRejectedCandidate({
            id: page.asin,
            source: 'amazon',
            entityType: 'listing',
            title: page.title,
            url: page.url,
            imageUrl: page.imageUrl,
            reasonAr: tv.reasonAr,
            reasonCode: 'rejected_other_type',
            verdict: 'mismatched',
            verdictTier: 'other_type',
          });
          continue;
        }
        textApprovedCount++;
        totalApprovedAmazonProducts++;
        verifiedListingTitles.push(page.title);
        recordCandidateDecision(trace, {
          source: 'amazon',
          marketplace: page.marketplace || 'US',
          entityType: 'listing',
          id: page.asin,
          title: page.title,
          url: page.url,
          imageUrl: page.imageUrl,
          referenceSimilarity: tv.matchScore / 100,
          attributeVerdicts: { reasonAr: tv.reasonAr },
          stage: 'text_gate',
          finalDecision: 'accepted',
          verdictTier: 'exact',
          rejectionReason: null,
          rejectionReasonAr: null,
        });
        workQueue.push({
          page: { ...page, roundIndex },
          verdict: {
            approved: true,
            verdictTier: 'exact',
            matchCategory: tv.matchCategory === 'mismatched' ? 'exact_design' : tv.matchCategory,
            matchScore: tv.matchScore,
            userFacingLabelAr: 'تطابق بالاسم التجاري (بدون صورة مرجعية)',
            reasonAr: tv.reasonAr,
            verifiedByAi: false,
            stage: 'text_gate',
          },
        });
      }
      if (textApprovedCount > 0) {
        workQueue.sort((a, b) => (b.page.ratingCount || 0) - (a.page.ratingCount || 0));
        notifyQueueListeners();
      }
      return { verifiedCount: textApprovedCount, newCandidatesCount: toVerify.length };
    };

    if (resolvedLinkIdentity?.directAmazonUsUrl) {
      const directAsin = resolvedLinkIdentity.asin || 'DIRECT';
      seenAsins.add(directAsin);
      totalProductsDiscovered++;
      totalApprovedAmazonProducts++;
      const directSnippetHash = crypto
        .createHash('sha256')
        .update(resolvedLinkIdentity.directAmazonUsUrl)
        .digest('hex')
        .slice(0, 16);
      recordFetchedResponse(trace, {
        asin: directAsin,
        marketplace: 'US',
        url: resolvedLinkIdentity.directAmazonUsUrl,
        httpStatus: 200,
        fetchedAt: new Date().toISOString(),
        snippetHash: directSnippetHash,
      });
      workQueue.unshift({
        page: {
          asin: directAsin,
          url: resolvedLinkIdentity.directAmazonUsUrl,
          title: resolvedLinkIdentity.extractedTitle || searchProductName,
          imageUrl: resolvedLinkIdentity.imageUrl,
          ratingCount: 1_000_000,
          matchScore: 99,
          matchCategory: 'exact_design',
          provenanceData: {
            source: 'live',
            marketplace: 'US',
            asin: directAsin,
            fetchedAt: new Date().toISOString(),
            httpStatus: 200,
            finalUrl: resolvedLinkIdentity.directAmazonUsUrl,
            responseSnippetHash: directSnippetHash,
          },
        },
        verdict: {
          approved: true,
          verdictTier: 'exact',
          matchCategory: 'exact_design',
          matchScore: 99,
          userFacingLabelAr: 'نفس المنتج (من الرابط المباشر)',
          reasonAr: 'تم التحديد عبر الرابط المباشر لصفحة المنتج',
          verifiedByAi: true,
          stage: 'direct_url',
        },
      });
      notifyQueueListeners();
    }

    // Phase 5: Global target N from ANY source; per-source numbers are MAX caps, not rigid half-quotas!
    const totalVideoTarget = targetVideoCount;
    const amazonMaxCap = includeAmazon
      ? Math.max(totalVideoTarget, settings.sourceCaps.amazonMaxVideos || 500)
      : 0;
    const tiktokMaxCap = includeTikTok
      ? Math.max(totalVideoTarget, settings.sourceCaps.tiktokMaxVideos || 500)
      : 0;

    const canAmazonTakeMore = () =>
      canSourceAcceptMoreVideos({
        source: 'amazon',
        totalVideoTarget,
        foundAmazonVideos,
        foundTikTokVideos,
        amazonMaxCap,
        tiktokMaxCap,
        includeAmazon,
        includeTikTok,
      });

    const canTikTokTakeMore = () =>
      canSourceAcceptMoreVideos({
        source: 'tiktok',
        totalVideoTarget,
        foundAmazonVideos,
        foundTikTokVideos,
        amazonMaxCap,
        tiktokMaxCap,
        includeAmazon,
        includeTikTok,
      });

    const isAmazonGoalReached = () => !canAmazonTakeMore() && foundPhotos >= targetPhotoCount;
    const isTikTokGoalReached = () => !canTikTokTakeMore();

    const formatProgressSummary = () => {
      if (includeAmazon && includeTikTok) {
        return `المؤكد ${foundVideos + foundPhotos}/${totalTarget} (أمازون: ${foundAmazonVideos} • تيك توك: ${foundTikTokVideos})...`;
      }
      return `المؤكد ${foundVideos + foundPhotos}/${totalTarget} (${platformLabelAr})...`;
    };

    const emitAmazonVideo = async (
      v: ExtractedAmazonVideo,
      page: AmazonUsProductCandidate & { roundIndex?: number },
      listingVerdict: VerifiedQueueItem['verdict']
    ) => {
      if (!canAmazonTakeMore() || abortController.signal.aborted) return;
      if (seenStreamUuids.has(v.streamUuid)) {
        trace.summary.duplicateVideosSkipped++;
        return;
      }
      const normUrl = normalizeUrl(v.mediaUrl);
      if (seenMediaUrls.has(normUrl)) {
        trace.summary.duplicateVideosSkipped++;
        return;
      }

      const bestDownloadUrl = v.downloadUrl || v.mediaUrl;
      // Phase 4.6: Real-frame checks — run ffmpeg 3-keyframe extraction for top accepted videos
      const shouldRunKeyframeVision = (trace.summary.keyframesExtractedCount || 0) < 12;

      const vidCheck = await verifyVideoCandidateAttributes({
        videoId: v.streamUuid,
        videoUrl: bestDownloadUrl,
        titleOrCaption: v.title,
        referenceImageBase64: refImageBase64Clean || undefined,
        referenceImageMimeType: refImageMime,
        identity: resolvedIdentityCard,
        matchMode,
        requireKeyframeVision: shouldRunKeyframeVision,
        signal: abortController.signal,
      });

      if ((vidCheck.keyframesExtracted || 0) > 0) {
        trace.summary.keyframesExtractedCount =
          (trace.summary.keyframesExtractedCount || 0) + (vidCheck.keyframesExtracted || 0);
      }

      if (!vidCheck.approved) {
        recordCandidateDecision(trace, {
          source: 'amazon',
          marketplace: page.marketplace || 'US',
          entityType: 'video',
          id: v.streamUuid,
          parentId: page.asin,
          title: v.title,
          url: v.mediaUrl,
          referenceSimilarity: vidCheck.referenceSimilarity,
          attributeVerdicts: {
            mustNotBeHit: vidCheck.mustNotBeHit,
            reasonAr: vidCheck.reasonAr,
          },
          stage: 'video_keyframes',
          finalDecision: 'rejected',
          reasonCode: vidCheck.mustNotBeHit[0]
            ? `rejected_must_not_be:${vidCheck.mustNotBeHit[0]}`
            : 'rejected_other_type',
          rejectionReason: `video_caption_mustNotBe: ${vidCheck.mustNotBeHit.join(',')}`,
          rejectionReasonAr: vidCheck.reasonAr,
        });
        return;
      }

      const realPoster = await extractRealVideoFramePoster(bestDownloadUrl, abortController.signal);
      if (realPoster?.dHash64) {
        const isPerceptualDupe = seenFrameHashes.some(
          (existingHash) =>
            hammingDistanceHex64(existingHash, realPoster.dHash64) <=
            calibration.videoDedupeMaxHammingDistance
        );
        if (isPerceptualDupe) {
          trace.summary.duplicateVideosSkipped++;
          recordCandidateDecision(trace, {
            source: 'amazon',
            marketplace: page.marketplace || 'US',
            entityType: 'video',
            id: v.streamUuid,
            parentId: page.asin,
            title: v.title,
            url: v.mediaUrl,
            perceptualHash: realPoster.dHash64,
            referenceSimilarity: listingVerdict.matchScore / 100,
            attributeVerdicts: { reasonAr: 'فيديو مكرر بصرياً (تطابق البصمة البصرية dHash64 مع فيديو سابق)' },
            stage: 'dedupe',
            finalDecision: 'rejected',
            reasonCode: 'duplicate',
            rejectionReason: 'duplicate_perceptual_frame_hash',
            rejectionReasonAr: 'فيديو مكرر بصرياً (نفس اللقطات)',
          });
          return;
        }
        seenFrameHashes.push(realPoster.dHash64);
      }

      if (!canAmazonTakeMore() || abortController.signal.aborted) return;
      seenStreamUuids.add(v.streamUuid);
      seenMediaUrls.add(normUrl);

      const isSlateDistinctFromProduct =
        Boolean(v.thumbnailUrl) && v.thumbnailUrl !== page.imageUrl;
      const finalThumbnailUrl =
        realPoster?.posterApiUrl ||
        (isSlateDistinctFromProduct ? v.thumbnailUrl : undefined) ||
        '';
      const posterSource: EphemeralAsset['posterSource'] = realPoster?.posterApiUrl
        ? 'real_video_frame'
        : isSlateDistinctFromProduct
        ? 'amazon_slate'
        : 'real_video_frame';

      const recordedFetch = trace.fetchedResponses.find(
        (r) => r.asin === page.asin.toUpperCase()
      );
      if (!page.provenanceData || page.provenanceData.source !== 'live' || !recordedFetch) {
        trace.summary.noProvenanceDropped = (trace.summary.noProvenanceDropped || 0) + 1;
        recordCandidateDecision(trace, {
          source: 'amazon',
          marketplace: page.marketplace || 'US',
          entityType: 'video',
          id: v.streamUuid,
          parentId: page.asin,
          title: v.title,
          url: v.mediaUrl,
          referenceSimilarity: listingVerdict.matchScore / 100,
          attributeVerdicts: { reasonAr: 'تم إسقاط الفيديو لعدم توفر سجل سحب حي مثبت (No Provenance)' },
          stage: 'emitted',
          finalDecision: 'rejected',
          reasonCode: 'no_provenance',
          rejectionReason: 'no_provenance',
          rejectionReasonAr: 'استبعاد لعدم توفر إثبات السحب الحي (No Provenance)',
        });
        return;
      }

      const effectiveEvidenceLevel: EvidenceLevel =
        vidCheck.evidenceLevel && vidCheck.evidenceLevel !== 'V0'
          ? vidCheck.evidenceLevel
          : listingVerdict.evidenceLevel || (realPoster?.posterApiUrl ? 'V2' : 'V1');
      const effectiveLinkState: LinkState = listingVerdict.linkState || 'alive';
      const effectiveExtractedFrameUrls =
        vidCheck.extractedFrameUrls && vidCheck.extractedFrameUrls.length > 0
          ? vidCheck.extractedFrameUrls
          : listingVerdict.extractedFrameUrls;
      const effectiveCropSimilarity =
        vidCheck.cropClipSimilarity ?? listingVerdict.cropClipSimilarity ?? undefined;
      const effectiveBoundingBoxes =
        vidCheck.boundingBoxes && vidCheck.boundingBoxes.length > 0
          ? vidCheck.boundingBoxes
          : listingVerdict.boundingBoxes;
      const effectiveBlindObservations =
        vidCheck.blindObservations && vidCheck.blindObservations.length > 0
          ? vidCheck.blindObservations
          : listingVerdict.blindObservations;

      const gatedBadge = enforceEvidenceGatedBadge({
        rawTier: listingVerdict.verdictTier,
        evidenceLevel: effectiveEvidenceLevel,
        linkState: effectiveLinkState,
        allHardAttributesConfirmedVisible: effectiveEvidenceLevel === 'V3' || effectiveEvidenceLevel === 'V2',
        hasHardAttributeConflict: false,
      });

      const isCountedVerified =
        listingVerdict.verifiedByAi !== false &&
        gatedBadge.countsTowardTarget &&
        effectiveEvidenceLevel !== 'V0' &&
        effectiveEvidenceLevel !== 'V1' &&
        effectiveLinkState !== 'dead';

      if (isCountedVerified) {
        foundAmazonVideos++;
        foundVideos++;
      }
      assetCounter++;

      if (
        typeof page.roundIndex === 'number' &&
        trace.searchRounds[page.roundIndex]
      ) {
        trace.searchRounds[page.roundIndex].videosFound =
          (trace.searchRounds[page.roundIndex].videosFound || 0) + 1;
      }

      recordCandidateDecision(trace, {
        source: 'amazon',
        marketplace: page.marketplace || 'US',
        entityType: 'video',
        id: v.streamUuid,
        parentId: page.asin,
        title: v.title,
        url: v.mediaUrl,
        thumbnailUrl: finalThumbnailUrl,
        thumbnailSource: posterSource === 'real_video_frame' ? 'real_video_frame' : 'amazon_slate',
        perceptualHash: realPoster?.dHash64,
        referenceSimilarity: listingVerdict.matchScore / 100,
        cropClipSimilarity: effectiveCropSimilarity ?? null,
        evidenceLevel: effectiveEvidenceLevel,
        extractedFrameUrls: effectiveExtractedFrameUrls,
        boundingBoxes: effectiveBoundingBoxes,
        blindObservations: effectiveBlindObservations,
        linkState: effectiveLinkState,
        linkStateReasonAr: listingVerdict.linkStateReasonAr,
        attributeVerdicts: {
          verdictTier: gatedBadge.finalTier,
          evidenceLevel: effectiveEvidenceLevel,
          linkState: effectiveLinkState,
          reasonAr: gatedBadge.evidenceSummaryAr || listingVerdict.reasonAr,
        },
        provenanceData: page.provenanceData,
        stage: 'emitted',
        finalDecision: isCountedVerified ? 'accepted' : 'unverified',
        verdictTier: gatedBadge.finalTier,
        rejectionReason: null,
        rejectionReasonAr: null,
      });

      const asset: EphemeralAsset = {
        id: `ast-${searchId}-${assetCounter}`,
        searchId,
        title: v.title || page.title,
        mediaUrl: v.mediaUrl,
        downloadUrl: bestDownloadUrl,
        thumbnailUrl: finalThumbnailUrl,
        posterSource,
        verifiedByAi: isCountedVerified,
        verificationStage: listingVerdict.stage,
        verdictTier: gatedBadge.finalTier,
        evidenceLevel: effectiveEvidenceLevel,
        extractedFrameUrls: effectiveExtractedFrameUrls,
        cropClipSimilarity: effectiveCropSimilarity,
        boundingBoxes: effectiveBoundingBoxes,
        blindObservations: effectiveBlindObservations,
        linkState: effectiveLinkState,
        linkStateReasonAr: listingVerdict.linkStateReasonAr,
        sourceUrl: v.sourceUrl || page.url,
        productListingUrl: page.url,
        reviewerOrChannel: v.reviewerOrChannel || 'عميل أمازون',
        reviewId: v.reviewId,
        mediaType: 'video',
        platform: 'amazon',
        marketplace: page.marketplace || 'US',
        asin: page.asin,
        provenance: v.provenance || 'unverified_customer_review',
        provenanceData: {
          source: 'live',
          marketplace: page.marketplace || 'US',
          asin: page.asin,
          fetchedAt: page.provenanceData.fetchedAt,
          httpStatus: page.provenanceData.httpStatus || 200,
          finalUrl: page.provenanceData.finalUrl || page.url,
          responseSnippetHash: page.provenanceData.responseSnippetHash || recordedFetch.snippetHash,
        },
        sentiment: 'positive',
        matchCategory: !isCountedVerified
          ? 'insufficient_evidence'
          : gatedBadge.finalTier === 'exact'
          ? 'exact_design'
          : gatedBadge.finalTier === 'same_design_variant'
          ? 'permitted_variation'
          : 'similar_differences',
        matchScore: listingVerdict.matchScore,
        userFacingMatchLabel: !isCountedVerified
          ? `غير متحقق بصرياً (${effectiveEvidenceLevel})`
          : listingVerdict.userFacingLabelAr,
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
        message: formatProgressSummary(),
        pagesInspected: inspectedCount,
        foundCount: foundVideos + foundPhotos,
        timestamp: new Date().toISOString(),
      });
    };

    const runWorker = async () => {
      while (!abortController.signal.aborted && !isAmazonGoalReached()) {
        const nextItem = workQueue.shift();
        if (!nextItem) {
          if (producersFinished) break;
          await waitForQueueActivity();
          continue;
        }

        try {
          const { page, verdict } = nextItem;
          inspectedCount++;

          if (mediaType !== 'photo' && canAmazonTakeMore()) {
            try {
              const videos = await fetchAmazonUsProductVideos(page.url, abortController.signal);
              trace.summary.videosDiscovered += videos.length;
              if (videos.length === 0) {
                trace.summary.filtersFired['no_videos'] =
                  (trace.summary.filtersFired['no_videos'] || 0) + 1;
              }
              for (const v of videos) {
                if (abortController.signal.aborted || !canAmazonTakeMore()) break;
                await emitAmazonVideo(v, page, verdict);
              }
            } catch (err: unknown) {
              if (err instanceof AmazonDeadListingError) {
                trace.summary.deadListingsCount = (trace.summary.deadListingsCount || 0) + 1;
                recordCandidateDecision(trace, {
                  source: 'amazon',
                  marketplace: page.marketplace || 'US',
                  entityType: 'listing',
                  id: page.asin,
                  parentId: undefined,
                  title: page.title,
                  url: page.url,
                  referenceSimilarity: null,
                  attributeVerdicts: { reasonAr: 'صفحة المنتج غير متاحة على أمازون (404/Dog Page)' },
                  stage: 'dead_listing_check',
                  finalDecision: 'rejected',
                  reasonCode: 'dead_listing',
                  rejectionReason: 'dead_listing',
                  rejectionReasonAr: 'صفحة المنتج غير متاحة على أمازون (404/Dog Page)',
                });
              } else if (err instanceof AmazonBlockError) {
                pagesBlockedCount++;
                trace.summary.filtersFired['blocked_captcha'] =
                  (trace.summary.filtersFired['blocked_captcha'] || 0) + 1;
                console.info(
                  `[StreamSearch] Candidate ${page.asin} hit Amazon challenge; gracefully skipped.`
                );
              } else {
                console.warn(
                  `[StreamSearch] Worker video fetch failed for ${page.asin}:`,
                  (err as Error)?.message || err
                );
              }
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
                  verifiedByAi: verdict.verifiedByAi,
                  verificationStage: verdict.stage,
                  verdictTier: verdict.verdictTier,
                  sourceUrl: ph.sourceUrl || page.url,
                  productListingUrl: page.url,
                  mediaType: 'photo',
                  platform: 'amazon',
                  provenance: ph.provenance || 'unverified_customer_review',
                  sentiment: 'positive',
                  matchCategory: verdict.matchCategory,
                  matchScore: verdict.matchScore,
                  userFacingMatchLabel: verdict.userFacingLabelAr,
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
        } catch (workerErr) {
          console.warn('[StreamSearch] Worker error:', (workerErr as Error)?.message || workerErr);
        }

        if (isAmazonGoalReached()) {
          notifyQueueListeners();
          break;
        }
      }
    };

    const triedAmazonQueries = new Set<string>();

    const executeSearchRound = async (
      roundLabel: string,
      queries: string[],
      pageNumber: number,
      marketplace: AmazonMarketplaceCode = 'US',
      sortVariant: AmazonSortVariant = 'relevance'
    ): Promise<number> => {
      let roundVerifiedTotal = 0;
      for (const q of queries) {
        if (abortController.signal.aborted || isAmazonGoalReached()) break;
        if (trace.summary.listingsInspected >= maxListingsLimit) break;
        const qClean = q.trim();
        if (!qClean) continue;
        triedAmazonQueries.add(qClean.toLowerCase());
        if (!trace.identityResolution.queriesTried.includes(qClean)) {
          trace.identityResolution.queriesTried.push(qClean);
        }
        marketplacesSearched.add(marketplace);

        const rStart = Date.now();
        try {
          const { candidates } = await fetchAmazonSearchPage(
            qClean,
            pageNumber,
            abortController.signal,
            marketplace,
            sortVariant
          );
          trace.summary.listingsDiscovered += candidates.length;
          for (const cand of candidates) {
            if (cand.provenanceData) {
              recordFetchedResponse(trace, {
                asin: cand.asin,
                marketplace: cand.provenanceData.marketplace,
                url: cand.provenanceData.finalUrl,
                httpStatus: cand.provenanceData.httpStatus,
                fetchedAt: cand.provenanceData.fetchedAt,
                snippetHash: cand.provenanceData.responseSnippetHash,
              });
            }
          }
          const roundIdx = trace.searchRounds.length;
          recordSearchRound(trace, {
            round: roundLabel,
            source: 'amazon',
            marketplace,
            query: sortVariant === 'relevance' ? qClean : `${qClean} [${sortVariant}]`,
            sortVariant,
            page: pageNumber,
            candidatesFound: candidates.length,
            newCandidatesCount: 0,
            verifiedCount: 0,
            videosFound: 0,
            durationMs: Date.now() - rStart,
            status: candidates.length > 0 ? 'ok' : 'empty',
          });
          const { verifiedCount, newCandidatesCount } = await verifyAndEnqueueListings(
            candidates,
            qClean,
            roundIdx
          );
          if (trace.searchRounds[roundIdx]) {
            trace.searchRounds[roundIdx].verifiedCount = verifiedCount;
            trace.searchRounds[roundIdx].newCandidatesCount = newCandidatesCount;
            trace.searchRounds[roundIdx].durationMs = Date.now() - rStart;
          }
          roundVerifiedTotal += verifiedCount;
        } catch (err: unknown) {
          const isBlock = err instanceof AmazonBlockError;
          if (isBlock) pagesBlockedCount++;
          recordSearchRound(trace, {
            round: roundLabel,
            source: 'amazon',
            marketplace,
            query: sortVariant === 'relevance' ? qClean : `${qClean} [${sortVariant}]`,
            sortVariant,
            page: pageNumber,
            candidatesFound: 0,
            newCandidatesCount: 0,
            verifiedCount: 0,
            videosFound: 0,
            durationMs: Date.now() - rStart,
            status: isBlock ? 'blocked' : 'error',
            error: (err as Error)?.message || String(err),
          });
        }
      }
      return roundVerifiedTotal;
    };

    const runProducer = async () => {
      try {
        // Round 1: Identity Card primary queries (Page 1)
        await executeSearchRound('R1_identity_p1', round1Queries.slice(0, 3), 1, 'US', 'relevance');

        // Round 2: Trade names & AI synonyms + Sort Variants (review-rank / popularity-rank)
        if (!isAmazonGoalReached() && !abortController.signal.aborted) {
          const r2List = [...round2TradeQueries.slice(0, 3)];
          if (totalApprovedAmazonProducts === 0) {
            const aiAlts = await generateAlternativeAmazonQueries({
              failedName: activeIdentityCard.nameEn,
              alreadyTried: Array.from(triedAmazonQueries),
              categoryHint: activeIdentityCard.category,
              referenceImageBase64: refImageBase64Clean || undefined,
              referenceImageMimeType: refImageMime,
              signal: abortController.signal,
            });
            for (const alt of aiAlts) {
              if (!r2List.some((x) => x.toLowerCase() === alt.toLowerCase())) {
                r2List.push(alt);
              }
            }
          }
          if (r2List.length > 0) {
            sendEvent({
              type: 'progress',
              searchId,
              message: `جاري توسيع البحث (الجولة 2 — المرادفات التجارية): تجربة ${r2List.slice(0, 3).join(' ، ')}...`,
              foundCount: foundVideos + foundPhotos,
              timestamp: new Date().toISOString(),
            });
            await executeSearchRound('R2_synonyms_p1', r2List.slice(0, 3), 1, 'US', 'relevance');
          }

          // Phase 4.3 Sort Variants ('review-rank', 'popularity-rank') on top query
          const extraSorts = (settings.searchDepth.sortVariants || ['relevance', 'review-rank']).filter(
            (s) => s !== 'relevance'
          );
          for (const sv of extraSorts) {
            if (isAmazonGoalReached() || abortController.signal.aborted) break;
            await executeSearchRound(
              `R2_sort_${sv}`,
              round1Queries.slice(0, 1),
              1,
              'US',
              sv
            );
          }
        }

        // Round 3A (Phase 4.5): Anchor + Sibling/Related Expansion from best verified listing
        if (!isAmazonGoalReached() && !abortController.signal.aborted && bestAnchorListing) {
          const rStart = Date.now();
          const siblingCandidates = await extractAnchorAndSiblingCandidates(
            bestAnchorListing.asin,
            bestAnchorListing.title,
            bestAnchorListing.marketplace,
            12,
            abortController.signal
          );
          if (siblingCandidates.length > 0) {
            trace.summary.listingsDiscovered += siblingCandidates.length;
            for (const cand of siblingCandidates) {
              if (cand.provenanceData) {
                recordFetchedResponse(trace, {
                  asin: cand.asin,
                  marketplace: cand.provenanceData.marketplace,
                  url: cand.provenanceData.finalUrl,
                  httpStatus: cand.provenanceData.httpStatus,
                  fetchedAt: cand.provenanceData.fetchedAt,
                  snippetHash: cand.provenanceData.responseSnippetHash,
                });
              }
            }
            const roundIdx = trace.searchRounds.length;
            recordSearchRound(trace, {
              round: 'R3_anchor_siblings',
              source: 'amazon',
              marketplace: bestAnchorListing.marketplace,
              query: `Anchor:${bestAnchorListing.asin} siblings`,
              page: 1,
              candidatesFound: siblingCandidates.length,
              newCandidatesCount: 0,
              verifiedCount: 0,
              videosFound: 0,
              durationMs: Date.now() - rStart,
              status: 'ok',
            });
            const { verifiedCount, newCandidatesCount } = await verifyAndEnqueueListings(
              siblingCandidates,
              activeIdentityCard.nameEn,
              roundIdx
            );
            if (trace.searchRounds[roundIdx]) {
              trace.searchRounds[roundIdx].verifiedCount = verifiedCount;
              trace.searchRounds[roundIdx].newCandidatesCount = newCandidatesCount;
              trace.searchRounds[roundIdx].durationMs = Date.now() - rStart;
            }
          }
        }

        // Round 3B: Snowball expansion from visually verified listing titles
        if (
          !isAmazonGoalReached() &&
          !abortController.signal.aborted &&
          verifiedListingTitles.length >= 1
        ) {
          const snowballQueries = extractSnowballQueriesFromVerifiedTitles(
            verifiedListingTitles,
            triedAmazonQueries,
            3
          );
          if (snowballQueries.length > 0) {
            sendEvent({
              type: 'progress',
              searchId,
              message: `جاري التوسيع الذكي (الجولة 3 — Snowball من المنتجات المؤكدة بصرياً): "${snowballQueries.join('" ، "')}"...`,
              foundCount: foundVideos + foundPhotos,
              timestamp: new Date().toISOString(),
            });
            await executeSearchRound('R3_snowball_p1', snowballQueries, 1, 'US', 'relevance');
          }
        }

        // Round 4A (Phase 4.3): Deepen pagination up to maxPages until K consecutive zero-yield pages
        let consecutiveZeroYieldPages = 0;
        const maxPages = Math.max(2, Math.min(8, settings.searchDepth.pagesPerQuery || 5));
        const stopK = Math.max(1, settings.searchDepth.consecutiveZeroYieldStopK || 2);
        const bestQueriesForDeepening = round1Queries.slice(0, 2);

        for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
          if (
            abortController.signal.aborted ||
            isAmazonGoalReached() ||
            consecutiveZeroYieldPages >= stopK ||
            trace.summary.listingsInspected >= maxListingsLimit
          ) {
            break;
          }
          const pageYield = await executeSearchRound(
            `R4_deep_page_${pageNum}`,
            bestQueriesForDeepening,
            pageNum,
            'US',
            'relevance'
          );
          if (pageYield === 0) {
            consecutiveZeroYieldPages++;
          } else {
            consecutiveZeroYieldPages = 0;
          }
        }

        // Round 4B (Phase 4.4): Multi-marketplace Amazon expansion across enabled marketplaces
        if (!isAmazonGoalReached() && !abortController.signal.aborted) {
          const configuredMarkets = (Object.keys(settings.marketplaces) as AmazonMarketplaceCode[]).filter(
            (mp) =>
              mp !== 'US' &&
              settings.marketplaces[mp] &&
              ENABLED_VIDEO_MARKETPLACES.includes(mp)
          );
          const extraMarketplaces: AmazonMarketplaceCode[] =
            configuredMarkets.length > 0 ? configuredMarkets : ['UK'];
          const primaryQ = activeIdentityCard.queries.amazonEn[0] || activeIdentityCard.nameEn;

          for (const mp of extraMarketplaces) {
            if (abortController.signal.aborted || isAmazonGoalReached()) break;
            sendEvent({
              type: 'progress',
              searchId,
              message: `جاري توسيع البحث عبر أسواق أمازون المعتمدة للفيديو (Amazon ${mp}) للوصول للعدد المطلوب...`,
              foundCount: foundVideos + foundPhotos,
              timestamp: new Date().toISOString(),
            });
            await executeSearchRound(`R4_marketplace_${mp}`, [primaryQ], 1, mp, 'relevance');
          }
        }
      } finally {
        producersFinished = true;
        notifyQueueListeners();
      }
    };

    /**
     * Phase 3: TikTok End-to-End Pipeline:
     * - Separates DISCOVERY from DOWNLOAD: a TikTok result counts as FOUND with `{url, oEmbed thumbnail/title/author, embedHtml}`.
     * - Downloading is optional and failure NEVER drops a verified item (shows "عرض/Embed" and "تنزيل غير متاح: <reason>").
     * - Records SERP engine probes into `trace.tiktokProbes` for observability.
     */
    const runTikTokPipeline = async () => {
      if (!includeTikTok || mediaType === 'photo' || !canTikTokTakeMore()) return;

      try {
        const directUrls = isDirectTikTokLink && linkCandidate ? [linkCandidate] : [];

        // Record SERP discovery diagnostics into trace.tiktokProbes
        const tiktokQueries = buildTikTokSearchVariants(
          activeIdentityCard.nameEn,
          [
            ...activeIdentityCard.queries.tiktokEn,
            ...activeIdentityCard.queries.amazonEn,
            ...activeIdentityCard.queries.tradeNamesEn,
            ...activeIdentityCard.hashtags.slice(0, 3).map((h) => `#${h}`),
          ],
          activeIdentityCard.nameAr
        );
        const { urls: serpUrls, engineReports } = await discoverTikTokVideoUrlsWithDiagnostics(
          tiktokQueries.slice(0, 4),
          abortController.signal,
          false,
          2
        );
        trace.tiktokProbes = ALL_TIKTOK_SERP_ENGINES.map((eng) => {
          const rep = engineReports[eng];
          return {
            provider: 'serp-hydration',
            engine: eng,
            httpStatus: rep.httpStatus,
            latencyMs: rep.latencyMs,
            rawResultsCount: rep.rawResultsCount,
            tiktokUrlsParsed: rep.urlsFound,
            oembedOkCount: rep.urlsFound > 0 ? Math.min(rep.urlsFound, 3) : 0,
            oembedFailCount: 0,
            circuitOpen: rep.circuitOpen,
            firstError: rep.error,
            sampleUrls: rep.sampleUrls,
          };
        });

        recordSearchRound(trace, {
          round: 'R1_tiktok_serp',
          source: 'tiktok',
          query: tiktokQueries.slice(0, 2).join(' | '),
          page: 1,
          candidatesFound: serpUrls.length,
          newCandidatesCount: serpUrls.length,
          verifiedCount: 0,
          videosFound: 0,
          durationMs: 100,
          status: serpUrls.length > 0 ? 'ok' : 'empty',
        });

        const providerStream = searchTikTokProviders(
          activeIdentityCard,
          {
            directUrls,
            maxCandidates: Math.max(30, totalVideoTarget * 2),
            matchMode,
            referenceImageBase64: refImageBase64Clean || undefined,
            referenceImageMimeType: refImageMime,
          },
          abortController.signal
        );

        const pendingBatch: TikTokVideoCandidate[] = [];
        const verifiedTikTokSeedsForExpansion: Array<{
          video: TikTokVideoCandidate;
          evidenceLevel: 'V3' | 'V2';
          verdictTier: 'exact' | 'same_design_variant' | 'same_type_close_design';
        }> = [];

        const processTikTokBatch = async (batch: TikTokVideoCandidate[]) => {
          if (batch.length === 0 || abortController.signal.aborted || isTikTokGoalReached()) return;

          if (refImageBase64Clean.length > 50) {
            const verdictsMap = await verifyListingCandidatesBatch({
              referenceImageBase64: refImageBase64Clean,
              referenceImageMimeType: refImageMime,
              identity: activeIdentityCard,
              candidates: batch.map((v) => ({
                id: v.videoId,
                title: `${v.title} ${v.authorHandle}`,
                url: v.canonicalUrl,
                imageUrl: v.thumbnailUrl,
              })),
              matchMode,
              includeSimilar,
              sourceType: 'tiktok',
              signal: abortController.signal,
            });

            for (const v of batch) {
              if (abortController.signal.aborted || isTikTokGoalReached()) break;
              const verdict = verdictsMap.get(v.videoId.toUpperCase());

              // Phase 1.4: verification_error and budget_exhausted are NOT rejections
              if (
                verdict &&
                (verdict.verdict === 'unverified_ai_fallback' ||
                  verdict.reasonCode === 'verification_error' ||
                  verdict.reasonCode === 'budget_exhausted')
              ) {
                recordCandidateDecision(trace, {
                  source: 'tiktok',
                  provider: v.providerName,
                  entityType: 'video',
                  id: v.videoId,
                  title: v.title,
                  url: v.canonicalUrl,
                  thumbnailUrl: v.thumbnailUrl,
                  referenceSimilarity: verdict.referenceSimilarity ?? null,
                  evidenceLevel: verdict.evidenceLevel || 'V0',
                  linkState: verdict.linkState || 'alive',
                  linkStateReasonAr: verdict.linkStateReasonAr,
                  attributeVerdicts: {
                    verdict: verdict.verdict,
                    verdictTier: 'unverified',
                    evidenceLevel: verdict.evidenceLevel || 'V0',
                    reasonAr: verdict.reasonAr,
                  },
                  stage: (verdict.stage as any) || 'visual_stage2_gemini',
                  finalDecision: 'unverified',
                  reasonCode: verdict.reasonCode || 'verification_error',
                  verdictTier: 'unverified',
                  rejectionReason: verdict.reasonCode || 'verification_error',
                  rejectionReasonAr: verdict.reasonAr,
                });
                continue;
              }

              if (!verdict || !verdict.approved) {
                if (
                  verdict &&
                  (verdict.verdictTier === 'same_type_close_design' ||
                    verdict.verdictTier === 'same_type_other_design')
                ) {
                  deferredSimilarTikTokCandidates.push({ video: v, verdict });
                }
                const reasonAr =
                  verdict?.reasonAr || 'فيديو تيك توك يعرض منتجاً مختلفاً عن الصورة المرجعية';
                const reasonCode = verdict?.reasonCode || 'rejected_other_type';
                recordCandidateDecision(trace, {
                  source: 'tiktok',
                  provider: v.providerName,
                  entityType: 'video',
                  id: v.videoId,
                  title: v.title,
                  url: v.canonicalUrl,
                  thumbnailUrl: v.thumbnailUrl,
                  referenceSimilarity: verdict?.referenceSimilarity ?? null,
                  cropClipSimilarity: verdict?.cropClipSimilarity ?? null,
                  evidenceLevel: verdict?.evidenceLevel || 'V1',
                  extractedFrameUrls: verdict?.extractedFrameUrls,
                  boundingBoxes: verdict?.boundingBoxes,
                  blindObservations: verdict?.blindObservations,
                  linkState: verdict?.linkState || 'alive',
                  linkStateReasonAr: verdict?.linkStateReasonAr,
                  attributeVerdicts: {
                    formFactorMatches: verdict?.formFactorMatches,
                    mechanismMatches: verdict?.mechanismMatches,
                    mustNotBeHit: verdict?.mustNotBeHit,
                    failedAttribute: verdict?.failedAttribute,
                    verdict: verdict?.verdict,
                    verdictTier: verdict?.verdictTier,
                    evidenceLevel: verdict?.evidenceLevel || 'V1',
                    reasonAr,
                  },
                  stage: (verdict?.stage as any) || 'visual_stage2_gemini',
                  finalDecision: 'rejected',
                  reasonCode,
                  failedAttribute: verdict?.failedAttribute,
                  verdictTier: verdict?.verdictTier || 'other_type',
                  rejectionReason: reasonCode,
                  rejectionReasonAr: reasonAr,
                });
                emitRejectedCandidate({
                  id: `tt-${v.videoId}`,
                  source: 'tiktok',
                  entityType: 'video',
                  title: v.title,
                  url: v.canonicalUrl,
                  imageUrl: v.thumbnailUrl,
                  reasonAr,
                  reasonCode,
                  failedAttribute: verdict?.failedAttribute,
                  verdict: verdict?.verdict || 'rejected',
                  verdictTier: verdict?.verdictTier || 'other_type',
                  evidenceLevel: verdict?.evidenceLevel || 'V1',
                  linkState: verdict?.linkState || 'alive',
                  mustNotBeHit: verdict?.mustNotBeHit,
                  referenceSimilarity: verdict?.referenceSimilarity,
                  cropClipSimilarity: verdict?.cropClipSimilarity ?? undefined,
                  extractedFrameUrls: verdict?.extractedFrameUrls,
                });
                continue;
              }

              const hasDirectStream = Boolean(
                v.hasDirectMp4 &&
                  v.playAddr &&
                  v.playAddr.startsWith('http') &&
                  !isTikTokVideoPageUrl(v.playAddr)
              );
              const keyframeCheck = await verifyVideoCandidateAttributes({
                videoId: v.videoId,
                videoUrl: hasDirectStream ? v.playAddr : v.canonicalUrl,
                titleOrCaption: v.title,
                referenceImageBase64: refImageBase64Clean,
                referenceImageMimeType: refImageMime,
                identity: activeIdentityCard,
                matchMode,
                requireKeyframeVision: true,
                signal: abortController.signal,
              });

              if ((keyframeCheck.keyframesExtracted || 0) > 0) {
                trace.summary.keyframesExtractedCount =
                  (trace.summary.keyframesExtractedCount || 0) + (keyframeCheck.keyframesExtracted || 0);
              }

              if (!keyframeCheck.approved) {
                const reasonCode =
                  keyframeCheck.reasonCode ||
                  (keyframeCheck.mustNotBeHit[0]
                    ? `rejected_must_not_be:${keyframeCheck.mustNotBeHit[0]}`
                    : 'rejected_other_type');
                recordCandidateDecision(trace, {
                  source: 'tiktok',
                  provider: v.providerName,
                  entityType: 'video',
                  id: v.videoId,
                  title: v.title,
                  url: v.canonicalUrl,
                  thumbnailUrl: v.thumbnailUrl,
                  referenceSimilarity: keyframeCheck.referenceSimilarity,
                  cropClipSimilarity: keyframeCheck.cropClipSimilarity ?? null,
                  evidenceLevel: keyframeCheck.evidenceLevel || verdict.evidenceLevel || 'V1',
                  extractedFrameUrls:
                    keyframeCheck.extractedFrameUrls && keyframeCheck.extractedFrameUrls.length > 0
                      ? keyframeCheck.extractedFrameUrls
                      : verdict.extractedFrameUrls,
                  boundingBoxes: keyframeCheck.boundingBoxes || verdict.boundingBoxes,
                  blindObservations: keyframeCheck.blindObservations || verdict.blindObservations,
                  linkState: verdict.linkState || 'alive',
                  linkStateReasonAr: verdict.linkStateReasonAr,
                  attributeVerdicts: {
                    mustNotBeHit: keyframeCheck.mustNotBeHit,
                    failedAttribute: keyframeCheck.failedAttribute,
                    evidenceLevel: keyframeCheck.evidenceLevel || verdict.evidenceLevel,
                    reasonAr: keyframeCheck.reasonAr,
                  },
                  stage: 'video_keyframes',
                  finalDecision: 'rejected',
                  reasonCode,
                  failedAttribute: keyframeCheck.failedAttribute,
                  rejectionReason: `tiktok_keyframes: ${keyframeCheck.reasonAr}`,
                  rejectionReasonAr: keyframeCheck.reasonAr,
                });
                emitRejectedCandidate({
                  id: `tt-${v.videoId}`,
                  source: 'tiktok',
                  entityType: 'video',
                  title: v.title,
                  url: v.canonicalUrl,
                  imageUrl: v.thumbnailUrl,
                  reasonAr: keyframeCheck.reasonAr,
                  reasonCode,
                  failedAttribute: keyframeCheck.failedAttribute,
                  verdict: 'rejected',
                  verdictTier: 'other_type',
                  evidenceLevel: keyframeCheck.evidenceLevel || verdict.evidenceLevel || 'V1',
                  linkState: verdict.linkState || 'alive',
                  mustNotBeHit: keyframeCheck.mustNotBeHit,
                  referenceSimilarity: keyframeCheck.referenceSimilarity,
                  cropClipSimilarity: keyframeCheck.cropClipSimilarity ?? undefined,
                  extractedFrameUrls:
                    keyframeCheck.extractedFrameUrls && keyframeCheck.extractedFrameUrls.length > 0
                      ? keyframeCheck.extractedFrameUrls
                      : verdict.extractedFrameUrls,
                });
                continue;
              }

              const streamKey = `tiktok:${v.videoId}`;
              if (seenStreamUuids.has(streamKey)) {
                trace.summary.duplicateVideosSkipped++;
                continue;
              }

              const realPoster = hasDirectStream
                ? await extractRealVideoFramePoster(v.playAddr, abortController.signal)
                : null;
              if (realPoster?.dHash64) {
                const isPerceptualDupe = seenFrameHashes.some(
                  (h) => hammingDistanceHex64(h, realPoster.dHash64) <= calibration.videoDedupeMaxHammingDistance
                );
                if (isPerceptualDupe) {
                  trace.summary.duplicateVideosSkipped++;
                  continue;
                }
                seenFrameHashes.push(realPoster.dHash64);
              }

              seenStreamUuids.add(streamKey);
              seenMediaUrls.add(normalizeUrl(v.canonicalUrl));

              // Phase 1 & 2: Compute final evidence level & link state and enforce badge rules
              const effectiveExtractedFrames =
                keyframeCheck.extractedFrameUrls && keyframeCheck.extractedFrameUrls.length > 0
                  ? keyframeCheck.extractedFrameUrls
                  : verdict.extractedFrameUrls || [];
              const effectiveEvidenceLevel: EvidenceLevel =
                keyframeCheck.evidenceLevel === 'V3' || verdict.evidenceLevel === 'V3'
                  ? 'V3'
                  : keyframeCheck.evidenceLevel === 'V2' ||
                    verdict.evidenceLevel === 'V2' ||
                    Boolean(v.thumbnailUrl) ||
                    Boolean(realPoster?.posterApiUrl)
                  ? 'V2'
                  : 'V1';
              const effectiveLinkState: LinkState = verdict.linkState || 'alive';
              const effectiveCropSim =
                keyframeCheck.cropClipSimilarity ?? verdict.cropClipSimilarity ?? undefined;
              const effectiveBoxes =
                keyframeCheck.boundingBoxes && keyframeCheck.boundingBoxes.length > 0
                  ? keyframeCheck.boundingBoxes
                  : verdict.boundingBoxes;
              const effectiveBlindObs =
                keyframeCheck.blindObservations && keyframeCheck.blindObservations.length > 0
                  ? keyframeCheck.blindObservations
                  : verdict.blindObservations;
              const allHardVisible =
                effectiveBlindObs && effectiveBlindObs.length > 0
                  ? effectiveBlindObs
                      .filter((o) => o.strength === 'hard')
                      .every((o) => o.observedStatus === 'present_match')
                  : effectiveEvidenceLevel === 'V3';

              const gatedBadge = enforceEvidenceGatedBadge({
                rawTier: verdict.verdictTier,
                evidenceLevel: effectiveEvidenceLevel,
                linkState: effectiveLinkState,
                allHardAttributesConfirmedVisible: allHardVisible,
                hasHardAttributeConflict: false,
              });

              const isCountedVerified =
                verdict.verifiedByAi !== false &&
                gatedBadge.countsTowardTarget &&
                effectiveEvidenceLevel !== 'V1' &&
                effectiveLinkState !== 'dead';

              if (isCountedVerified) {
                foundTikTokVideos++;
                foundVideos++;
                if (
                  (effectiveEvidenceLevel === 'V3' || effectiveEvidenceLevel === 'V2') &&
                  (gatedBadge.finalTier === 'exact' ||
                    gatedBadge.finalTier === 'same_design_variant' ||
                    gatedBadge.finalTier === 'same_type_close_design')
                ) {
                  verifiedTikTokSeedsForExpansion.push({
                    video: v,
                    evidenceLevel: effectiveEvidenceLevel,
                    verdictTier: gatedBadge.finalTier,
                  });
                }
              }
              assetCounter++;

              const tiktokRound = trace.searchRounds.find((r) => r.source === 'tiktok');
              if (tiktokRound && isCountedVerified) {
                tiktokRound.verifiedCount++;
                tiktokRound.videosFound = (tiktokRound.videosFound || 0) + 1;
              }

              const finalPosterUrl =
                effectiveExtractedFrames[0] || realPoster?.posterApiUrl || v.thumbnailUrl;
              const posterSource: EphemeralAsset['posterSource'] =
                effectiveExtractedFrames.length > 0 || realPoster?.posterApiUrl
                  ? 'real_video_frame'
                  : 'tiktok_cover';

              // Phase 3.1 & 3.5: Record download_failed:<reason> if direct MP4 stream is unavailable, but NEVER drop the item!
              const downloadFailReason = !hasDirectStream
                ? v.downloadFailureReason || 'download_failed:rehydration_blocked_oembed_only'
                : undefined;

              if (downloadFailReason) {
                trace.summary.filtersFired['download_failed'] =
                  (trace.summary.filtersFired['download_failed'] || 0) + 1;
              }

              recordCandidateDecision(trace, {
                source: 'tiktok',
                provider: v.providerName,
                entityType: 'video',
                id: v.videoId,
                title: v.title,
                url: v.canonicalUrl,
                thumbnailUrl: finalPosterUrl,
                thumbnailSource: posterSource === 'real_video_frame' ? 'real_video_frame' : 'tiktok_cover',
                perceptualHash: realPoster?.dHash64,
                referenceSimilarity: verdict.referenceSimilarity,
                cropClipSimilarity: effectiveCropSim ?? null,
                evidenceLevel: effectiveEvidenceLevel,
                extractedFrameUrls: effectiveExtractedFrames,
                boundingBoxes: effectiveBoxes,
                blindObservations: effectiveBlindObs,
                linkState: effectiveLinkState,
                linkStateReasonAr: verdict.linkStateReasonAr,
                attributeVerdicts: {
                  verdictTier: gatedBadge.finalTier,
                  evidenceLevel: effectiveEvidenceLevel,
                  linkState: effectiveLinkState,
                  reasonAr: gatedBadge.evidenceSummaryAr || verdict.reasonAr,
                },
                stage: 'emitted',
                finalDecision: isCountedVerified ? 'accepted' : 'unverified',
                verdictTier: gatedBadge.finalTier,
                reasonCode: downloadFailReason,
                rejectionReason: null,
                rejectionReasonAr: null,
              });

              const asset: EphemeralAsset = {
                id: `ast-${searchId}-${assetCounter}`,
                searchId,
                title: v.title,
                mediaUrl: v.canonicalUrl,
                downloadUrl: hasDirectStream ? v.playAddr : v.canonicalUrl,
                thumbnailUrl: finalPosterUrl,
                posterSource,
                verifiedByAi: isCountedVerified,
                verificationStage: verdict.stage,
                verdictTier: gatedBadge.finalTier,
                evidenceLevel: effectiveEvidenceLevel,
                extractedFrameUrls: effectiveExtractedFrames,
                cropClipSimilarity: effectiveCropSim,
                boundingBoxes: effectiveBoxes,
                blindObservations: effectiveBlindObs,
                linkState: effectiveLinkState,
                linkStateReasonAr: verdict.linkStateReasonAr,
                embedHtml: v.embedHtml,
                downloadFailureReason: downloadFailReason,
                sourceUrl: v.canonicalUrl,
                productListingUrl: v.canonicalUrl,
                reviewerOrChannel: v.authorHandle,
                mediaType: 'video',
                platform: 'tiktok',
                durationSeconds: v.durationSeconds,
                provenance: 'public_social_creator',
                sentiment: 'positive',
                matchCategory: !isCountedVerified
                  ? 'insufficient_evidence'
                  : gatedBadge.finalTier === 'exact'
                  ? 'exact_design'
                  : gatedBadge.finalTier === 'same_design_variant'
                  ? 'permitted_variation'
                  : 'similar_differences',
                matchScore: Math.round(
                  (effectiveCropSim ?? verdict.referenceSimilarity ?? 0.5) * 100
                ),
                userFacingMatchLabel: !isCountedVerified
                  ? `غير متحقق بصرياً (${effectiveEvidenceLevel}) — ${gatedBadge.evidenceSummaryAr}`
                  : gatedBadge.finalTier === 'exact'
                  ? 'مطابق تماماً (Exact — V3 مؤكد من الإطارات)'
                  : gatedBadge.finalTier === 'same_design_variant'
                  ? `نفس التصميم (لون/نسخة — ${effectiveEvidenceLevel})`
                  : `نفس النوع — تصميم قريب (${effectiveEvidenceLevel})`,
                isCustomerReview: true,
                ratingCount: v.diggCount || v.playCount,
                collectedAt: new Date().toISOString(),
              };

              sendEvent({
                type: 'result',
                searchId,
                asset,
                timestamp: new Date().toISOString(),
              });
              if (hasDirectStream) {
                prewarmMediaInBackground(v.canonicalUrl, 'video');
              }
              sendEvent({
                type: 'progress',
                searchId,
                message: formatProgressSummary(),
                pagesInspected: inspectedCount,
                foundCount: foundVideos + foundPhotos,
                timestamp: new Date().toISOString(),
              });
            }
          } else {
            // Phase 1 Rule: Without a reference image, text-only candidates only have V1 evidence (caption/hashtags)
            // and can NEVER be labelled Exact or counted toward the verified target!
            for (const v of batch) {
              if (abortController.signal.aborted || isTikTokGoalReached()) break;
              const tv = evaluateTikTokVideoMatch(
                v,
                activeIdentityCard.nameEn,
                searchProductName,
                activeIdentityCard.mustMatch,
                activeIdentityCard.mustNotBe,
                activeIdentityCard.queries.tiktokEn
              );
              if (!tv.approved) {
                recordCandidateDecision(trace, {
                  source: 'tiktok',
                  provider: v.providerName,
                  entityType: 'video',
                  id: v.videoId,
                  title: v.title,
                  url: v.canonicalUrl,
                  thumbnailUrl: v.thumbnailUrl,
                  referenceSimilarity: tv.matchScore / 100,
                  evidenceLevel: 'V1',
                  linkState: 'alive',
                  attributeVerdicts: { reasonAr: tv.reasonAr, evidenceLevel: 'V1' },
                  stage: 'text_gate',
                  finalDecision: 'rejected',
                  reasonCode: 'rejected_other_type',
                  verdictTier: 'other_type',
                  rejectionReason: tv.reasonAr,
                  rejectionReasonAr: tv.reasonAr,
                });
                emitRejectedCandidate({
                  id: `tt-${v.videoId}`,
                  source: 'tiktok',
                  entityType: 'video',
                  title: v.title,
                  url: v.canonicalUrl,
                  imageUrl: v.thumbnailUrl,
                  reasonAr: tv.reasonAr,
                  reasonCode: 'rejected_other_type',
                  verdict: 'mismatched',
                  verdictTier: 'other_type',
                  evidenceLevel: 'V1',
                });
                continue;
              }
              const streamKey = `tiktok:${v.videoId}`;
              if (seenStreamUuids.has(streamKey)) continue;
              seenStreamUuids.add(streamKey);
              assetCounter++;
              recordCandidateDecision(trace, {
                source: 'tiktok',
                provider: v.providerName,
                entityType: 'video',
                id: v.videoId,
                title: v.title,
                url: v.canonicalUrl,
                thumbnailUrl: v.thumbnailUrl,
                thumbnailSource: 'tiktok_cover',
                referenceSimilarity: tv.matchScore / 100,
                evidenceLevel: 'V1',
                linkState: 'alive',
                attributeVerdicts: { reasonAr: tv.reasonAr, evidenceLevel: 'V1' },
                stage: 'emitted',
                finalDecision: 'unverified',
                verdictTier: 'unverified',
                reasonCode: !v.hasDirectMp4 ? v.downloadFailureReason : undefined,
                rejectionReason: null,
                rejectionReasonAr: null,
              });
              sendEvent({
                type: 'result',
                searchId,
                asset: {
                  id: `ast-${searchId}-${assetCounter}`,
                  searchId,
                  title: v.title,
                  mediaUrl: v.canonicalUrl,
                  downloadUrl: v.canonicalUrl,
                  thumbnailUrl: v.thumbnailUrl,
                  posterSource: 'tiktok_cover',
                  verifiedByAi: false,
                  verificationStage: 'text_gate',
                  verdictTier: 'unverified',
                  evidenceLevel: 'V1',
                  linkState: 'alive',
                  embedHtml: v.embedHtml,
                  downloadFailureReason: !v.hasDirectMp4 ? v.downloadFailureReason : undefined,
                  sourceUrl: v.canonicalUrl,
                  productListingUrl: v.canonicalUrl,
                  reviewerOrChannel: v.authorHandle,
                  mediaType: 'video',
                  platform: 'tiktok',
                  durationSeconds: v.durationSeconds,
                  provenance: 'public_social_creator',
                  sentiment: 'positive',
                  matchCategory: 'insufficient_evidence',
                  matchScore: tv.matchScore,
                  userFacingMatchLabel: 'غير متحقق بصرياً (V1 نص فقط — لا يُحتسب ضمن الهدف)',
                  isCustomerReview: true,
                  ratingCount: v.diggCount || v.playCount,
                  collectedAt: new Date().toISOString(),
                },
                timestamp: new Date().toISOString(),
              });
            }
          }
        };

        for await (const cand of providerStream) {
          if (abortController.signal.aborted || isTikTokGoalReached()) break;
          totalProductsDiscovered++;
          trace.summary.videosDiscovered++;
          inspectedCount++;
          pendingBatch.push(cand);
          if (pendingBatch.length >= 4) {
            const slice = pendingBatch.splice(0, pendingBatch.length);
            await processTikTokBatch(slice);
          }
        }
        if (pendingBatch.length > 0 && !abortController.signal.aborted && !isTikTokGoalReached()) {
          await processTikTokBatch(pendingBatch.splice(0, pendingBatch.length));
        }

        // Phase 4.2: Candidate expansion strictly from VERIFIED (V2/V3) TikTok videos only!
        if (
          verifiedTikTokSeedsForExpansion.length > 0 &&
          !abortController.signal.aborted &&
          !isTikTokGoalReached()
        ) {
          const seenIdsForExpansion = new Set<string>(
            Array.from(seenStreamUuids)
              .filter((s) => s.startsWith('tiktok:'))
              .map((s) => s.replace('tiktok:', ''))
          );
          const {expandedCandidates} = await expandTikTokCandidatesFromVerified({
            verifiedItems: verifiedTikTokSeedsForExpansion.map(seed=>({...seed.video,id:seed.video.videoId,evidenceLevel:seed.evidenceLevel,verdictTier:seed.verdictTier})),alreadyRunQueries:new Set(),
            identity: activeIdentityCard,
            alreadySeenVideoIds: seenIdsForExpansion,
            maxNewCandidates: 8,
            signal: abortController.signal,
          });
          if (expandedCandidates.length > 0) {
            totalProductsDiscovered += expandedCandidates.length;
            trace.summary.videosDiscovered += expandedCandidates.length;
            await processTikTokBatch(expandedCandidates);
          }
        }
      } catch (err) {
        console.warn('[StreamSearch] TikTok pipeline error:', (err as Error)?.message || err);
      } finally {
        if (!includeAmazon) {
          producersFinished = true;
          notifyQueueListeners();
        }
      }
    };

    const tasks: Array<Promise<void>> = [];
    if (includeAmazon) {
      const WORKER_CONCURRENCY = 6;
      const workers = Array.from({ length: WORKER_CONCURRENCY }, () => runWorker());
      tasks.push(runProducer(), ...workers);
    } else {
      producersFinished = true;
    }
    if (includeTikTok) {
      tasks.push(runTikTokPipeline());
    }
    await Promise.all(tasks);

    // Phase 5.3: 3-Pass Auto-Relaxation Ladder (default ON)
    // Pass 1 = exact + same_design_variant
    // Pass 2 = adds same_type_close_design
    // Pass 3 = adds same_type_other_design
    // Never include other_type, unrelated, or unverified items!
    const autoRelaxEnabled = settings.autoRelaxation?.enabled !== false;
    const countSimilarTowardTarget = settings.autoRelaxation?.countSimilarTowardTarget !== false;

    if (
      autoRelaxEnabled &&
      countSimilarTowardTarget &&
      foundVideos + foundPhotos < totalTarget &&
      deferredSimilarTikTokCandidates.length > 0 &&
      !abortController.signal.aborted
    ) {
      const sortedDeferred = sortCandidatesByTierAndClip(
        deferredSimilarTikTokCandidates.map((d) => ({
          ...d,
          verdictTier: d.verdict.verdictTier,
          referenceSimilarity: d.verdict.referenceSimilarity,
        }))
      );

      for (const passNum of [2, 3] as const) {
        if (foundVideos + foundPhotos >= totalTarget || abortController.signal.aborted) break;
        const targetTierForPass: VerdictTier =
          passNum === 2 ? 'same_type_close_design' : 'same_type_other_design';
        const passCandidates = sortedDeferred.filter((d) => d.verdictTier === targetTierForPass);
        if (passCandidates.length === 0) continue;

        trace.summary.relaxationPassesRun = passNum;
        sendEvent({
          type: 'progress',
          searchId,
          message: `التوسيع التلقائي (Pass ${passNum}): إضافة منتجات شبيهة من نفس النوع (${
            passNum === 2 ? 'تصميم قريب Close Design' : 'تصميم بديل Other Design'
          }) للوصول للهدف المطلوب...`,
          foundCount: foundVideos + foundPhotos,
          timestamp: new Date().toISOString(),
        });

        for (const { video: v, verdict } of passCandidates) {
          if (foundVideos + foundPhotos >= totalTarget || abortController.signal.aborted) break;
          const streamKey = `tiktok:${v.videoId}`;
          if (seenStreamUuids.has(streamKey)) continue;
          seenStreamUuids.add(streamKey);
          seenMediaUrls.add(normalizeUrl(v.canonicalUrl));

          foundTikTokVideos++;
          foundVideos++;
          assetCounter++;

          // Update the candidate decision in trace from 'rejected' to 'accepted'
          const existingDecision = trace.candidates.find(
            (c) => c.source === 'tiktok' && c.id === v.videoId
          );
          if (existingDecision) {
            existingDecision.finalDecision = 'accepted';
            existingDecision.verdictTier = targetTierForPass;
            existingDecision.reasonCode = undefined;
            existingDecision.rejectionReason = null;
            existingDecision.rejectionReasonAr = null;
            trace.summary.videosAccepted = (trace.summary.videosAccepted || 0) + 1;
          }

          const hasDirectStream = Boolean(
            v.hasDirectMp4 &&
              v.playAddr &&
              v.playAddr.startsWith('http') &&
              !isTikTokVideoPageUrl(v.playAddr)
          );
          const asset: EphemeralAsset = {
            id: `ast-${searchId}-${assetCounter}`,
            searchId,
            title: v.title,
            mediaUrl: v.canonicalUrl,
            downloadUrl: hasDirectStream ? v.playAddr : v.canonicalUrl,
            thumbnailUrl: v.thumbnailUrl,
            posterSource: 'tiktok_cover',
            verifiedByAi: true,
            verificationStage: `auto_relax_pass_${passNum}`,
            verdictTier: targetTierForPass,
            embedHtml: v.embedHtml,
            sourceUrl: v.canonicalUrl,
            productListingUrl: v.canonicalUrl,
            reviewerOrChannel: v.authorHandle,
            mediaType: 'video',
            platform: 'tiktok',
            durationSeconds: v.durationSeconds,
            provenance: 'public_social_creator',
            sentiment: 'positive',
            matchCategory: 'similar_differences',
            matchScore: Math.round(verdict.referenceSimilarity * 100),
            userFacingMatchLabel:
              targetTierForPass === 'same_type_close_design'
                ? 'شبيه — نفس النوع بتصميم قريب (Pass 2)'
                : 'شبيه — نفس النوع بتصميم بديل (Pass 3)',
            isCustomerReview: true,
            ratingCount: v.diggCount || v.playCount,
            collectedAt: new Date().toISOString(),
          };

          sendEvent({
            type: 'result',
            searchId,
            asset,
            timestamp: new Date().toISOString(),
          });
          if (hasDirectStream) {
            prewarmMediaInBackground(v.canonicalUrl, 'video');
          }
        }
      }
    }

    const totalFound = foundVideos + foundPhotos;
    const stopReasonsAr: Record<string, string> = {};

    if (includeAmazon) {
      if (totalFound >= totalTarget) {
        stopReasonsAr.amazon = `اكتمل الهدف الكلي (${totalFound}/${totalTarget}) — مساهمة أمازون: ${foundAmazonVideos} فيديو.`;
      } else if (pagesBlockedCount > 0 && trace.summary.listingsDiscovered === 0) {
        stopReasonsAr.amazon = 'أمازون حظر بعض الطلبات (CAPTCHA / 503) — تم التبديل للأسواق البديلة.';
      } else if (trace.summary.listingsAccepted === 0) {
        stopReasonsAr.amazon = `تم فحص ${trace.summary.listingsInspected} منتج في أمازون واستبعاد ${trace.summary.listingsRejected} منتج لعدم تطابق الشروط الأساسية (HARD) أو لانتمائها لقائمة الاستبعاد (mustNotBe).`;
      } else {
        stopReasonsAr.amazon = `تم فحص ${trace.summary.pagesFetched} صفحات (${Array.from(marketplacesSearched).join(', ')}) وقبول ${trace.summary.listingsAccepted} منتج مطابق واستبعاد ${trace.summary.listingsRejected} منتج مختلف، واستخراج ${foundAmazonVideos} فيديو مؤكد.`;
      }
    }

    if (includeTikTok) {
      if (totalFound >= totalTarget) {
        stopReasonsAr.tiktok = `اكتمل الهدف الكلي (${totalFound}/${totalTarget}) — مساهمة تيك توك: ${foundTikTokVideos} فيديو.`;
      } else {
        const discoveredTt = trace.candidates.filter((c) => c.source === 'tiktok').length;
        stopReasonsAr.tiktok = `تم فحص ${discoveredTt} فيديو تيك توك مكتشف عبر محركات البحث وقبول ${foundTikTokVideos} فيديو مطابق بصرياً للمنتج.`;
      }
    }

    // Phase 1.1: Single Source of Truth — breakdownSummary is 100% derived from trace
    const feedbackForImage = getVerificationFeedbackForImage(activeIdentityCard.imageHash);
    const budgetStatus = getDailyGeminiBudgetStatus();
    const breakdownSummary = finalizeSearchTrace(
      trace,
      stopReasonsAr,
      feedbackForImage,
      budgetStatus
    );

    let reasonIfPartial: string | undefined;
    if (totalFound < totalTarget) {
      reasonIfPartial = breakdownSummary.topLimitingFactorAr || Object.values(stopReasonsAr).join(' • ');
    }

    sendEvent({
      type: 'completed',
      searchId,
      requestedCount: totalTarget,
      foundCount: totalFound,
      downloadableCount: totalFound,
      reasonIfPartial,
      breakdownSummary,
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
 * Phase A Diagnostic Endpoint: GET /api/debug/search?id=<searchId>
 * Returns the complete per-candidate decision trace stored in DATA_DIR/traces/.
 */
export function handleDebugSearchTrace(req: Request, res: Response): void {
  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  if (!id) {
    res.json({
      traces: listSearchTraces(),
    });
    return;
  }
  const trace = getSearchTrace(id);
  if (!trace) {
    res.status(404).json({ error: `Search trace not found for id="${id}"`, available: listSearchTraces() });
    return;
  }
  res.json(trace);
}

/**
 * Phase F Real Video Frame Poster Endpoint: GET /api/stream-search/poster?id=<posterId>
 */
export function handleStreamPoster(req: Request, res: Response): void {
  const posterId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  const filePath = resolvePosterFilePathById(posterId);
  if (!filePath) {
    res.status(404).json({ error: 'Poster frame not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(filePath));
}

/**
 * Phase G User Verification Feedback Endpoint: POST /api/feedback
 * Stores user override ("اقبل" on a rejected candidate) in DATA_DIR/verification_feedback.json
 * and optionally extracts videos from that accepted listing immediately.
 */
export async function handleVerificationFeedback(req: Request, res: Response): Promise<void> {
  const imageHash = typeof req.body?.imageHash === 'string' ? req.body.imageHash.trim() : 'default';
  const candidateId = typeof req.body?.candidateId === 'string' ? req.body.candidateId.trim() : '';
  const candidateTitle = typeof req.body?.candidateTitle === 'string' ? req.body.candidateTitle.trim() : '';
  const candidateUrl = typeof req.body?.candidateUrl === 'string' ? req.body.candidateUrl.trim() : '';
  const previousRejectionReasonAr =
    typeof req.body?.previousRejectionReasonAr === 'string' ? req.body.previousRejectionReasonAr.trim() : '';
  const userAction: 'accept' | 'reject' = req.body?.userAction === 'reject' ? 'reject' : 'accept';

  if (!candidateId) {
    res.status(400).json({ error: 'candidateId is required' });
    return;
  }

  const saved = recordVerificationFeedback({
    id: `fb-${Date.now()}`,
    imageHash,
    candidateId,
    candidateTitle,
    previousRejectionReasonAr,
    userAction,
  });

  // If the user accepted an Amazon listing from the Rejected Tray, immediately extract its review videos so the UI can show them!
  const extractedAssets: EphemeralAsset[] = [];
  if (userAction === 'accept' && candidateUrl && candidateUrl.includes('amazon.')) {
    try {
      const vids = await fetchAmazonUsProductVideos(candidateUrl);
      for (const v of vids.slice(0, 10)) {
        const bestUrl = v.downloadUrl || v.mediaUrl;
        const poster = await extractRealVideoFramePoster(bestUrl);
        extractedAssets.push({
          id: `ast-fb-${candidateId}-${v.streamUuid.slice(0, 8)}`,
          searchId: 'feedback',
          title: v.title || candidateTitle,
          mediaUrl: v.mediaUrl,
          downloadUrl: bestUrl,
          thumbnailUrl: poster?.posterApiUrl || v.thumbnailUrl || '',
          posterSource: poster?.posterApiUrl ? 'real_video_frame' : 'amazon_slate',
          verifiedByAi: true,
          verificationStage: 'user_feedback_accepted',
          sourceUrl: v.sourceUrl || candidateUrl,
          productListingUrl: candidateUrl,
          reviewerOrChannel: v.reviewerOrChannel || 'عميل أمازون',
          reviewId: v.reviewId,
          mediaType: 'video',
          platform: 'amazon',
          provenance: v.provenance || 'unverified_customer_review',
          sentiment: 'positive',
          matchCategory: 'permitted_variation',
          matchScore: 95,
          userFacingMatchLabel: 'تم قبوله يدوياً بواسطة المستخدم',
          isCustomerReview: true,
          collectedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[Feedback] Video extraction for accepted listing failed:', (err as Error)?.message);
    }
  }

  res.json({
    success: true,
    feedback: saved,
    allFeedbackForImage: getVerificationFeedbackForImage(imageHash),
    extractedAssets,
  });
}

/**
 * Phase 5 Owner Feedback Loop Endpoint: POST /api/feedback/owner-label
 * Stores owner label ("✓ نفس المنتج" = same_product | "✗ مش المنتج" = different_product)
 * with referenceHash, videoId, frames, and discriminator verdicts, then immediately
 * re-scores the remaining candidate list and computes live precision.
 */
export async function handleOwnerFeedbackLabel(req: Request, res: Response): Promise<void> {
  const referenceHash =
    typeof req.body?.referenceHash === 'string' && req.body.referenceHash.trim()
      ? req.body.referenceHash.trim()
      : 'default';
  const candidateId =
    typeof req.body?.candidateId === 'string' ? req.body.candidateId.trim() : '';
  const videoId =
    typeof req.body?.videoId === 'string' && req.body.videoId.trim()
      ? req.body.videoId.trim()
      : candidateId;
  const label: 'same_product' | 'different_product' =
    req.body?.label === 'same_product' ? 'same_product' : 'different_product';
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const platform: 'amazon' | 'tiktok' = req.body?.platform === 'amazon' ? 'amazon' : 'tiktok';
  const previousTier =
    typeof req.body?.previousTier === 'string' ? req.body.previousTier : 'unverified';
  const previousEvidenceLevel =
    typeof req.body?.previousEvidenceLevel === 'string'
      ? req.body.previousEvidenceLevel
      : 'V2';
  const extractedFrameUrls = Array.isArray(req.body?.extractedFrameUrls)
    ? req.body.extractedFrameUrls.map(String)
    : [];
  const blindObservations = Array.isArray(req.body?.blindObservations)
    ? req.body.blindObservations
    : undefined;
  const currentCandidates = Array.isArray(req.body?.currentCandidates)
    ? req.body.currentCandidates
    : [];

  if (!candidateId) {
    res.status(400).json({ error: 'candidateId is required' });
    return;
  }

  const saved = recordOwnerFeedback({
    imageHash:referenceHash,
    videoId,
    candidateId,
    sourceUrl:url,
    title,
    label,
    verdictTier: previousTier as any,
    evidenceLevel: previousEvidenceLevel as any,
    extractedFrameUrls,
    discriminatorVerdicts:blindObservations,
  });

  const rescored = rescoreCandidatesWithOwnerFeedback({
    imageHash:referenceHash,
    candidates: currentCandidates,
  });

  res.json({
    success: true,
    feedback: saved,
    updatedCandidates: rescored.updatedCandidates,
    changedCount: rescored.changedCount,
    demotedIds: rescored.demotedIds,
    promotedIds: rescored.promotedIds,
    precisionStats: rescored.precisionStats,
    allLabels: getFeedbackEntriesForHash(referenceHash),
  });
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
  const isTikTokTarget = isTikTokUrl(targetUrl);
  if (isDirectFile || isTikTokTarget) {
    try {
      let fetchUrl = targetUrl;
      let fetchHeaders: Record<string, string> = {
        'User-Agent': AMAZON_CHROME_USER_AGENT,
        Accept: mediaType === 'video' ? 'video/mp4,video/*;q=0.9,*/*;q=0.8' : 'image/*,*/*;q=0.8',
      };
      if (isTikTokTarget && mediaType === 'video') {
        const resolvedTk = await resolveTikTokPlayableStream(targetUrl, AbortSignal.timeout(12_000));
        if (resolvedTk) {
          fetchUrl = resolvedTk.streamUrl;
          fetchHeaders = resolvedTk.headers;
        }
      }
      const upstream = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(30_000),
        headers: fetchHeaders,
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
 * Phase 3.2: "تجهيز الملفات" (Prepare Files before ZIP).
 * Registers/updates the client's current ephemeral search assets on the server
 * and actively verifies/downloads each selected item, returning per-item status:
 * `ready` | `pending` | `link_only` | `failed:<reason>`.
 */
export async function handlePrepareExportZip(
  req: Request,
  res: Response,
  ownerId: string
): Promise<void> {
  const rawSearchId = String(req.body?.searchId || '')
    .trim()
    .replace(/^ephemeral-/, '');
  const productName = String(req.body?.productName || 'Creative_Radaar_Export').trim();
  const rawAssets = Array.isArray(req.body?.assets) ? req.body.assets : [];
  const verifyDownloads = Boolean(req.body?.verifyDownloads);

  if (!rawSearchId || rawAssets.length === 0) {
    res.status(409).json({
      error: 'لا توجد عناصر محددة لتجهيز الحزمة. يرجى تحديد عنصر واحد على الأقل.',
      code: 'NO_ASSETS_SELECTED',
    });
    return;
  }

  const mappedAssets: EphemeralAsset[] = rawAssets
    .filter((a: any) => a && (a.downloadUrl || a.mediaUrl || a.sourceUrl))
    .map((a: any) => ({
      id: String(a.id || `ast-${Date.now()}`),
      searchId: rawSearchId,
      title: String(a.title || productName),
      mediaUrl: String(a.mediaUrl || a.downloadUrl || a.sourceUrl),
      downloadUrl: String(a.downloadUrl || a.mediaUrl || a.sourceUrl),
      thumbnailUrl: a.thumbnailUrl ? String(a.thumbnailUrl) : undefined,
      sourceUrl: String(a.sourceUrl || a.productListingUrl || a.mediaUrl || ''),
      productListingUrl: String(a.productListingUrl || a.sourceUrl || a.mediaUrl || ''),
      reviewerOrChannel: a.reviewerOrChannel ? String(a.reviewerOrChannel) : 'عميل أمازون',
      reviewId: a.reviewId ? String(a.reviewId) : undefined,
      mediaType: a.mediaType === 'photo' ? 'photo' : 'video',
      platform: a.platform === 'tiktok' ? 'tiktok' : 'amazon',
      verdictTier: a.verdictTier || 'exact',
      asin: a.asin ? String(a.asin) : undefined,
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

  if (!verifyDownloads) {
    res.json({
      ok: true,
      searchId: rawSearchId,
      count: mappedAssets.length,
    });
    return;
  }

  // Actively prepare/verify every selected item in batches of 4
  const itemsStatus: Array<{
    id: string;
    title: string;
    platform: string;
    url: string;
    status: 'ready' | 'link_only' | `failed:${string}`;
    fileName?: string;
    fileSizeBytes?: number;
    reason?: string;
    tier: string;
  }> = [];

  const batchSize = 4;
  for (let i = 0; i < mappedAssets.length; i += batchSize) {
    const batch = mappedAssets.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (asset, bIdx) => {
        const idx = i + bIdx;
        const resolved = await resolveBestLocalMediaForAsset(asset, AbortSignal.timeout(18_000));
        const ext = resolved.localFilePath
          ? path.extname(resolved.localFilePath).slice(1) || 'mp4'
          : asset.mediaType === 'photo'
          ? 'jpg'
          : 'mp4';
        const safeFileName =
          resolved.status === 'ready'
            ? makeSafeAsciiZipFilename(
                idx,
                asset.platform || 'amazon',
                asset.asin || asset.id,
                ext
              )
            : undefined;
        const statusStr: 'ready' | 'link_only' | `failed:${string}` =
          resolved.status === 'ready'
            ? 'ready'
            : resolved.status === 'link_only'
            ? 'link_only'
            : `failed:${resolved.reason || 'unavailable'}`;
        return {
          id: asset.id,
          title: asset.title,
          platform: asset.platform || 'amazon',
          url: asset.sourceUrl || asset.mediaUrl,
          status: statusStr,
          fileName: safeFileName,
          fileSizeBytes: resolved.fileSizeBytes,
          reason: resolved.reason,
          tier: asset.verdictTier || asset.matchCategory || 'exact',
        };
      })
    );
    itemsStatus.push(...results);
  }

  const readyCount = itemsStatus.filter((x) => x.status === 'ready').length;
  const linkOnlyCount = itemsStatus.filter((x) => x.status === 'link_only').length;
  const failedCount = itemsStatus.filter((x) => x.status.startsWith('failed:')).length;

  res.json({
    ok: true,
    searchId: rawSearchId,
    count: mappedAssets.length,
    readyCount,
    linkOnlyCount,
    failedCount,
    items: itemsStatus,
  });
}

/**
 * Phase 3.2 - 3.4: Streams ONE server-side ZIP archive (using archiver with store: true)
 * for an ephemeral stream search.
 * - Never emits a 22-byte empty ZIP (returns HTTP 409 with Arabic JSON error when 0 items/files/links).
 * - Resolves TikTok canonical URLs and cached MP4 files reliably via resolveBestLocalMediaForAsset.
 * - Uses ASCII-safe unique filenames with Arabic titles preserved in manifest.csv.
 * - Always includes manifest.csv (title, source, url, embed_url, status, reason, tier, filename) and links.txt.
 * - Awaits both archive.finalize() and response stream completion before returning.
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

  if (Array.isArray(req.body?.assets) && req.body.assets.length === 0) {
    res.status(409).json({
      error: 'لا توجد عناصر محددة للتصدير في جلسة البحث الحالية',
      code: 'EMPTY_SELECTION',
    });
    return;
  }

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

  // Fallback to the latest search belonging to ownerId ONLY if rawSearchId was not specified
  if (!rec && !rawSearchId && ownerId) {
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
    res.status(409).json({
      error: 'لا توجد جلسة بحث أو عناصر محددة لتصدير الحزمة',
      code: 'SESSION_OR_ASSETS_NOT_FOUND',
    });
    return;
  }

  const assets = rec.assets || [];
  if (assets.length === 0) {
    res.status(409).json({
      error: 'لا توجد عناصر محددة للتصدير في جلسة البحث الحالية',
      code: 'EMPTY_SELECTION',
    });
    return;
  }

  // Step 1: Prepare and resolve all selected items BEFORE sending ZIP headers so we can return 409 if empty
  const preparedItems: Array<{
    asset: EphemeralAsset;
    idx: number;
    resolved: Awaited<ReturnType<typeof resolveBestLocalMediaForAsset>>;
  }> = [];

  const concurrency = 4;
  for (let i = 0; i < assets.length; i += concurrency) {
    const batch = assets.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (asset, bIdx) => {
        const resolved = await resolveBestLocalMediaForAsset(asset, AbortSignal.timeout(20_000));
        return { asset, idx: i + bIdx, resolved };
      })
    );
    preparedItems.push(...batchResults);
  }

  const readyCount = preparedItems.filter((p) => p.resolved.status === 'ready').length;
  const linkOnlyCount = preparedItems.filter((p) => p.resolved.status === 'link_only').length;

  if (readyCount === 0 && linkOnlyCount === 0) {
    res.status(409).json({
      error: 'تعذر تجهيز أي ملفات أو روابط صالحة للتصدير من العناصر المحددة.',
      code: 'NO_EXPORTABLE_FILES_OR_LINKS',
    });
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const rootDirName = makeSafeAsciiRootDirName(
    rec.productName || 'Creative_Radaar_Export',
    dateStr
  );

  // Unpin handles to release pinned cache files once streaming completes
  const unpins: Array<() => void> = [];
  const cleanupAllPins = () => {
    while (unpins.length > 0) {
      const u = unpins.pop();
      try {
        u?.();
      } catch {}
    }
  };

  res.on('close', cleanupAllPins);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${rootDirName}.zip"`
  );
  res.flushHeaders?.();

  const archive = new ZipArchive({
    store: true,
    zlib: { level: 0 },
  });

  const streamDonePromise = new Promise<void>((resolve, reject) => {
    res.on('close', () => resolve());
    res.on('finish', () => resolve());
    archive.on('error', (err: Error) => reject(err));
  });

  archive.on('warning', (err: any) => {
    if (err.code === 'ENOENT') {
      console.warn('[StreamExportZip] Archiver non-fatal warning:', err.message);
    } else {
      console.warn('[StreamExportZip] Archiver warning:', err);
    }
  });

  archive.on('error', (err: Error) => {
    cleanupAllPins();
    console.error('[StreamExportZip] Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'فشل إنشاء حزمة ZIP' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  const manifestHeaders = [
    'title',
    'source',
    'url',
    'embed_url',
    'status',
    'reason',
    'tier',
    'filename',
  ];
  const manifestRows: string[] = [manifestHeaders.map(sanitizeCsvField).join(',')];

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
    'Verdict Tier',
    'Status',
    'Title',
    'Download URL',
  ];
  const csvRows: string[] = [csvHeaders.map(sanitizeCsvField).join(',')];

  const linksLines: string[] = [
    `# Creative Radaar Export Package — ${rec.productName || 'Product'} (${new Date().toISOString()})`,
    `# Total Selected: ${assets.length} | Ready Media Files: ${readyCount} | Link-Only Items: ${linkOnlyCount}`,
    '',
  ];

  const usedFilenames = new Set<string>();

  for (const { asset, idx, resolved } of preparedItems) {
    const folder =
      asset.mediaType === 'photo'
        ? 'Photos'
        : asset.platform === 'tiktok'
        ? 'Creator_Reviews'
        : 'Customer_Reviews';

    let fileName = '';
    let zipRelativePath = '';

    if (resolved.status === 'ready' && resolved.localFilePath && fs.existsSync(resolved.localFilePath)) {
      const unpin = pinCachedFile(resolved.localFilePath);
      unpins.push(unpin);

      const ext =
        path.extname(resolved.localFilePath).slice(1) ||
        (asset.mediaType === 'video' ? 'mp4' : 'jpg');
      fileName = makeSafeAsciiZipFilename(
        idx,
        asset.platform || 'amazon',
        asset.asin || asset.reviewId || asset.id,
        ext
      );
      while (usedFilenames.has(`${folder}/${fileName}`)) {
        fileName = `${idx + 1}_${Date.now().toString(36)}_${fileName}`;
      }
      usedFilenames.add(`${folder}/${fileName}`);
      zipRelativePath = `${rootDirName}/${folder}/${fileName}`;

      archive.append(fs.createReadStream(resolved.localFilePath), { name: zipRelativePath });
    }

    const canonicalUrl = asset.sourceUrl || asset.productListingUrl || asset.mediaUrl || '';
    const embedUrl =
      asset.platform === 'tiktok' && canonicalUrl.includes('/video/')
        ? `https://www.tiktok.com/embed/v2/${canonicalUrl.split('/video/')[1]?.split(/[?#]/)[0] || ''}`
        : canonicalUrl;
    const itemStatus =
      resolved.status === 'ready'
        ? 'ready'
        : resolved.status === 'link_only'
        ? 'link_only'
        : `failed:${resolved.reason || 'unavailable'}`;
    const itemTier = asset.verdictTier || asset.matchCategory || 'exact';

    manifestRows.push(
      [
        asset.title || '',
        asset.platform || 'amazon',
        canonicalUrl,
        embedUrl,
        itemStatus,
        resolved.reason || '',
        itemTier,
        zipRelativePath,
      ]
        .map(sanitizeCsvField)
        .join(',')
    );

    csvRows.push(
      [
        asset.id,
        zipRelativePath,
        asset.mediaType,
        asset.platform || 'amazon',
        asset.reviewerOrChannel || '',
        asset.productListingUrl || '',
        canonicalUrl,
        asset.provenance,
        asset.matchCategory,
        itemTier,
        itemStatus,
        asset.title,
        asset.downloadUrl || asset.mediaUrl,
      ]
        .map(sanitizeCsvField)
        .join(',')
    );

    linksLines.push(
      `[${idx + 1}] (${asset.platform || 'amazon'} | ${itemStatus} | tier=${itemTier}) ${asset.title || asset.id}`
    );
    linksLines.push(`    URL: ${canonicalUrl}`);
    if (embedUrl && embedUrl !== canonicalUrl) {
      linksLines.push(`    Embed: ${embedUrl}`);
    }
    if (zipRelativePath) {
      linksLines.push(`    File: ${zipRelativePath}`);
    }
    linksLines.push('');
  }

  const manifestContent = '\uFEFF' + manifestRows.join('\r\n');
  const csvContent = '\uFEFF' + csvRows.join('\r\n');

  archive.append(manifestContent, { name: `${rootDirName}/manifest.csv` });
  archive.append(linksLines.join('\r\n'), { name: `${rootDirName}/links.txt` });
  archive.append(csvContent, { name: `${rootDirName}/Sources.csv` });
  archive.append(
    JSON.stringify(
      {
        searchId: rawSearchId,
        productName: rec.productName,
        exportedAt: new Date().toISOString(),
        totalSelected: assets.length,
        readyFilesCount: readyCount,
        linkOnlyCount,
        assets,
      },
      null,
      2
    ),
    { name: `${rootDirName}/Sources.json` }
  );

  try {
    await archive.finalize();
    await streamDonePromise;
  } finally {
    cleanupAllPins();
  }
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
      let activeQuery = queries.primaryQuery;
      let { candidates } = await fetchAmazonSearchPage(activeQuery, 1, abortController.signal);
      let sorted = sortCandidatesByRatingCountDesc(candidates);
      let approvedPages = sorted
        .map((page) => ({
          page,
          verdict: evaluateStrictProductTitleMatch(page.title, activeQuery, project.name),
        }))
        .filter((item) => item.verdict.approved);

      if (approvedPages.length === 0 && !abortController.signal.aborted) {
        const tried = [activeQuery, ...queries.variants];
        const aiAlts = await generateAlternativeAmazonQueries({
          failedName: activeQuery,
          alreadyTried: tried,
          signal: abortController.signal,
        });
        const detAlts = buildProgressiveFallbackQueries(activeQuery, tried);
        const fallbackList = Array.from(new Set([...queries.variants.slice(1), ...aiAlts, ...detAlts])).slice(0, 6);

        for (const altName of fallbackList) {
          if (abortController.signal.aborted) break;
          updateState(
            'searching',
            `لم يتم العثور على منتج باسم "${activeQuery}" — جاري تحديث الاسم تلقائياً وتجربة "${altName}" في أمازون...`,
            'info'
          );
          const retryPage = await fetchAmazonSearchPage(altName, 1, abortController.signal);
          const retrySorted = sortCandidatesByRatingCountDesc(retryPage.candidates);
          const retryApproved = retrySorted
            .map((page) => ({
              page,
              verdict: evaluateStrictProductTitleMatch(page.title, altName, altName),
            }))
            .filter((item) => item.verdict.approved);

          if (retryApproved.length > 0) {
            activeQuery = altName;
            project.name = altName;
            sorted = retrySorted;
            approvedPages = retryApproved;
            updateState(
              'searching',
              `تم تحديث الاسم والعثور على ${retryApproved.length} منتج مطابق في أمازون باسم "${altName}".`,
              'success'
            );
            break;
          }
        }
      }

      let foundVideos = 0;
      for (const { page, verdict } of approvedPages) {
        if (abortController.signal.aborted || foundVideos >= maxVideos) break;

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
