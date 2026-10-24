import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Response } from 'express';
import {
  Project,
  CandidateAsset,
  JobState,
  ProvenanceClassification
} from '../types/index.ts';
import { StorageService } from './storage.ts';
import {
  analyzeProductImage,
  discoverProductWebSources,
  isGeminiConfigured,
  verifyAmazonProductsBatchVisually,
  verifyVideosPositiveAndExactMatch,
  ProductMatchVerdict
} from './gemini.ts';
import { isQuotaExhaustedError, isTransientUnavailableError } from './geminiRetry.ts';
import { isSafeExternalUrl, computeSha256 } from '../utils/security.ts';
import { isDuplicateCandidate, matchesStrictness, matchesMediaType, normalizeUrl } from '../utils/rules.ts';
import { downloadMedia } from './downloader.ts';
import { prepareSearchIdentity } from '../utils/productIdentity.ts';
import { DATA_DIR } from './runtimePaths.ts';
import {
  AMAZON_US_HEADERS,
  AMAZON_US_PRODUCT_PAGE_HEADERS,
  buildAmazonUsQuery,
  searchAmazonUsProductPages,
  fetchAmazonUsProductVideos,
  parseAmazonUsVideosFromHtml,
  evaluateStrictProductTitleMatch,
  fetchProductImageAsBase64,
  isPositiveReviewVideo,
  AmazonUsProductCandidate,
  ExtractedAmazonVideo
} from './amazonUs.ts';

const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

// In-memory extraction cache (15 minutes TTL) to avoid re-fetching identical product/review pages
const EXTRACTION_CACHE_TTL_MS = 15 * 60 * 1000;
const videoResolveCache = new Map<string, { value: string | undefined; expiresAt: number }>();
const photoResolveCache = new Map<string, { value: ExtractedPhotoCandidate[]; expiresAt: number }>();

export function isDirectMediaLink(url?: string): boolean {
  if (!url) return false;
  return /\.(mp4|m3u8|jpg|jpeg|png|webp)(?:[?#]|$)/i.test(url.trim());
}

function getHostnameSafe(url?: string): string {
  if (!url) return 'default';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'default';
  }
}

/**
 * Runs async tasks with bounded global concurrency (e.g. 3) and bounded per-host concurrency (e.g. 2).
 */
async function runWithHostBoundedConcurrency<T>(
  items: T[],
  getUrl: (item: T) => string | undefined,
  maxTotalConcurrency: number,
  maxPerHostConcurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  if (items.length === 0) return;

  const pendingIndices = items.map((_, idx) => idx);
  const hostActiveCount = new Map<string, number>();
  let activeTotal = 0;

  return new Promise<void>((resolve) => {
    const scheduleNext = () => {
      if (shouldStop && shouldStop()) {
        if (activeTotal === 0) resolve();
        return;
      }

      if (pendingIndices.length === 0 && activeTotal === 0) {
        resolve();
        return;
      }

      while (activeTotal < maxTotalConcurrency && pendingIndices.length > 0) {
        if (shouldStop && shouldStop()) break;

        // Find the first pending item whose host has capacity
        let chosenQueuePos = -1;
        for (let i = 0; i < pendingIndices.length; i++) {
          const itemIdx = pendingIndices[i];
          const host = getHostnameSafe(getUrl(items[itemIdx]));
          const currentHostActive = hostActiveCount.get(host) || 0;
          if (currentHostActive < maxPerHostConcurrency) {
            chosenQueuePos = i;
            break;
          }
        }

        if (chosenQueuePos === -1) {
          // All remaining items are waiting on per-host limits
          break;
        }

        const [itemIdx] = pendingIndices.splice(chosenQueuePos, 1);
        const item = items[itemIdx];
        const host = getHostnameSafe(getUrl(item));

        activeTotal++;
        hostActiveCount.set(host, (hostActiveCount.get(host) || 0) + 1);

        fn(item, itemIdx)
          .catch(() => {})
          .finally(() => {
            activeTotal--;
            const prev = hostActiveCount.get(host) || 1;
            if (prev <= 1) hostActiveCount.delete(host);
            else hostActiveCount.set(host, prev - 1);
            scheduleNext();
          });
      }
    };

    scheduleNext();
  });
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

  let url = source;
  for (let hop = 0; hop < 4; hop++) {
    if (!isSafeExternalUrl(url).safe) return undefined;
    const timeoutSig = AbortSignal.timeout(10000);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const isAmz = url.toLowerCase().includes('amazon.');
    const response = await fetch(url, {
      redirect: 'manual',
      signal: combinedSig,
      headers: isAmz
        ? AMAZON_US_HEADERS
        : { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,video/*' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return undefined;
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) return undefined;
    if ((response.headers.get('content-type') || '').startsWith('video/')) {
      videoResolveCache.set(source, { value: url, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
      return url;
    }
    if (Number(response.headers.get('content-length') || 0) > 6000000) return undefined;
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 6000000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    if (isAmz) {
      const amzVideos = parseAmazonUsVideosFromHtml(html, url);
      if (amzVideos.length > 0) {
        const best = amzVideos[0].mediaUrl;
        videoResolveCache.set(source, { value: best, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
        return best;
      }
    }
    html = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const media =
      html.match(/https:\/\/m\.media-amazon\.com\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi) ||
      html.match(/https:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi) ||
      [];
    const found = media.find((link) => isSafeExternalUrl(link).safe);
    videoResolveCache.set(source, { value: found, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
    return found;
  }
  return undefined;
}

export interface ExtractedPhotoCandidate {
  mediaUrl: string;
  sourceUrl: string;
  title: string;
  provenance: ProvenanceClassification;
  verifiedPurchaseEvidence?: string;
}

function isIgnoredThumbnailOrStock(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('unsplash.com') || lower.includes('picsum.photos') || lower.includes('placehold')) {
    return true;
  }
  if (
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
  ) {
    return true;
  }
  return false;
}

function upgradeAmazonImageResolution(url: string): string {
  if (url.includes('m.media-amazon.com/images/I/')) {
    return url.replace(/\._[A-Z0-9,_-]+_\.(jpg|jpeg|png|webp)/i, '._SL1500_.$1');
  }
  return url;
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
        : { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,image/*' },
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
      const single = [
        {
          mediaUrl: url,
          sourceUrl: source,
          title: 'صورة منتج مباشرة',
          provenance: 'unresolved_source' as ProvenanceClassification,
        },
      ];
      photoResolveCache.set(source, { value: single, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
      return single;
    }
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return [];
    if (Number(response.headers.get('content-length') || 0) > 6000000) return [];
    const reader = response.body?.getReader();
    if (!reader) return [];
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 6000000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    html = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');

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

    // 1. Customer Review Images (prioritized first)
    const reviewTileRegex =
      /<img[^>]+(?:data-hook="review-image-tile"|class="[^"]*review-image-tile[^"]*"|class="[^"]*cr-lightbox-image-thumbnail[^"]*")[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = reviewTileRegex.exec(html)) !== null) {
      const hiRes = upgradeAmazonImageResolution(match[1]);
      addCandidate({
        mediaUrl: hiRes,
        sourceUrl: source,
        title: 'صورة مراجعة عميل',
        provenance: 'unverified_customer_review',
      });
    }

    // 2. Seller High-Res Product Gallery Images (honestly classified as seller_manufacturer_demo)
    const hiResRegex = /"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    while ((match = hiResRegex.exec(html)) !== null) {
      addCandidate({
        mediaUrl: match[1],
        sourceUrl: source,
        title: 'صورة المنتج (عرض البائع)',
        provenance: 'seller_manufacturer_demo',
      });
    }

    const oldHiresRegex = /data-old-hires="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    while ((match = oldHiresRegex.exec(html)) !== null) {
      addCandidate({
        mediaUrl: match[1],
        sourceUrl: source,
        title: 'صورة المنتج (عرض البائع)',
        provenance: 'seller_manufacturer_demo',
      });
    }

    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/[^"']+)["']/i);
    if (ogImageMatch?.[1]) {
      addCandidate({
        mediaUrl: ogImageMatch[1],
        sourceUrl: source,
        title: 'صورة المنتج الرئيسية (عرض البائع)',
        provenance: 'seller_manufacturer_demo',
      });
    }

    photoResolveCache.set(source, { value: results, expiresAt: now + EXTRACTION_CACHE_TTL_MS });
    return results.slice(0, maxPhotos);
  }
  return [];
}

export interface StageTimings {
  discoveryMs: number;
  extractionMs: number;
  downloadMs: number;
  verificationMs: number;
  totalMs: number;
}

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

  public isRunning(projectId: string): boolean {
    return this.activeJobs.has(projectId);
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
          // ignore closed connections
        }
      }
    }
  }

  public cancelJob(projectId: string): void {
    this.cancelledJobs.add(projectId);
    const controller = this.jobAbortControllers.get(projectId);
    if (controller) {
      try {
        controller.abort();
      } catch {}
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

  /**
   * Adds a manual link (source link or direct video/photo link) directly to project candidates.
   * Immediately pulls media without invoking Gemini or image analysis.
   */
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
    const fingerprint = prepareSearchIdentity(project);
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

    const isYouTube = cleanSourceUrl.includes('youtube.com') || cleanSourceUrl.includes('youtu.be');
    const isAmazon = cleanSourceUrl.includes('amazon.');

    const candidate: CandidateAsset = {
      searchInputFingerprint: fingerprint,
      id: assetId,
      projectId: project.id,
      title:
        payload.title ||
        (resolvedMediaType === 'photo'
          ? 'صورة منتج (مدخلة يدوياً)'
          : isAmazon
          ? 'مراجعة من متجر أمازون (مدخلة يدويًا)'
          : isYouTube
          ? 'مراجعة يوتيوب (مدخلة يدويًا)'
          : 'رابط مراجعة مدخل يدويًا'),
      mediaType: resolvedMediaType,
      platform: isAmazon ? 'amazon' : isYouTube ? 'youtube' : 'direct_web',
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
        } catch {}
      } else {
        try {
          targetDownloadUrl = await resolvePublicVideo(cleanSourceUrl);
        } catch {}
      }
    }
    candidate.mediaUrl = targetDownloadUrl;
    if (resolvedMediaType === 'photo' && targetDownloadUrl) {
      candidate.thumbnailUrl = targetDownloadUrl;
    }

    if (targetDownloadUrl) {
      const dlResult = await downloadMedia(targetDownloadUrl, assetId, resolvedMediaType);
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

    if (!storage.getProject(projectId) || prepareSearchIdentity(storage.getProject(projectId)!) !== fingerprint) {
      throw new Error('تغيّر المنتج أثناء إضافة الرابط؛ أعد الإضافة للمنتج الحالي');
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
    if (!project) return;

    if (this.activeJobs.has(projectId)) {
      return; // already running
    }
    const searchFingerprint = prepareSearchIdentity(project);

    const abortController = new AbortController();
    this.activeJobs.add(projectId);
    this.cancelledJobs.delete(projectId);
    this.jobAbortControllers.set(projectId, abortController);

    const isCancelled = () =>
      this.cancelledJobs.has(projectId) || abortController.signal.aborted;

    const updateState = (
      state: JobState,
      message: string,
      level: 'info' | 'warn' | 'error' | 'success' = 'info'
    ) => {
      if (isCancelled()) return;
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

    const jobStartMs = performance.now();
    let discoveryMs = 0;
    let extractionMs = 0;
    let downloadMs = 0;
    let verificationMs = 0;

    try {
      storage.incrementSearches();

      const wantVideo = project.mediaTypeRequested === 'video' || project.mediaTypeRequested === 'both';
      const wantPhoto = project.mediaTypeRequested === 'photo' || project.mediaTypeRequested === 'both';
      const maxVideos = wantVideo ? Math.min(500, Math.max(1, Number(project.targetVideoCount) || 10)) : 0;
      const maxPhotos = wantPhoto ? Math.min(500, Math.max(1, Number(project.targetPhotoCount) || 10)) : 0;
      const targetTotal = maxVideos + maxPhotos;
      project.counters.targetCount = targetTotal;

      const directMediaInput = isDirectMediaLink(project.productListingUrl);

      // ==========================================
      // STAGE 1: Analyzing Product Profile (Skipped if direct media URL provided)
      // ==========================================
      const tDiscStart = performance.now();
      let quotaExhaustedOccurred = false;

      const refImg = project.referenceImages?.[0];
      let refBase64: string | undefined = refImg?.base64Data;
      let refMimeType: string = refImg?.mimeType || 'image/jpeg';

      if (!refBase64 && refImg?.url) {
        if (refImg.url.startsWith('data:image/')) {
          refBase64 = refImg.url;
          const m = refImg.url.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i);
          if (m) refMimeType = m[1];
        } else if (refImg.url.startsWith('http')) {
          const fetchedRef = await fetchProductImageAsBase64(refImg.url, abortController.signal);
          if (fetchedRef) {
            refBase64 = fetchedRef.base64;
            refMimeType = fetchedRef.mimeType;
          }
        }
      }

      if (refImg && !directMediaInput && (!refBase64 || !isGeminiConfigured())) {
        updateState('needs_configuration', !refBase64 ? 'تعذر قراءة الصورة المرجعية؛ أعد رفعها قبل البحث.' : 'يلزم ضبط GEMINI_API_KEY للتحقق من مطابقة الصورة؛ لم يتم قبول نتائج بالعنوان فقط.', 'warn');
        return;
      }

      if (
        !directMediaInput &&
        (!project.productProfile || (refBase64 && project.productProfile.confidence === 'low'))
      ) {
        if (refBase64 && isGeminiConfigured()) {
          updateState('analyzing', 'جاري فحص صورة المنتج المرفوعة وتحديد مواصفاته...');
          try {
            project.productProfile = await analyzeProductImage(
              refBase64,
              refMimeType,
              project.userNotes,
              project.productListingUrl,
              project.name
            );
            if (isCancelled()) return;
            updateState(
              'analyzing',
              `تم فحص المنتج وتحديد هيكله: "${project.productProfile.suggestedNameAr}"`,
              'success'
            );
          } catch (err: unknown) {
            if (isQuotaExhaustedError(err)) {
              quotaExhaustedOccurred = true;
            }
          }
        }

        if (!project.productProfile) {
          const hasValidUserProductName =
            Boolean(project.name && project.name.trim() && project.name.trim() !== 'بحث بالصورة');

          if (!hasValidUserProductName) {
            updateState(
              'completed_partial',
              'تعذر تحليل الصورة تلقائياً في هذه اللحظة — يرجى كتابة اسم المنتج مع الصورة أو إعادة المحاولة.',
              'warn'
            );
            return;
          }

          const cleanFallbackName = project.name.trim();
          project.productProfile = {
            category: 'منتجات التجارة الإلكترونية',
            suggestedNameAr: cleanFallbackName,
            suggestedNameEn: cleanFallbackName,
            brandOrModelText: [],
            distinctiveGeometry: 'مواصفات مستندة إلى الاسم والرابط',
            components: ['الهيكل الخارجي'],
            materials: [],
            colors: ['الألوان المتاحة'],
            visibleAccessories: [],
            mechanism: 'تشغيل مباشر',
            mustMatchAttributes: ['تطابق المنتج الأصلي 100%'],
            allowedDifferences: [],
            unknownAttributes: [],
            confidence: 'low',
            multilingualQueries: {
              ar: [`ريفيو تجربة ${cleanFallbackName}`, `تقييم ${cleanFallbackName} أمازون`],
              en: [`${cleanFallbackName} customer review video`, `${cleanFallbackName} review`],
            },
          };
        }
      }

      if (isCancelled()) return;

      // ==========================================
      // STAGE 2: Amazon US Customer Review Discovery FIRST + 100% Exact Product & Positive Review Gate
      // ==========================================
      updateState(
        'searching',
        'جاري البحث على أمازون أمريكا وفحص مطابقة المنتجات وبيانات المراجعات...'
      );

      const discoveredCandidates: Partial<CandidateAsset>[] = [];
      const webSourcesToExtract: Array<{ url: string; title: string; snippet?: string }> = [];
      const tExtStart = performance.now();

      // 2A. Direct media link fast-path (no Gemini needed)
      if (directMediaInput && project.productListingUrl) {
        const directUrl = project.productListingUrl.trim();
        const isPhoto = /\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.test(directUrl);
        discoveredCandidates.push({
          title: project.name || (isPhoto ? 'صورة منتج مباشرة' : 'فيديو منتج مباشر'),
          sourceUrl: directUrl,
          mediaUrl: directUrl,
          thumbnailUrl: isPhoto ? directUrl : '',
          platform: directUrl.includes('amazon.') ? 'amazon' : 'direct_web',
          mediaType: isPhoto ? 'photo' : 'video',
          provenance: 'unresolved_source',
          matchCategory: 'exact_design',
          matchScore: 98,
          userFacingMatchLabel: 'نفس المنتج (تطابق 100%)',
          sentiment: 'positive',
          supportingObservations: ['رابط ميديا مباشر للمنتج المحدد'],
          contentDescription: 'ملف ميديا مباشر تم تزويده في البحث',
        });
      } else {
        // 2B. FIRST: Go into Amazon US (amazon.com), strictly verify each candidate product (100% exact match), and fetch POSITIVE Customer Review Videos ONLY
        const amazonProductPages: AmazonUsProductCandidate[] = [];
        const seenAmazonUrls = new Set<string>();

        if (
          project.productListingUrl &&
          isSafeExternalUrl(project.productListingUrl).safe &&
          project.productListingUrl.toLowerCase().includes('amazon.')
        ) {
          seenAmazonUrls.add(project.productListingUrl);
          const asinMatch = project.productListingUrl.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i);
          amazonProductPages.push({
            asin: asinMatch ? asinMatch[1].toUpperCase() : 'DIRECT_URL',
            url: project.productListingUrl,
            title: project.name,
            isSponsored: false,
          });
        } else if (project.productListingUrl && isSafeExternalUrl(project.productListingUrl).safe) {
          webSourcesToExtract.push({
            url: project.productListingUrl,
            title: `صفحة المنتج (${project.name})`,
          });
        }

        const amazonQuery = await buildAmazonUsQuery(
          project.name,
          project.productProfile?.suggestedNameEn,
          project.productProfile?.multilingualQueries?.en,
          abortController.signal
        );

        // Dynamically scale how many Amazon US product pages we discover based on the requested counts
        const desiredAmazonPages = Math.min(
          160,
          Math.max(48, maxVideos * 3, Math.ceil(maxPhotos * 2))
        );

        const amzSearchPages = await searchAmazonUsProductPages(
          amazonQuery,
          desiredAmazonPages,
          abortController.signal
        );
        for (const p of amzSearchPages) {
          if (!seenAmazonUrls.has(p.url)) {
            seenAmazonUrls.add(p.url);
            amazonProductPages.push(p);
          }
        }

        // Search additional query variants if initial search returned fewer than 35 listings
        const extraQueries = (project.productProfile?.multilingualQueries?.en || []).filter(
          (q) => q.toLowerCase() !== amazonQuery.toLowerCase()
        );
        for (const extraQ of extraQueries) {
          if (amazonProductPages.length >= desiredAmazonPages) break;
          const extraPages = await searchAmazonUsProductPages(extraQ, 36, abortController.signal);
          for (const p of extraPages) {
            if (!seenAmazonUrls.has(p.url)) {
              seenAmazonUrls.add(p.url);
              amazonProductPages.push(p);
            }
          }
        }

        // Sort candidate listings by reviews & sales volume so high-review items with abundant customer videos are prioritized first!
        amazonProductPages.sort(
          (a, b) => (b.reviewOrSalesScore || 0) - (a.reviewOrSalesScore || 0)
        );

        if (amazonProductPages.length > 0 && !isCancelled()) {
          type ApprovedAmazonVideo = ExtractedAmazonVideo & {
            matchCategory: CandidateAsset['matchCategory'];
            matchScore: number;
            userFacingMatchLabel: string;
            supportingObservations: string[];
          };
          type ApprovedAmazonPhoto = ExtractedPhotoCandidate & {
            matchCategory: CandidateAsset['matchCategory'];
            matchScore: number;
            userFacingMatchLabel: string;
            supportingObservations: string[];
          };

          const allowSellerDemos = project.settings?.contentSources === 'all_including_seller';
          const onlyOrganicCustomers =
            project.settings?.contentSources === 'customer_only' || !project.settings?.contentSources;
          const customerReviewVideos: ApprovedAmazonVideo[] = [];
          const otherAmazonVideos: ApprovedAmazonVideo[] = [];
          const amazonPhotos: ApprovedAmazonPhoto[] = [];

          // Track unique mediaUrls and reviewIds across existing + newly discovered items so we don't stop early on duplicates
          const seenVideoMediaUrls = new Set<string>();
          const seenVideoReviewIds = new Set<string>();
          const seenPhotoMediaUrls = new Set<string>();

          for (const existing of project.candidates || []) {
            if (existing.mediaType === 'video') {
              if (existing.mediaUrl) seenVideoMediaUrls.add(normalizeUrl(existing.mediaUrl));
              if (existing.reviewId) seenVideoReviewIds.add(existing.reviewId);
            } else if (existing.mediaType === 'photo' && existing.mediaUrl) {
              seenPhotoMediaUrls.add(normalizeUrl(existing.mediaUrl));
            }
          }

          const existingVerifiedVideos = (project.candidates || []).filter(
            (c) => c.mediaType === 'video' && c.downloadStatus === 'verified_available'
          ).length;
          const existingVerifiedPhotos = (project.candidates || []).filter(
            (c) => c.mediaType === 'photo' && c.downloadStatus === 'verified_available'
          ).length;

          const neededNewVideos = Math.max(0, maxVideos - existingVerifiedVideos);
          const neededNewPhotos = Math.max(0, maxPhotos - existingVerifiedPhotos);

          // Target a 25% reserve buffer so any failed stream or duplicate file hash can be replaced immediately
          const desiredUniqueVideos = Math.ceil(neededNewVideos * 1.25) + 2;
          const desiredUniquePhotos = Math.ceil(neededNewPhotos * 1.25) + 2;

          let approvedProductsCount = 0;
          let rejectedProductsCount = 0;

          const batchSize = 8;
          for (let offset = 0; offset < amazonProductPages.length; offset += batchSize) {
            if (isCancelled()) break;

            const currentLiveVids = (project.candidates || []).filter((c) => c.mediaType === 'video').length;
            const uniqueVideosSoFar = customerReviewVideos.length + otherAmazonVideos.length;
            const hasEnoughVideos =
              !wantVideo || (currentLiveVids >= maxVideos && uniqueVideosSoFar >= neededNewVideos);
            const hasEnoughPhotos = !wantPhoto || amazonPhotos.length >= desiredUniquePhotos;

            if (hasEnoughVideos && hasEnoughPhotos) {
              break;
            }

            const batch = amazonProductPages.slice(offset, offset + batchSize);

            const finalApprovedBatch: Array<{
              page: AmazonUsProductCandidate;
              verdict: ProductMatchVerdict;
            }> = [];

            const preApprovedCandidates: Array<{
              page: AmazonUsProductCandidate;
              fallbackVerdict: ProductMatchVerdict;
            }> = [];

            for (const cand of batch) {
              if (cand.asin === 'DIRECT_URL' || cand.url === project.productListingUrl) {
                finalApprovedBatch.push({
                  page: cand,
                  verdict: {
                    asin: cand.asin,
                    approved: true,
                    matchCategory: 'exact_design',
                    matchScore: 98,
                    userFacingLabelAr: 'صفحة المنتج المحددة بواسطة المستخدم',
                    reasonAr: 'صفحة المنتج المرفوعة مباشرة من المستخدم',
                  },
                });
                continue;
              }

              const titleVerdict = evaluateStrictProductTitleMatch(
                cand.title,
                amazonQuery,
                project.name,
                project.productProfile?.mustMatchAttributes
              );

              if (!titleVerdict.approved) {
                rejectedProductsCount++;
                continue;
              }

              preApprovedCandidates.push({
                page: cand,
                fallbackVerdict: {
                  asin: cand.asin,
                  approved: true,
                  matchCategory: titleVerdict.matchCategory,
                  matchScore: titleVerdict.matchScore,
                  userFacingLabelAr: 'تطابق مبدئي بالعنوان؛ لم يُفحص بصرياً',
                  reasonAr: titleVerdict.reasonAr,
                },
              });
            }

            // Fast Micro-Batch AI Visual Verification (up to 8 candidate thumbnails at a time)
            // Ensures candidate products have the EXACT SAME physical shape/structure as the uploaded reference image
            if (preApprovedCandidates.length > 0) {
              if (refBase64 && !quotaExhaustedOccurred && isGeminiConfigured()) {
                const candidatesWithImages = await Promise.all(
                  preApprovedCandidates.map(async ({ page }) => {
                    const img = page.imageUrl
                      ? await fetchProductImageAsBase64(page.imageUrl, abortController.signal)
                      : null;
                    return {
                      asin: page.asin,
                      title: page.title,
                      imageBase64: img?.base64,
                      imageMimeType: img?.mimeType,
                    };
                  })
                );

                const visualVerdicts = await verifyAmazonProductsBatchVisually(
                  refBase64,
                  refMimeType,
                  project.name,
                  project.productProfile,
                  candidatesWithImages,
                  () => {
                    quotaExhaustedOccurred = true;
                  }
                );

                if (visualVerdicts && visualVerdicts.size > 0) {
                  for (const item of preApprovedCandidates) {
                    const v = visualVerdicts.get(item.page.asin.toUpperCase());
                    if (v && candidatesWithImages.find(c => c.asin === item.page.asin)?.imageBase64) {
                      if (v.approved) {
                        finalApprovedBatch.push({ page: item.page, verdict: v });
                      } else {
                        rejectedProductsCount++;
                      }
                    }
                  }
                } else {
                  rejectedProductsCount += preApprovedCandidates.length;
                }
              } else {
                // A title is a search pre-filter, not visual identity evidence.
                if (!refBase64) {
                  for (const item of preApprovedCandidates) finalApprovedBatch.push({page: item.page, verdict: item.fallbackVerdict});
                } else rejectedProductsCount += preApprovedCandidates.length;
              }
            }

            approvedProductsCount += finalApprovedBatch.length;
            if (finalApprovedBatch.length === 0) {
              continue;
            }

            // Extract POSITIVE organic customer review videos with high parallel concurrency and live real-time streaming
            await runWithHostBoundedConcurrency(
              finalApprovedBatch,
              (item) => item.page.url,
              16,
              10,
              async ({ page: amzPage, verdict }) => {
                if (isCancelled()) return;

                if (wantVideo && customerReviewVideos.length < desiredUniqueVideos) {
                  const pageVids = await fetchAmazonUsProductVideos(
                    amzPage.url,
                    abortController.signal,
                    allowSellerDemos,
                    onlyOrganicCustomers
                  );
                  if (isCancelled()) return;
                  // Product-page identity alone cannot prove that every review video shows it.
                  const thumbs = refBase64 ? await Promise.all(pageVids.map(async (v, index) => {
                    const image = v.thumbnailUrl ? await fetchProductImageAsBase64(v.thumbnailUrl, abortController.signal) : null;
                    return {index, title: v.title, reviewer: v.reviewerOrChannel || '', thumbBase64: image?.base64, thumbMimeType: image?.mimeType};
                  })) : [];
                  const videoVerdicts = refBase64 && !quotaExhaustedOccurred
                    ? await verifyVideosPositiveAndExactMatch(refBase64, refMimeType, project.name, project.productProfile, thumbs, () => { quotaExhaustedOccurred = true; })
                    : null;
                  if (isCancelled()) return;
                  let addedNewOnPage = false;

                  for (const [videoIndex, v] of pageVids.entries()) {
                    const videoVerdict = videoVerdicts?.get(videoIndex);
                    if (refBase64 && (!thumbs[videoIndex]?.thumbBase64 || !videoVerdict?.approved || videoVerdict.sentiment !== 'positive')) continue;
                    if (customerReviewVideos.length >= desiredUniqueVideos) break;

                    // Strictly exclude creator ads / marketer demonstrations when customer_only is active
                    if (
                      onlyOrganicCustomers &&
                      (!v.isCustomerReview ||
                        v.provenance === 'affiliate_creator_demo' ||
                        v.provenance === 'seller_manufacturer_demo' ||
                        v.provenance === 'unresolved_source')
                    ) {
                      continue;
                    }
                    if (
                      !allowSellerDemos &&
                      (v.provenance === 'seller_manufacturer_demo' ||
                        v.provenance === 'unresolved_source')
                    ) {
                      continue;
                    }

                    const normMedia = normalizeUrl(v.mediaUrl);
                    if (seenVideoMediaUrls.has(normMedia)) continue;
                    if (v.reviewId && seenVideoReviewIds.has(v.reviewId)) continue;

                    seenVideoMediaUrls.add(normMedia);
                    if (v.reviewId) seenVideoReviewIds.add(v.reviewId);

                    const resolvedThumb = v.thumbnailUrl || amzPage.imageUrl || '';
                    const approvedVid: ApprovedAmazonVideo = {
                      ...v,
                      thumbnailUrl: resolvedThumb,
                      matchCategory: verdict.matchCategory,
                      matchScore: verdict.matchScore,
                      userFacingMatchLabel: verdict.userFacingLabelAr,
                      supportingObservations: [
                        'تم فحص بيانات المراجعة؛ لا يغني ذلك عن مشاهدة الفيديو كاملاً',
                        ...(videoVerdict ? [videoVerdict.reasonAr] : []),
                        verdict.reasonAr,
                        `المنتج المطابق: ${amzPage.title.slice(0, 90)}`,
                      ],
                    };

                    if (approvedVid.isCustomerReview) {
                      customerReviewVideos.push(approvedVid);
                    } else {
                      otherAmazonVideos.push(approvedVid);
                    }

                    // Stream newly approved video directly into project candidates in real-time!
                    if (!project.candidates) project.candidates = [];
                    if (project.candidates.filter((c) => c.mediaType === 'video').length < maxVideos) {
                      const newAssetId = `ast-${project.id}-${project.candidates.length + 1}`;
                      const newAsset: CandidateAsset = {
                        searchInputFingerprint: searchFingerprint,
                        id: newAssetId,
                        visibleDifferences: [],
                        unknowns: ['لم تتم مراجعة كامل محتوى الفيديو والصوت'],
                        rightsStatus: 'unknown',
                        projectId: project.id,
                        title: approvedVid.title,
                        sourceUrl: approvedVid.sourceUrl,
                        productListingUrl: approvedVid.productListingUrl,
                        mediaUrl: approvedVid.mediaUrl,
                        thumbnailUrl: resolvedThumb,
                        reviewerOrChannel: approvedVid.reviewerOrChannel,
                        reviewId: approvedVid.reviewId,
                        incentiveDisclosure: approvedVid.incentiveDisclosure,
                        platform: 'amazon',
                        mediaType: 'video',
                        provenance: approvedVid.provenance,
                        matchCategory: approvedVid.matchCategory,
                        matchScore: approvedVid.matchScore,
                        userFacingMatchLabel: approvedVid.userFacingMatchLabel,
                        sentiment: 'positive',
                        supportingObservations: approvedVid.supportingObservations,
                        contentDescription: approvedVid.contentDescription,
                        downloadStatus: 'pending',
                        collectedAt: new Date().toISOString(),
                        selectedForExport: true,
                      };
                      if (!isDuplicateCandidate(newAsset, project.candidates).isDuplicate) {
                        project.candidates.push(newAsset);
                        addedNewOnPage = true;
                      }
                    }
                  }

                  if (addedNewOnPage) {
                    project.counters.candidatesDiscovered = project.candidates.length;
                    storage.upsertProject(project);
                    this.broadcast(projectId, { project });
                  }
                }

                if (wantPhoto && amazonPhotos.length < desiredUniquePhotos) {
                  try {
                    const photos = await resolvePublicPhotos(
                      amzPage.url,
                      Math.max(15, neededNewPhotos),
                      abortController.signal
                    );
                    if (isCancelled()) return;
                    for (const ph of photos) {
                      const normPhoto = normalizeUrl(ph.mediaUrl);
                      if (seenPhotoMediaUrls.has(normPhoto)) continue;
                      seenPhotoMediaUrls.add(normPhoto);
                      amazonPhotos.push({
                        ...ph,
                        matchCategory: verdict.matchCategory,
                        matchScore: verdict.matchScore,
                        userFacingMatchLabel: verdict.userFacingLabelAr,
                        supportingObservations: [
                          verdict.reasonAr,
                          `المنتج المطابق: ${amzPage.title.slice(0, 90)}`,
                        ],
                      });
                    }
                  } catch {}
                }
              },
              isCancelled
            );

            const currentLiveVidsAfterBatch = (project.candidates || []).filter(
              (c) => c.mediaType === 'video'
            ).length;
            updateState(
              'searching',
              `تم العثور على ${currentLiveVidsAfterBatch} من أصل ${maxVideos} فيديو تقييم عميل إيجابي مطابق...`,
              'info'
            );

            if (
              currentLiveVidsAfterBatch >= maxVideos &&
              (!wantPhoto || amazonPhotos.length >= maxPhotos)
            ) {
              break;
            }
          }

          if (rejectedProductsCount > 0 || approvedProductsCount > 0) {
            updateState(
              'searching',
              `اكتمل فحص الدفعة: اعتماد ${approvedProductsCount} منتج واستبعاد ${rejectedProductsCount} منتج مختلف أو غير مؤكّد.`,
              'info'
            );
          }

          // Place Customer Review Videos FIRST so they fill the video quota from people's positive reviews of the exact product
          const prioritizedAmazonVideos = onlyOrganicCustomers ? customerReviewVideos : [...customerReviewVideos, ...(allowSellerDemos ? otherAmazonVideos : [])];
          for (const v of prioritizedAmazonVideos) {
            discoveredCandidates.push({
              title: v.title,
              sourceUrl: v.sourceUrl,
              productListingUrl: v.productListingUrl,
              mediaUrl: v.mediaUrl,
              thumbnailUrl: v.thumbnailUrl,
              reviewerOrChannel: v.reviewerOrChannel,
              reviewId: v.reviewId,
              incentiveDisclosure: v.incentiveDisclosure,
              platform: 'amazon',
              mediaType: 'video',
              provenance: v.provenance,
              matchCategory: v.matchCategory,
              matchScore: v.matchScore,
              userFacingMatchLabel: v.userFacingMatchLabel,
              sentiment: 'positive',
              supportingObservations: v.supportingObservations,
              contentDescription: v.contentDescription,
            });
          }

          for (const p of amazonPhotos) {
            discoveredCandidates.push({
              title: p.title,
              sourceUrl: p.sourceUrl,
              mediaUrl: p.mediaUrl,
              thumbnailUrl: p.mediaUrl,
              platform: 'amazon',
              mediaType: 'photo',
              provenance: p.provenance,
              verifiedPurchaseEvidence: p.verifiedPurchaseEvidence,
              matchCategory: p.matchCategory,
              matchScore: p.matchScore,
              userFacingMatchLabel: p.userFacingMatchLabel,
              sentiment: 'positive',
              supportingObservations: p.supportingObservations,
              contentDescription:
                p.provenance === 'seller_manufacturer_demo'
                  ? 'صورة المنتج المطابق 100% من صفحة البائع على أمازون أمريكا'
                  : 'صورة مراجعة عميل إيجابية للمنتج المطابق 100% من أمازون أمريكا',
            });
          }
        }

        // 2C. Continue with Web Grounding ONLY if zero matching Amazon candidates were found and Gemini is available
        const currentVidCount =
          (project.candidates || []).filter((c) => c.mediaType === 'video').length +
          discoveredCandidates.filter((c) => c.mediaType === 'video').length;
        const currentPhotoCount =
          (project.candidates || []).filter((c) => c.mediaType === 'photo').length +
          discoveredCandidates.filter((c) => c.mediaType === 'photo').length;
        const needsMoreVideos = wantVideo && currentVidCount === 0;
        const needsMorePhotos = wantPhoto && currentPhotoCount === 0;

        if (
          (needsMoreVideos || needsMorePhotos) &&
          !quotaExhaustedOccurred &&
          isGeminiConfigured() &&
          project.productProfile
        ) {
          try {
            const webSources = await discoverProductWebSources(
              project.productProfile,
              project.settings,
              () => {
                quotaExhaustedOccurred = true;
              }
            );
            for (const src of webSources) {
              if (!seenAmazonUrls.has(src.url)) {
                webSourcesToExtract.push(src);
              }
            }
          } catch (err: unknown) {
            if (isQuotaExhaustedError(err)) {
              quotaExhaustedOccurred = true;
            }
          }
        }
      }

      discoveryMs = Math.round(performance.now() - tDiscStart);

      if (quotaExhaustedOccurred && discoveredCandidates.length === 0) {
        updateState(
          'searching',
          'حصة البحث غير متاحة مؤقتاً (429) — يمكنك إعادة المحاولة يدوياً أو إضافة روابط مباشرة من التفاصيل.',
          'warn'
        );
      }

      if (isCancelled()) return;

      // 2D. Concurrent extraction from any additional non-Amazon web sources (max 3 total, max 2 per host)
      // This fallback has no visual identity verifier: never use it to bypass the image gate.
      if (!refBase64 && webSourcesToExtract.length > 0 && project.settings.contentSources !== 'customer_only') {
        await runWithHostBoundedConcurrency(
          webSourcesToExtract,
          (src) => src.url,
          3,
          2,
          async (src) => {
            if (isCancelled()) return;
            const titleCheck = evaluateStrictProductTitleMatch(
              src.title,
              project.productProfile?.suggestedNameEn || project.name,
              project.name,
              project.productProfile?.mustMatchAttributes
            );
            if (!titleCheck.approved || !isPositiveReviewVideo(src.title)) return;

            const isYt = src.url.includes('youtube.com') || src.url.includes('youtu.be');
            const isAmz = src.url.includes('amazon.');
            const platform = isYt ? 'youtube' : isAmz ? 'amazon' : 'direct_web';

            if (wantVideo) {
              if (isAmz) {
                const allowSellerDemos = project.settings?.contentSources === 'all_including_seller';
                const amzVids = await fetchAmazonUsProductVideos(src.url, abortController.signal, allowSellerDemos);
                for (const v of amzVids) {
                  discoveredCandidates.push({
                    title: v.title,
                    sourceUrl: v.sourceUrl,
                    productListingUrl: v.productListingUrl,
                    mediaUrl: v.mediaUrl,
                    thumbnailUrl: v.thumbnailUrl,
                    reviewerOrChannel: v.reviewerOrChannel,
                    reviewId: v.reviewId,
                    platform: 'amazon',
                    mediaType: 'video',
                    provenance: v.provenance,
                    matchCategory: 'exact_design',
                    matchScore: titleCheck.matchScore,
                    userFacingMatchLabel: 'نفس المنتج (تطابق 100%)',
                    sentiment: 'positive',
                    supportingObservations: [titleCheck.reasonAr],
                    contentDescription: v.contentDescription,
                  });
                }
              } else {
                let directVid: string | undefined;
                if (!isYt) {
                  try {
                    directVid = await resolvePublicVideo(src.url, abortController.signal);
                  } catch {}
                }
                discoveredCandidates.push({
                  title: src.title,
                  sourceUrl: src.url,
                  mediaUrl: directVid,
                  platform,
                  mediaType: 'video',
                  provenance: 'unresolved_source',
                  thumbnailUrl: '',
                  matchCategory: 'exact_design',
                  matchScore: titleCheck.matchScore,
                  userFacingMatchLabel: 'نفس المنتج (تطابق 100%)',
                  sentiment: 'positive',
                  supportingObservations: [titleCheck.reasonAr],
                  contentDescription: src.snippet || 'مراجعة إيجابية وتجربة للمنتج تم اكتشافها عبر الويب',
                });
              }
            }

            if (wantPhoto && !isYt) {
              const currentPhotoCandidates = discoveredCandidates.filter(
                (c) => c.mediaType === 'photo'
              ).length;
              if (currentPhotoCandidates < maxPhotos * 1.3) {
                try {
                  const pagePhotos = await resolvePublicPhotos(
                    src.url,
                    Math.max(10, maxPhotos - currentPhotoCandidates),
                    abortController.signal
                  );
                  for (const p of pagePhotos) {
                    discoveredCandidates.push({
                      title: p.title || src.title,
                      sourceUrl: p.sourceUrl,
                      mediaUrl: p.mediaUrl,
                      thumbnailUrl: p.mediaUrl,
                      platform,
                      mediaType: 'photo',
                      provenance: p.provenance,
                      verifiedPurchaseEvidence: p.verifiedPurchaseEvidence,
                      matchCategory: 'exact_design',
                      matchScore: titleCheck.matchScore,
                      userFacingMatchLabel: 'نفس المنتج (تطابق 100%)',
                      sentiment: 'positive',
                      supportingObservations: [titleCheck.reasonAr],
                      contentDescription:
                        p.provenance === 'seller_manufacturer_demo'
                          ? 'صورة المنتج من صفحة البائع'
                          : 'صورة مراجعة مستخرجة من المصدر',
                    });
                  }
                } catch {}
              }
            }
          },
          isCancelled
        );
      }
      extractionMs = Math.round(performance.now() - tExtStart);

      if (isCancelled()) return;

      // Merge existing candidates (preserving manual links!) with newly discovered ones
      const existingCandidates = (project.candidates || []).filter(c => c.projectId === project.id && c.searchInputFingerprint === searchFingerprint);
      const combinedCandidates = [...existingCandidates, ...discoveredCandidates];
      project.counters.candidatesDiscovered = combinedCandidates.length;

      // ==========================================
      // STAGE 3: Inspecting, Deduplication & Independent Quotas (+ Reserve Pool)
      // ==========================================
      updateState('inspecting', 'جاري تصفية النتائج واستبعاد المكررات حسب الأعداد المطلوبة...');

      const inspectedAssets: CandidateAsset[] = [];
      const reserveVideoAssets: CandidateAsset[] = [];
      const reservePhotoAssets: CandidateAsset[] = [];
      const allAcceptedPool: CandidateAsset[] = [];
      let rejectedDuplicatesCount = 0;
      let collectedVideos = 0;
      let collectedPhotos = 0;

      for (let i = 0; i < combinedCandidates.length; i++) {
        if (isCancelled()) return;

        const candidate = combinedCandidates[i];
        project.counters.sourcesInspected = i + 1;

        const candMediaType: 'video' | 'photo' = candidate.mediaType === 'photo' ? 'photo' : 'video';

        if (!matchesMediaType(candMediaType, project.mediaTypeRequested)) {
          continue;
        }

        // Enforce 100% positive sentiment & non-negative title on every video
        if (candMediaType === 'video') {
          if (candidate.sentiment === 'negative') continue;
          if (candidate.title && !isPositiveReviewVideo(candidate.title)) continue;
        }

        const dupCheck = isDuplicateCandidate(candidate, allAcceptedPool);
        if (dupCheck.isDuplicate) {
          rejectedDuplicatesCount++;
          project.counters.rejectedDuplicates = rejectedDuplicatesCount;
          continue;
        }

        const category = candidate.matchCategory || 'insufficient_evidence';
        if (category === 'mismatched') {
          continue;
        }
        if (
          category !== 'insufficient_evidence' &&
          !matchesStrictness(category, project.settings.strictness)
        ) {
          continue;
        }

        const assetId = candidate.id || `ast-${project.id}-${allAcceptedPool.length + 1}`;
        const sha =
          candidate.sha256 ||
          computeSha256(
            `${candidate.sourceUrl}-${candidate.mediaUrl || ''}-${candidate.title}-${candidate.platformAssetId}`
          );

        const asset: CandidateAsset = {
          searchInputFingerprint: searchFingerprint,
          id: assetId,
          projectId: project.id,
          title: candidate.title || 'مراجعة إيجابية للمنتج',
          mediaType: candMediaType,
          platform: candidate.platform || 'amazon',
          sourceUrl: candidate.sourceUrl || 'https://www.amazon.com',
          productListingUrl: candidate.productListingUrl || project.productListingUrl,
          reviewerOrChannel: candidate.reviewerOrChannel || '',
          platformAssetId: candidate.platformAssetId,
          reviewId: candidate.reviewId,
          thumbnailUrl:
            candidate.thumbnailUrl || (candMediaType === 'photo' ? candidate.mediaUrl || '' : ''),
          mediaUrl: candidate.mediaUrl,
          provenance: candidate.provenance || 'unresolved_source',
          verifiedPurchaseEvidence: candidate.verifiedPurchaseEvidence,
          incentiveDisclosure: candidate.incentiveDisclosure,
          matchCategory: category,
          matchScore: candidate.matchScore ?? 0,
          userFacingMatchLabel: candidate.userFacingMatchLabel || 'المطابقة تحتاج مراجعة',
          visibleDifferences: candidate.visibleDifferences || [],
          supportingObservations: candidate.supportingObservations || [],
          unknowns: candidate.unknowns || [],
          contentDescription: candidate.contentDescription || 'عرض وتقييم إيجابي للمنتج',
          sentiment: candidate.sentiment || 'neutral',
          durationSeconds: candidate.durationSeconds,
          dimensions: candidate.dimensions,
          hasAudio: candidate.hasAudio,
          fileSizeBytes: candidate.fileSizeBytes,
          sha256: sha,
          downloadStatus: candidate.downloadStatus || 'pending',
          localFilePath: candidate.localFilePath,
          downloadError: candidate.downloadError,
          collectedAt: candidate.collectedAt || new Date().toISOString(),
          rightsStatus: 'unknown',
          selectedForExport: true,
        };

        allAcceptedPool.push(asset);

        if (candMediaType === 'video') {
          if (collectedVideos < maxVideos) {
            inspectedAssets.push(asset);
            collectedVideos++;
          } else {
            reserveVideoAssets.push(asset);
          }
        } else {
          if (collectedPhotos < maxPhotos) {
            inspectedAssets.push(asset);
            collectedPhotos++;
          } else {
            reservePhotoAssets.push(asset);
          }
        }
      }

      if (isCancelled()) return;

      project.counters.visuallyMatchedAssets = inspectedAssets.filter(
        (a) => a.matchCategory === 'exact_design' || a.matchCategory === 'permitted_variation'
      ).length;

      // Stream initial candidates immediately so UI doesn't wait for all downloads
      project.candidates = inspectedAssets;
      storage.upsertProject(project);
      this.broadcast(projectId, { project });

      // ==========================================
      // STAGE 4: Concurrent Real Downloads & Verification + Reserve Backfill (max 3 total, max 2 per host)
      // ==========================================
      const tDlStart = performance.now();
      const verifiedShaSet = new Set<string>();

      const downloadAndVerifySingleAsset = async (asset: CandidateAsset): Promise<boolean> => {
        if (isCancelled()) return false;

        if (
          asset.downloadStatus === 'verified_available' &&
          asset.localFilePath &&
          fs.existsSync(asset.localFilePath)
        ) {
          if (asset.sha256) verifiedShaSet.add(asset.sha256);
          return true;
        }

        let targetUrl = asset.mediaUrl;
        if (!targetUrl) {
          if (asset.mediaType === 'video') {
            try {
              targetUrl = await resolvePublicVideo(asset.sourceUrl, abortController.signal);
              asset.mediaUrl = targetUrl;
            } catch {}
          } else {
            try {
              const photos = await resolvePublicPhotos(asset.sourceUrl, 1, abortController.signal);
              if (photos.length > 0) {
                targetUrl = photos[0].mediaUrl;
                asset.mediaUrl = targetUrl;
                asset.thumbnailUrl = targetUrl;
                if (asset.provenance === 'unresolved_source') {
                  asset.provenance = photos[0].provenance;
                }
              }
            } catch {}
          }
        }

        if (
          !targetUrl ||
          (asset.mediaType === 'video' &&
            (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')))
        ) {
          asset.downloadStatus = 'source_only';
          asset.downloadError =
            'متاح للمشاهدة على المصدر الأصلي ولا يتوفر ملف مباشر غير محمي.';
          storage.upsertProject(project);
          this.broadcast(projectId, { project, assetUpdated: asset });
          return false;
        }

        asset.downloadStatus = 'downloading';
        this.broadcast(projectId, { project, assetUpdated: asset });

        const dlResult = await downloadMedia(
          targetUrl,
          asset.id,
          asset.mediaType,
          60 * 1024 * 1024,
          abortController.signal
        );

        // If the downloaded file has the exact same SHA-256 bytes as an already-verified file in this project, reject it as a duplicate stream
        if (
          dlResult.status === 'verified_available' &&
          dlResult.sha256 &&
          verifiedShaSet.has(dlResult.sha256)
        ) {
          rejectedDuplicatesCount++;
          project.counters.rejectedDuplicates = rejectedDuplicatesCount;
          asset.downloadStatus = 'download_failed';
          asset.downloadError = 'ملف مكرر مطابق لبصمة فيديو آخر تم سحبه';
          return false;
        }

        asset.downloadStatus = dlResult.status;
        asset.localFilePath = dlResult.localFilePath;
        asset.sha256 = dlResult.sha256 || asset.sha256;
        asset.fileSizeBytes = dlResult.fileSizeBytes || asset.fileSizeBytes;
        asset.downloadError = dlResult.error;
        if (dlResult.durationSeconds) asset.durationSeconds = dlResult.durationSeconds;
        if (dlResult.width && dlResult.height) {
          asset.dimensions = { width: dlResult.width, height: dlResult.height };
        }

        if (dlResult.status === 'verified_available' && asset.sha256) {
          verifiedShaSet.add(asset.sha256);
        }

        const readyCount = project.candidates.filter(
          (a) => a.downloadStatus === 'verified_available'
        ).length;
        project.counters.downloadedAssets = readyCount;
        project.counters.verifiedAssets = readyCount;

        // Stream each ready asset immediately to the UI!
        storage.upsertProject(project);
        this.broadcast(projectId, { project, assetUpdated: asset });

        return dlResult.status === 'verified_available';
      };

      if (inspectedAssets.length > 0) {
        updateState(
          'downloading',
          `جاري فحص وسحب الملفات المؤهلة (${inspectedAssets.length} عنصر)...`
        );

        await runWithHostBoundedConcurrency(
          inspectedAssets,
          (asset) => asset.mediaUrl || asset.sourceUrl,
          3,
          2,
          async (asset) => {
            await downloadAndVerifySingleAsset(asset);
          },
          isCancelled
        );

        // Backfill from reserveVideoAssets / reservePhotoAssets if any initial candidate failed verification or was a duplicate stream
        const backfillType = async (
          mediaType: 'video' | 'photo',
          targetQuota: number,
          reserves: CandidateAsset[]
        ) => {
          if (targetQuota <= 0 || reserves.length === 0 || isCancelled()) return;

          while (!isCancelled() && reserves.length > 0) {
            const currentVerified = inspectedAssets.filter(
              (a) => a.mediaType === mediaType && a.downloadStatus === 'verified_available'
            ).length;
            if (currentVerified >= targetQuota) break;

            const needed = targetQuota - currentVerified;
            const batch = reserves.splice(0, Math.min(reserves.length, needed + 1));

            await runWithHostBoundedConcurrency(
              batch,
              (asset) => asset.mediaUrl || asset.sourceUrl,
              3,
              2,
              async (reserveAsset) => {
                if (isCancelled()) return;
                const nowVerified = inspectedAssets.filter(
                  (a) => a.mediaType === mediaType && a.downloadStatus === 'verified_available'
                ).length;
                if (nowVerified >= targetQuota) return;

                const ok = await downloadAndVerifySingleAsset(reserveAsset);
                if (ok) {
                  // Replace a non-verified asset of the same mediaType or append if below targetQuota
                  const failedIdx = inspectedAssets.findIndex(
                    (a) => a.mediaType === mediaType && a.downloadStatus !== 'verified_available'
                  );
                  if (failedIdx !== -1) {
                    inspectedAssets[failedIdx] = reserveAsset;
                  } else if (
                    inspectedAssets.filter((a) => a.mediaType === mediaType).length < targetQuota
                  ) {
                    inspectedAssets.push(reserveAsset);
                  }
                  project.candidates = inspectedAssets;
                  const readyCount = inspectedAssets.filter(
                    (a) => a.downloadStatus === 'verified_available'
                  ).length;
                  project.counters.downloadedAssets = readyCount;
                  project.counters.verifiedAssets = readyCount;
                  storage.upsertProject(project);
                  this.broadcast(projectId, { project, assetUpdated: reserveAsset });
                }
              },
              isCancelled
            );
          }
        };

        await backfillType('video', maxVideos, reserveVideoAssets);
        await backfillType('photo', maxPhotos, reservePhotoAssets);
      }
      downloadMs = Math.round(performance.now() - tDlStart);

      if (isCancelled()) return;

      // ==========================================
      // STAGE 5: Verifying & Terminal State Finalization
      // ==========================================
      const tVerStart = performance.now();
      project.candidates = inspectedAssets;
      const verifiedCount = inspectedAssets.filter(
        (a) => a.downloadStatus === 'verified_available'
      ).length;
      project.counters.downloadedAssets = verifiedCount;
      project.counters.verifiedAssets = verifiedCount;
      verificationMs = Math.round(performance.now() - tVerStart);

      const totalMs = Math.round(performance.now() - jobStartMs);
      this.lastTimings.set(projectId, {
        discoveryMs,
        extractionMs,
        downloadMs,
        verificationMs,
        totalMs,
      });

      if (inspectedAssets.length === 0) {
        if (quotaExhaustedOccurred) {
          updateState(
            'completed_partial',
            'حصة البحث غير متاحة مؤقتاً — يمكنك إعادة المحاولة يدوياً أو إضافة روابط مباشرة من التفاصيل.',
            'warn'
          );
        } else {
          updateState(
            'completed_partial',
            'لم يتم العثور على نتائج مطابقة تلقائياً. يمكنك إضافة روابط مباشرة من التفاصيل.',
            'warn'
          );
        }
      } else if (verifiedCount >= targetTotal) {
        updateState(
          'completed',
          `اكتمل البحث بنجاح (${verifiedCount} ملف جاهز للتنزيل).`,
          'success'
        );
      } else if (verifiedCount > 0) {
        updateState(
          'completed_partial',
          `اكتمل البحث جزئياً: ${verifiedCount} ملف جاهز للتنزيل و ${inspectedAssets.length - verifiedCount} رابط مصدر.`,
          'warn'
        );
      } else {
        updateState(
          'completed_partial',
          quotaExhaustedOccurred
            ? 'حصة البحث غير متاحة مؤقتاً — يمكنك إعادة المحاولة يدوياً أو إضافة روابط مباشرة من التفاصيل.'
            : `تم العثور على ${inspectedAssets.length} رابط مصدر للمشاهدة المباشرة.`,
          'warn'
        );
      }
    } catch (err) {
      console.error('[Worker Error]', err);
      updateState('failed', `فشلت العملية: ${(err as Error).message}`, 'error');
    } finally {
      this.activeJobs.delete(projectId);
      this.jobAbortControllers.delete(projectId);
    }
  }
}
