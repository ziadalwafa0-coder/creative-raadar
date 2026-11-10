import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import { cosineSimilarity } from './clipEmbedding.ts';
import type {
  BlindDiscriminatorObservation,
  CandidateAsset,
  EvidenceLevel,
  OwnerFeedbackLabel,
  VerdictTier,
} from '../../types/index.ts';

export interface StoredOwnerFeedbackEntry {
  id: string;
  imageHash: string;
  candidateId: string;
  videoId: string;
  sourceUrl: string;
  title: string;
  label: OwnerFeedbackLabel;
  verdictTierAtLabelTime?: VerdictTier;
  evidenceLevelAtLabelTime?: EvidenceLevel;
  extractedFrameUrls?: string[];
  discriminatorVerdicts?: BlindDiscriminatorObservation[];
  observedSummary?: string;
  embedding?: number[];
  labelledAt: string;
}

const FEEDBACK_STORE_FILE = path.join(DATA_DIR, 'owner_feedback_store.json');
const feedbackEntries = new Map<string, StoredOwnerFeedbackEntry>();

function loadFeedbackStore(): void {
  try {
    if (fs.existsSync(FEEDBACK_STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FEEDBACK_STORE_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item?.id && item?.candidateId && item?.label) {
            feedbackEntries.set(item.id, item as StoredOwnerFeedbackEntry);
          }
        }
      }
    }
  } catch {}
}

function saveFeedbackStore(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const all = Array.from(feedbackEntries.values()).slice(-1000);
    fs.writeFileSync(FEEDBACK_STORE_FILE, JSON.stringify(all, null, 2), 'utf-8');
  } catch {}
}

loadFeedbackStore();

function hashesMatch(h1?: string, h2?: string): boolean {
  const a = String(h1 || '').trim();
  const b = String(h2 || '').trim();
  if (!a || !b) return true; // If one side didn't specify a hash, match within current session
  if (a === b) return true;
  if (a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

function normalizeTitleTokens(title: string): Set<string> {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function titleJaccardSimilarity(t1: string, t2: string): number {
  const s1 = normalizeTitleTokens(t1);
  const s2 = normalizeTitleTokens(t2);
  if (s1.size === 0 || s2.size === 0) return 0;
  let inter = 0;
  for (const tok of s1) {
    if (s2.has(tok)) inter++;
  }
  const union = s1.size + s2.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * PHASE 5.1 — Record an owner label ("same_product" | "different_product") with reference hash,
 * video id, frames, discriminator verdicts, and optional CLIP embedding.
 */
export function recordOwnerFeedback(params: {
  imageHash: string;
  candidateId: string;
  videoId?: string;
  sourceUrl?: string;
  title: string;
  label: OwnerFeedbackLabel;
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  extractedFrameUrls?: string[];
  discriminatorVerdicts?: BlindDiscriminatorObservation[];
  observedSummary?: string;
  embedding?: Float32Array | number[] | null;
}): StoredOwnerFeedbackEntry {
  const cleanHash = String(params.imageHash || 'default').slice(0, 24);
  const cleanVid = String(params.videoId || params.candidateId).trim();
  const id = `${cleanHash}::${cleanVid}`;

  const entry: StoredOwnerFeedbackEntry = {
    id,
    imageHash: cleanHash,
    candidateId: params.candidateId,
    videoId: cleanVid,
    sourceUrl: String(params.sourceUrl || ''),
    title: String(params.title || ''),
    label: params.label,
    verdictTierAtLabelTime: params.verdictTier,
    evidenceLevelAtLabelTime: params.evidenceLevel,
    extractedFrameUrls: params.extractedFrameUrls || [],
    discriminatorVerdicts: params.discriminatorVerdicts || [],
    observedSummary: params.observedSummary || '',
    embedding: params.embedding ? Array.from(params.embedding).slice(0, 512) : undefined,
    labelledAt: new Date().toISOString(),
  };

  feedbackEntries.set(id, entry);
  saveFeedbackStore();
  return entry;
}

export function getFeedbackEntriesForHash(imageHash?: string): StoredOwnerFeedbackEntry[] {
  const out: StoredOwnerFeedbackEntry[] = [];
  for (const entry of feedbackEntries.values()) {
    if (!imageHash || hashesMatch(entry.imageHash, imageHash)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * PHASE 5.2(b) — Format labelled positives and negatives as few-shot examples for future verification prompts
 * on the same reference product.
 */
export function getFewShotFeedbackExamplesForHash(imageHash: string): string {
  const entries = getFeedbackEntriesForHash(imageHash);
  if (entries.length === 0) return '';

  const positives = entries.filter((e) => e.label === 'same_product').slice(-4);
  const negatives = entries.filter((e) => e.label === 'different_product').slice(-6);

  const lines: string[] = [
    '\nOWNER GROUND-TRUTH FEW-SHOT EXAMPLES FOR THIS PRODUCT (HIGHEST PRIORITY):',
  ];

  for (const pos of positives) {
    lines.push(
      `  - CONFIRMED SAME PRODUCT BY OWNER: title="${pos.title}" ${
        pos.observedSummary ? `| visual="${pos.observedSummary}"` : ''
      }`
    );
  }
  for (const neg of negatives) {
    lines.push(
      `  - REJECTED AS WRONG PRODUCT BY OWNER (MUST MARK CONFLICT): title="${neg.title}" ${
        neg.observedSummary ? `| visual="${neg.observedSummary}"` : ''
      }`
    );
  }
  return lines.join('\n');
}

export interface RescoreFeedbackResult {
  updatedCandidates: CandidateAsset[];
  changedCount: number;
  demotedIds: string[];
  promotedIds: string[];
  precisionStats: {
    totalLabelled: number;
    sameProductCount: number;
    differentProductCount: number;
    precisionPercent: number;
    precisionByTier: Record<string, { same: number; total: number; pct: number }>;
    precisionByEvidenceLevel: Record<string, { same: number; total: number; pct: number }>;
    thresholdSuggestionAr?: string;
  };
}

/**
 * PHASE 5.2(a, c, d) — Immediately apply owner labels across a list of candidates:
 * - Marks directly labelled items
 * - Demotes near-duplicates of negatively labelled items by CLIP embedding similarity (>= 0.88) or title/caption similarity (>= 0.60)
 * - Computes live precision ("دقة النتائج حسب تقييمك: X من Y") and proposes threshold adjustments after >=20 labels (or low precision).
 */
export function rescoreCandidatesWithOwnerFeedback(params: {
  imageHash?: string;
  candidates: CandidateAsset[];
  candidateEmbeddings?: Map<string, Float32Array | number[]>;
}): RescoreFeedbackResult {
  const entries = getFeedbackEntriesForHash(params.imageHash);
  const byCandidateId = new Map<string, StoredOwnerFeedbackEntry>();
  const negativeEntries: StoredOwnerFeedbackEntry[] = [];
  const positiveEntries: StoredOwnerFeedbackEntry[] = [];

  for (const e of entries) {
    byCandidateId.set(e.candidateId, e);
    byCandidateId.set(e.videoId, e);
    if (e.label === 'different_product') negativeEntries.push(e);
    if (e.label === 'same_product') positiveEntries.push(e);
  }

  const demotedIds: string[] = [];
  const promotedIds: string[] = [];
  let changedCount = 0;

  const updatedCandidates = params.candidates.map((cand) => {
    const copy: CandidateAsset = { ...cand };
    const direct =
      byCandidateId.get(cand.id) ||
      (cand.platformAssetId ? byCandidateId.get(cand.platformAssetId) : undefined);

    if (direct) {
      const prevFeedback = copy.ownerFeedback;
      copy.ownerFeedback = direct.label;
      if (direct.label === 'different_product') {
        if (copy.verdictTier !== 'same_type_other_design' || !copy.demotedByFeedback) {
          changedCount++;
        }
        copy.demotedByFeedback = true;
        copy.verdictTier = 'same_type_other_design';
        copy.selectedForExport = false;
        copy.userFacingMatchLabel = 'مرفوض بتقييم المالك (✗ مش المنتج)';
        demotedIds.push(copy.id);
      } else if (direct.label === 'same_product') {
        if (prevFeedback !== 'same_product') changedCount++;
        copy.demotedByFeedback = false;
        promotedIds.push(copy.id);
      }
      return copy;
    }

    // Check if near-duplicate of any negatively labelled item
    const candEmbRaw = params.candidateEmbeddings?.get(cand.id);
    const candEmb = candEmbRaw
      ? candEmbRaw instanceof Float32Array
        ? candEmbRaw
        : new Float32Array(candEmbRaw)
      : null;

    for (const neg of negativeEntries) {
      let isNearDup = false;
      let dupReason = '';

      if (candEmb && neg.embedding && neg.embedding.length === candEmb.length) {
        const sim = cosineSimilarity(candEmb, new Float32Array(neg.embedding));
        if (sim >= 0.88) {
          isNearDup = true;
          dupReason = `تشابه بصري ${(sim * 100).toFixed(0)}% مع عنصر مرفوض`;
        }
      }

      if (!isNearDup) {
        const titleSim = titleJaccardSimilarity(cand.title, neg.title);
        if (titleSim >= 0.58) {
          isNearDup = true;
          dupReason = `تشابه عنوان (${(titleSim * 100).toFixed(0)}%) مع "${neg.title.slice(0, 35)}..."`;
        }
      }

      if (isNearDup) {
        if (!copy.demotedByFeedback) {
          changedCount++;
        }
        copy.demotedByFeedback = true;
        copy.verdictTier = 'same_type_other_design';
        copy.selectedForExport = false;
        copy.userFacingMatchLabel = `تم خفض التصنيف تلقائياً (${dupReason})`;
        demotedIds.push(copy.id);
        break;
      }
    }

    return copy;
  });

  const precisionStats = computeOwnerPrecisionStats(params.imageHash);

  return {
    updatedCandidates,
    changedCount,
    demotedIds,
    promotedIds,
    precisionStats,
  };
}

export function computeOwnerPrecisionStats(imageHash?: string): {
  totalLabelled: number;
  sameProductCount: number;
  differentProductCount: number;
  precisionPercent: number;
  precisionByTier: Record<string, { same: number; total: number; pct: number }>;
  precisionByEvidenceLevel: Record<string, { same: number; total: number; pct: number }>;
  thresholdSuggestionAr?: string;
} {
  const entries = getFeedbackEntriesForHash(imageHash);
  // Also compute global stats if current hash has < 20 labels so >=20 threshold calibration works across session
  const allEntries = Array.from(feedbackEntries.values());
  const targetList = entries.length > 0 ? entries : allEntries;

  let sameProductCount = 0;
  let differentProductCount = 0;
  const precisionByTier: Record<string, { same: number; total: number; pct: number }> = {};
  const precisionByEvidenceLevel: Record<string, { same: number; total: number; pct: number }> = {};

  for (const e of targetList) {
    const isSame = e.label === 'same_product';
    if (isSame) sameProductCount++;
    else differentProductCount++;

    const tierKey = e.verdictTierAtLabelTime || 'unknown';
    if (!precisionByTier[tierKey]) precisionByTier[tierKey] = { same: 0, total: 0, pct: 0 };
    precisionByTier[tierKey].total++;
    if (isSame) precisionByTier[tierKey].same++;
    precisionByTier[tierKey].pct = Math.round(
      (precisionByTier[tierKey].same / precisionByTier[tierKey].total) * 100
    );

    const evKey = e.evidenceLevelAtLabelTime || 'V2';
    if (!precisionByEvidenceLevel[evKey]) {
      precisionByEvidenceLevel[evKey] = { same: 0, total: 0, pct: 0 };
    }
    precisionByEvidenceLevel[evKey].total++;
    if (isSame) precisionByEvidenceLevel[evKey].same++;
    precisionByEvidenceLevel[evKey].pct = Math.round(
      (precisionByEvidenceLevel[evKey].same / precisionByEvidenceLevel[evKey].total) * 100
    );
  }

  const totalLabelled = sameProductCount + differentProductCount;
  const precisionPercent =
    totalLabelled > 0 ? Math.round((sameProductCount / totalLabelled) * 100) : 100;

  let thresholdSuggestionAr: string | undefined;
  if (totalLabelled >= 20 || (totalLabelled >= 3 && precisionPercent < 70)) {
    const v2Stats = precisionByEvidenceLevel['V2'];
    if (v2Stats && v2Stats.total >= 2 && v2Stats.pct < 65) {
      thresholdSuggestionAr = `توصية معايرة تلقائية (بناءً على ${totalLabelled} تقييم للمالك، دقة V2=${v2Stats.pct}%): يُنصح باشتراط مستوى دليل V3 (>= إطارين مرئيين) لقبول النتائج ورفع عتبة التشابه المقطعي CLIP إلى 0.78.`;
    } else if (precisionPercent < 75) {
      thresholdSuggestionAr = `توصية معايرة تلقائية (بناءً على ${totalLabelled} تقييم، الدقة الإجمالية ${precisionPercent}%): يُنصح برفع عتبة تشابه CLIP المقطعي من 0.68 إلى 0.76 وتفعيل وضع التطابق الصارم.`;
    } else {
      thresholdSuggestionAr = `معايرة الدقة ممتازة (${precisionPercent}% عبر ${totalLabelled} تقييم للمالك) — العتبات الحالية متوازنة.`;
    }
  }

  return {
    totalLabelled,
    sameProductCount,
    differentProductCount,
    precisionPercent,
    precisionByTier,
    precisionByEvidenceLevel,
    thresholdSuggestionAr,
  };
}
