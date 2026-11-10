import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { computeOwnerPrecisionStats } from './ownerFeedback.ts';
import type {
  VerdictTier,
  EvidenceLevel,
  LinkState,
  DiscriminatorSpec,
  StopReasonCode,
  ReasonHistogramEntry,
  FunnelStageSummary,
  SourceFunnelBreakdown,
  QueryPlanRow,
  QueryScoreboardRow,
  RejectedCandidateItem,
  RejectionOverrideWarning,
  TikTokProviderProbeItem,
  SearchBreakdownSummary,
  AttributeStrength,
} from '../../types/index.ts';

export type ReasonCodePrefix =
  | 'rejected_other_type'
  | 'rejected_hard_attribute'
  | 'rejected_must_not_be'
  | 'low_similarity'
  | 'duplicate'
  | 'dead_listing'
  | 'no_videos'
  | 'verification_error'
  | 'budget_exhausted'
  | 'blocked_captcha'
  | 'login_wall'
  | 'provider_failed'
  | 'no_candidates'
  | 'download_failed';

export function isErrorNotRejectionReason(reasonCode?: string | null): boolean {
  if (!reasonCode) return false;
  return (
    reasonCode === 'verification_error' ||
    reasonCode.startsWith('verification_error:') ||
    reasonCode === 'budget_exhausted' ||
    reasonCode.startsWith('budget_exhausted:')
  );
}

export function getReasonCodeLabelAr(reasonCode?: string | null): string {
  if (!reasonCode) return 'غير محدد';
  const clean = reasonCode.trim();
  if (clean === 'rejected_other_type') return 'نوع منتج مختلف (Other Type)';
  if (clean.startsWith('rejected_hard_attribute:')) {
    const attr = clean.slice('rejected_hard_attribute:'.length).trim();
    return `تعارض سمة أساسية (HARD): ${attr}`;
  }
  if (clean.startsWith('rejected_must_not_be:')) {
    const term = clean.slice('rejected_must_not_be:'.length).trim();
    return `مستبعد بقائمة الاستبعاد (mustNotBe): ${term}`;
  }
  if (clean === 'low_similarity') return 'تشابه بصري محلي منخفض (Low CLIP Similarity)';
  if (clean === 'duplicate') return 'عنصر أو فيديو مكرر (Duplicate)';
  if (clean === 'dead_listing') return 'صفحة منتج معطلة 404 (Dead Listing)';
  if (clean === 'no_videos') return 'المنتج مقبول ولكن لا يحتوي على فيديوهات مراجعات';
  if (clean === 'verification_error' || clean.startsWith('verification_error:')) {
    return 'خطأ تقني في التحقق (Gemini Timeout/429 — لا يُحتسب كمرفوض)';
  }
  if (clean === 'budget_exhausted' || clean.startsWith('budget_exhausted:')) {
    return 'استنفاد ميزانية Gemini اليومية (لا يُحتسب كمرفوض)';
  }
  if (clean === 'blocked_captcha') return 'حظر CAPTCHA / تحدي روبوت';
  if (clean === 'login_wall') return 'جدار تسجيل دخول (Login Wall)';
  if (clean.startsWith('provider_failed:')) {
    const prov = clean.slice('provider_failed:'.length).trim();
    return `فشل مزود المصدر (${prov})`;
  }
  if (clean === 'no_candidates') return 'لا توجد نتائج مرشحة من المزود';
  if (clean === 'download_failed' || clean.startsWith('download_failed:')) {
    const detail = clean.includes(':') ? clean.slice(clean.indexOf(':') + 1).trim() : '';
    return detail ? `تعذر تنزيل الفيديو (${detail}) — متاح كعرض Embed` : 'تعذر تنزيل الفيديو المباشر — متاح كعرض Embed';
  }
  return clean;
}

export function getStopReasonLabelAr(code: StopReasonCode): string {
  if (code.startsWith('provider_failed:')) {
    const prov = code.slice('provider_failed:'.length);
    return `فشل مزود المصدر (${prov}) (${code})`;
  }
  switch (code) {
    case 'target_reached':
      return 'اكتمل العدد المطلوب (target_reached)';
    case 'exhausted_candidates':
      return 'نفدت المرشحات المتاحة بعد فحص جميع الجولات والأسواق (exhausted_candidates)';
    case 'insufficient_search':
      return 'توقف البحث قبل استيفاء الحد الأدنى من الجولات والمرشحات (insufficient_search)';
    case 'amazon_blocked':
      return 'توقف بسبب حظر أمازون CAPTCHA / 503 (amazon_blocked)';
    case 'tiktok_unreachable':
      return 'تعذر الوصول لمزودات تيك توك (tiktok_unreachable)';
    case 'gemini_budget':
      return 'توقف لاستنفاد ميزانية Gemini اليومية (gemini_budget)';
    case 'timeout':
      return 'انتهت مهلة البحث القصوى (timeout)';
    case 'user_cancelled':
      return 'تم الإيقاف بطلب المستخدم (user_cancelled)';
    default:
      return 'نفدت المرشحات المتاحة (exhausted_candidates)';
  }
}

export function normalizeLegacyReasonCode(entry: {
  rejectionReason?: string | null;
  stage?: string;
  finalDecision?: string;
  attributeVerdicts?: AttributeVerdictTrace;
}): string {
  if (entry.finalDecision === 'unverified_ai_fallback' || entry.finalDecision === 'unverified') {
    if (entry.stage === 'budget_fallback' || entry.rejectionReason?.includes('budget')) {
      return 'budget_exhausted';
    }
    return 'verification_error';
  }
  const raw = (entry.rejectionReason || '').trim();
  if (
    raw === 'rejected_other_type' ||
    raw.startsWith('rejected_hard_attribute:') ||
    raw.startsWith('rejected_must_not_be:') ||
    raw === 'low_similarity' ||
    raw === 'duplicate' ||
    raw === 'dead_listing' ||
    raw === 'no_videos' ||
    raw === 'verification_error' ||
    raw.startsWith('verification_error:') ||
    raw === 'budget_exhausted' ||
    raw === 'blocked_captcha' ||
    raw === 'login_wall' ||
    raw.startsWith('provider_failed:') ||
    raw === 'no_candidates' ||
    raw === 'download_failed' ||
    raw.startsWith('download_failed:')
  ) {
    return raw;
  }
  const mustNotBe = entry.attributeVerdicts?.mustNotBeHit;
  if (Array.isArray(mustNotBe) && mustNotBe.length > 0) {
    return `rejected_must_not_be:${mustNotBe[0]}`;
  }
  if (entry.attributeVerdicts?.failedHardAttributes && entry.attributeVerdicts.failedHardAttributes.length > 0) {
    return `rejected_hard_attribute:${entry.attributeVerdicts.failedHardAttributes[0]}`;
  }
  if (entry.stage === 'visual_stage1_clip' || entry.stage === 'visual_stage1_local' || raw.includes('visual_stage1')) {
    return 'low_similarity';
  }
  if (entry.stage === 'dedupe' || raw.includes('duplicate')) {
    return 'duplicate';
  }
  if (entry.stage === 'dead_listing_check' || raw.includes('dead_listing')) {
    return 'dead_listing';
  }
  if (raw.includes('no_videos')) {
    return 'no_videos';
  }
  if (raw.includes('unverified') || raw.includes('timeout')) {
    return 'verification_error';
  }
  return 'rejected_other_type';
}

export interface AttributeVerdictTrace {
  formFactorMatches?: boolean;
  mechanismMatches?: boolean;
  colorMatches?: boolean;
  mustMatchHits?: string[];
  failedAttribute?: string;
  failedHardAttributes?: string[];
  failedSoftAttributes?: string[];
  notVisibleHardAttributes?: string[];
  mustNotBeHit?: string[];
  verdict?:
    | 'same_design'
    | 'variant'
    | 'similar_other_type'
    | 'unrelated'
    | 'unverified_by_ai'
    | 'unverified_ai_fallback';
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  linkState?: LinkState;
  confidence?: number;
  reasonAr?: string;
}

export interface CandidateDecisionTrace {
  boundingBoxes?:import("../../types/index.ts").BoundingBox2D[];blindObservations?:import("../../types/index.ts").BlindDiscriminatorObservation[];linkStateReasonAr?:string;
  timestamp: string;
  source: 'amazon' | 'tiktok' | 'youtube' | string;
  marketplace?: string;
  provider?: string;
  query?: string;
  round?: string;
  entityType: 'listing' | 'video';
  id: string;
  parentId?: string;
  title: string;
  url: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  thumbnailSource?:
    | 'video_frame'
    | 'real_video_frame'
    | 'amazon_slate'
    | 'product_listing_image'
    | 'tiktok_cover'
    | 'none';
  perceptualHash?: string;
  referenceSimilarity: number | null;
  cropClipSimilarity?: number | null;
  attributeVerdicts: AttributeVerdictTrace;
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  linkState?: LinkState;
  extractedFrameUrls?: string[];
  stage:
    | 'text_gate'
    | 'iterative_name_relaxation'
    | 'visual_stage1_clip'
    | 'visual_stage1_local'
    | 'visual_stage2_gemini'
    | 'visual_timeout_fallback'
    | 'budget_fallback'
    | 'video_keyframe_verify'
    | 'video_keyframes'
    | 'dedupe'
    | 'dead_listing_check'
    | 'no_videos_check'
    | 'emitted';
  finalDecision: 'accepted' | 'rejected' | 'unverified_ai_fallback' | 'unverified';
  reasonCode?: string | null;
  failedAttribute?: string;
  rejectionReason: string | null;
  rejectionReasonAr: string | null;
  keyframesExtracted?: number;
  downloadFailedButKept?: boolean;
  downloadFailureReason?: string;
  embedHtml?: string;
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

export interface SearchRoundTrace {
  timestamp: string;
  round: string;
  source: string;
  marketplace?: string;
  sortVariant?: string;
  query: string;
  page: number;
  candidatesFound: number;
  newCandidatesCount?: number;
  verifiedCount: number;
  videosFoundCount?: number;
  videosFound?: number;
  durationMs: number;
  status: 'ok' | 'empty' | 'blocked' | 'timeout' | 'error';
  error?: string;
}

export interface SearchDecisionTrace {
  searchId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  request: {
    productName: string;
    productUrl?: string;
    mediaType: string;
    sourcePlatform: string;
    targetVideoCount: number;
    targetAmazonVideoCount?: number;
    targetTikTokVideoCount?: number;
    hasReferenceImage: boolean;
    matchMode: 'same_design' | 'strict_color';
    includeSimilar?: boolean;
  };
  settingsUsed?: Record<string, any>;
  relaxationPassesRun?: number;
  queryScoreboard?: QueryScoreboardRow[];
  identityResolution: {
    imageHash?: string;
    durationMs?: number;
    profileResolved: boolean;
    emergencyFallbackUsed: boolean;
    suggestedNameEn?: string;
    suggestedNameAr?: string;
    formFactor?: string;
    mechanism?: string;
    discriminators?: DiscriminatorSpec[];
    sameCategoryLookalikes?: string[];
    mustMatch: string[];
    attributeStrengths?: Record<string, AttributeStrength>;
    mustNotBe: string[];
    variableAttributes: string[];
    queriesTried: string[];
    error?: string;
  };
  marketplaceProbes?: Array<{
    marketplace: string;
    enabled: boolean;
    httpStatus: number;
    exposesVideos: boolean;
    reason: string;
  }>;
  providerProbes?: TikTokProviderProbeItem[];
  tiktokProbes?: TikTokProviderProbeItem[];
  tiktokProviderFunnels?: Array<{
    provider: string;
    query?: string;
    serpResults: number;
    tiktokUrlsParsed: number;
    oembedOk: number;
    preRankedPassed: number;
    sentToFrameVerification: number;
    acceptedCount: number;
  }>;
  rounds: SearchRoundTrace[];
  searchRounds: SearchRoundTrace[];
  candidates: CandidateDecisionTrace[];
  fetchedResponses: Array<{
    asin: string;
    marketplace: string;
    url: string;
    httpStatus: number;
    fetchedAt: string;
    snippetHash: string;
  }>;
  summary: {
    requestedVideos: number;
    emittedVideos: number;
    unverifiedVideosCount?: number;
    unverifiedListingsCount?: number;
    verificationErrorsCount?: number;
    budgetExhaustedCount?: number;
    pagesFetched: number;
    listingsDiscovered: number;
    listingsDeduped?: number;
    listingsInspected: number;
    listingsAccepted: number;
    listingsRejected: number;
    videosDiscovered: number;
    videosAccepted?: number;
    videosEmitted: number;
    videosRejected: number;
    deadListingsCount: number;
    noProvenanceDropped: number;
    duplicateAsinsSkipped?: number;
    duplicateVideosSkipped: number;
    productImageUsedAsPosterCount: number;
    realVideoFramePosterCount: number;
    keyframesExtractedCount?: number;
    keyframesFailedCount?: number;
    tiktokDownloadFailedButKeptCount?: number;
    geminiCallsUsed?: number;
    relaxationPassesRun?: number;
    timeoutsCount: number;
    stopReasonCode?: StopReasonCode;
    stopReasons: Record<string, string>;
    filtersFired: Record<string, number>;
  };
  derivedDiagnostics?: SearchBreakdownSummary;
}

const TRACES_DIR = path.join(DATA_DIR, 'traces');
const memoryTraces = new Map<string, SearchDecisionTrace>();
let latestSearchId: string | null = null;

function ensureTracesDir(): void {
  try {
    if (!fs.existsSync(TRACES_DIR)) {
      fs.mkdirSync(TRACES_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[SearchTrace] Failed to create traces dir:', (err as Error)?.message);
  }
}

export function createSearchTrace(
  searchId: string,
  request: SearchDecisionTrace['request'],
  settingsUsed?: Record<string, any>
): SearchDecisionTrace {
  ensureTracesDir();
  const roundsArr: SearchRoundTrace[] = [];
  const probesArr: TikTokProviderProbeItem[] = [];
  const trace: SearchDecisionTrace = {
    searchId,
    startedAt: new Date().toISOString(),
    request,
    settingsUsed,
    relaxationPassesRun: 1,
    queryScoreboard: [],
    identityResolution: {
      profileResolved: false,
      emergencyFallbackUsed: false,
      mustMatch: [],
      mustNotBe: [],
      variableAttributes: [],
      queriesTried: [],
    },
    marketplaceProbes: [],
    providerProbes: probesArr,
    tiktokProbes: probesArr,
    rounds: roundsArr,
    searchRounds: roundsArr,
    candidates: [],
    fetchedResponses: [],
    summary: {
      requestedVideos: request.targetVideoCount,
      emittedVideos: 0,
      unverifiedVideosCount: 0,
      unverifiedListingsCount: 0,
      verificationErrorsCount: 0,
      budgetExhaustedCount: 0,
      pagesFetched: 0,
      listingsDiscovered: 0,
      listingsDeduped: 0,
      listingsInspected: 0,
      listingsAccepted: 0,
      listingsRejected: 0,
      videosDiscovered: 0,
      videosEmitted: 0,
      videosRejected: 0,
      deadListingsCount: 0,
      noProvenanceDropped: 0,
      duplicateAsinsSkipped: 0,
      duplicateVideosSkipped: 0,
      productImageUsedAsPosterCount: 0,
      realVideoFramePosterCount: 0,
      keyframesExtractedCount: 0,
      keyframesFailedCount: 0,
      tiktokDownloadFailedButKeptCount: 0,
      geminiCallsUsed: 0,
      timeoutsCount: 0,
      stopReasons: {},
      filtersFired: {},
    },
  };
  memoryTraces.set(searchId, trace);
  latestSearchId = searchId;
  persistSearchTrace(trace);
  return trace;
}

export function recordFetchedResponse(
  trace: SearchDecisionTrace,
  response: {
    asin: string;
    marketplace: string;
    url: string;
    httpStatus: number;
    fetchedAt?: string;
    snippetHash?: string;
  }
): void {
  trace.fetchedResponses.push({
    asin: response.asin.toUpperCase(),
    marketplace: response.marketplace,
    url: response.url,
    httpStatus: response.httpStatus,
    fetchedAt: response.fetchedAt || new Date().toISOString(),
    snippetHash: response.snippetHash || response.asin,
  });
}

export function recordCandidateDecision(
  trace: SearchDecisionTrace,
  decision: Omit<CandidateDecisionTrace, 'timestamp'>
): void {
  const normalizedCode =
    decision.finalDecision === 'accepted'
      ? decision.downloadFailedButKept
        ? `download_failed:${decision.downloadFailureReason || 'direct_mp4_unavailable'}`
        : null
      : decision.reasonCode || normalizeLegacyReasonCode(decision);

  const isUnverifiedOrError =
    decision.finalDecision === 'unverified_ai_fallback' ||
    decision.finalDecision === 'unverified' ||
    isErrorNotRejectionReason(normalizedCode);

  const finalDecision: CandidateDecisionTrace['finalDecision'] =
    decision.finalDecision === 'accepted'
      ? 'accepted'
      : isUnverifiedOrError
      ? 'unverified'
      : 'rejected';

  const entry: CandidateDecisionTrace = {
    ...decision,
    finalDecision,
    reasonCode: normalizedCode,
    timestamp: new Date().toISOString(),
  };
  trace.candidates.push(entry);

  if (typeof decision.keyframesExtracted === 'number' && decision.keyframesExtracted > 0) {
    trace.summary.keyframesExtractedCount =
      (trace.summary.keyframesExtractedCount || 0) + decision.keyframesExtracted;
  }

  if (decision.entityType === 'listing') {
    if (finalDecision === 'accepted') {
      trace.summary.listingsAccepted++;
    } else if (finalDecision === 'unverified') {
      trace.summary.unverifiedListingsCount = (trace.summary.unverifiedListingsCount || 0) + 1;
      if (normalizedCode?.startsWith('budget_exhausted')) {
        trace.summary.budgetExhaustedCount = (trace.summary.budgetExhaustedCount || 0) + 1;
      } else {
        trace.summary.verificationErrorsCount = (trace.summary.verificationErrorsCount || 0) + 1;
      }
    } else {
      trace.summary.listingsRejected++;
      const reasonKey = normalizedCode || decision.rejectionReason || decision.stage;
      trace.summary.filtersFired[reasonKey] = (trace.summary.filtersFired[reasonKey] || 0) + 1;
    }
  } else if (decision.entityType === 'video') {
    if (finalDecision === 'accepted') {
      trace.summary.videosEmitted++;
      trace.summary.emittedVideos = trace.summary.videosEmitted;
      if (decision.downloadFailedButKept) {
        trace.summary.tiktokDownloadFailedButKeptCount =
          (trace.summary.tiktokDownloadFailedButKeptCount || 0) + 1;
      }
      if (decision.thumbnailSource === 'product_listing_image') {
        trace.summary.productImageUsedAsPosterCount++;
      } else if (
        decision.thumbnailSource === 'real_video_frame' ||
        decision.thumbnailSource === 'video_frame' ||
        decision.thumbnailSource === 'amazon_slate'
      ) {
        trace.summary.realVideoFramePosterCount++;
      }
    } else if (finalDecision === 'unverified') {
      trace.summary.unverifiedVideosCount = (trace.summary.unverifiedVideosCount || 0) + 1;
      if (normalizedCode?.startsWith('budget_exhausted')) {
        trace.summary.budgetExhaustedCount = (trace.summary.budgetExhaustedCount || 0) + 1;
      } else {
        trace.summary.verificationErrorsCount = (trace.summary.verificationErrorsCount || 0) + 1;
      }
    } else {
      trace.summary.videosRejected++;
      const reasonKey = normalizedCode || decision.rejectionReason || decision.stage;
      trace.summary.filtersFired[reasonKey] = (trace.summary.filtersFired[reasonKey] || 0) + 1;
    }
  }
}

export function recordSearchRound(
  trace: SearchDecisionTrace,
  round: Omit<SearchRoundTrace, 'timestamp'>
): void {
  trace.rounds.push({
    ...round,
    timestamp: new Date().toISOString(),
  });
  trace.summary.pagesFetched++;
  if (round.status === 'timeout') {
    trace.summary.timeoutsCount++;
  }
}

function buildFunnelForCandidates(
  scopeKey: string,
  labelAr: string,
  source: 'amazon' | 'tiktok' | 'all',
  candidates: CandidateDecisionTrace[],
  discoveredRawCount: number,
  marketplace?: string,
  provider?: string
): SourceFunnelBreakdown {
  const primaryItems =
    source === 'amazon'
      ? candidates.filter((c) => c.entityType === 'listing')
      : source === 'tiktok'
      ? candidates.filter((c) => c.entityType === 'video' && c.stage !== 'emitted')
          .concat(
            candidates.filter(
              (c) =>
                c.entityType === 'video' &&
                c.stage === 'emitted' &&
                !candidates.some((o) => o.id === c.id && o.stage !== 'emitted')
            )
          )
      : candidates.filter((c) => c.entityType === 'listing' || c.source === 'tiktok');

  const dedupedCount = primaryItems.length;
  const foundCount = Math.max(discoveredRawCount, dedupedCount);
  const dupesDropped = Math.max(0, foundCount - dedupedCount);

  const buildReasonHistogram = (items: CandidateDecisionTrace[]): ReasonHistogramEntry[] => {
    const byCode = new Map<string, CandidateDecisionTrace[]>();
    for (const item of items) {
      const code = item.reasonCode || normalizeLegacyReasonCode(item);
      const list = byCode.get(code) || [];
      list.push(item);
      byCode.set(code, list);
    }
    return Array.from(byCode.entries())
      .map(([code, list]) => ({
        reasonCode: code,
        labelAr: getReasonCodeLabelAr(code),
        count: list.length,
        isErrorNotRejection: isErrorNotRejectionReason(code),
        examples: list.slice(0, 3).map((x) => ({
          id: x.id,
          title: x.title,
          url: x.url,
          imageUrl: x.imageUrl || x.thumbnailUrl,
          reasonAr: x.rejectionReasonAr || x.attributeVerdicts?.reasonAr || getReasonCodeLabelAr(code),
          source: x.source,
        })),
      }))
      .sort((a, b) => b.count - a.count);
  };

  // Stage 1: found
  const stageFound: FunnelStageSummary = {
    stageId: 'found',
    labelAr: '1. المكتشف (Found)',
    inCount: foundCount,
    outCount: foundCount,
    droppedCount: 0,
    reasons: [],
  };

  // Stage 2: deduped
  const stageDeduped: FunnelStageSummary = {
    stageId: 'deduped',
    labelAr: '2. بعد إزالة التكرار (Deduped)',
    inCount: foundCount,
    outCount: dedupedCount,
    droppedCount: dupesDropped,
    reasons:
      dupesDropped > 0
        ? [
            {
              reasonCode: 'duplicate',
              labelAr: getReasonCodeLabelAr('duplicate'),
              count: dupesDropped,
              examples: [],
            },
          ]
        : [],
  };

  // Stage 3: text_prefilter
  const textDropped = primaryItems.filter(
    (c) =>
      c.finalDecision === 'rejected' &&
      (c.stage === 'text_gate' ||
        c.reasonCode?.startsWith('rejected_must_not_be:') ||
        ((c.stage === 'visual_stage1_local' || c.stage === 'visual_stage1_clip') &&
          (c.attributeVerdicts?.mustNotBeHit?.length || 0) > 0))
  );
  const afterTextCount = Math.max(0, dedupedCount - textDropped.length);
  const stageText: FunnelStageSummary = {
    stageId: 'text_prefilter',
    labelAr: '3. الفلترة النصية المسبقة (Text Pre-Filter / mustNotBe)',
    inCount: dedupedCount,
    outCount: afterTextCount,
    droppedCount: textDropped.length,
    reasons: buildReasonHistogram(textDropped),
  };

  // Stage 4: local_visual (CLIP Stage 1)
  const textDroppedIds = new Set(textDropped.map((c) => c.id));
  const localVisualDropped = primaryItems.filter(
    (c) =>
      !textDroppedIds.has(c.id) &&
      c.finalDecision === 'rejected' &&
      (c.stage === 'visual_stage1_local' ||
        c.stage === 'visual_stage1_clip' ||
        c.reasonCode === 'low_similarity')
  );
  const afterLocalVisualCount = Math.max(0, afterTextCount - localVisualDropped.length);
  const stageLocalVisual: FunnelStageSummary = {
    stageId: 'local_visual',
    labelAr: '4. التشابه البصري المحلي (Local CLIP Stage 1)',
    inCount: afterTextCount,
    outCount: afterLocalVisualCount,
    droppedCount: localVisualDropped.length,
    reasons: buildReasonHistogram(localVisualDropped),
  };

  // Stage 5: gemini_attribute_check
  const geminiDropped = primaryItems.filter(
    (c) =>
      !textDroppedIds.has(c.id) &&
      !localVisualDropped.includes(c) &&
      c.finalDecision === 'rejected'
  );
  const geminiUnverified = primaryItems.filter((c) => c.finalDecision === 'unverified');
  const acceptedItems = primaryItems.filter((c) => c.finalDecision === 'accepted');

  const stageGemini: FunnelStageSummary = {
    stageId: 'gemini_attribute_check',
    labelAr: '5. فحص السمات بالذكاء الاصطناعي (Gemini Attribute Check)',
    inCount: afterLocalVisualCount,
    outCount: acceptedItems.length,
    droppedCount: geminiDropped.length,
    unverifiedCount: geminiUnverified.length,
    reasons: buildReasonHistogram([...geminiDropped, ...geminiUnverified]),
  };

  // Stage 6: accepted
  const stageAccepted: FunnelStageSummary = {
    stageId: 'accepted',
    labelAr: '6. المقبول النهائي (Accepted)',
    inCount: acceptedItems.length,
    outCount: acceptedItems.length,
    droppedCount: 0,
    reasons: [],
  };

  return {
    scopeKey,
    labelAr,
    source,
    marketplace,
    provider,
    stages: [
      stageFound,
      stageDeduped,
      stageText,
      stageLocalVisual,
      stageGemini,
      stageAccepted,
    ],
  };
}

function isBlockedRound(r: SearchRoundTrace): boolean {
  if (r.status === 'blocked') return true;
  const err = (r.error || '').toLowerCase();
  return (
    err.includes('captcha') ||
    err.includes('robot check') ||
    err.includes('(503)') ||
    err.includes('(429)') ||
    err.includes('blocked') ||
    err.includes('dogs of amazon')
  );
}

/**
 * PHASE 1 & PHASE 2 SINGLE SOURCE OF TRUTH:
 * Every counter, funnel, reason histogram, query plan row, query scoreboard,
 * rejection audit sample, override warning, top limiting factor sentence,
 * semantic counters, and Markdown+JSON diagnostic report is 100% derived from `trace`.
 */
export function computeDerivedDiagnostics(
  trace: SearchDecisionTrace,
  userFeedback: Array<{
    candidateId: string;
    userAction: 'accept' | 'reject';
    previousRejectionReasonAr?: string;
  }> = [],
  geminiBudgetStatus?: {
    callsUsed: number;
    maxCalls: number;
    exhausted: boolean;
  }
): SearchBreakdownSummary {
  const candidates = trace.candidates || [];
  const rounds = trace.rounds || [];

  // Normalize all candidate decisions
  for (const c of candidates) {
    if (!c.reasonCode && c.finalDecision !== 'accepted') {
      c.reasonCode = normalizeLegacyReasonCode(c);
    }
    if (
      (c.finalDecision === 'unverified_ai_fallback' || isErrorNotRejectionReason(c.reasonCode)) &&
      c.finalDecision !== 'accepted'
    ) {
      c.finalDecision = 'unverified';
    }
  }

  const listingCandidates = candidates.filter((c) => c.entityType === 'listing');
  const videoCandidates = candidates.filter((c) => c.entityType === 'video');

  // Primary evaluated candidates (listings on Amazon + verified/rejected videos on TikTok)
  const primaryEvaluated = candidates.filter(
    (c) =>
      c.entityType === 'listing' ||
      (c.entityType === 'video' && c.source === 'tiktok' && c.stage !== 'emitted') ||
      (c.entityType === 'video' &&
        c.source === 'tiktok' &&
        c.stage === 'emitted' &&
        !candidates.some((o) => o.id === c.id && o.stage !== 'emitted'))
  );

  // Listings counters derived directly from trace.candidates
  const listingsAccepted = listingCandidates.filter((c) => c.finalDecision === 'accepted').length;
  const listingsUnverified = listingCandidates.filter((c) => c.finalDecision === 'unverified').length;
  const listingsRejected = listingCandidates.filter((c) => c.finalDecision === 'rejected').length;
  const listingsInspected = listingCandidates.length;
  const listingsDiscovered = Math.max(
    trace.summary.listingsDiscovered || 0,
    rounds.filter((r) => r.source === 'amazon').reduce((acc, r) => acc + (r.candidatesFound || 0), 0),
    listingsInspected
  );

  // Emitted videos counters derived directly from trace.candidates
  // PHASE 1: V1/V0 and dead links NEVER count toward emittedVideos / target
  const acceptedVideos = videoCandidates.filter(
    (c) =>
      c.finalDecision === 'accepted' &&
      c.stage === 'emitted' &&
      c.evidenceLevel !== 'V0' &&
      c.evidenceLevel !== 'V1' &&
      c.linkState !== 'dead'
  );
  const amazonEmitted = acceptedVideos.filter((c) => c.source === 'amazon').length;
  const tiktokEmitted = acceptedVideos.filter((c) => c.source === 'tiktok').length;
  const emittedVideos = acceptedVideos.length;

  const unverifiedVideosCount = videoCandidates.filter(
    (c) =>
      c.finalDecision === 'unverified' ||
      c.evidenceLevel === 'V0' ||
      c.evidenceLevel === 'V1' ||
      c.linkState === 'dead'
  ).length;

  // Real video frame poster count derived directly from acceptedVideos
  const realVideoFramePosterCount = acceptedVideos.filter(
    (c) =>
      c.thumbnailSource === 'real_video_frame' ||
      c.thumbnailSource === 'video_frame' ||
      c.thumbnailSource === 'amazon_slate' ||
      (c.keyframesExtracted || 0) > 0
  ).length;

  const duplicateVideosSkipped = Math.max(
    trace.summary.duplicateVideosSkipped || 0,
    videoCandidates.filter((c) => c.reasonCode === 'duplicate' || c.stage === 'dedupe').length
  );

  const tiktokDownloadFailedButKeptCount = acceptedVideos.filter(
    (c) => c.source === 'tiktok' && c.downloadFailedButKept
  ).length;

  // PHASE 2.3: Semantic counters across all rejected/unverified items
  const allRejectedCandidates = candidates.filter((c) => c.finalDecision === 'rejected');
  const rejectedTotal = allRejectedCandidates.length;

  const rejected_by_text_prefilter = allRejectedCandidates.filter(
    (c) =>
      c.stage === 'text_gate' ||
      c.reasonCode?.startsWith('rejected_must_not_be:') ||
      (c.attributeVerdicts?.mustNotBeHit?.length || 0) > 0
  ).length;

  const rejected_by_local_visual = allRejectedCandidates.filter(
    (c) =>
      c.stage !== 'text_gate' &&
      !c.reasonCode?.startsWith('rejected_must_not_be:') &&
      (c.stage === 'visual_stage1_clip' ||
        c.stage === 'visual_stage1_local' ||
        c.reasonCode === 'low_similarity')
  ).length;

  const rejected_by_hard_attribute = allRejectedCandidates.filter(
    (c) =>
      c.reasonCode?.startsWith('rejected_hard_attribute:') ||
      (c.attributeVerdicts?.failedHardAttributes?.length || 0) > 0
  ).length;

  const rejected_by_gemini = allRejectedCandidates.filter(
    (c) =>
      c.stage === 'visual_stage2_gemini' ||
      c.stage === 'video_keyframe_verify' ||
      c.stage === 'video_keyframes' ||
      c.reasonCode === 'rejected_other_type' ||
      c.reasonCode?.startsWith('rejected_hard_attribute:')
  ).length;

  const duplicates =
    duplicateVideosSkipped +
    (trace.summary.duplicateAsinsSkipped || 0) +
    allRejectedCandidates.filter((c) => c.reasonCode === 'duplicate' || c.stage === 'dedupe').length;

  // Tier counts across all primary evaluated items (listings + TikTok videos)
  const tierCounts: Record<VerdictTier, number> = {
    exact: 0,
    same_design_variant: 0,
    same_type_close_design: 0,
    same_type_other_design: 0,
    other_type: 0,
    unrelated: 0,
    unverified: 0,
  };

  // PHASE 1 & 6: Evidence level histogram (V3, V2, V1, V0) & Link state histogram (alive, blocked, dead)
  const evidenceLevelHistogram: Record<EvidenceLevel, number> = {
    V3: 0,
    V2: 0,
    V1: 0,
    V0: 0,
  };
  const linkStateHistogram: Record<LinkState, number> = {
    alive: 0,
    blocked: 0,
    dead: 0,
  };
  const perAttributeRejectionHistogram: Record<string, number> = {};

  const resolveCandidateTier = (c: CandidateDecisionTrace): VerdictTier => {
    if (c.finalDecision === 'unverified' || c.evidenceLevel === 'V0' || c.evidenceLevel === 'V1' || c.linkState === 'dead') {
      return 'unverified';
    }
    if (c.verdictTier) return c.verdictTier;
    if (c.attributeVerdicts?.verdictTier) return c.attributeVerdicts.verdictTier;
    if (c.attributeVerdicts?.verdict === 'same_design') return 'exact';
    if (c.attributeVerdicts?.verdict === 'variant') return 'same_design_variant';
    if (c.attributeVerdicts?.verdict === 'similar_other_type') {
      return c.finalDecision === 'accepted' ? 'same_type_close_design' : 'other_type';
    }
    return c.finalDecision === 'accepted' ? 'exact' : 'unrelated';
  };

  for (const c of primaryEvaluated) {
    const tier = resolveCandidateTier(c);
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;

    const ev: EvidenceLevel =
      c.evidenceLevel ||
      c.attributeVerdicts?.evidenceLevel ||
      ((c.keyframesExtracted || 0) >= 2
        ? 'V3'
        : c.imageUrl || c.thumbnailUrl
        ? 'V2'
        : c.title
        ? 'V1'
        : 'V0');
    evidenceLevelHistogram[ev] = (evidenceLevelHistogram[ev] || 0) + 1;

    const ls: LinkState = c.linkState || 'alive';
    linkStateHistogram[ls] = (linkStateHistogram[ls] || 0) + 1;

    if (c.finalDecision === 'rejected') {
      const failedAttrs = [
        ...(c.attributeVerdicts?.failedHardAttributes || []),
        ...(c.attributeVerdicts?.mustNotBeHit || []),
      ];
      if (c.reasonCode?.startsWith('rejected_hard_attribute:')) {
        failedAttrs.push(c.reasonCode.slice('rejected_hard_attribute:'.length));
      } else if (c.reasonCode?.startsWith('rejected_must_not_be:')) {
        failedAttrs.push(`mustNotBe:${c.reasonCode.slice('rejected_must_not_be:'.length)}`);
      }
      for (const attr of new Set(failedAttrs)) {
        if (attr) {
          perAttributeRejectionHistogram[attr] = (perAttributeRejectionHistogram[attr] || 0) + 1;
        }
      }
    }
  }

  // Matched vs Similar counts among emitted videos
  let matchedCount = 0;
  let similarCount = 0;
  for (const v of acceptedVideos) {
    const tier = resolveCandidateTier(v);
    if (tier === 'same_type_close_design' || tier === 'same_type_other_design') {
      similarCount++;
    } else {
      matchedCount++;
    }
  }

  // Global reason histograms across all rejected/unverified items
  const nonAccepted = candidates.filter((c) => c.finalDecision !== 'accepted');
  const reasonGroups = new Map<string, CandidateDecisionTrace[]>();
  for (const item of nonAccepted) {
    const code = item.reasonCode || normalizeLegacyReasonCode(item);
    const arr = reasonGroups.get(code) || [];
    arr.push(item);
    reasonGroups.set(code, arr);
  }

  const reasonHistograms: ReasonHistogramEntry[] = Array.from(reasonGroups.entries())
    .map(([code, items]) => ({
      reasonCode: code,
      labelAr: getReasonCodeLabelAr(code),
      count: items.length,
      isErrorNotRejection: isErrorNotRejectionReason(code),
      examples: items.slice(0, 3).map((x) => ({
        id: x.id,
        title: x.title,
        url: x.url,
        imageUrl: x.imageUrl || x.thumbnailUrl,
        reasonAr: x.rejectionReasonAr || x.attributeVerdicts?.reasonAr || getReasonCodeLabelAr(code),
        source: x.source,
      })),
    }))
    .sort((a, b) => b.count - a.count);

  const filtersFired: Record<string, number> = {};
  for (const rh of reasonHistograms) {
    if (!rh.isErrorNotRejection) {
      filtersFired[rh.reasonCode] = rh.count;
    }
  }

  const verificationErrorsCount = nonAccepted.filter(
    (c) => c.reasonCode === 'verification_error' || c.reasonCode?.startsWith('verification_error:')
  ).length;
  const budgetExhaustedCount = nonAccepted.filter(
    (c) => c.reasonCode === 'budget_exhausted' || c.reasonCode?.startsWith('budget_exhausted:')
  ).length;

  // Funnels per source, per marketplace, and per provider
  const funnels: SourceFunnelBreakdown[] = [];
  const amazonCandidates = candidates.filter((c) => c.source === 'amazon');
  if (amazonCandidates.length > 0 || trace.request.sourcePlatform !== 'tiktok') {
    funnels.push(
      buildFunnelForCandidates('amazon', 'قمع أمازون الإجمالي (Amazon Funnel)', 'amazon', amazonCandidates, listingsDiscovered)
    );
  }

  const marketplacesSearched = Array.from(
    new Set([
      ...rounds.map((r) => r.marketplace).filter((m): m is string => Boolean(m)),
      ...listingCandidates.map((c) => c.marketplace).filter((m): m is string => Boolean(m)),
    ])
  );
  if (marketplacesSearched.length === 0 && amazonCandidates.length > 0) {
    marketplacesSearched.push('US');
  }

  for (const mp of marketplacesSearched) {
    const mpCands = amazonCandidates.filter((c) => (c.marketplace || 'US') === mp);
    const mpFound = rounds
      .filter((r) => r.source === 'amazon' && (r.marketplace || 'US') === mp)
      .reduce((acc, r) => acc + (r.candidatesFound || 0), 0);
    if (mpCands.length > 0 || mpFound > 0) {
      funnels.push(
        buildFunnelForCandidates(
          `amazon:${mp}`,
          `سوق أمازون ${mp} (Amazon ${mp})`,
          'amazon',
          mpCands,
          mpFound,
          mp
        )
      );
    }
  }

  const tiktokCandidates = candidates.filter((c) => c.source === 'tiktok');
  const tiktokDiscoveredCount = Math.max(
    tiktokCandidates.filter((c) => c.stage !== 'emitted').length,
    acceptedVideos.filter((c) => c.source === 'tiktok').length +
      tiktokCandidates.filter((c) => c.finalDecision !== 'accepted').length
  );
  if (tiktokCandidates.length > 0 || trace.request.sourcePlatform !== 'amazon') {
    funnels.push(
      buildFunnelForCandidates(
        'tiktok',
        'قمع تيك توك الإجمالي (TikTok Funnel)',
        'tiktok',
        tiktokCandidates,
        tiktokDiscoveredCount
      )
    );
  }

  // Query plan table rows derived from trace.rounds
  const queryPlan: QueryPlanRow[] = rounds.map((r) => ({
    round: r.round,
    source: r.source,
    marketplace: r.marketplace || (r.source === 'amazon' ? 'US' : 'global'),
    sortVariant: r.sortVariant || 'relevance',
    query: r.query,
    pagesFetched: 1,
    listingsReturned: r.candidatesFound,
    listingsNew: r.newCandidatesCount ?? r.candidatesFound,
    listingsAccepted: r.verifiedCount,
    videosFound: r.videosFoundCount ?? r.videosFound ?? 0,
    durationMs: r.durationMs,
    status: r.status,
    error: r.error,
  }));

  // Phase 3.4 & 4.2: Query Scoreboard (لوحة الاستعلامات)
  const queryScoreboard: QueryScoreboardRow[] =
    trace.queryScoreboard && trace.queryScoreboard.length > 0
      ? trace.queryScoreboard
      : rounds.map((r) => {
          const matchingCands = primaryEvaluated.filter(
            (c) =>
              (c.query && c.query === r.query) ||
              (c.round && c.round === r.round) ||
              (!c.query && !c.round && c.source === r.source && rounds.filter((x) => x.source === r.source).length === 1)
          );
          const inspectedCount = matchingCands.length || r.newCandidatesCount || 0;
          const acceptedCount = matchingCands.length
            ? matchingCands.filter((c) => c.finalDecision === 'accepted').length
            : r.verifiedCount;
          const exactOrVariantCount = matchingCands.filter((c) => {
            const t = resolveCandidateTier(c);
            return t === 'exact' || t === 'same_design_variant';
          }).length;
          const similarTierCount = matchingCands.filter((c) => {
            const t = resolveCandidateTier(c);
            return t === 'same_type_close_design' || t === 'same_type_other_design';
          }).length;
          const otherTypeCount = matchingCands.filter((c) => {
            const t = resolveCandidateTier(c);
            return t === 'other_type' || t === 'unrelated';
          }).length;
          const sims = matchingCands
            .map((c) => c.cropClipSimilarity ?? c.referenceSimilarity)
            .filter((s): s is number => typeof s === 'number' && !Number.isNaN(s));
          const avgClip =
            sims.length > 0 ? Number((sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(2)) : 0;
          const denom = Math.max(1, inspectedCount || r.candidatesFound || 1);
          const precisionProxy = Number(
            Math.min(1, (acceptedCount + exactOrVariantCount * 0.5 + similarTierCount * 0.25) / denom).toFixed(2)
          );
          const probeAcceptedRate = Number(
            ((acceptedCount + exactOrVariantCount) / denom).toFixed(2)
          );
          return {
            query: r.query,
            source: r.source === 'tiktok' ? 'tiktok' : 'amazon',
            marketplace: r.marketplace || (r.source === 'amazon' ? 'US' : 'global'),
            round: r.round,
            resultsCount: r.candidatesFound,
            inspectedCount,
            acceptedCount,
            exactOrVariantCount,
            similarCount: similarTierCount,
            otherTypeCount,
            avgClipSimilarity: avgClip,
            precisionProxy,
            probeAcceptedRate,
            probePassed: probeAcceptedRate >= 0.1 || acceptedCount > 0,
            status: isBlockedRound(r) ? 'blocked' : r.status,
          };
        });

  // Rejection Audit Sample (up to 15 rejected items with full reasonCode & failedAttribute)
  const acceptedOverrideIds = new Set(
    userFeedback.filter((f) => f.userAction === 'accept').map((f) => f.candidateId.toUpperCase())
  );

  const allRejectedItems: RejectedCandidateItem[] = allRejectedCandidates.map((c) => {
    const code = c.reasonCode || normalizeLegacyReasonCode(c);
    const failedAttr = code.startsWith('rejected_hard_attribute:')
      ? code.slice('rejected_hard_attribute:'.length)
      : code.startsWith('rejected_must_not_be:')
      ? code.slice('rejected_must_not_be:'.length)
      : c.attributeVerdicts?.failedHardAttributes?.[0] ||
        c.attributeVerdicts?.mustNotBeHit?.[0] ||
        undefined;
    return {
      id: c.id,
      source: c.source === 'tiktok' ? 'tiktok' : 'amazon',
      marketplace: c.marketplace,
      provider: c.provider,
      entityType: c.entityType,
      title: c.title,
      url: c.url,
      imageUrl: c.imageUrl || c.thumbnailUrl,
      reasonCode: code,
      reasonLabelAr: getReasonCodeLabelAr(code),
      failedAttribute: failedAttr,
      reasonAr: c.rejectionReasonAr || c.attributeVerdicts?.reasonAr || getReasonCodeLabelAr(code),
      verdict: c.attributeVerdicts?.verdict || 'rejected',
      verdictTier: resolveCandidateTier(c),
      evidenceLevel: c.evidenceLevel || c.attributeVerdicts?.evidenceLevel,
      linkState: c.linkState,
      stage: c.stage,
      mustNotBeHit: c.attributeVerdicts?.mustNotBeHit,
      referenceSimilarity: c.cropClipSimilarity ?? c.referenceSimilarity ?? undefined,
      acceptedByUser: acceptedOverrideIds.has(c.id.toUpperCase()),
    };
  });

  // Deterministic spread sample of 15 items across different reason codes
  const rejectionAuditSample: RejectedCandidateItem[] = [];
  if (allRejectedItems.length <= 15) {
    rejectionAuditSample.push(...allRejectedItems);
  } else {
    const step = allRejectedItems.length / 15;
    for (let i = 0; i < 15; i++) {
      const idx = Math.min(allRejectedItems.length - 1, Math.floor(i * step));
      rejectionAuditSample.push(allRejectedItems[idx]);
    }
  }

  // Phase 1.8: Override Warnings (>40% of items from one reason/attribute overridden by user)
  const overrideWarnings: RejectionOverrideWarning[] = [];
  const rejectedByReason = new Map<string, RejectedCandidateItem[]>();
  for (const item of allRejectedItems) {
    const code = item.reasonCode || 'rejected_other_type';
    const arr = rejectedByReason.get(code) || [];
    arr.push(item);
    rejectedByReason.set(code, arr);
  }
  for (const [code, list] of rejectedByReason.entries()) {
    const overriddenCount = list.filter((x) => x.acceptedByUser).length;
    if (list.length >= 2 && overriddenCount / list.length > 0.4) {
      const ratio = Number((overriddenCount / list.length).toFixed(2));
      overrideWarnings.push({
        reasonCode: code,
        labelAr: getReasonCodeLabelAr(code),
        totalRejected: list.length,
        overriddenCount,
        overrideRatio: ratio,
        warningAr: `هذا الشرط ربما صارم أكثر من اللازم (${overriddenCount}/${list.length} = ${Math.round(ratio * 100)}% تم قبولها يدوياً)`,
        suggestionAr: code.startsWith('rejected_hard_attribute:')
          ? `ننصح بتحويل السمة "${code.slice('rejected_hard_attribute:'.length)}" من HARD إلى SOFT في بطاقة الهوية.`
          : code === 'low_similarity'
          ? 'ننصح بخفض حد تشابه CLIP في الإعدادات أو اختيار الوضع المتساهل.'
          : 'ننصح بتفعيل خيار "عرض المنتجات الشبيهة" أو تخفيف هذا الشرط في بطاقة الهوية.',
      });
    }
  }

  // PHASE 1.2: Stop-Reason Mapping & Minimum-Effort Guard
  const requestedVideos = trace.summary.requestedVideos || trace.request.targetVideoCount || 10;
  const minEffortCfg = trace.settingsUsed?.minimumEffort || {
    minQueries: 3,
    minPagesPerMarketplace: 1,
    minListingsInspected: 10,
  };

  const amazonRounds = rounds.filter((r) => r.source === 'amazon');
  const allAmazonRoundsBlocked =
    amazonRounds.length > 0 &&
    amazonRounds.every((r) => isBlockedRound(r)) &&
    listingsDiscovered === 0;

  const uniqueQueriesRun = new Set(rounds.map((r) => r.query)).size;
  const totalEvaluatedItems = primaryEvaluated.length;
  const allProvidersHealthy = !allAmazonRoundsBlocked;

  const minimumEffortMet =
    uniqueQueriesRun >= (minEffortCfg.minQueries || 3) &&
    rounds.length >= (minEffortCfg.minPagesPerMarketplace || 1) &&
    totalEvaluatedItems >= (minEffortCfg.minListingsInspected || 10) &&
    allProvidersHealthy;

  let stopReasonCode: StopReasonCode = trace.summary.stopReasonCode || 'exhausted_candidates';
  if (emittedVideos >= requestedVideos) {
    stopReasonCode = 'target_reached';
  } else if (trace.summary.stopReasons?.user_cancelled) {
    stopReasonCode = 'user_cancelled';
  } else if (budgetExhaustedCount > 0 && emittedVideos === 0) {
    stopReasonCode = 'gemini_budget';
  } else if (allAmazonRoundsBlocked) {
    stopReasonCode = 'amazon_blocked';
  } else if (
    trace.request.sourcePlatform === 'tiktok' &&
    tiktokDiscoveredCount === 0 &&
    (trace.providerProbes || []).length > 0 &&
    (trace.providerProbes || []).every((p) => p.tiktokUrlsParsed === 0)
  ) {
    stopReasonCode = 'tiktok_unreachable';
  } else if (
    stopReasonCode === 'exhausted_candidates' &&
    !minimumEffortMet
  ) {
    stopReasonCode = 'insufficient_search';
  }

  const stopReasonLabelAr = getStopReasonLabelAr(stopReasonCode);

  const rejectionOnlyHistograms = reasonHistograms.filter((r) => !r.isErrorNotRejection);
  const topReason = rejectionOnlyHistograms[0];
  let topLimitingFactorAr = '';
  if (emittedVideos >= requestedVideos) {
    topLimitingFactorAr = `تم تحقيق الهدف بالكامل (${emittedVideos}/${requestedVideos} فيديو مؤكد).`;
  } else if (allAmazonRoundsBlocked && topReason) {
    topLimitingFactorAr = `أكبر سبب لنقص الفيديوهات: حظر أمازون (503/CAPTCHA) لجميع جولات البحث (${amazonRounds.length} جولة)، بالإضافة إلى ${rejectedTotal} عنصر مرفوض (أهم سبب: ${topReason.labelAr} (${topReason.count})).`;
  } else if (allAmazonRoundsBlocked) {
    topLimitingFactorAr = `أكبر سبب لنقص الفيديوهات: حظر أمازون (503/CAPTCHA) لجميع جولات البحث (${amazonRounds.length} جولة).`;
  } else if (topReason && rejectedTotal > 0) {
    topLimitingFactorAr = `أكبر سبب لنقص الفيديوهات: ${rejectedTotal} عنصر مرفوض، أهم سبب: ${topReason.labelAr} (${topReason.count})`;
  } else if (listingsAccepted > 0 && emittedVideos < requestedVideos) {
    topLimitingFactorAr = `أكبر سبب لنقص الفيديوهات: تم قبول ${listingsAccepted} منتج مطابق، ولكن عدد فيديوهات المراجعات المتاحة عليها كان ${emittedVideos} فقط.`;
  } else {
    topLimitingFactorAr = `أكبر سبب لنقص الفيديوهات: ${stopReasonLabelAr}`;
  }

  const summary: SearchBreakdownSummary = {
    searchId: trace.searchId,
    requestedVideos,
    emittedVideos,
    matchedCount,
    similarCount,
    relaxationPassesRun: trace.relaxationPassesRun || 1,
    unverifiedVideosCount,
    unverifiedListingsCount: listingsUnverified,
    verificationErrorsCount,
    budgetExhaustedCount,
    rejectedTotal,
    rejected_by_text_prefilter,
    rejected_by_local_visual,
    rejected_by_gemini,
    rejected_by_hard_attribute,
    verification_error: verificationErrorsCount,
    duplicates,
    minimumEffortMet,
    amazonRequested: trace.request.targetAmazonVideoCount ?? requestedVideos,
    amazonMaxCap: trace.settingsUsed?.sourceCaps?.amazonMax ?? 500,
    amazonEmitted,
    tiktokRequested: trace.request.targetTikTokVideoCount ?? requestedVideos,
    tiktokMaxCap: trace.settingsUsed?.sourceCaps?.tiktokMax ?? 500,
    tiktokEmitted,
    tiktokDownloadFailedButKeptCount,
    pagesFetched: rounds.length,
    marketplacesSearched,
    marketplaceProbes: trace.marketplaceProbes || [],
    listingsDiscovered,
    listingsDeduped: listingsInspected,
    listingsInspected,
    listingsAccepted,
    listingsRejected,
    tierCounts,
    evidenceLevelHistogram,
    linkStateHistogram,
    perAttributeRejectionHistogram,
    tiktokProviderFunnels: trace.tiktokProviderFunnels || [],
    videosDiscovered: Math.max(trace.summary.videosDiscovered || 0, videoCandidates.length),
    duplicateVideosSkipped,
    realVideoFramePosterCount,
    keyframesExtractedCount: trace.summary.keyframesExtractedCount || realVideoFramePosterCount,
    keyframesFailedCount: trace.summary.keyframesFailedCount || 0,
    stopReasonCode,
    stopReasonLabelAr,
    topLimitingFactorAr,
    stopReasonsAr: trace.summary.stopReasons || {},
    filtersFired,
    reasonHistograms,
    funnels,
    queryPlan,
    queryScoreboard,
    rejectionAuditSample,
    overrideWarnings,
    providerProbes: trace.tiktokProbes?.length ? trace.tiktokProbes : (trace.providerProbes || []),
    settingsUsed: trace.settingsUsed || {},
    geminiUsage: {
      callsUsedInSearch: trace.summary.geminiCallsUsed || 0,
      dailyCallsUsed: geminiBudgetStatus?.callsUsed ?? 0,
      dailyMaxCalls: geminiBudgetStatus?.maxCalls ?? 1500,
      exhausted: geminiBudgetStatus?.exhausted ?? false,
    },
  };

  summary.diagnosticReportMarkdown = buildDiagnosticReportMarkdown(trace, summary);
  return summary;
}

export function buildDiagnosticReportMarkdown(
  trace: SearchDecisionTrace,
  diag: SearchBreakdownSummary
): string {
  const lines: string[] = [];
  lines.push(`# تقرير التشخيص الكامل (Creative Radaar Diagnostic Report)`);
  lines.push(`- **Search ID**: \`${trace.searchId}\``);
  lines.push(`- **Started At**: ${trace.startedAt} | **Duration**: ${trace.durationMs || 0}ms`);
  lines.push(`- **Stop Reason**: \`${diag.stopReasonCode}\` — ${diag.stopReasonLabelAr} (minimumEffortMet=${Boolean(diag.minimumEffortMet)}, relaxationPasses=${diag.relaxationPassesRun || 1})`);
  lines.push(`- **Top Limiting Factor**: ${diag.topLimitingFactorAr}`);
  lines.push(
    `- **Confirmed Videos**: المؤكد ${diag.emittedVideos} من ${diag.requestedVideos} المطلوب (مطابق: ${diag.matchedCount || 0} + شبيه: ${diag.similarCount || 0} | أمازون: ${diag.amazonEmitted} فيديو | تيك توك: ${diag.tiktokEmitted} فيديو | غير متحقق: ${diag.unverifiedVideosCount || 0})`
  );
  lines.push(
    `- **Evidence Levels Histogram**: V3=${diag.evidenceLevelHistogram?.V3 || 0}, V2=${diag.evidenceLevelHistogram?.V2 || 0}, V1=${diag.evidenceLevelHistogram?.V1 || 0}, V0=${diag.evidenceLevelHistogram?.V0 || 0}`
  );
  lines.push(
    `- **Link State Histogram**: alive=${diag.linkStateHistogram?.alive || 0}, blocked=${diag.linkStateHistogram?.blocked || 0}, dead=${diag.linkStateHistogram?.dead || 0}`
  );
  lines.push(
    `- **Per-Attribute Rejection Histogram**: ${JSON.stringify(diag.perAttributeRejectionHistogram || {})}`
  );
  lines.push(
    `- **Semantic Rejection Counters**: rejectedTotal=${diag.rejectedTotal || 0} (rejected_by_text_prefilter=${diag.rejected_by_text_prefilter || 0}, rejected_by_local_visual=${diag.rejected_by_local_visual || 0}, rejected_by_gemini=${diag.rejected_by_gemini || 0}, rejected_by_hard_attribute=${diag.rejected_by_hard_attribute || 0}, verification_error=${diag.verification_error || 0}, duplicates=${diag.duplicates || 0})`
  );
  lines.push(
    `- **Listings**: Discovered ${diag.listingsDiscovered} -> Deduped/Inspected ${diag.listingsInspected} -> Accepted ${diag.listingsAccepted} | Rejected ${diag.listingsRejected} | Unverified (Errors/Budget): ${diag.unverifiedListingsCount || 0}`
  );
  lines.push(
    `- **Tier Counts**: exact=${diag.tierCounts?.exact || 0}, same_design_variant=${diag.tierCounts?.same_design_variant || 0}, same_type_close_design=${diag.tierCounts?.same_type_close_design || 0}, same_type_other_design=${diag.tierCounts?.same_type_other_design || 0}, other_type=${diag.tierCounts?.other_type || 0}, unrelated=${diag.tierCounts?.unrelated || 0}, unverified=${diag.tierCounts?.unverified || 0}`
  );
  lines.push(
    `- **FFmpeg Frames**: realVideoFramePosters=${diag.realVideoFramePosterCount}, keyframesExtracted=${diag.keyframesExtractedCount || 0}, keyframesFailed=${diag.keyframesFailedCount || 0}`
  );
  lines.push('');
  lines.push(`## 1. Identity Card v3 (بطاقة الهوية البصرية والمحددات التمييزية)`);
  lines.push(`- **Name (EN / AR)**: ${trace.identityResolution.suggestedNameEn || trace.request.productName} / ${trace.identityResolution.suggestedNameAr || ''}`);
  lines.push(`- **Form Factor**: ${trace.identityResolution.formFactor || 'N/A'}`);
  lines.push(`- **Mechanism**: ${trace.identityResolution.mechanism || 'N/A'}`);
  lines.push(`- **Discriminators**: ${JSON.stringify(trace.identityResolution.discriminators || [])}`);
  lines.push(`- **Must Match**: ${JSON.stringify(trace.identityResolution.mustMatch)}`);
  lines.push(`- **Attribute Strengths**: ${JSON.stringify(trace.identityResolution.attributeStrengths || {})}`);
  lines.push(`- **Must Not Be (Look-alikes)**: ${JSON.stringify(trace.identityResolution.mustNotBe)}`);
  lines.push('');
  lines.push(`## 2. Query Scoreboard (لوحة الاستعلامات — ${diag.queryScoreboard?.length || 0} queries across ${diag.marketplacesSearched.join(', ') || 'global'})`);
  for (const qs of diag.queryScoreboard || []) {
    lines.push(
      `- [${qs.round}] (${qs.source}:${qs.marketplace}) "${qs.query}" -> results=${qs.resultsCount}, parsed/inspected=${qs.inspectedCount}, probeAcceptedRate=${qs.probeAcceptedRate ?? qs.precisionProxy}, finalAccepted=${qs.acceptedCount}, exact/variant=${qs.exactOrVariantCount}, similar=${qs.similarCount}, otherType=${qs.otherTypeCount}, avgClip=${qs.avgClipSimilarity}, status=${qs.status}`
    );
  }
  lines.push('');
  lines.push(`## 3. Funnels & TikTok Provider Funnels (قمع التحقق لكل مصدر ومزود)`);
  for (const f of diag.funnels || []) {
    lines.push(`### ${f.labelAr} (\`${f.scopeKey}\`)`);
    for (const st of f.stages) {
      lines.push(
        `  - **${st.labelAr}**: in=${st.inCount} -> out=${st.outCount} (dropped=${st.droppedCount}${st.unverifiedCount ? `, unverified=${st.unverifiedCount}` : ''})`
      );
    }
  }
  if (diag.tiktokProviderFunnels && diag.tiktokProviderFunnels.length > 0) {
    lines.push(`### قمع تيك توك التفصيلي حسب الاستعلام والمزود (TikTok Funnel by Provider)`);
    for (const tf of diag.tiktokProviderFunnels) {
      lines.push(
        `  - **${tf.provider}** ("${tf.query}"): SERP=${tf.serpResults} -> URLs=${tf.tiktokUrlsParsed} -> oEmbed=${tf.oembedOk} -> preRanked=${tf.preRankedPassed} -> frameVerified=${tf.sentToFrameVerification} -> accepted=${tf.acceptedCount} | reasons=${'—'}`
      );
    }
  }
  lines.push('');
  lines.push(`## 4. Reason Histograms & Examples (توزيع أسباب الاستبعاد والأخطاء)`);
  for (const rh of diag.reasonHistograms || []) {
    lines.push(
      `- **\`${rh.reasonCode}\`** (${rh.labelAr}): **${rh.count}** ${rh.isErrorNotRejection ? '[ERROR/UNVERIFIED - NOT REJECTED]' : '[REJECTED]'}`
    );
    for (const ex of rh.examples) {
      lines.push(`  * Example: \`${ex.id}\` — "${ex.title.slice(0, 80)}" (${ex.reasonAr})`);
    }
  }
  lines.push('');
  lines.push(`## 5. TikTok Provider Probes`);
  for (const p of diag.providerProbes || []) {
    lines.push(
      `- **${p.provider}${p.engine ? ` (${p.engine})` : ''}**: status=${p.httpStatus}, latency=${p.latencyMs}ms, raw=${p.rawResultsCount}, tiktokUrls=${p.tiktokUrlsParsed}, oEmbedOk=${p.oembedOkCount}, err=${p.firstError || 'none'}`
    );
  }
  lines.push('');
  lines.push(`## 6. Raw JSON Summary`);
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        searchId: trace.searchId,
        stopReasonCode: diag.stopReasonCode,
        minimumEffortMet: diag.minimumEffortMet,
        relaxationPassesRun: diag.relaxationPassesRun,
        topLimitingFactorAr: diag.topLimitingFactorAr,
        requestedVideos: diag.requestedVideos,
        emittedVideos: diag.emittedVideos,
        matchedCount: diag.matchedCount,
        similarCount: diag.similarCount,
        amazonEmitted: diag.amazonEmitted,
        tiktokEmitted: diag.tiktokEmitted,
        evidenceLevelHistogram: diag.evidenceLevelHistogram,
        linkStateHistogram: diag.linkStateHistogram,
        perAttributeRejectionHistogram: diag.perAttributeRejectionHistogram,
        rejectedTotal: diag.rejectedTotal,
        rejected_by_text_prefilter: diag.rejected_by_text_prefilter,
        rejected_by_local_visual: diag.rejected_by_local_visual,
        rejected_by_gemini: diag.rejected_by_gemini,
        rejected_by_hard_attribute: diag.rejected_by_hard_attribute,
        verification_error: diag.verification_error,
        duplicates: diag.duplicates,
        listingsDiscovered: diag.listingsDiscovered,
        listingsInspected: diag.listingsInspected,
        listingsAccepted: diag.listingsAccepted,
        listingsRejected: diag.listingsRejected,
        unverifiedListingsCount: diag.unverifiedListingsCount,
        tierCounts: diag.tierCounts,
        realVideoFramePosterCount: diag.realVideoFramePosterCount,
        settingsUsed: diag.settingsUsed,
        geminiUsage: diag.geminiUsage,
      },
      null,
      2
    )
  );
  lines.push('```');
  return lines.join('\n');
}

export function finalizeSearchTrace(
  trace: SearchDecisionTrace,
  stopReasons?: Record<string, string>,
  userFeedback: Array<{
    candidateId: string;
    userAction: 'accept' | 'reject';
    previousRejectionReasonAr?: string;
  }> = [],
  geminiBudgetStatus?: {
    callsUsed: number;
    maxCalls: number;
    exhausted: boolean;
  }
): SearchBreakdownSummary {
  trace.completedAt = new Date().toISOString();
  trace.durationMs = Math.max(
    0,
    new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()
  );
  if (stopReasons) {
    trace.summary.stopReasons = { ...trace.summary.stopReasons, ...stopReasons };
  }
  const derived = computeDerivedDiagnostics(trace, userFeedback, geminiBudgetStatus);
  // Sync trace.summary with derived single-source-of-truth counters
  trace.summary.emittedVideos = derived.emittedVideos;
  trace.summary.videosEmitted = derived.emittedVideos;
  trace.summary.listingsDiscovered = derived.listingsDiscovered;
  trace.summary.listingsDeduped = derived.listingsDeduped;
  trace.summary.listingsInspected = derived.listingsInspected;
  trace.summary.listingsAccepted = derived.listingsAccepted;
  trace.summary.listingsRejected = derived.listingsRejected;
  trace.summary.unverifiedListingsCount = derived.unverifiedListingsCount;
  trace.summary.unverifiedVideosCount = derived.unverifiedVideosCount;
  trace.summary.verificationErrorsCount = derived.verificationErrorsCount;
  trace.summary.budgetExhaustedCount = derived.budgetExhaustedCount;
  trace.summary.realVideoFramePosterCount = derived.realVideoFramePosterCount;
  trace.summary.stopReasonCode = derived.stopReasonCode;
  trace.summary.filtersFired = derived.filtersFired;
  trace.derivedDiagnostics = derived;
  persistSearchTrace(trace);
  return derived;
}

export function persistSearchTrace(trace: SearchDecisionTrace): void {
  ensureTracesDir();
  memoryTraces.set(trace.searchId, trace);
  latestSearchId = trace.searchId;
  try {
    const safeId = trace.searchId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(TRACES_DIR, `search_${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), 'utf-8');
    const latestPath = path.join(TRACES_DIR, 'search_latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(trace, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[SearchTrace] Failed to persist trace to disk:', (err as Error)?.message);
  }
}

export function getSearchTrace(searchId?: string): SearchDecisionTrace | null {
  ensureTracesDir();
  const targetId = !searchId || searchId === 'latest' ? latestSearchId : searchId;
  if (targetId && memoryTraces.has(targetId)) {
    const t = memoryTraces.get(targetId)!;
    if (!t.derivedDiagnostics) {
      t.derivedDiagnostics = computeDerivedDiagnostics(t);
    }
    return t;
  }

  try {
    if (!searchId || searchId === 'latest') {
      const latestPath = path.join(TRACES_DIR, 'search_latest.json');
      if (fs.existsSync(latestPath)) {
        const t = JSON.parse(fs.readFileSync(latestPath, 'utf-8')) as SearchDecisionTrace;
        t.derivedDiagnostics = computeDerivedDiagnostics(t);
        return t;
      }
      const files = fs
        .readdirSync(TRACES_DIR)
        .filter((f) => f.startsWith('search_') && f.endsWith('.json'))
        .sort((a, b) => {
          const sa = fs.statSync(path.join(TRACES_DIR, a)).mtimeMs;
          const sb = fs.statSync(path.join(TRACES_DIR, b)).mtimeMs;
          return sb - sa;
        });
      if (files.length > 0) {
        const t = JSON.parse(
          fs.readFileSync(path.join(TRACES_DIR, files[0]), 'utf-8')
        ) as SearchDecisionTrace;
        t.derivedDiagnostics = computeDerivedDiagnostics(t);
        return t;
      }
      return null;
    }

    const safeId = searchId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(TRACES_DIR, `search_${safeId}.json`);
    if (fs.existsSync(filePath)) {
      const t = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SearchDecisionTrace;
      t.derivedDiagnostics = computeDerivedDiagnostics(t);
      return t;
    }
  } catch (err) {
    console.warn('[SearchTrace] Failed to read trace from disk:', (err as Error)?.message);
  }
  return null;
}

export function listSearchTraces(limit = 20): Array<{
  searchId: string;
  startedAt: string;
  completedAt?: string;
  productName: string;
  requestedVideos: number;
  emittedVideos: number;
  stopReasonCode?: string;
}> {
  ensureTracesDir();
  try {
    const files = fs
      .readdirSync(TRACES_DIR)
      .filter((f) => f.startsWith('search_') && f !== 'search_latest.json' && f.endsWith('.json'))
      .sort((a, b) => {
        const sa = fs.statSync(path.join(TRACES_DIR, a)).mtimeMs;
        const sb = fs.statSync(path.join(TRACES_DIR, b)).mtimeMs;
        return sb - sa;
      })
      .slice(0, limit);

    return files.map((f) => {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(TRACES_DIR, f), 'utf-8')
      ) as SearchDecisionTrace;
      return {
        searchId: parsed.searchId,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
        productName: parsed.request.productName,
        requestedVideos: parsed.summary.requestedVideos,
        emittedVideos: parsed.summary.emittedVideos,
        stopReasonCode: parsed.summary.stopReasonCode,
      };
    });
  } catch {
    return [];
  }
}
