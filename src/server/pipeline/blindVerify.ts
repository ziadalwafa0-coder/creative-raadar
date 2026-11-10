import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@google/genai';
import { DATA_DIR } from '../config.ts';
import { generateContentWithModelFallback, isGeminiConfigured } from '../gemini.ts';
import { computeImageBufferEmbedding, cosineSimilarity } from './clipEmbedding.ts';
import { IdentityCardV2, buildDiscriminatorsForIdentityCard } from './identity.ts';
import { enforceEvidenceGatedBadge } from './linkState.ts';
import { getFewShotFeedbackExamplesForHash } from './ownerFeedback.ts';
import type {
  BlindDiscriminatorObservation,
  BoundingBox2D,
  DiscriminatorSpec,
  EvidenceLevel,
  LinkState,
  VerdictTier,
} from '../../types/index.ts';

const execFileAsync = promisify(execFile);

export interface ExtractedKeyframesResult {
  frameBuffers: Buffer[];
  framePublicUrls: string[];
  frameFilePaths: string[];
  keyframesExtractedCount: number;
  usedFallbackThumbnailOnly: boolean;
  extractionReasonAr: string;
}

const POSTERS_DIR = path.join(DATA_DIR, 'downloads', 'posters');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

function ensureDirs(): void {
  try {
    fs.mkdirSync(POSTERS_DIR, { recursive: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch {}
}

/**
 * Finds an already-downloaded MP4 on disk for a candidate URL or video ID if available.
 */
export function findLocalPrewarmedVideo(candidateId: string, videoOrPageUrl?: string): string | null {
  ensureDirs();
  try {
    if (videoOrPageUrl) {
      const urlHash = crypto.createHash('md5').update(videoOrPageUrl).digest('hex').slice(0, 8);
      const prewarmPath = path.join(DOWNLOADS_DIR, `prewarm_${urlHash}_verified.mp4`);
      if (fs.existsSync(prewarmPath) && fs.statSync(prewarmPath).size > 15_000) {
        return prewarmPath;
      }
    }
    const cleanId = candidateId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24);
    if (cleanId) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      for (const f of files) {
        if (f.endsWith('.mp4') && f.includes(cleanId)) {
          const full = path.join(DOWNLOADS_DIR, f);
          if (fs.statSync(full).size > 15_000) return full;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * PHASE 2.3 — Extract 3-5 scene-aware keyframes via ffmpeg (skipping the first 0.8s black frame).
 * If video frames cannot be obtained, falls back to the thumbnail buffer and caps evidence at V2 with explicit reason.
 */
export async function extractSceneAwareKeyframes(params: {
  candidateId: string;
  videoInputPathOrUrl?: string;
  fallbackThumbnailBuffers?: Buffer[];
  durationSec?: number;
  maxFrames?: number;
}): Promise<ExtractedKeyframesResult> {
  ensureDirs();
  const maxFrames = Math.min(5, Math.max(3, params.maxFrames || 4));
  const safeId =
    params.candidateId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) ||
    crypto.randomBytes(4).toString('hex');

  // Check if keyframes were already extracted on disk for this candidateId
  const cachedBuffers: Buffer[] = [];
  const cachedUrls: string[] = [];
  const cachedPaths: string[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const p = path.join(POSTERS_DIR, `kf_${safeId}_${i}.jpg`);
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.size > 1800) {
          cachedBuffers.push(fs.readFileSync(p));
          cachedUrls.push(`/api/posters/kf_${safeId}_${i}.jpg`);
          cachedPaths.push(p);
        }
      } catch {}
    }
  }
  if (cachedBuffers.length >= 2) {
    return {
      frameBuffers: cachedBuffers,
      framePublicUrls: cachedUrls,
      frameFilePaths: cachedPaths,
      keyframesExtractedCount: cachedBuffers.length,
      usedFallbackThumbnailOnly: false,
      extractionReasonAr: `تم استخراج ${cachedBuffers.length} إطارات فيديو حقيقية عبر ffmpeg (تجاوز الإطار الأسود الأول)`,
    };
  }

  let inputTarget = params.videoInputPathOrUrl || '';
  if (!inputTarget || (!fs.existsSync(inputTarget) && !inputTarget.startsWith('http'))) {
    const localPrewarm = findLocalPrewarmedVideo(params.candidateId, params.videoInputPathOrUrl);
    if (localPrewarm) {
      inputTarget = localPrewarm;
    }
  } else if (inputTarget.startsWith('http')) {
    const localPrewarm = findLocalPrewarmedVideo(params.candidateId, inputTarget);
    if (localPrewarm) {
      inputTarget = localPrewarm;
    }
  }

  if (inputTarget && (fs.existsSync(inputTarget) || inputTarget.startsWith('http'))) {
    try {
      // Determine video duration via ffprobe if local file
      let duration = params.durationSec && params.durationSec > 2 ? params.durationSec : 10;
      if (fs.existsSync(inputTarget)) {
        try {
          const { stdout } = await execFileAsync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_entries',
              'format=duration',
              '-of',
              'default=noprint_wrappers=1:nokey=1',
              inputTarget,
            ],
            { timeout: 4000 }
          );
          const parsedDur = parseFloat(String(stdout || '').trim());
          if (Number.isFinite(parsedDur) && parsedDur > 1.2) {
            duration = parsedDur;
          }
        } catch {}
      }

      // Skip first 0.85s (avoids first black/fade-in frame) and sample 4 distinct timestamps across the video
      const startOffset = Math.min(0.85, Math.max(0.25, duration * 0.1));
      const usableSpan = Math.max(1.5, duration - startOffset - 0.3);
      const fractions = [0.08, 0.34, 0.62, 0.86].slice(0, maxFrames);
      const timestamps = fractions.map((f) => Number((startOffset + usableSpan * f).toFixed(2)));

      const extractedBuffers: Buffer[] = [];
      const extractedUrls: string[] = [];
      const extractedPaths: string[] = [];

      for (let idx = 0; idx < timestamps.length; idx++) {
        const ts = timestamps[idx];
        const outPath = path.join(POSTERS_DIR, `kf_${safeId}_${idx}.jpg`);
        try {
          const args: string[] = ['-y', '-ss', String(ts)];
          if (inputTarget.startsWith('http')) {
            args.push(
              '-user_agent',
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            );
          }
          args.push(
            '-i',
            inputTarget,
            '-vf',
            "scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
            '-frames:v',
            '1',
            '-q:v',
            '4',
            outPath
          );
          await execFileAsync('ffmpeg', args, { timeout: 7500 });
          if (fs.existsSync(outPath)) {
            const stat = fs.statSync(outPath);
            // A pure black 640x360 JPEG at q=4 is typically < 1.8KB; real video frames are > 3KB
            if (stat.size >= 2400) {
              extractedBuffers.push(fs.readFileSync(outPath));
              extractedUrls.push(`/api/posters/kf_${safeId}_${idx}.jpg`);
              extractedPaths.push(outPath);
            } else {
              try {
                fs.unlinkSync(outPath);
              } catch {}
            }
          }
        } catch {}
      }

      if (extractedBuffers.length >= 2) {
        return {
          frameBuffers: extractedBuffers,
          framePublicUrls: extractedUrls,
          frameFilePaths: extractedPaths,
          keyframesExtractedCount: extractedBuffers.length,
          usedFallbackThumbnailOnly: false,
          extractionReasonAr: `تم استخراج ${extractedBuffers.length} إطارات فيديو مستقلة عبر ffmpeg (تجاوز الإطار الأسود الأول)`,
        };
      }
    } catch {}
  }

  // Fallback to provided thumbnail buffers (capped at V2)
  const fallbacks = (params.fallbackThumbnailBuffers || []).filter((b) => b && b.byteLength > 400);
  return {
    frameBuffers: fallbacks,
    framePublicUrls: [],
    frameFilePaths: [],
    keyframesExtractedCount: 0,
    usedFallbackThumbnailOnly: true,
    extractionReasonAr:
      fallbacks.length > 0
        ? 'تعذر استخراج إطارات الفيديو المباشرة عبر ffmpeg — تم فحص الصورة المصغرة فقط وتقييد سقف الدليل عند V2'
        : 'تعذر جلب أي إطارات أو صورة مصغرة صالحة (V0)',
  };
}

/**
 * PHASE 2.2 — Crops a normalized [ymin, xmin, ymax, xmax] (0..1000) bounding box from a frame buffer via ffmpeg
 * and computes maximum local CLIP cosine similarity against all reference + anchor image embeddings.
 */
export async function cropBoundingBoxAndCompareClip(params: {
  frameBuffer: Buffer;
  box: BoundingBox2D;
  referenceEmbeddings: Float32Array[];
}): Promise<{ cropSimilarity: number | null; croppedBuffer: Buffer | null }> {
  if (!params.frameBuffer || params.referenceEmbeddings.length === 0) {
    return { cropSimilarity: null, croppedBuffer: null };
  }

  const ymin = Math.max(0, Math.min(950, Number(params.box.ymin) || 0));
  const xmin = Math.max(0, Math.min(950, Number(params.box.xmin) || 0));
  const ymax = Math.max(ymin + 50, Math.min(1000, Number(params.box.ymax) || 1000));
  const xmax = Math.max(xmin + 50, Math.min(1000, Number(params.box.xmax) || 1000));

  const wFrac = ((xmax - xmin) / 1000).toFixed(3);
  const hFrac = ((ymax - ymin) / 1000).toFixed(3);
  const xFrac = (xmin / 1000).toFixed(3);
  const yFrac = (ymin / 1000).toFixed(3);

  const tmpDir = path.join(DATA_DIR, 'tmp_crop');
  let croppedBuffer: Buffer | null = null;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const id = crypto.randomBytes(5).toString('hex');
    const inPath = path.join(tmpDir, `in_${id}.jpg`);
    const outPath = path.join(tmpDir, `crop_${id}.jpg`);
    fs.writeFileSync(inPath, params.frameBuffer);

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inPath,
        '-vf',
        `crop=iw*${wFrac}:ih*${hFrac}:iw*${xFrac}:ih*${yFrac}`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        outPath,
      ],
      { timeout: 3500 }
    );

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 600) {
      croppedBuffer = fs.readFileSync(outPath);
    }
    try {
      fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}
  } catch {}

  const targetBuffer = croppedBuffer || params.frameBuffer;
  const cropEmb = await computeImageBufferEmbedding(targetBuffer);
  if (!cropEmb) {
    return { cropSimilarity: null, croppedBuffer };
  }

  let bestSim = -1;
  for (const refEmb of params.referenceEmbeddings) {
    const sim = cosineSimilarity(refEmb, cropEmb);
    if (sim > bestSim) bestSim = sim;
  }

  return {
    cropSimilarity: bestSim >= 0 ? Number(bestSim.toFixed(4)) : null,
    croppedBuffer,
  };
}

export interface BlindCandidateDescription {
  productVisibleFrameIndices: number[];
  onlyPersonOrBackgroundVisible: boolean;
  observedProductCategory: string;
  observedProductTitleEn: string;
  observedProductSummaryAr: string;
  observedFormFactor: string;
  observedPlacement: string;
  observedConstructionType: string;
  hasWirelessChargerVisible: 'yes' | 'no' | 'not_visible';
  observedLookalikeMatch: string;
  boundingBoxes: BoundingBox2D[];
  discriminatorObservations: BlindDiscriminatorObservation[];
}

const BLIND_DESC_CACHE_FILE = path.join(DATA_DIR, 'blind_descriptions_cache.json');
const blindDescCache = new Map<string, BlindCandidateDescription>();

try {
  if (fs.existsSync(BLIND_DESC_CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(BLIND_DESC_CACHE_FILE, 'utf-8'));
    if (Array.isArray(raw)) {
      for (const [k, v] of raw) {
        if (k && v) blindDescCache.set(k, v);
      }
    }
  }
} catch {}

function saveBlindDescCache(): void {
  try {
    const entries = Array.from(blindDescCache.entries()).slice(-400);
    fs.writeFileSync(BLIND_DESC_CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch {}
}

/**
 * PHASE 2.1 — BLIND DESCRIBE-THEN-COMPARE (Stage B: Blind Candidate Extraction)
 * CRITICAL ANTI-BIAS RULE:
 * - Never show the reference image in this call.
 * - Never ask "is this the same product?".
 * - Never leak the seller caption as visual fact.
 * - Force the model to inspect each frame independently, locate the product bounding box,
 *   and fill out each discriminator field with 'present_match' | 'present_conflict' | 'not_visible'.
 */
export async function describeCandidateBlindWithGemini(params: {
  candidateId: string;
  frameBuffers: Buffer[];
  discriminators: DiscriminatorSpec[];
  sameCategoryLookalikes: string[];
  imageHash?: string;
}): Promise<BlindCandidateDescription> {
  if (params.frameBuffers.length === 0) {
    return {
      productVisibleFrameIndices: [],
      onlyPersonOrBackgroundVisible: true,
      observedProductCategory: 'none',
      observedProductTitleEn: 'No visual frames available',
      observedProductSummaryAr: 'لا توجد إطارات مرئية للفحص',
      observedFormFactor: 'not_visible',
      observedPlacement: 'not_visible',
      observedConstructionType: 'not_visible',
      hasWirelessChargerVisible: 'not_visible',
      observedLookalikeMatch: 'none',
      boundingBoxes: [],
      discriminatorObservations: params.discriminators.map((d) => ({
        discriminatorId: d.id,
        discriminatorName: d.name,
        strength: d.strength,
        observedStatus: 'not_visible' as const,frameIndices:[],
        observedValue: 'No frame available',
      })),
    };
  }

  const framesDigest = crypto
    .createHash('md5')
    .update(params.frameBuffers.map((b) => b.subarray(0, 512)).join('|'))
    .digest('hex')
    .slice(0, 12);
  const discDigest = crypto
    .createHash('md5')
    .update(JSON.stringify(params.discriminators.map((d) => [d.id, d.name, d.strength])))
    .digest('hex')
    .slice(0, 8);
  const cacheKey = `blind_v3_${params.candidateId}_${framesDigest}_${discDigest}`;

  const cached = blindDescCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  if (!isGeminiConfigured()) {
    throw new Error('GEMINI_API_KEY_MISSING');
  }

  const parts: Array<{ inlineData?: { data: string; mimeType: string }; text?: string }> = [];
  const framesToSend = params.frameBuffers.slice(0, 4);
  for (let i = 0; i < framesToSend.length; i++) {
    parts.push({
      inlineData: {
        data: framesToSend[i].toString('base64'),
        mimeType: 'image/jpeg',
      },
    });
  }

  const discSchemaText = params.discriminators
    .map(
      (d, idx) =>
        `  ${idx + 1}. id="${d.id}" | feature="${d.name}" | expected_if_present="${d.expectedValue}" | evidence_guide="${d.evidencePhrase}"`
    )
    .join('\n');

  const lookalikesText = params.sameCategoryLookalikes.length
    ? params.sameCategoryLookalikes.map((l, idx) => `  - Look-alike #${idx + 1}: "${l}"`).join('\n')
    : '  - None specified';

  // Phase 5.2b: Include owner-labelled few-shot guidance for this reference product if any
  const ownerFewShotText = params.imageHash
    ? getFewShotFeedbackExamplesForHash(params.imageHash)
    : '';

  const promptText = `You are a blind forensic visual inspector.
You are shown ${framesToSend.length} video frame(s) (indexed 0 to ${framesToSend.length - 1}) from a candidate video.
You are NOT shown any reference image. Do NOT guess or assume anything that is not directly visible in the pixels of these frames. Ignore any burned-in promotional text if it contradicts the physical object shown.

TASK 1 — PRODUCT VISIBILITY & LOCALIZATION:
- Which frame indices (0..${framesToSend.length - 1}) clearly show a physical product item (not just a person talking, face, empty car interior, or text slide)?
- Provide a 2D bounding box [ymin, xmin, ymax, xmax] on a 0..1000 scale for the main product in each frame where it is visible.

TASK 2 — OBJECTIVE STRUCTURAL DESCRIPTION:
- observedProductCategory: What specific product category is shown?
- observedProductTitleEn: Objective 4-8 word English description of the exact physical design shown.
- observedProductSummaryAr: One concise Arabic sentence describing the exact physical object shown in the frames.
- observedFormFactor: Describe its exact 3D shape, height profile (e.g., thin top pad/cushion vs tall full console box), surface texture/stitching (e.g., diamond-quilted stitching vs smooth leather/plastic).
- observedPlacement: Where is it installed or used in the video? (e.g., "strapped on top of front center console lid", "installed on rear seat bench / rear center armrest", "between seats", "handheld", or "not_visible").
- observedConstructionType: Is it a "soft top booster cushion pad" or a "rigid/tall full armrest storage box" or something else?
- hasWirelessChargerVisible: Does the product have a built-in wireless charging pad/coil/15W charger plate? ("yes" | "no" | "not_visible").
- observedLookalikeMatch: Check if the object shown in the frames is actually one of these known different designs:
${lookalikesText}
  If it matches one of those look-alike designs, write that exact look-alike name here; otherwise write "none".
${ownerFewShotText}

TASK 3 — BLIND DISCRIMINATOR CHECKLIST:
For EACH discriminator below, inspect ONLY the visible pixels in the frames and set status to:
- "present_match": The feature described in expected_if_present is CLEARLY VISIBLE in the frames and matches.
- "present_conflict": The part of the product is visible, and it has a DIFFERENT design/structure that contradicts expected_if_present (for example: it is a tall rear-seat armrest box instead of a front console top pad; or it has a 15W wireless charger when expected is no wireless charger; or smooth unquilted leather instead of diamond-quilted stitching).
- "not_visible": That part/angle of the product is occluded, blurry, or not shown in the frames.

Discriminators to evaluate:
${discSchemaText}`;

  parts.push({ text: promptText });

  const response = await generateContentWithModelFallback(
    (model) => ({
      model,
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            productVisibleFrameIndices: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
            },
            onlyPersonOrBackgroundVisible: { type: Type.BOOLEAN },
            observedProductCategory: { type: Type.STRING },
            observedProductTitleEn: { type: Type.STRING },
            observedProductSummaryAr: { type: Type.STRING },
            observedFormFactor: { type: Type.STRING },
            observedPlacement: { type: Type.STRING },
            observedConstructionType: { type: Type.STRING },
            hasWirelessChargerVisible: {
              type: Type.STRING,
              enum: ['yes', 'no', 'not_visible'],
            },
            observedLookalikeMatch: { type: Type.STRING },
            boundingBoxes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  frameIndex: { type: Type.INTEGER },
                  ymin: { type: Type.INTEGER },
                  xmin: { type: Type.INTEGER },
                  ymax: { type: Type.INTEGER },
                  xmax: { type: Type.INTEGER },
                  label: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                },
                required: ['frameIndex', 'ymin', 'xmin', 'ymax', 'xmax', 'label', 'confidence'],
              },
            },
            discriminatorObservations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  status: {
                    type: Type.STRING,
                    enum: ['present_match', 'present_conflict', 'not_visible'],
                  },
                  observedValue: { type: Type.STRING },
                },
                required: ['id', 'status', 'observedValue'],
              },
            },
          },
          required: [
            'productVisibleFrameIndices',
            'onlyPersonOrBackgroundVisible',
            'observedProductCategory',
            'observedProductTitleEn',
            'observedProductSummaryAr',
            'observedFormFactor',
            'observedPlacement',
            'observedConstructionType',
            'hasWirelessChargerVisible',
            'observedLookalikeMatch',
            'boundingBoxes',
            'discriminatorObservations',
          ],
        },
      },
    }),
    { maxRetries: 2, baseMs: 500, timeoutMs: 22_000 }
  );

  const parsed = JSON.parse(response.text?.trim() || '{}');

  const obsMap = new Map<string, { status: 'present_match' | 'present_conflict' | 'not_visible'; observedValue: string }>();
  if (Array.isArray(parsed.discriminatorObservations)) {
    for (const o of parsed.discriminatorObservations) {
      if (o?.id) {
        obsMap.set(String(o.id), {
          status:
            o.status === 'present_match' || o.status === 'present_conflict'
              ? o.status
              : 'not_visible',
          observedValue: String(o.observedValue || '').trim(),
        });
      }
    }
  }

  const normalizedObs: BlindDiscriminatorObservation[] = params.discriminators.map((d) => {
    const found = obsMap.get(d.id);
    return {
      discriminatorId: d.id,
      discriminatorName: d.name,
      strength: d.strength,
      observedStatus: found?.status || 'not_visible',frameIndices:[],
      observedValue: found?.observedValue || 'Not visible in frames',
    };
  });

  const visibleIndices = Array.isArray(parsed.productVisibleFrameIndices)
    ? parsed.productVisibleFrameIndices
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isInteger(n) && n >= 0 && n < framesToSend.length)
    : [];

  const result: BlindCandidateDescription = {
    productVisibleFrameIndices: visibleIndices,
    onlyPersonOrBackgroundVisible: Boolean(parsed.onlyPersonOrBackgroundVisible) || visibleIndices.length === 0,
    observedProductCategory: String(parsed.observedProductCategory || 'unknown').trim(),
    observedProductTitleEn: String(parsed.observedProductTitleEn || '').trim(),
    observedProductSummaryAr: String(parsed.observedProductSummaryAr || '').trim(),
    observedFormFactor: String(parsed.observedFormFactor || '').trim(),
    observedPlacement: String(parsed.observedPlacement || '').trim(),
    observedConstructionType: String(parsed.observedConstructionType || '').trim(),
    hasWirelessChargerVisible:
      parsed.hasWirelessChargerVisible === 'yes' || parsed.hasWirelessChargerVisible === 'no'
        ? parsed.hasWirelessChargerVisible
        : 'not_visible',
    observedLookalikeMatch: String(parsed.observedLookalikeMatch || 'none').trim(),
    boundingBoxes: Array.isArray(parsed.boundingBoxes) ? parsed.boundingBoxes : [],
    discriminatorObservations: normalizedObs,
  };

  blindDescCache.set(cacheKey, result);
  saveBlindDescCache();
  return result;
}

export interface BlindCodeComparisonResult {
  approved: boolean;
  countsTowardTarget: boolean;
  verdictTier: VerdictTier;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  userFacingBadgeAr: string;
  evidenceSummaryAr: string;
  reasonAr: string;
  reasonCode: string;
  failedHardAttributes: string[];
  failedSoftAttributes: string[];
  notVisibleHardAttributes: string[];
  matchedAttributes: string[];
  mustNotBeHit: string[];
}

/**
 * PHASE 2.1(c) — Pure deterministic CODE comparator between the Reference Identity Card v3
 * and the Blind Candidate Description + Crop CLIP similarity + Link State.
 * Can be unit-tested directly without mocking LLM calls.
 */
export function compareBlindProfileInCode(params: {
  identityCard: IdentityCardV2;
  blindDesc: BlindCandidateDescription;
  candidateTitle?: string;
  framesInspectedCount: number;
  usedFallbackThumbnailOnly: boolean;
  fullFrameClipSimilarity: number | null;
  cropClipSimilarity: number | null;
  linkState: LinkState;
  hasRetrievableMedia: boolean;
}): BlindCodeComparisonResult {
  const { discriminators, sameCategoryLookalikes } = buildDiscriminatorsForIdentityCard(
    params.identityCard
  );

  const failedHardAttributes: string[] = [];
  const failedSoftAttributes: string[] = [];
  const notVisibleHardAttributes: string[] = [];
  const matchedAttributes: string[] = [];
  const mustNotBeHit: string[] = [];

  // 1. Check each discriminator observation
  for (const disc of discriminators) {
    const obs = params.blindDesc.discriminatorObservations.find(
      (o) => o.discriminatorId === disc.id || o.discriminatorName === disc.name
    );
    const status = obs?.observedStatus || 'not_visible';
    const detail = obs?.observedValue ? `${disc.name} [الملاحظ: ${obs.observedValue}]` : disc.name;

    if (status === 'present_match') {
      matchedAttributes.push(disc.name);
    } else if (status === 'present_conflict') {
      if (disc.strength === 'hard') {
        failedHardAttributes.push(detail);
      } else {
        failedSoftAttributes.push(detail);
      }
    } else {
      // not_visible
      if (disc.strength === 'hard') {
        notVisibleHardAttributes.push(disc.name);
      }
    }
  }

  // 2. Check explicit look-alike or mustNotBe hits in the blind visual observation or caption
  const lookalikeObserved = (params.blindDesc.observedLookalikeMatch || '').trim();
  if (lookalikeObserved && lookalikeObserved.toLowerCase() !== 'none') {
    mustNotBeHit.push(lookalikeObserved);
    failedHardAttributes.push(`تصميم مشابه مختلف: ${lookalikeObserved}`);
  }

  const combinedObservedText = [
    params.blindDesc.observedProductTitleEn,
    params.blindDesc.observedFormFactor,
    params.blindDesc.observedPlacement,
    params.blindDesc.observedConstructionType,
    params.candidateTitle || '',
  ]
    .join(' ')
    .toLowerCase();

  const refTextLower = `${params.identityCard.nameEn} ${params.identityCard.formFactor?.shape || ''} ${params.identityCard.mustMatch.join(' ')}`.toLowerCase();
  const isRefFrontConsolePad =
    refTextLower.includes('armrest') &&
    (refTextLower.includes('pad') || refTextLower.includes('cushion') || refTextLower.includes('quilted'));

  if (isRefFrontConsolePad) {
    // Hard domain rule for Front Center Console Armrest Pad vs Rear Seat Armrest Box / Wireless Charger Box / Highlander Box
    if (
      /\b(rear\s+seat|back\s+seat|second\s+row|wireless\s+charg\w*|15w\s+charg\w*|highlander)\b/i.test(
        combinedObservedText
      ) ||
      params.blindDesc.hasWirelessChargerVisible === 'yes'
    ) {
      const conflictReason =
        params.blindDesc.hasWirelessChargerVisible === 'yes' ||
        /\b(wireless\s+charg\w*|15w)\b/i.test(combinedObservedText)
          ? 'Rear/center armrest box with built-in 15W wireless charger (المرجع وسادة مسند بدون شاحن لاسلكي)'
          : 'Rear seat / model-specific full armrest box (المرجع وسادة علوية لمسند الكونسول الأمامي)';
      if (!failedHardAttributes.includes(conflictReason)) {
        failedHardAttributes.push(conflictReason);
      }
      if (!mustNotBeHit.includes(conflictReason)) {
        mustNotBeHit.push(conflictReason);
      }
    }
  }

  for (const forbidden of [...(params.identityCard.mustNotBe || []), ...sameCategoryLookalikes]) {
    const cleanForbidden = forbidden.trim().toLowerCase();
    if (cleanForbidden.length >= 5 && combinedObservedText.includes(cleanForbidden)) {
      if (!mustNotBeHit.includes(forbidden)) {
        mustNotBeHit.push(forbidden);
      }
    }
  }

  // 3. Determine visible frames count (capped at 1 if usedFallbackThumbnailOnly)
  const rawVisibleFrames = params.blindDesc.onlyPersonOrBackgroundVisible
    ? 0
    : params.blindDesc.productVisibleFrameIndices.length;
  const effectiveVisibleFrames = params.usedFallbackThumbnailOnly
    ? Math.min(1, rawVisibleFrames)
    : rawVisibleFrames;

  const anyHardConflict = failedHardAttributes.length > 0 || mustNotBeHit.length > 0;
  const anyHardNotVisible = notVisibleHardAttributes.length > 0;
  const hardDiscriminators = discriminators.filter((d) => d.strength === 'hard');
  const allHardConfirmedVisible =
    !anyHardConflict &&
    !anyHardNotVisible &&
    hardDiscriminators.every((d) => {
      const obs = params.blindDesc.discriminatorObservations.find((o) => o.discriminatorId === d.id);
      return obs?.observedStatus === 'present_match';
    });

  // 4. Propose tier before evidence gate
  const bestClipSim = Math.max(
    params.cropClipSimilarity ?? -1,
    params.fullFrameClipSimilarity ?? -1
  );

  let proposedTier: VerdictTier = 'same_type_other_design';
  let proposedApproved = false;

  if (anyHardConflict) {
    proposedTier = 'same_type_other_design';
    proposedApproved = false;
  } else if (allHardConfirmedVisible) {
    if (failedSoftAttributes.length === 0 && effectiveVisibleFrames >= 2 && (bestClipSim < 0 || bestClipSim >= 0.68)) {
      proposedTier = 'exact';
      proposedApproved = true;
    } else {
      proposedTier = 'same_design_variant';
      proposedApproved = true;
    }
  } else if (anyHardNotVisible && effectiveVisibleFrames >= 1) {
    // Hard attribute not visible in current angle -> capped at V2 / محتمل
    proposedTier = 'same_type_close_design';
    proposedApproved = bestClipSim >= 0.75;
  } else {
    proposedTier = 'unverified';
    proposedApproved = false;
  }

  // 5. Run strict Phase 1 Evidence Gate
  const gated = enforceEvidenceGatedBadge({
    proposedTier,
    proposedApproved,
    framesInspectedCount: params.framesInspectedCount,
    productVisibleFramesCount: effectiveVisibleFrames,
    onlyTextOrPersonVisible:
      params.blindDesc.onlyPersonOrBackgroundVisible || effectiveVisibleFrames === 0,
    allHardConfirmedVisible,
    anyHardNotVisible,
    anyHardConflict,
    linkState: params.linkState,
    hasRetrievableMedia: params.hasRetrievableMedia,
  });

  // Build transparent Arabic explanation
  let reasonAr = '';
  let reasonCode = 'accepted';

  if (anyHardConflict) {
    const firstHard = failedHardAttributes[0] || mustNotBeHit[0] || 'تعارض سمة أساسية';
    reasonCode = mustNotBeHit.length > 0
      ? `rejected_must_not_be:${mustNotBeHit[0]}`
      : `rejected_hard_attribute:${firstHard.split('[')[0].trim()}`;
    reasonAr = `مرفوض بالوصف الأعمى (Describe-then-Compare): المنتج الملاحظ في الإطارات هو "${
      params.blindDesc.observedProductSummaryAr || params.blindDesc.observedProductTitleEn
    }" — تعارض صارم: ${failedHardAttributes.concat(mustNotBeHit).slice(0, 2).join(' | ')}`;
  } else if (!gated.approved) {
    reasonCode = gated.gateReasonCode || 'insufficient_visual_evidence';
    reasonAr = `${gated.evidenceSummaryAr} — الملاحظ في الإطارات: ${
      params.blindDesc.observedProductSummaryAr || params.blindDesc.observedProductTitleEn || 'المنتج غير واضح'
    }${
      notVisibleHardAttributes.length > 0
        ? ` (سمات أساسية غير مرئية: ${notVisibleHardAttributes.join('، ')})`
        : ''
    }`;
  } else {
    reasonCode = 'accepted';
    reasonAr = `${gated.evidenceSummaryAr} — تطابقت السمات الأساسية: ${matchedAttributes
      .slice(0, 3)
      .join(' + ')}${
      bestClipSim > 0 ? ` (تطابق بصري محلي للمنطقة المقصوصة: ${(bestClipSim * 100).toFixed(0)}%)` : ''
    }`;
  }

  const confidence = anyHardConflict
    ? 0.92
    : gated.evidenceLevel === 'V3'
    ? 0.94
    : gated.evidenceLevel === 'V2'
    ? 0.78
    : 0.35;

  return {
    approved: gated.approved,
    countsTowardTarget: gated.countsTowardTarget,
    verdictTier: gated.finalTier,
    evidenceLevel: gated.evidenceLevel,
    confidence,
    userFacingBadgeAr: gated.userFacingBadgeAr,
    evidenceSummaryAr: gated.evidenceSummaryAr,
    reasonAr,
    reasonCode,
    failedHardAttributes,
    failedSoftAttributes,
    notVisibleHardAttributes,
    matchedAttributes,
    mustNotBeHit,
  };
}
