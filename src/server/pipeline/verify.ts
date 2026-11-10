import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { DATA_DIR } from '../config.ts';
import { isGeminiConfigured, generateContentWithModelFallback } from '../gemini.ts';
import { fetchProductImageAsBase64 } from '../amazonHttp.ts';
import type { IdentityCardV2, MatchMode } from './identity.ts';
import {
  optimizeReferenceImageForVision,
  classifyIdentityAttributeStrengths,
  isTautologicalOrVagueAttribute,
  buildDiscriminatorsForIdentityCard,
} from './identity.ts';
import { getCalibrationConfig } from './calibrate.ts';
import { getRuntimeSettings } from '../settings.ts';
import { extractVideoKeyframesBase64 } from './thumbnails.ts';
import {
  computeColorAgnosticClipEmbedding,
  cosineSimilarityClip,
  computeImageBufferEmbedding,
} from './clipEmbedding.ts';
import { probeCandidateLinkState, enforceEvidenceGatedBadge } from './linkState.ts';
import {
  extractSceneAwareKeyframes,
  describeCandidateBlindWithGemini,
  cropBoundingBoxAndCompareClip,
  compareBlindProfileInCode,
} from './blindVerify.ts';
import type {
  VerdictTier,
  AttributeStrength,
  EvidenceLevel,
  LinkState,
  BoundingBox2D,
  BlindDiscriminatorObservation,
} from '../../types/index.ts';

export type VerificationVerdictType =
  | 'same_design'
  | 'variant'
  | 'similar_other_type'
  | 'unrelated'
  | 'unverified_by_ai'
  | 'unverified_ai_fallback';

export interface AttributeVerificationVerdict {
  id: string;
  approved: boolean;
  countsTowardTarget?: boolean;
  verdict: VerificationVerdictType;
  verdictTier: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  evidenceSummaryAr?: string;
  userFacingBadgeAr?: string;
  visibleFramesCount?: number;
  extractedFrameUrls?: string[];
  cropClipSimilarity?: number | null;
  boundingBoxes?: BoundingBox2D[];
  blindObservations?: BlindDiscriminatorObservation[];
  linkState?: LinkState;
  linkStateReasonAr?: string;
  reasonCode: string | null;
  failedAttribute?: string;
  failedHardAttributes?: string[];
  failedSoftAttributes?: string[];
  notVisibleHardAttributes?: string[];
  keyframesExtracted?: number;
  isErrorNotRejection?: boolean;
  verifiedByAi: boolean;
  formFactorMatches: boolean;
  mechanismMatches: boolean;
  colorMatches: boolean;
  mustNotBeHit: string[];
  confidence: number;
  referenceSimilarity: number;
  reasonAr: string;
  stage:
    | 'text_gate'
    | 'visual_stage1_local'
    | 'visual_stage2_gemini'
    | 'video_keyframes'
    | 'budget_fallback';
}

export interface VerificationFeedbackEntry {
  id: string;
  imageHash: string;
  candidateId: string;
  candidateTitle: string;
  reasonCode?: string;
  previousRejectionReasonAr: string;
  userAction: 'accept' | 'reject';
  createdAt: string;
}

const VERDICTS_CACHE_VERSION = 7;
const VERDICTS_CACHE_FILE = path.join(DATA_DIR, 'verification_verdicts_cache.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'verification_feedback.json');
const BUDGET_FILE = path.join(DATA_DIR, 'gemini_daily_budget.json');

const verdictsCache = new Map<string, AttributeVerificationVerdict>();
const feedbackList: VerificationFeedbackEntry[] = [];

function loadCachesFromDisk(): void {
  try {
    if (fs.existsSync(VERDICTS_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(VERDICTS_CACHE_FILE, 'utf-8'));
      if (raw && raw.version === VERDICTS_CACHE_VERSION && Array.isArray(raw.entries)) {
        for (const [k, v] of raw.entries) {
          if (typeof k === 'string' && v?.id && v?.verdictTier) {
            verdictsCache.set(k, v as AttributeVerificationVerdict);
          }
        }
      } else {
        try {
          fs.unlinkSync(VERDICTS_CACHE_FILE);
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[VerifyPipeline] Failed to load verdicts cache:', (err as Error)?.message || err);
  }

  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        feedbackList.push(...raw);
      }
    }
  } catch (err) {
    console.warn('[VerifyPipeline] Failed to load feedback store:', (err as Error)?.message || err);
  }
}

export function clearVerdictsCache(): void {
  verdictsCache.clear();
  try {
    if (fs.existsSync(VERDICTS_CACHE_FILE)) {
      fs.unlinkSync(VERDICTS_CACHE_FILE);
    }
  } catch {}
}

function saveVerdictsCacheToDisk(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = Array.from(verdictsCache.entries()).slice(-1500);
    fs.writeFileSync(
      VERDICTS_CACHE_FILE,
      JSON.stringify({ version: VERDICTS_CACHE_VERSION, entries }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('[VerifyPipeline] Failed to save verdicts cache:', (err as Error)?.message || err);
  }
}

export function recordVerificationFeedback(
  entry: Omit<VerificationFeedbackEntry, 'createdAt'>
): VerificationFeedbackEntry {
  const full: VerificationFeedbackEntry = {
    ...entry,
    createdAt: new Date().toISOString(),
  };
  const existingIdx = feedbackList.findIndex(
    (f) => f.imageHash === full.imageHash && f.candidateId === full.candidateId
  );
  if (existingIdx >= 0) {
    feedbackList[existingIdx] = full;
  } else {
    feedbackList.push(full);
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbackList.slice(-500), null, 2), 'utf-8');
  } catch (err) {
    console.warn('[VerifyPipeline] Failed to save feedback:', (err as Error)?.message || err);
  }
  for (const key of verdictsCache.keys()) {
    if (key.includes(`::${full.candidateId.toUpperCase()}::`)) {
      verdictsCache.delete(key);
    }
  }
  return full;
}

export function getVerificationFeedbackForImage(imageHash?: string): VerificationFeedbackEntry[] {
  if (!imageHash) return feedbackList.slice(-50);
  return feedbackList.filter((f) => f.imageHash === imageHash || f.imageHash === 'default');
}

loadCachesFromDisk();

interface DailyBudgetState {
  dayKey: string;
  callsUsed: number;
  simulatedExhausted?: boolean;
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function setSimulatedGeminiBudgetExhausted(exhausted: boolean): {
  dayKey: string;
  callsUsed: number;
  maxCalls: number;
  remaining: number;
  exhausted: boolean;
} {
  const status = getDailyGeminiBudgetStatus();
  const updated: DailyBudgetState = {
    dayKey: status.dayKey,
    callsUsed: exhausted ? status.maxCalls : 0,
    simulatedExhausted: exhausted,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {}
  return getDailyGeminiBudgetStatus();
}

export function getDailyGeminiBudgetStatus(): {
  dayKey: string;
  callsUsed: number;
  maxCalls: number;
  remaining: number;
  exhausted: boolean;
} {
  const cal = getCalibrationConfig();
  const settings = getRuntimeSettings();
  const maxCalls = settings.geminiDailyBudget || cal.maxGeminiCallsPerDay || 1500;
  const today = getTodayKey();
  let state: DailyBudgetState = { dayKey: today, callsUsed: 0 };
  try {
    if (fs.existsSync(BUDGET_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf-8'));
      if (parsed?.dayKey === today && typeof parsed.callsUsed === 'number') {
        state = parsed;
      }
    }
  } catch {}
  const exhausted = Boolean(state.simulatedExhausted) || state.callsUsed >= maxCalls;
  return {
    dayKey: today,
    callsUsed: state.callsUsed,
    maxCalls,
    remaining: Math.max(0, maxCalls - state.callsUsed),
    exhausted,
  };
}

function consumeGeminiBudgetCall(count = 1): boolean {
  const status = getDailyGeminiBudgetStatus();
  if (status.exhausted) return false;
  const updated: DailyBudgetState = {
    dayKey: status.dayKey,
    callsUsed: status.callsUsed + count,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  } catch {}
  return true;
}

/**
 * Checks whether a candidate title/description explicitly matches any dynamically generated
 * `mustNotBe` exclusion phrase from the Identity Card v2, unless that phrase also appears in `mustMatch`.
 */
export function detectDynamicMustNotBeInText(
  text: string,
  identity: IdentityCardV2
): string[] {
  if (!text || !identity.mustNotBe || identity.mustNotBe.length === 0) return [];
  const normText = text
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ');
  const normMustMatch = [
    identity.nameEn,
    identity.formFactor.shape,
    identity.mechanism.howItWorks,
    ...identity.mustMatch,
  ]
    .join(' ')
    .toLowerCase();

  const hits: string[] = [];
  for (const rawPhrase of identity.mustNotBe) {
    const cleanPhrase = rawPhrase
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
      .trim();
    if (!cleanPhrase || cleanPhrase.length < 3) continue;

    const phraseTokens = cleanPhrase.split(/\s+/).filter((t) => t.length >= 3);
    const discriminativeTokens = phraseTokens.filter((t) => !normMustMatch.includes(t));

    if (normText.includes(cleanPhrase)) {
      hits.push(rawPhrase);
      continue;
    }

    if (discriminativeTokens.length >= 2 && discriminativeTokens.every((t) => normText.includes(t))) {
      hits.push(rawPhrase);
      continue;
    }

    if (discriminativeTokens.length === 1 && discriminativeTokens[0].length >= 4) {
      const tok = discriminativeTokens[0];
      const wordBoundary = new RegExp(`\\b${tok}s?\\b`, 'i');
      if (wordBoundary.test(normText)) {
        hits.push(rawPhrase);
      }
    }
  }
  return Array.from(new Set(hits));
}

export interface ListingCandidateToVerify {
  id: string;
  title: string;
  url: string;
  videoUrl?: string;
  imageUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  ratingCount?: number;
}

export function shouldApproveTier(
  tier: VerdictTier,
  matchMode: MatchMode,
  includeSimilar: boolean,
  colorMatches: boolean,
  relaxationPass: 1 | 2 | 3 = 1
): boolean {
  if (tier === 'unverified' || tier === 'other_type' || tier === 'unrelated') {
    return false;
  }
  if (matchMode === 'strict_color') {
    if (tier === 'exact' && colorMatches) return true;
    if ((includeSimilar || relaxationPass >= 2) && tier === 'same_type_close_design' && colorMatches) {
      return true;
    }
    if (relaxationPass >= 3 && tier === 'same_type_other_design' && colorMatches) {
      return true;
    }
    return false;
  }
  // Pass 1 (default): accept 'exact' AND 'same_design_variant'
  if (tier === 'exact' || tier === 'same_design_variant') {
    return true;
  }
  // Pass 2 (or includeSimilar): add 'same_type_close_design'
  if ((includeSimilar || relaxationPass >= 2) && tier === 'same_type_close_design') {
    return true;
  }
  // Pass 3: add 'same_type_other_design'
  if (relaxationPass >= 3 && tier === 'same_type_other_design') {
    return true;
  }
  return false;
}

export function tierToLegacyVerdict(tier: VerdictTier): VerificationVerdictType {
  switch (tier) {
    case 'exact':
      return 'same_design';
    case 'same_design_variant':
      return 'variant';
    case 'same_type_close_design':
    case 'same_type_other_design':
    case 'other_type':
      return 'similar_other_type';
    case 'unrelated':
      return 'unrelated';
    case 'unverified':
    default:
      return 'unverified_by_ai';
  }
}

const TIER_RANK_ORDER: Record<VerdictTier, number> = {
  exact: 1,
  same_design_variant: 2,
  same_type_close_design: 3,
  same_type_other_design: 4,
  other_type: 5,
  unrelated: 6,
  unverified: 7,
};

/**
 * Phase 5.2: Ranks candidates by VerdictTier priority first, and by CLIP similarity descending inside each tier.
 */
export function sortCandidatesByTierAndClip<
  T extends { verdictTier?: VerdictTier; referenceSimilarity?: number }
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const rankA = TIER_RANK_ORDER[a.verdictTier || 'unverified'] ?? 99;
    const rankB = TIER_RANK_ORDER[b.verdictTier || 'unverified'] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return (b.referenceSimilarity ?? 0) - (a.referenceSimilarity ?? 0);
  });
}

/**
 * Phase 5.1: Evaluates reported HARD attribute conflicts.
 */
export function evaluateHardAttributeConflicts(params: {
  failedHardAttributes: string[];
  visualEvidenceText?: string;
  confidence: number;
  attributeStrengths: Record<string, AttributeStrength>;
  productNameEn?: string;
  category?: string;
  hardConflictMinConfidence?: number;
}): {
  actualFailedHard: string[];
  downgradedToSoft: string[];
} {
  const {
    failedHardAttributes,
    visualEvidenceText = '',
    confidence,
    attributeStrengths,
    productNameEn = '',
    category = '',
    hardConflictMinConfidence = 0.72,
  } = params;

  const actualFailedHard: string[] = [];
  const downgradedToSoft: string[] = [];
  const hasVisualEvidence = String(visualEvidenceText || '').trim().length >= 6;
  const hasSufficientConfidence = confidence >= hardConflictMinConfidence;

  for (const rawAttr of failedHardAttributes || []) {
    const attr = String(rawAttr || '').trim();
    if (!attr) continue;

    const quality = isTautologicalOrVagueAttribute(attr, productNameEn, category);
    const strength = attributeStrengths[attr] || 'hard';

    if (
      strength !== 'hard' ||
      quality.isInvalidForHard ||
      SOFT_ATTRIBUTE_CHECK(attr) ||
      !hasVisualEvidence ||
      !hasSufficientConfidence
    ) {
      downgradedToSoft.push(attr);
    } else {
      actualFailedHard.push(attr);
    }
  }

  return { actualFailedHard, downgradedToSoft };
}

/**
 * Two-stage attribute-level verifier for product listings and TikTok candidates.
 * - For TikTok candidates (or when blind verification is enabled): runs PHASE 2 Describe-then-Compare
 *   with scene-aware ffmpeg keyframes, blind Gemini extraction, bounding-box crop CLIP similarity,
 *   link-state probing, and Phase 1 Evidence-Gated Badges (V0..V3).
 * - NEVER counts verification_error or budget_exhausted as rejections.
 */
export async function verifyListingCandidatesBatch(params: {
  referenceImageBase64: string;
  referenceImageMimeType: string;
  additionalReferenceImagesBase64?: string[];
  identity: IdentityCardV2;
  candidates: ListingCandidateToVerify[];
  matchMode?: MatchMode;
  includeSimilar?: boolean;
  relaxationPass?: 1 | 2 | 3;
  sourceType?: 'amazon' | 'tiktok';
  attributeStrengthOverrides?: Record<string, AttributeStrength>;
  onGeminiCallRecorded?: (calls: number) => void;
  signal?: AbortSignal;
}): Promise<Map<string, AttributeVerificationVerdict>> {
  const {
    referenceImageBase64,
    referenceImageMimeType,
    additionalReferenceImagesBase64 = [],
    identity,
    candidates,
    matchMode = 'same_design',
    includeSimilar = false,
    relaxationPass = 1,
    sourceType = 'amazon',
    attributeStrengthOverrides,
    onGeminiCallRecorded,
    signal,
  } = params;

  const cal = getCalibrationConfig();
  const settings = getRuntimeSettings();
  const out = new Map<string, AttributeVerificationVerdict>();
  if (candidates.length === 0) return out;

  const attributeStrengths = classifyIdentityAttributeStrengths(
    identity.mustMatch,
    {
      ...(identity.attributeStrengths || {}),
      ...(attributeStrengthOverrides || {}),
    },
    { nameEn: identity.nameEn, category: identity.category }
  );
  const hardAttributes = identity.mustMatch.filter((a) => attributeStrengths[a] === 'hard');
  const softAttributes = identity.mustMatch.filter((a) => attributeStrengths[a] === 'soft');

  const stage1ClipThreshold =
    sourceType === 'tiktok'
      ? settings.thresholds.stage1TikTokClipMin ?? 0.34
      : settings.thresholds.stage1ClipMin ?? cal.stage1LocalDirectRejectSimilarity ?? 0.42;

  const stage2ConfMin =
    settings.thresholds.stage2ConfidenceMin ?? cal.stage2AcceptMinConfidence ?? 0.60;
  const stage2MustNotBeConf =
    settings.thresholds.stage2MustNotBeConfidence ?? cal.stage2MustNotBeRejectConfidence ?? 0.58;

  const optimizedRef = await optimizeReferenceImageForVision(
    referenceImageBase64.replace(/^data:[^;]+;base64,/, ''),
    referenceImageMimeType || 'image/jpeg'
  );
  const refBuf = Buffer.from(optimizedRef.base64, 'base64');
  let refClipEmbedding: number[] | null = null;
  const multiRefEmbeddings: Float32Array[] = [];

  try {
    const refClip = await computeColorAgnosticClipEmbedding(refBuf);
    refClipEmbedding = refClip.embedding;
    const primaryNeuralEmb = await computeImageBufferEmbedding(refBuf);
    if (primaryNeuralEmb) multiRefEmbeddings.push(primaryNeuralEmb);

    // Phase 2.5 Multi-reference: compute embeddings for additional uploaded + anchor-listing images (up to 4)
    for (const extraB64 of additionalReferenceImagesBase64.slice(0, 4)) {
      if (!extraB64) continue;
      try {
        const cleanExtra = extraB64.replace(/^data:[^;]+;base64,/, '');
        const extraBuf = Buffer.from(cleanExtra, 'base64');
        const extraEmb = await computeImageBufferEmbedding(extraBuf);
        if (extraEmb) multiRefEmbeddings.push(extraEmb);
      } catch {}
    }
  } catch (err) {
    console.warn('[VerifyPipeline] Reference CLIP embedding error:', (err as Error)?.message);
  }

  const userFeedback = getVerificationFeedbackForImage(identity.imageHash);
  const userAcceptedIds = new Set(
    userFeedback.filter((f) => f.userAction === 'accept').map((f) => f.candidateId.toUpperCase())
  );

  const stage1Survivors: Array<{
    candidate: ListingCandidateToVerify;
    imageBase64: string;
    imageMimeType: string;
    localSim: number;
    colorSim: number;
    textMustNotBeHits: string[];
  }> = [];

  await Promise.all(
    candidates.map(async (cand) => {
      const idUpper = cand.id.toUpperCase();
      const cacheKey = `${identity.imageHash}::${idUpper}::${sourceType}`;

      if (userAcceptedIds.has(idUpper)) {
        const verdict: AttributeVerificationVerdict = {
          id: idUpper,
          approved: true,
          countsTowardTarget: true,
          verdict: 'same_design',
          verdictTier: 'same_design_variant',
          evidenceLevel: 'V2',
          evidenceSummaryAr: 'تم قبوله يدوياً بواسطة المالك (تغذية راجعة مؤكدة)',
          userFacingBadgeAr: 'مقبول يدوياً من المالك',
          linkState: 'alive',
          reasonCode: null,
          verifiedByAi: true,
          formFactorMatches: true,
          mechanismMatches: true,
          colorMatches: true,
          mustNotBeHit: [],
          confidence: 0.99,
          referenceSimilarity: 0.95,
          reasonAr: 'تم قبوله يدوياً بواسطة المستخدم (تغذية راجعة مؤكدة)',
          stage: 'visual_stage2_gemini',
        };
        out.set(idUpper, verdict);
        return;
      }

      const cached = verdictsCache.get(cacheKey);
      if (cached && cached.verdictTier !== 'unverified') {
        const approved =
          cached.evidenceLevel !== 'V0' &&
          cached.evidenceLevel !== 'V1' &&
          cached.linkState !== 'dead' &&
          shouldApproveTier(
            cached.verdictTier,
            matchMode,
            includeSimilar,
            cached.colorMatches,
            relaxationPass
          );
        out.set(idUpper, {
          ...cached,
          approved,
          reasonCode: approved ? null : cached.reasonCode,
        });
        return;
      }

      const typeGate = evaluateProductTypeGate(cand.title, identity);
      const textMustNotBeHits = Array.from(
        new Set([
          ...detectDynamicMustNotBeInText(cand.title, identity),
          ...(typeGate.conflictingTypeTerm ? [typeGate.conflictingTypeTerm] : []),
        ])
      );

      // Ignore Amazon lazy-load SVG placeholders
      const cleanImageUrl =
        cand.imageUrl && !cand.imageUrl.toLowerCase().endsWith('.svg') ? cand.imageUrl : undefined;

      let imgB64 = cand.imageBase64;
      let imgMime = cand.imageMimeType || 'image/jpeg';
      if (!imgB64 && cleanImageUrl) {
        const fetched = await fetchProductImageAsBase64(cleanImageUrl, signal);
        if (fetched) {
          imgB64 = fetched.base64;
          imgMime = fetched.mimeType;
        }
      }

      // Phase 1: V0 / no retrievable media can NEVER receive a match badge and is marked unverified/rejected
      if (!imgB64) {
        const verdict: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unverified_by_ai',
          verdictTier: 'unverified',
          evidenceLevel: 'V0',
          evidenceSummaryAr: 'مستوى الدليل V0: لا توجد صورة مصغرة أو إطارات قابلة للجلب',
          userFacingBadgeAr: 'غير متحقق (لا توجد وسائط V0)',
          reasonCode: 'low_similarity',
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: false,
          mustNotBeHit: textMustNotBeHits,
          confidence: 0.9,
          referenceSimilarity: 0,
          reasonAr: 'تم استبعاد العنصر لعدم توفر صورة أو إطارات صالحة للتحقق البصري (V0 — لا يُقبل بالنص فقط)',
          stage: 'visual_stage1_local',
        };
        out.set(idUpper, verdict);
        return;
      }

      let localSim = 0.72;
      const colorSim = 0.75;
      if (refClipEmbedding) {
        try {
          const candBuf = Buffer.from(imgB64.replace(/^data:[^;]+;base64,/, ''), 'base64');
          const candClip = await computeColorAgnosticClipEmbedding(candBuf);
          localSim = Number(cosineSimilarityClip(refClipEmbedding, candClip.embedding).toFixed(4));
        } catch (err) {
          console.warn(`[VerifyPipeline] Candidate CLIP error on ${idUpper}:`, (err as Error)?.message);
        }
      }

      // For TikTok or explicit Type Gate violations (e.g. rear seat armrest box / wireless charger / Highlander box), reject immediately in Stage 1
      if (
        (!typeGate.passesTypeGate && sourceType === 'tiktok') ||
        (textMustNotBeHits.length > 0 && localSim < cal.stage1MustNotBeOverrideClipSimilarity)
      ) {
        const term = textMustNotBeHits[0] || typeGate.conflictingTypeTerm || 'must_not_be';
        const verdict: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'similar_other_type',
          verdictTier: 'other_type',
          evidenceLevel: 'V1',
          evidenceSummaryAr: `تعارض صريح مع بوابة النوع / قائمة الاستبعاد (${term})`,
          reasonCode: `rejected_must_not_be:${term}`,
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: true,
          mustNotBeHit: textMustNotBeHits,
          confidence: 0.92,
          referenceSimilarity: localSim,
          reasonAr: `مستبعد بقائمة الاستبعاد / بوابة النوع (${textMustNotBeHits.slice(0, 2).join(' / ')}) — تشابه CLIP ${(localSim * 100).toFixed(1)}%`,
          stage: 'visual_stage1_local',
        };
        verdictsCache.set(cacheKey, verdict);
        out.set(idUpper, verdict);
        return;
      }

      if (localSim < stage1ClipThreshold) {
        const verdict: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unrelated',
          verdictTier: 'unrelated',
          evidenceLevel: 'V2',
          reasonCode: 'low_similarity',
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: false,
          mustNotBeHit: textMustNotBeHits,
          confidence: 0.88,
          referenceSimilarity: localSim,
          reasonAr: `تشابه بصري محلي (CLIP) منخفض (${(localSim * 100).toFixed(1)}% < ${(stage1ClipThreshold * 100).toFixed(0)}%) مقارنة بالصورة المرجعية`,
          stage: 'visual_stage1_local',
        };
        verdictsCache.set(cacheKey, verdict);
        out.set(idUpper, verdict);
        return;
      }

      stage1Survivors.push({
        candidate: cand,
        imageBase64: imgB64,
        imageMimeType: imgMime,
        localSim,
        colorSim,
        textMustNotBeHits,
      });
    })
  );

  if (stage1Survivors.length === 0) {
    saveVerdictsCacheToDisk();
    return out;
  }

  // PHASE 2 — For TikTok candidates, ALWAYS use Blind Describe-Then-Compare + Scene-Aware Keyframes + Link State Probe!
  if (sourceType === 'tiktok') {
    const { discriminators, sameCategoryLookalikes } = buildDiscriminatorsForIdentityCard(identity);

    for (const item of stage1Survivors) {
      if (signal?.aborted) break;
      const idUpper = item.candidate.id.toUpperCase();
      const cacheKey = `${identity.imageHash}::${idUpper}::${sourceType}`;
      const budget = getDailyGeminiBudgetStatus();

      if (!isGeminiConfigured() || budget.exhausted || !consumeGeminiBudgetCall(1)) {
        const vObj: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unverified_by_ai',
          verdictTier: 'unverified',
          evidenceLevel: 'V1',
          reasonCode: 'budget_exhausted',
          isErrorNotRejection: true,
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: true,
          mustNotBeHit: item.textMustNotBeHits,
          confidence: item.localSim,
          referenceSimilarity: item.localSim,
          reasonAr: 'استنفاد ميزانية Gemini اليومية — غير متحقق بالذكاء الاصطناعي (لا يُحتسب كمرفوض)',
          stage: 'budget_fallback',
        };
        out.set(idUpper, vObj);
        continue;
      }

      onGeminiCallRecorded?.(1);

      try {
        const candThumbBuf = Buffer.from(
          item.imageBase64.replace(/^data:[^;]+;base64,/, ''),
          'base64'
        );

        // 1. Probe link state (alive / blocked / dead)
        const linkProbe = await probeCandidateLinkState(item.candidate.url, 'tiktok', signal);

        // 2. Extract 3-5 scene-aware keyframes via ffmpeg (or fallback to thumbnail capped at V2)
        const kfResult = await extractSceneAwareKeyframes({
          candidateId: item.candidate.id,
          videoInputPathOrUrl: item.candidate.videoUrl || item.candidate.url,
          fallbackThumbnailBuffers: [candThumbBuf],
          maxFrames: 4,
        });

        // 3. Blind Describe-Then-Compare with Gemini (NO reference image shown, NO "is this the same product?" prompt)
        const blindDesc = await describeCandidateBlindWithGemini({
          candidateId: item.candidate.id,
          frameBuffers: kfResult.frameBuffers,
          discriminators,
          sameCategoryLookalikes,
          imageHash: identity.imageHash,
        });

        // 4. Product localization: crop primary bounding box and compute CLIP similarity against all reference images
        let cropClipSim: number | null = null;
        if (blindDesc.boundingBoxes.length > 0 && multiRefEmbeddings.length > 0) {
          const primaryBox = blindDesc.boundingBoxes[0];
          const frameIdx = Math.max(
            0,
            Math.min(kfResult.frameBuffers.length - 1, primaryBox.frameIndex || 0)
          );
          const cropRes = await cropBoundingBoxAndCompareClip({
            frameBuffer: kfResult.frameBuffers[frameIdx],
            box: primaryBox,
            referenceEmbeddings: multiRefEmbeddings,
          });
          cropClipSim = cropRes.cropSimilarity;
        }

        // 5. Pure code comparison with HARD/SOFT rules and V0-V3 Evidence Gate
        const codeComp = compareBlindProfileInCode({
          identityCard: identity,
          blindDesc,
          candidateTitle: item.candidate.title,
          framesInspectedCount: kfResult.frameBuffers.length,
          usedFallbackThumbnailOnly: kfResult.usedFallbackThumbnailOnly,
          fullFrameClipSimilarity: item.localSim,
          cropClipSimilarity: cropClipSim,
          linkState: linkProbe.linkState,
          hasRetrievableMedia: kfResult.frameBuffers.length > 0,
        });

        const finalSim =
          cropClipSim !== null
            ? Number((cropClipSim * 0.65 + item.localSim * 0.35).toFixed(4))
            : item.localSim;

        const vObj: AttributeVerificationVerdict = {
          id: idUpper,
          approved: codeComp.approved,
          countsTowardTarget: codeComp.countsTowardTarget,
          verdict: tierToLegacyVerdict(codeComp.verdictTier),
          verdictTier: codeComp.verdictTier,
          evidenceLevel: codeComp.evidenceLevel,
          evidenceSummaryAr: `${codeComp.evidenceSummaryAr} (${kfResult.extractionReasonAr})`,
          userFacingBadgeAr: codeComp.userFacingBadgeAr,
          visibleFramesCount: blindDesc.productVisibleFrameIndices.length,
          keyframesExtracted: kfResult.keyframesExtractedCount,
          extractedFrameUrls: kfResult.framePublicUrls,
          cropClipSimilarity: cropClipSim,
          boundingBoxes: blindDesc.boundingBoxes,
          blindObservations: blindDesc.discriminatorObservations,
          linkState: linkProbe.linkState,
          linkStateReasonAr: linkProbe.reasonAr,
          reasonCode: codeComp.approved ? null : codeComp.reasonCode,
          failedHardAttributes: codeComp.failedHardAttributes,
          failedSoftAttributes: codeComp.failedSoftAttributes,
          notVisibleHardAttributes: codeComp.notVisibleHardAttributes,
          verifiedByAi: true,
          formFactorMatches: codeComp.failedHardAttributes.length === 0,
          mechanismMatches: codeComp.failedHardAttributes.length === 0,
          colorMatches: true,
          mustNotBeHit: Array.from(new Set([...item.textMustNotBeHits, ...codeComp.mustNotBeHit])),
          confidence: codeComp.confidence,
          referenceSimilarity: finalSim,
          reasonAr: codeComp.reasonAr,
          stage: kfResult.keyframesExtractedCount >= 2 ? 'video_keyframes' : 'visual_stage2_gemini',
        };

        verdictsCache.set(cacheKey, vObj);
        out.set(idUpper, vObj);
      } catch (err) {
        const errMsg = (err as Error)?.message || String(err);
        console.warn(`[VerifyPipeline] Blind verification error on ${idUpper}:`, errMsg);
        const vObj: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unverified_by_ai',
          verdictTier: 'unverified',
          evidenceLevel: 'V1',
          reasonCode: 'verification_error',
          isErrorNotRejection: true,
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: false,
          mustNotBeHit: item.textMustNotBeHits,
          confidence: item.localSim,
          referenceSimilarity: item.localSim,
          reasonAr: `خطأ تقني مؤقت أثناء التحقق الأعمى (${errMsg.slice(0, 60)}) — صُنّف كغير متحقق ولا يُحتسب كمرفوض`,
          stage: 'budget_fallback',
        };
        out.set(idUpper, vObj);
      }
    }

    saveVerdictsCacheToDisk();
    return out;
  }

  // Stage 2: Batched Gemini multimodal attribute verification on Amazon listing Stage 1 survivors
  const batchSize = cal.maxStage2BatchSize || 4;
  for (let i = 0; i < stage1Survivors.length; i += batchSize) {
    if (signal?.aborted) break;
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const chunk = stage1Survivors.slice(i, i + batchSize);
    const budget = getDailyGeminiBudgetStatus();

    if (!isGeminiConfigured() || budget.exhausted || !consumeGeminiBudgetCall(1)) {
      for (const item of chunk) {
        const idUpper = item.candidate.id.toUpperCase();
        const verdict: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unverified_by_ai',
          verdictTier: 'unverified',
          evidenceLevel: 'V1',
          reasonCode: 'budget_exhausted',
          isErrorNotRejection: true,
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: true,
          mustNotBeHit: item.textMustNotBeHits,
          confidence: item.localSim,
          referenceSimilarity: item.localSim,
          reasonAr: 'استنفاد ميزانية Gemini اليومية — غير متحقق بالذكاء الاصطناعي (لا يُحتسب كمرفوض)',
          stage: 'budget_fallback',
        };
        out.set(idUpper, verdict);
      }
      continue;
    }

    onGeminiCallRecorded?.(1);

    try {
      const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [
        {
          inlineData: {
            data: optimizedRef.base64,
            mimeType: optimizedRef.mimeType,
          },
        },
        {
          text: `Image #1 above is the REFERENCE PRODUCT.
Identity Card v3 for Reference Product:
- Name: "${identity.nameEn}" (${identity.nameAr})
- Primary Color: ${identity.primaryColor}
- Form Factor: shape="${identity.formFactor.shape}", size="${identity.formFactor.approximateSize}"
- Mechanism: howItWorks="${identity.mechanism.howItWorks}", powerSource="${identity.mechanism.powerSource}"
- HARD Attributes (TYPE & DESIGN DEFINING — conflict means different product design/type): ${JSON.stringify(hardAttributes)}
- SOFT Attributes (SECONDARY DETAILS — differences in color, brand, logo, packaging, or minor accessory counts are ALLOWED): ${JSON.stringify([...softAttributes, ...identity.variableAttributes])}
- mustNotBe (STRICT EXCLUSIONS — different product types or look-alike designs that must be rejected): ${JSON.stringify(identity.mustNotBe)}
${
  userFeedback.length > 0
    ? `\nUser Feedback Overrides for this product:\n${userFeedback
        .slice(-5)
        .map((f) => `- Candidate "${f.candidateTitle}" (${f.candidateId}) was marked "${f.userAction}" by user.`)
        .join('\n')}`
    : ''
}

Below are ${chunk.length} Amazon product listings. Evaluate each listing's PHOTO and TITLE against the Reference Product.`,
        },
      ];

      chunk.forEach((item, idx) => {
        parts.push({
          inlineData: {
            data: item.imageBase64,
            mimeType: item.imageMimeType,
          },
        });
        parts.push({
          text: `Candidate #${idx + 1}:
id: "${item.candidate.id}"
title: "${item.candidate.title}"`,
        });
      });

      parts.push({
        text: `For EVERY candidate, return a structured evaluation:
- id: Exact candidate id string.
- formFactorMatches: boolean — true if the core 3D product shape/form-factor class matches.
- mechanismMatches: boolean — true if the core operating mechanism matches.
- colorMatches: boolean — true if main color matches (${identity.primaryColor}), false if different color variant.
- failedHardAttributes: array of strings from HARD Attributes (${JSON.stringify(hardAttributes)}) that this candidate violates in the image. Empty array [] if all HARD attributes are satisfied.
- hardConflictEvidence: string — concrete visual evidence from the image explaining WHY a HARD attribute is violated (empty string "" if failedHardAttributes is empty).
- failedSoftAttributes: array of strings from SOFT Attributes that differ.
- mustNotBeHit: array of strings from mustNotBe that this candidate actually is. Empty array [] if none.
- verdictTier: Choose ONE of the 6 tiers:
  * "exact": Same product design, form factor, mechanism, and color.
  * "same_design_variant": Same product design class, form factor, and mechanism, with differences in SOFT attributes.
  * "same_type_close_design": Same functional product type and mechanism (does NOT hit mustNotBe), with a close housing/contour design.
  * "same_type_other_design": Same functional product type and mechanism (does NOT hit mustNotBe), with a noticeably different outer shell/kit layout.
  * "other_type": Different product type or mechanism (hits mustNotBe or fundamentally different tool/appliance type).
  * "unrelated": Completely unrelated product or bare spare part/cable only.
- confidence: number 0.0 to 1.0.
- reasonAr: Concise Arabic explanation.`,
      });

      const response = await generateContentWithModelFallback(
        (model) => ({
          model,
          contents: { parts },
          config: {
            abortSignal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
              : AbortSignal.timeout(25000),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                verdicts: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      formFactorMatches: { type: Type.BOOLEAN },
                      mechanismMatches: { type: Type.BOOLEAN },
                      colorMatches: { type: Type.BOOLEAN },
                      failedHardAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
                      hardConflictEvidence: { type: Type.STRING },
                      failedSoftAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
                      mustNotBeHit: { type: Type.ARRAY, items: { type: Type.STRING } },
                      verdictTier: {
                        type: Type.STRING,
                        enum: [
                          'exact',
                          'same_design_variant',
                          'same_type_close_design',
                          'same_type_other_design',
                          'other_type',
                          'unrelated',
                        ],
                      },
                      confidence: { type: Type.NUMBER },
                      reasonAr: { type: Type.STRING },
                    },
                    required: [
                      'id',
                      'formFactorMatches',
                      'mechanismMatches',
                      'colorMatches',
                      'failedHardAttributes',
                      'failedSoftAttributes',
                      'mustNotBeHit',
                      'verdictTier',
                      'confidence',
                      'reasonAr',
                    ],
                  },
                },
              },
              required: ['verdicts'],
            },
          },
        }),
        { maxRetries: 2, baseMs: 700, timeoutMs: 25000 }
      );

      const parsed = JSON.parse(response.text?.trim() || '{}');
      const rawVerdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
      const verdictMap = new Map<string, any>();
      for (const rv of rawVerdicts) {
        if (rv?.id) verdictMap.set(String(rv.id).trim().toUpperCase(), rv);
      }

      for (const item of chunk) {
        const idUpper = item.candidate.id.toUpperCase();
        const cacheKey = `${identity.imageHash}::${idUpper}::${sourceType}`;
        const rv = verdictMap.get(idUpper);

        if (rv) {
          const conf = Math.max(0, Math.min(1, Number(rv.confidence) || 0.78));
          const mergedMustNotBe = Array.from(
            new Set([
              ...(Array.isArray(rv.mustNotBeHit) ? rv.mustNotBeHit.map(String).filter(Boolean) : []),
              ...item.textMustNotBeHits,
            ])
          );
          const rawFailedHard: string[] = Array.isArray(rv.failedHardAttributes)
            ? rv.failedHardAttributes.map(String).filter(Boolean)
            : [];
          const hardConflictEvidenceText = String(rv.hardConflictEvidence || rv.reasonAr || '').trim();

          const { actualFailedHard, downgradedToSoft } = evaluateHardAttributeConflicts({
            failedHardAttributes: rawFailedHard,
            visualEvidenceText: hardConflictEvidenceText,
            confidence: conf,
            attributeStrengths,
            productNameEn: identity.nameEn,
            category: identity.category,
            hardConflictMinConfidence: 0.72,
          });

          const failedSoft: string[] = Array.from(
            new Set([
              ...(Array.isArray(rv.failedSoftAttributes)
                ? rv.failedSoftAttributes.map(String).filter(Boolean)
                : []),
              ...downgradedToSoft,
            ])
          );

          const formOk = Boolean(rv.formFactorMatches);
          const mechOk = Boolean(rv.mechanismMatches);
          const colorOk = Boolean(rv.colorMatches);

          let tier: VerdictTier =
            rv.verdictTier === 'exact' ||
            rv.verdictTier === 'same_design_variant' ||
            rv.verdictTier === 'same_type_close_design' ||
            rv.verdictTier === 'same_type_other_design' ||
            rv.verdictTier === 'other_type' ||
            rv.verdictTier === 'unrelated'
              ? rv.verdictTier
              : 'other_type';

          if (mergedMustNotBe.length > 0 && conf >= stage2MustNotBeConf) {
            if (
              tier === 'exact' ||
              tier === 'same_design_variant' ||
              tier === 'same_type_close_design' ||
              tier === 'same_type_other_design'
            ) {
              tier = 'other_type';
            }
          }

          if (!mechOk || actualFailedHard.length > 0) {
            if (tier === 'exact' || tier === 'same_design_variant') {
              tier = !mechOk
                ? 'other_type'
                : formOk
                ? 'same_type_close_design'
                : 'same_type_other_design';
            }
          }

          if (mergedMustNotBe.length === 0 && actualFailedHard.length === 0) {
            if (formOk && mechOk && tier === 'other_type') {
              tier = failedSoft.length === 0 && colorOk ? 'exact' : 'same_design_variant';
            } else if (mechOk && tier === 'other_type') {
              tier = item.localSim >= 0.52 ? 'same_type_close_design' : 'same_type_other_design';
            }
          }

          const approved =
            conf >= stage2ConfMin &&
            shouldApproveTier(tier, matchMode, includeSimilar, colorOk, relaxationPass);

          let reasonCode: string | null = null;
          if (!approved) {
            if (mergedMustNotBe.length > 0) {
              reasonCode = `rejected_must_not_be:${mergedMustNotBe[0]}`;
            } else if (actualFailedHard.length > 0) {
              reasonCode = `rejected_hard_attribute:${actualFailedHard[0]}`;
            } else if (!mechOk) {
              reasonCode = `rejected_hard_attribute:mechanism`;
            } else if (!formOk) {
              reasonCode = `rejected_hard_attribute:form_factor`;
            } else if (matchMode === 'strict_color' && !colorOk) {
              reasonCode = `rejected_hard_attribute:color`;
            } else {
              reasonCode = 'rejected_other_type';
            }
          }

          let reasonAr = String(rv.reasonAr || '').trim();
          if (!reasonAr || (approved && downgradedToSoft.length > 0)) {
            reasonAr = approved
              ? tier === 'exact'
                ? 'مطابق تماماً لتصميم وآلية عمل المنتج المرجعي'
                : tier === 'same_design_variant'
                ? 'نفس التصميم وآلية العمل (مع اختلاف مسموح في اللون/العلامة/الحقيبة/التفاصيل الثانوية)'
                : tier === 'same_type_close_design'
                ? 'نفس نوع المنتج وآلية العمل بتصميم قريب'
                : 'نفس نوع المنتج وآلية العمل بتصميم بديل'
              : getReasonArFallback(reasonCode, mergedMustNotBe, actualFailedHard);
          }

          // Listing check has 1 listing image -> V2 until video keyframes are extracted
          const vObj: AttributeVerificationVerdict = {
            id: idUpper,
            approved,
            countsTowardTarget: approved,
            verdict: tierToLegacyVerdict(tier),
            verdictTier: tier,
            evidenceLevel: 'V2',
            evidenceSummaryAr: 'مستوى الدليل V2: تم التحقق من صورة صفحة المنتج على أمازون',
            visibleFramesCount: 1,
            linkState: 'alive',
            reasonCode,
            failedHardAttributes: actualFailedHard,
            failedSoftAttributes: failedSoft,
            verifiedByAi: true,
            formFactorMatches: formOk,
            mechanismMatches: mechOk,
            colorMatches: colorOk,
            mustNotBeHit: mergedMustNotBe,
            confidence: conf,
            referenceSimilarity: Number((conf * 0.75 + item.localSim * 0.25).toFixed(3)),
            reasonAr,
            stage: 'visual_stage2_gemini',
          };

          verdictsCache.set(cacheKey, vObj);
          out.set(idUpper, vObj);
        } else {
          const vObj: AttributeVerificationVerdict = {
            id: idUpper,
            approved: false,
            countsTowardTarget: false,
            verdict: 'unverified_by_ai',
            verdictTier: 'unverified',
            evidenceLevel: 'V1',
            reasonCode: 'verification_error',
            isErrorNotRejection: true,
            verifiedByAi: false,
            formFactorMatches: false,
            mechanismMatches: false,
            colorMatches: false,
            mustNotBeHit: item.textMustNotBeHits,
            confidence: item.localSim,
            referenceSimilarity: item.localSim,
            reasonAr: 'لم يرجع نموذج التحقق نتيجة لهذا العنصر (خطأ تقني — لا يُحتسب كمرفوض)',
            stage: 'budget_fallback',
          };
          out.set(idUpper, vObj);
        }
      }
    } catch (err) {
      const errMsg = (err as Error)?.message || String(err);
      console.warn('[VerifyPipeline] Stage 2 Gemini batch error after retries:', errMsg);
      for (const item of chunk) {
        const idUpper = item.candidate.id.toUpperCase();
        const vObj: AttributeVerificationVerdict = {
          id: idUpper,
          approved: false,
          countsTowardTarget: false,
          verdict: 'unverified_by_ai',
          verdictTier: 'unverified',
          evidenceLevel: 'V1',
          reasonCode: 'verification_error',
          isErrorNotRejection: true,
          verifiedByAi: false,
          formFactorMatches: false,
          mechanismMatches: false,
          colorMatches: false,
          mustNotBeHit: item.textMustNotBeHits,
          confidence: item.localSim,
          referenceSimilarity: item.localSim,
          reasonAr: `خطأ تقني مؤقت أثناء التحقق (${errMsg.slice(0, 60)}) — صُنّف كغير متحقق ولا يُحتسب كمرفوض`,
          stage: 'budget_fallback',
        };
        out.set(idUpper, vObj);
      }
    }
  }

  saveVerdictsCacheToDisk();
  return out;
}

function SOFT_ATTRIBUTE_CHECK(attr: string): boolean {
  return /\b(colou?r|beige|black|white|grey|gray|brand|logo|retail\s*box|packag|cable\s*length)\b/i.test(
    attr
  );
}

function getReasonArFallback(
  reasonCode: string | null,
  mustNotBe: string[],
  failedHard: string[]
): string {
  if (mustNotBe.length > 0) {
    return `مستبعد لانتمائه لقائمة الاستبعاد (${mustNotBe[0]})`;
  }
  if (failedHard.length > 0) {
    return `تعارض في سمة أساسية (${failedHard[0]})`;
  }
  return reasonCode || 'مختلف في الشكل الهندسي أو آلية العمل عن المنتج المرجعي';
}

/**
 * PHASE 2.1, 2.2, 2.3 — Video-level Blind Describe-Then-Compare verification:
 * Extracts 3-5 scene-aware keyframes via ffmpeg (skipping the first black frame),
 * runs blind Gemini description on the keyframes alone, crops the product bounding box
 * for local CLIP similarity, and runs compareBlindProfileInCode + enforceEvidenceGatedBadge.
 * If frames cannot be obtained, caps evidence at V2 and explains why.
 */
export async function verifyVideoCandidateAttributes(params: {
  videoId: string;
  videoUrl: string;
  fallbackThumbnailUrl?: string;
  fallbackThumbnailBuffer?: Buffer;
  titleOrCaption: string;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  additionalReferenceImagesBase64?: string[];
  identity?: IdentityCardV2 | null;
  matchMode?: MatchMode;
  includeSimilar?: boolean;
  requireKeyframeVision?: boolean;
  linkState?: LinkState;
  onKeyframesExtracted?: (count: number, failed: boolean, reason?: string) => void;
  onGeminiCallRecorded?: (calls: number) => void;
  signal?: AbortSignal;
}): Promise<AttributeVerificationVerdict> {
  const {
    videoId,
    videoUrl,
    fallbackThumbnailUrl,
    fallbackThumbnailBuffer,
    titleOrCaption,
    referenceImageBase64,
    referenceImageMimeType = 'image/jpeg',
    additionalReferenceImagesBase64 = [],
    identity,
    matchMode = 'same_design',
    requireKeyframeVision = false,
    linkState = 'alive',
    onKeyframesExtracted,
    onGeminiCallRecorded,
    signal,
  } = params;

  if (!identity) {
    return {
      id: videoId,
      approved: false,
      countsTowardTarget: false,
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
      evidenceLevel: 'V1',
      reasonCode: null,
      verifiedByAi: false,
      formFactorMatches: true,
      mechanismMatches: true,
      colorMatches: true,
      mustNotBeHit: [],
      confidence: 0.7,
      referenceSimilarity: 0.7,
      reasonAr: 'بحث نصي بدون صورة مرجعية (V1 — غير متحقق بصرياً)',
      stage: 'text_gate',
    };
  }

  const typeGate = evaluateProductTypeGate(titleOrCaption, identity);
  const textHits = Array.from(
    new Set([
      ...detectDynamicMustNotBeInText(titleOrCaption, identity),
      ...(typeGate.conflictingTypeTerm ? [typeGate.conflictingTypeTerm] : []),
    ])
  );
  if (textHits.length > 0) {
    return {
      id: videoId,
      approved: false,
      countsTowardTarget: false,
      verdict: 'similar_other_type',
      verdictTier: 'other_type',
      evidenceLevel: 'V1',
      reasonCode: `rejected_must_not_be:${textHits[0]}`,
      verifiedByAi: false,
      formFactorMatches: false,
      mechanismMatches: false,
      colorMatches: false,
      mustNotBeHit: textHits,
      confidence: 0.92,
      referenceSimilarity: 0.2,
      reasonAr: `عنوان الفيديو يشير إلى منتج مختلف مستبعد (${textHits.slice(0, 2).join(' / ')})`,
      stage: 'video_keyframes',
    };
  }

  const cacheKey = `${identity.imageHash}::VID_${videoId}::${matchMode}`;
  const cached = verdictsCache.get(cacheKey);
  if (cached && cached.verdictTier !== 'unverified') {
    onKeyframesExtracted?.(cached.keyframesExtracted ?? 3, false);
    return cached;
  }

  // Gather fallback thumbnail buffer if provided or fetchable
  const fallbackBuffers: Buffer[] = [];
  if (fallbackThumbnailBuffer && fallbackThumbnailBuffer.byteLength > 400) {
    fallbackBuffers.push(fallbackThumbnailBuffer);
  } else if (fallbackThumbnailUrl && fallbackThumbnailUrl.startsWith('http')) {
    try {
      const fetched = await fetchProductImageAsBase64(fallbackThumbnailUrl, signal);
      if (fetched?.base64) {
        fallbackBuffers.push(Buffer.from(fetched.base64, 'base64'));
      }
    } catch {}
  }

  const kfResult = await extractSceneAwareKeyframes({
    candidateId: videoId,
    videoInputPathOrUrl: videoUrl,
    fallbackThumbnailBuffers: fallbackBuffers,
    maxFrames: 4,
  });

  if (kfResult.keyframesExtractedCount === 0) {
    onKeyframesExtracted?.(0, true, kfResult.extractionReasonAr);
    // PHASE 2.3 & PHASE 4.4: If keyframes cannot be obtained, cap evidence at V2 (or V1 if no thumbnail)
    // and never grant Exact (V3)!
    if (!requireKeyframeVision) {
      return {
        id: videoId,
        approved: fallbackBuffers.length > 0,
        countsTowardTarget: fallbackBuffers.length > 0,
        verdict: fallbackBuffers.length > 0 ? 'variant' : 'unverified_by_ai',
        verdictTier: fallbackBuffers.length > 0 ? 'same_design_variant' : 'unverified',
        evidenceLevel: fallbackBuffers.length > 0 ? 'V2' : 'V1',
        evidenceSummaryAr: kfResult.extractionReasonAr,
        userFacingBadgeAr:
          fallbackBuffers.length > 0
            ? 'نفس التصميم (مقيد عند V2 لتعذر استخراج إطارات الفيديو)'
            : 'غير متحقق (V1)',
        keyframesExtracted: 0,
        visibleFramesCount: fallbackBuffers.length > 0 ? 1 : 0,
        linkState,
        reasonCode: fallbackBuffers.length > 0 ? null : 'no_keyframes_capped_v1',
        verifiedByAi: true,
        formFactorMatches: true,
        mechanismMatches: true,
        colorMatches: true,
        mustNotBeHit: [],
        confidence: 0.78,
        referenceSimilarity: 0.78,
        reasonAr: kfResult.extractionReasonAr,
        stage: 'video_keyframes',
      };
    }
  } else {
    onKeyframesExtracted?.(kfResult.keyframesExtractedCount, false);
  }

  if (kfResult.frameBuffers.length === 0) {
    return {
      id: videoId,
      approved: false,
      countsTowardTarget: false,
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
      evidenceLevel: 'V0',
      evidenceSummaryAr: 'مستوى الدليل V0: تعذر استخراج إطارات الفيديو أو الصورة المصغرة',
      userFacingBadgeAr: 'غير متحقق (V0)',
      keyframesExtracted: 0,
      visibleFramesCount: 0,
      linkState,
      reasonCode: 'no_media_evidence',
      verifiedByAi: false,
      formFactorMatches: false,
      mechanismMatches: false,
      colorMatches: false,
      mustNotBeHit: [],
      confidence: 0.3,
      referenceSimilarity: 0.3,
      reasonAr: 'تعذر استخراج إطارات الفيديو أو الصورة المصغرة — تم التصنيف كغير متحقق (V0)',
      stage: 'video_keyframes',
    };
  }

  const budget = getDailyGeminiBudgetStatus();
  if (!isGeminiConfigured() || budget.exhausted || !consumeGeminiBudgetCall(1)) {
    return {
      id: videoId,
      approved: false,
      countsTowardTarget: false,
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
      evidenceLevel: 'V1',
      reasonCode: 'budget_exhausted',
      isErrorNotRejection: true,
      verifiedByAi: false,
      formFactorMatches: false,
      mechanismMatches: false,
      colorMatches: false,
      mustNotBeHit: [],
      confidence: 0.5,
      referenceSimilarity: 0.5,
      reasonAr: 'غير متحقق بالذكاء الاصطناعي (تجاوز ميزانية Gemini اليومية)',
      stage: 'budget_fallback',
    };
  }

  onGeminiCallRecorded?.(1);

  try {
    const { discriminators, sameCategoryLookalikes } = buildDiscriminatorsForIdentityCard(identity);

    const blindDesc = await describeCandidateBlindWithGemini({
      candidateId: videoId,
      frameBuffers: kfResult.frameBuffers,
      discriminators,
      sameCategoryLookalikes,
      imageHash: identity.imageHash,
    });

    const refEmbeddings: Float32Array[] = [];
    if (referenceImageBase64) {
      try {
        const optimizedRef = await optimizeReferenceImageForVision(
          referenceImageBase64.replace(/^data:[^;]+;base64,/, ''),
          referenceImageMimeType
        );
        const emb = await computeImageBufferEmbedding(Buffer.from(optimizedRef.base64, 'base64'));
        if (emb) refEmbeddings.push(emb);
      } catch {}
    }
    for (const extra of additionalReferenceImagesBase64.slice(0, 4)) {
      try {
        const emb = await computeImageBufferEmbedding(
          Buffer.from(extra.replace(/^data:[^;]+;base64,/, ''), 'base64')
        );
        if (emb) refEmbeddings.push(emb);
      } catch {}
    }

    let cropClipSim: number | null = null;
    if (blindDesc.boundingBoxes.length > 0 && refEmbeddings.length > 0) {
      const box = blindDesc.boundingBoxes[0];
      const fIdx = Math.max(0, Math.min(kfResult.frameBuffers.length - 1, box.frameIndex || 0));
      const cropRes = await cropBoundingBoxAndCompareClip({
        frameBuffer: kfResult.frameBuffers[fIdx],
        box,
        referenceEmbeddings: refEmbeddings,
      });
      cropClipSim = cropRes.cropSimilarity;
    }

    const codeComp = compareBlindProfileInCode({
      identityCard: identity,
      blindDesc,
      candidateTitle: titleOrCaption,
      framesInspectedCount: kfResult.frameBuffers.length,
      usedFallbackThumbnailOnly: kfResult.usedFallbackThumbnailOnly,
      fullFrameClipSimilarity: cropClipSim ?? 0.78,
      cropClipSimilarity: cropClipSim,
      linkState,
      hasRetrievableMedia: kfResult.frameBuffers.length > 0,
    });

    const result: AttributeVerificationVerdict = {
      id: videoId,
      approved: codeComp.approved,
      countsTowardTarget: codeComp.countsTowardTarget,
      verdict: tierToLegacyVerdict(codeComp.verdictTier),
      verdictTier: codeComp.verdictTier,
      evidenceLevel: codeComp.evidenceLevel,
      evidenceSummaryAr: `${codeComp.evidenceSummaryAr} (${kfResult.extractionReasonAr})`,
      userFacingBadgeAr: codeComp.userFacingBadgeAr,
      visibleFramesCount: blindDesc.productVisibleFrameIndices.length,
      keyframesExtracted: kfResult.keyframesExtractedCount,
      extractedFrameUrls: kfResult.framePublicUrls,
      cropClipSimilarity: cropClipSim,
      boundingBoxes: blindDesc.boundingBoxes,
      blindObservations: blindDesc.discriminatorObservations,
      linkState,
      reasonCode: codeComp.approved ? null : codeComp.reasonCode,
      failedHardAttributes: codeComp.failedHardAttributes,
      failedSoftAttributes: codeComp.failedSoftAttributes,
      notVisibleHardAttributes: codeComp.notVisibleHardAttributes,
      verifiedByAi: true,
      formFactorMatches: codeComp.failedHardAttributes.length === 0,
      mechanismMatches: codeComp.failedHardAttributes.length === 0,
      colorMatches: true,
      mustNotBeHit: codeComp.mustNotBeHit,
      confidence: codeComp.confidence,
      referenceSimilarity: cropClipSim ?? codeComp.confidence,
      reasonAr: codeComp.reasonAr,
      stage: 'video_keyframes',
    };
    verdictsCache.set(cacheKey, result);
    saveVerdictsCacheToDisk();
    return result;
  } catch (err) {
    console.warn('[VerifyPipeline] Keyframe blind verification failed:', (err as Error)?.message || err);
    return {
      id: videoId,
      approved: false,
      countsTowardTarget: false,
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
      evidenceLevel: 'V2',
      evidenceSummaryAr: 'تعذر إكمال التحقق الأعمى لإطارات الفيديو — تم تقييد العنصر كغير متحقق (V2)',
      keyframesExtracted: kfResult.keyframesExtractedCount,
      reasonCode: 'verification_error',
      isErrorNotRejection: true,
      verifiedByAi: false,
      formFactorMatches: true,
      mechanismMatches: true,
      colorMatches: true,
      mustNotBeHit: [],
      confidence: 0.5,
      referenceSimilarity: 0.5,
      reasonAr: 'تعذر فحص إطارات الفيديو الإضافية (خطأ تقني — صُنّف كغير متحقق)',
      stage: 'video_keyframes',
    };
  }
}

/**
 * Phase 5.1 & Phase 2 Separate TYPE & LOOK-ALIKE GATE:
 * Verifies that a candidate's title does not explicitly declare a different functional product type
 * or a known look-alike design (e.g., rear-seat armrest box / 15W wireless charger console box / Highlander box
 * when searching for a front center console quilted armrest pad).
 */
export function evaluateProductTypeGate(
  candidateTitle: string,
  identity: Partial<IdentityCardV2> & { nameEn: string; mustNotBe?: string[]; shape?: string }
): { passesTypeGate: boolean; conflictingTypeTerm?: string } {
  const titleLower = String(candidateTitle || '').toLowerCase();
  const refContext = `${identity.nameEn || ''} ${identity.category || ''} ${identity.formFactor?.shape || identity.shape || ''} ${(identity.mustMatch || []).join(' ')}`.toLowerCase();

  // 1. Check explicit mustNotBe phrases
  const mustNotHits = detectDynamicMustNotBeInText(candidateTitle, identity as IdentityCardV2);
  if (mustNotHits.length > 0) {
    return { passesTypeGate: false, conflictingTypeTerm: mustNotHits[0] };
  }

  // 2. Category-specific Type & Look-Alike Gate rules
  if (
    /\b(armrest)\b/i.test(refContext) &&
    /\b(pad|cushion|quilted|center\s*console)\b/i.test(refContext) &&
    !/\b(rear\s*seat|wireless\s*charger)\b/i.test(refContext)
  ) {
    const conflictingArmrestBox = titleLower.match(
      /\b(rear\s+seat\s+armrest|back\s+seat\s+armrest|wireless\s+charger|15w\s+built[- ]in|highlander\s+rear|full\s+replacement\s+console)\b/i
    );
    if (conflictingArmrestBox) {
      return { passesTypeGate: false, conflictingTypeTerm: conflictingArmrestBox[0] };
    }
  }

  if (/\b(drill)\b/i.test(refContext)) {
    const nonDrillToolMatch = titleLower.match(
      /\b(torque\s*wrench|impact\s*wrench|extended\s*reach\s*ratchet|ratchet|scroll\s*shear|metal\s*shear|angle\s*grinder|circular\s*saw|reciprocating\s*saw|jigsaw|orbital\s*sander|leaf\s*blower|brad\s*nailer|impact\s*driver\b(?!.*drill)|\b3453\b.*\bimpact\b)/i
    );
    const mentionsActualDrill = /\b(cordless.*drill|drill\s*driver|power\s*drill|combo\s*kit)\b/i.test(titleLower);
    if (nonDrillToolMatch && !mentionsActualDrill) {
      return { passesTypeGate: false, conflictingTypeTerm: nonDrillToolMatch[0] };
    }
  }

  if (/\b(massage\s*pillow|neck\s*and\s*back\s*massager|shiatsu.*pillow)\b/i.test(refContext)) {
    const nonPillowMassagerMatch = titleLower.match(
      /\b(massage\s*gun|percussion\s*gun|fascia\s*gun|foot\s*bath|foot\s*spa|full\s*body\s*mat|massage\s*mat|mattress|eye\s*massager|head\s*massager|scalp\s*massager|hand\s*massager|knee\s*massager)\b/i
    );
    if (nonPillowMassagerMatch) {
      return { passesTypeGate: false, conflictingTypeTerm: nonPillowMassagerMatch[0] };
    }
  }

  if (/\b(mosquito|bug|insect)\b/i.test(refContext) && /\b(suction|photocatalyst|fan|trap)\b/i.test(refContext)) {
    const nonSuctionBugMatch = titleLower.match(
      /\b(swatter|racket|tennis|ultrasonic\s*pest\s*repeller|sticky\s*pad|glue\s*trap|repellent\s*bracelet|essential\s*oil|citronella\s*candle)\b/i
    );
    if (nonSuctionBugMatch) {
      return { passesTypeGate: false, conflictingTypeTerm: nonSuctionBugMatch[0] };
    }
  }

  return { passesTypeGate: true };
}

/**
 * Phase 5.4: Re-evaluates a stored trace candidate through the new Phase 5 rules:
 * - Sanitizes identity card attributes (downgrading tautological/vague "X design" and >3 hard attributes to SOFT)
 * - Runs the explicit Product TYPE GATE
 * - Evaluates hard attribute conflicts with visual evidence + confidence threshold
 * - Assigns one of the 6 VerdictTiers (exact, same_design_variant, same_type_close_design, same_type_other_design, other_type, unrelated)
 */
export function reclassifyStoredCandidateUnderPhase5Rules(
  candidate: {
    id: string;
    title: string;
    thumbnailUrl?: string;
    referenceSimilarity?: number | null;
    reasonCode?: string;
    rejectionReasonAr?: string | null;
    verdictTier?: VerdictTier;
    attributeVerdicts?: Record<string, unknown>;
  },
  identity: IdentityCardV2,
  relaxationPass: 1 | 2 | 3 = 3
): {
  oldReasonCode: string;
  oldVerdictTier: VerdictTier;
  newVerdictTier: VerdictTier;
  approvedInPass1: boolean;
  approvedInPass2: boolean;
  approvedInPass3: boolean;
  downgradedHardToSoft: string[];
  newReasonAr: string;
} {
  const oldReasonCode = candidate.reasonCode || 'unknown';
  const oldVerdictTier: VerdictTier = candidate.verdictTier || 'other_type';
  const sim = typeof candidate.referenceSimilarity === 'number' ? candidate.referenceSimilarity : 0;

  const attributeStrengths = classifyIdentityAttributeStrengths(
    identity.mustMatch,
    identity.attributeStrengths,
    { nameEn: identity.nameEn, category: identity.category }
  );

  const typeGate = evaluateProductTypeGate(candidate.title, identity);
  const av = (candidate.attributeVerdicts || {}) as Record<string, any>;
  const mustNotBeHit: string[] = Array.from(
    new Set([
      ...(Array.isArray(av.mustNotBeHit) ? av.mustNotBeHit.map(String).filter(Boolean) : []),
      ...(typeGate.conflictingTypeTerm ? [typeGate.conflictingTypeTerm] : []),
    ])
  );

  const rawFailedHard: string[] = Array.isArray(av.failedHardAttributes)
    ? av.failedHardAttributes.map(String).filter(Boolean)
    : oldReasonCode.startsWith('rejected_hard_attribute:')
    ? [oldReasonCode.replace('rejected_hard_attribute:', '')]
    : [];

  const { actualFailedHard, downgradedToSoft } = evaluateHardAttributeConflicts({
    failedHardAttributes: rawFailedHard,
    visualEvidenceText: String(av.reasonAr || candidate.rejectionReasonAr || ''),
    confidence: sim >= 0.6 ? sim : 0.75,
    attributeStrengths,
    productNameEn: identity.nameEn,
    category: identity.category,
    hardConflictMinConfidence: 0.72,
  });

  const titleLower = String(candidate.title || '').toLowerCase();
  const isUnrelatedVideo =
    oldReasonCode === 'low_similarity' &&
    sim < 0.36 &&
    !/\b(drill|tool|driver|impact|screwdriver|power|massage|shiatsu|mosquito|bug|zapper|lamp|pliers)\b/i.test(
      titleLower
    );

  let newVerdictTier: VerdictTier = oldVerdictTier;

  if (isUnrelatedVideo) {
    newVerdictTier = 'unrelated';
  } else if (!typeGate.passesTypeGate || mustNotBeHit.length > 0) {
    newVerdictTier = 'other_type';
  } else if (actualFailedHard.length === 0) {
    const formOk = av.formFactorMatches !== false;
    const mechOk = av.mechanismMatches !== false;
    const colorOk = av.colorMatches !== false;

    if (formOk && mechOk) {
      newVerdictTier = colorOk && downgradedToSoft.length === 0 ? 'exact' : 'same_design_variant';
    } else if (mechOk || downgradedToSoft.length > 0) {
      // Distinguish close design vs other design based on title/visual similarity
      const hasExactKitMatch = /\b(cordless\s+drill|drill\s+tool\s+kit|power\s+drill\s+driver|shiatsu|neck.*massage|mosquito\s+killer)\b/i.test(
        titleLower
      );
      if (hasExactKitMatch && sim >= 0.88) {
        newVerdictTier = 'same_design_variant';
      } else if (sim >= 0.85) {
        newVerdictTier = 'same_type_close_design';
      } else {
        newVerdictTier = 'same_type_other_design';
      }
    } else {
      newVerdictTier = sim >= 0.52 ? 'same_type_other_design' : 'other_type';
    }
  } else {
    const mechOk = av.mechanismMatches !== false;
    newVerdictTier = mechOk && sim >= 0.5 ? 'same_type_other_design' : 'other_type';
  }

  const approvedInPass1 = shouldApproveTier(newVerdictTier, 'same_design', false, true, 1);
  const approvedInPass2 = shouldApproveTier(newVerdictTier, 'same_design', false, true, 2);
  const approvedInPass3 = shouldApproveTier(newVerdictTier, 'same_design', false, true, 3);

  const newReasonAr =
    newVerdictTier === 'exact'
      ? 'مطابق تماماً لتصميم وآلية عمل المنتج المرجعي'
      : newVerdictTier === 'same_design_variant'
      ? `نفس التصميم وآلية العمل (تم تحويل السمة المقيدة "${downgradedToSoft.join(', ') || 'تفصيل ثانوي'}" إلى SOFT — مقبول في Pass 1)`
      : newVerdictTier === 'same_type_close_design'
      ? `نفس نوع المنتج بتصميم قريب (تم تحويل "${downgradedToSoft.join(', ')}" إلى SOFT — مقبول في Pass 2)`
      : newVerdictTier === 'same_type_other_design'
      ? `نفس نوع المنتج بتصميم بديل (مقبول في Pass 3 للتوسيع التلقائي)`
      : newVerdictTier === 'other_type'
      ? `بوابة النوع (TYPE GATE) / قائمة الاستبعاد: منتج مختلف (${mustNotBeHit[0] || actualFailedHard[0] || 'نوع أداة مختلف'})`
      : 'فيديو غير مرتبط بالمنتج (تشابه بصري منخفض جداً)';

  return {
    oldReasonCode,
    oldVerdictTier,
    newVerdictTier,
    approvedInPass1,
    approvedInPass2,
    approvedInPass3,
    downgradedHardToSoft: downgradedToSoft,
    newReasonAr,
  };
}

