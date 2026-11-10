import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@google/genai';
import { DATA_DIR } from '../config.ts';
import { ai, isGeminiConfigured, generateContentWithModelFallback } from '../gemini.ts';
import type { VisualAttribute, AttributeStrength, DiscriminatorSpec } from '../../types/index.ts';
import { getRuntimeSettings } from '../settings.ts';

const execFileAsync = promisify(execFile);

export type MatchMode = 'same_design' | 'strict_color';

export interface IdentityCardV2 {
  imageHash: string;
  nameEn: string;
  nameAr: string;
  category: string;
  primaryColor: string;
  formFactor: {
    shape: string;
    approximateSize: string;
    orientationPlacement: string;
  };
  mechanism: {
    howItWorks: string;
    powerSource: string;
    keyComponents: string[];
  };
  discriminators?: DiscriminatorSpec[];
  sameCategoryLookalikes?: string[];
  mustMatch: string[];
  attributeStrengths?: Record<string, AttributeStrength>;
  variableAttributes: string[];
  mustNotBe: string[];
  queries: {
    amazonEn: string[];
    amazonAr: string[];
    tiktokEn: string[];
    tiktokAr: string[];
    tradeNamesEn: string[];
  };
  hashtags: string[];
  confidence: number;
  ambiguity: string[];
  createdAt: string;
}

/**
 * Only truly variable/cosmetic attributes (color, packaging box, brand logo, minor cord/bit count, voltage number)
 * are forced to SOFT. Structural discriminators (quilted diamond stitching, cup holder count/shape,
 * front-facing slot, rear vs center placement, wireless charger presence) are allowed to be HARD!
 */
const SOFT_ATTRIBUTE_PATTERNS =
  /\b(colou?r|beige|black|white|grey|gray|blue|red|green|pink|brown|yellow|orange|brand|logo|retail\s*box|packag|artwork|bundle|pouch|brush|cable\s*length|cord\s*length|adapter|plug|carrying\s*case|storage\s*case|plastic\s*case|hard\s*case|bit\s*count|socket\s*count|attachment\s*count|\d+(?:\.\d+)?\s*v(?:olt)?|appearance|look)\b/i;

const VAGUE_DESIGN_ATTRIBUTE_PATTERN =
  /\b([a-z0-9_-]+\s+){0,5}(design|style|look|appearance|aesthetic|configuration|layout)\b/i;

/**
 * Phase 5.1: Checks whether an attribute is tautological (merely restates the product type/name/category,
 * which is already checked by the separate TYPE GATE) or vague (e.g., "Pistol-grip cordless drill design").
 */
export function isTautologicalOrVagueAttribute(
  attr: string,
  productNameEn = '',
  category = ''
): { isInvalidForHard: boolean; reason?: 'vague_design' | 'tautological_type' | 'soft_detail' } {
  const clean = String(attr || '').trim();
  if (!clean) return { isInvalidForHard: true, reason: 'vague_design' };

  if (/\b(design|style|appearance|aesthetic)\b/i.test(clean) && VAGUE_DESIGN_ATTRIBUTE_PATTERN.test(clean)) {
    return { isInvalidForHard: true, reason: 'vague_design' };
  }

  const typeReference = `${productNameEn} ${category}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (typeReference.length > 0) {
    const typeSet = new Set(typeReference);
    const attrTokens = clean
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !['with', 'and', 'for', 'the', 'type', 'style', 'design', 'standard', 'electric', 'power'].includes(w));

    if (attrTokens.length > 0 && attrTokens.every((t) => typeSet.has(t))) {
      return { isInvalidForHard: true, reason: 'tautological_type' };
    }
  }

  if (SOFT_ATTRIBUTE_PATTERNS.test(clean)) {
    return { isInvalidForHard: true, reason: 'soft_detail' };
  }

  return { isInvalidForHard: false };
}

/**
 * Classifies identity attributes into HARD (at most 5 binary/structural, image-observable,
 * discriminative attributes) vs SOFT (color, brand, packaging, minor counts).
 */
export function classifyIdentityAttributeStrengths(
  mustMatch: string[],
  existingOrOverrides?: Record<string, AttributeStrength>,
  context?: { nameEn?: string; category?: string; allowExplicitVagueOverride?: boolean }
): Record<string, AttributeStrength> {
  let settingsOverrides: Record<string, AttributeStrength> = {};
  try {
    settingsOverrides = getRuntimeSettings().attributeStrengthOverrides || {};
  } catch {}

  const mergedOverrides = {
    ...settingsOverrides,
    ...(existingOrOverrides || {}),
  };

  const out: Record<string, AttributeStrength> = {};
  let hardCount = 0;
  const MAX_HARD = 3;

  for (const rawAttr of mustMatch) {
    const attr = rawAttr.trim();
    if (!attr) continue;

    const qualityCheck = isTautologicalOrVagueAttribute(
      attr,
      context?.nameEn,
      context?.category
    );

    const explicit = mergedOverrides[attr] || mergedOverrides[attr.toLowerCase()];
    if (explicit === 'ignore' || explicit === 'soft') {
      out[attr] = explicit;
      continue;
    }

    if (qualityCheck.isInvalidForHard || hardCount >= MAX_HARD) {
      out[attr] = 'soft';
      continue;
    }

    if (explicit === 'hard') {
      out[attr] = 'hard';
      hardCount++;
      continue;
    }

    out[attr] = 'hard';
    hardCount++;
  }

  return out;
}

/**
 * PHASE 2.4 — Builds up to 5 concrete design-level discriminators (with HARD/SOFT strength and evidence phrase)
 * and 3-6 same-category look-alikes for mustNotBe.
 */
export function buildDiscriminatorsForIdentityCard(card: IdentityCardV2): {
  discriminators: DiscriminatorSpec[];
  sameCategoryLookalikes: string[];
} {
  const existingDiscs = Array.isArray(card.discriminators) ? card.discriminators : [];
  const nameLower = `${card.nameEn} ${card.formFactor?.shape || ''} ${card.mustMatch.join(' ')}`.toLowerCase();

  // Special high-precision discriminator profile for Car Center Console Armrest Pad with Cup Holder
  if (nameLower.includes('armrest') && (nameLower.includes('pad') || nameLower.includes('cushion') || nameLower.includes('quilted') || nameLower.includes('console'))) {
    const isFrontPad =
      nameLower.includes('pad') ||
      nameLower.includes('cushion') ||
      nameLower.includes('quilted') ||
      nameLower.includes('straps');
    if (isFrontPad) {
      const discs: DiscriminatorSpec[] = [
        {
          id: 'placement_and_form',
          name: 'Front center console top booster pad/cushion (NOT a full rear-seat console box)',
          nameAr: 'وسادة علوية فوق مسند الكونسول الوسطي الأمامي (وليست صندوق مقعد خلفي كامل)',
          expectedValue: 'Top-mounted booster cushion pad strapped onto center console lid',
          strength: 'hard',
          evidencePhrase: 'Must be a low-profile padded cushion sitting ON TOP of a center console lid, not a tall standalone rear-seat armrest box.',
        },
        {
          id: 'dual_rear_cup_holders_and_slot',
          name: 'Two circular cup holder cutouts + rectangular phone/tissue slot on top surface',
          nameAr: 'فتحتان دائريتان للأكواب + فتحة مستطيلة للهاتف/المناديل في السطح العلوي',
          expectedValue: '2 round cup cutouts + 1 rectangular slot integrated at one end of the pad',
          strength: 'hard',
          evidencePhrase: 'Visible dual circular cup cutouts next to a rectangular slot on the recessed end of the pad.',
        },
        {
          id: 'surface_stitching_and_no_charger',
          name: 'Quilted diamond-stitched surface WITHOUT built-in 15W wireless charging pad or LED plate',
          nameAr: 'سطح مبطن بنقشة معينات ماسية بدون شاحن لاسلكي 15W مدمج',
          expectedValue: 'Diamond-quilted stitched PU leather surface, no electronic wireless charger module',
          strength: 'hard',
          evidencePhrase: 'Surface has raised diamond-quilted stitching and NO electronic 15W wireless charging symbol/pad.',
        },
        {
          id: 'side_storage_pockets',
          name: 'Hanging side storage pockets on left/right flanks',
          nameAr: 'جيوب تخزين جانبية متدلية على الجانبين',
          expectedValue: 'Flat hanging side pockets along the sides of the pad',
          strength: 'soft',
          evidencePhrase: 'Hanging side pocket flaps visible descending from the side edges of the cushion.',
        },
        {
          id: 'elastic_strap_mounting',
          name: 'Elastic hook-and-loop straps underneath for lid attachment',
          nameAr: 'أحزمة مطاطية سفلية للتثبيت على غطاء المسند',
          expectedValue: 'Elastic straps wrapping under console lid',
          strength: 'soft',
          evidencePhrase: 'Straps wrapping under the console lid or flat bottom pad mount.',
        },
      ];
      const lookalikes = [
        'Rear seat full armrest box with 15W wireless charger',
        'Toyota Highlander / SUV full replacement center console box',
        'Smooth unquilted tall rear-seat storage box with sliding lid',
        'Seat-gap filler organizer wedged between seat and console',
        'Flat thin armrest cover mat without cup holders',
      ];
      return { discriminators: discs.slice(0, 5), sameCategoryLookalikes: lookalikes };
    }
  }

  if (existingDiscs.length > 0) {
    return {
      discriminators: existingDiscs.slice(0, 5),
      sameCategoryLookalikes: cleanStringArray(
        card.sameCategoryLookalikes?.length ? card.sameCategoryLookalikes : card.mustNotBe.slice(0, 6),
        6
      ),
    };
  }

  const strengths = card.attributeStrengths || {};
  const discriminators: DiscriminatorSpec[] = card.mustMatch.slice(0, 5).map((attr, idx) => {
    const strength: 'hard' | 'soft' = strengths[attr] === 'hard' && idx < 3 ? 'hard' : 'soft';
    return {
      id: `disc_${idx + 1}`,
      name: attr,
      nameAr: attr,
      expectedValue: attr,
      strength,
      evidencePhrase: `Frame must visibly show: ${attr} ( matching form factor: ${card.formFactor?.shape || card.nameEn})`,
    };
  });

  const sameCategoryLookalikes = cleanStringArray(
    card.sameCategoryLookalikes?.length ? card.sameCategoryLookalikes : card.mustNotBe.slice(0, 6),
    6
  );

  return { discriminators, sameCategoryLookalikes };
}

/**
 * Sanitizes an IdentityCardV2 in-place so vague "X design" phrases are cleaned,
 * attributeStrengths strictly obey the HARD attribute rules, and Identity v3 discriminators are populated.
 */
export function sanitizeIdentityCardAttributes(card: IdentityCardV2): IdentityCardV2 {
  const cleanedMustMatch: string[] = [];
  for (const raw of card.mustMatch || []) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    cleanedMustMatch.push(trimmed);
  }
  card.mustMatch = cleanedMustMatch;
  card.attributeStrengths = classifyIdentityAttributeStrengths(
    card.mustMatch,
    card.attributeStrengths,
    { nameEn: card.nameEn, category: card.category }
  );

  const { discriminators, sameCategoryLookalikes } = buildDiscriminatorsForIdentityCard(card);
  card.discriminators = discriminators;
  card.sameCategoryLookalikes = sameCategoryLookalikes;

  // Ensure sameCategoryLookalikes are merged into mustNotBe so negative filtering catches look-alike designs
  const mergedMustNotBe = cleanStringArray([...(card.mustNotBe || []), ...sameCategoryLookalikes], 16);
  card.mustNotBe = mergedMustNotBe;

  return card;
}

const IDENTITY_CACHE_FILE = path.join(DATA_DIR, 'identity_v2_cache.json');
const identityMemoryCache = new Map<string, IdentityCardV2>();
const inflightIdentityMap = new Map<string, Promise<IdentityCardV2>>();

function loadIdentityCacheFromDisk(): void {
  try {
    if (fs.existsSync(IDENTITY_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(IDENTITY_CACHE_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item?.imageHash && item?.nameEn && Array.isArray(item?.mustNotBe)) {
            const card = sanitizeIdentityCardAttributes(item as IdentityCardV2);
            identityMemoryCache.set(card.imageHash, card);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[IdentityV2] Failed to read disk cache:', (err as Error)?.message || err);
  }
}

function saveIdentityCacheToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const items = Array.from(identityMemoryCache.values()).slice(-200);
    fs.writeFileSync(IDENTITY_CACHE_FILE, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[IdentityV2] Failed to write disk cache:', (err as Error)?.message || err);
  }
}

loadIdentityCacheFromDisk();

/**
 * Downscales large reference images (>180KB raw) to max 768px JPEG via ffmpeg
 * so Gemini multimodal requests complete in ~1.5-2.5s without aborting on 500KB+ PNGs.
 */
export async function optimizeReferenceImageForVision(
  base64Clean: string,
  mimeType: string
): Promise<{ base64: string; mimeType: string }> {
  const rawBuf = Buffer.from(base64Clean, 'base64');
  if (rawBuf.byteLength <= 180 * 1024 && mimeType === 'image/jpeg') {
    return { base64: base64Clean, mimeType };
  }

  const tmpDir = path.join(DATA_DIR, 'tmp_img');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    const inExt = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const inPath = path.join(tmpDir, `in_${id}.${inExt}`);
    const outPath = path.join(tmpDir, `out_${id}.jpg`);
    fs.writeFileSync(inPath, rawBuf);

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inPath,
        '-vf',
        "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
        '-q:v',
        '4',
        '-frames:v',
        '1',
        outPath,
      ],
      { timeout: 4000 }
    );

    if (fs.existsSync(outPath)) {
      const outBuf = fs.readFileSync(outPath);
      try {
        fs.unlinkSync(inPath);
        fs.unlinkSync(outPath);
      } catch {}
      if (outBuf.byteLength > 500) {
        return {
          base64: outBuf.toString('base64'),
          mimeType: 'image/jpeg',
        };
      }
    }
    try {
      fs.unlinkSync(inPath);
    } catch {}
  } catch (err) {
    console.warn('[IdentityV2] Image downscale fallback to original:', (err as Error)?.message || err);
  }
  return { base64: base64Clean, mimeType };
}

function cleanStringArray(arr: unknown, maxLen = 10): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    const s = String(item || '').replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) continue;
    const lower = s.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(s);
    }
    if (out.length >= maxLen) break;
  }
  return out;
}

export class IdentityResolutionFailedError extends Error {
  public readonly code = 'IDENTITY_RESOLUTION_FAILED';
  public readonly attemptsMade: number;
  public readonly arabicMessage =
    'تعذر استخراج الهوية البصرية الكاملة للمنتج (السمات الإلزامية mustMatch وقائمة الاستبعاد mustNotBe) بعد 3 محاولات. تم إيقاف البحث تلقائياً لمنع جلب منتجات خاطئة — يرجى إدخال سمات المنتج يدوياً في النموذج أدناه قبل بدء البحث.';

  constructor(detail: string, attemptsMade = 3) {
    super(`IDENTITY_RESOLUTION_FAILED (after ${attemptsMade} attempts): ${detail}`);
    this.name = 'IdentityResolutionFailedError';
    this.attemptsMade = attemptsMade;
  }
}

export async function resolveIdentityCardV2(params: {
  base64Data: string;
  mimeType?: string;
  userNotes?: string;
  userHint?: string;
  productListingUrl?: string;
  explicitProductName?: string;
  forceRefresh?: boolean;
  simulateFailure?: boolean;
  simulatedEmptyAttributes?: boolean;
  backoffBaseMs?: number;
  onAttemptLog?: (msg: string) => void;
}): Promise<IdentityCardV2> {
  if (!isGeminiConfigured() && !params.simulateFailure && !params.simulatedEmptyAttributes) {
    throw new IdentityResolutionFailedError('GEMINI_API_KEY_MISSING', 0);
  }

  const cleanBase64 = params.base64Data.replace(/^data:[^;]+;base64,/, '');
  const mimeType = params.mimeType || 'image/jpeg';
  const imageHash = crypto.createHash('sha256').update(cleanBase64).digest('hex');

  if (!params.forceRefresh && !params.simulateFailure && !params.simulatedEmptyAttributes) {
    const cached = identityMemoryCache.get(imageHash);
    if (cached && cached.mustNotBe.length > 0 && cached.mustMatch.length > 0 && cached.nameEn) {
      return cached;
    }
    const inflight = inflightIdentityMap.get(imageHash);
    if (inflight) return await inflight;
  }

  const MAX_ATTEMPTS = 3;
  const ATTEMPT_TIMEOUT_MS = 25_000;
  const BACKOFF_BASE_MS = params.backoffBaseMs ?? 500;

  const workPromise = (async (): Promise<IdentityCardV2> => {
    const optimized = await optimizeReferenceImageForVision(cleanBase64, mimeType);
    const nameHint = params.explicitProductName || params.userHint || '';
    const contextHint = [
      nameHint && nameHint !== 'بحث بالصورة' ? `User product name hint: "${nameHint}"` : '',
      params.userNotes ? `User notes: "${params.userNotes}"` : '',
      params.productListingUrl ? `Product URL hint: "${params.productListingUrl}"` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const promptText = `You are a senior e-commerce product forensics and visual taxonomy engineer.
Inspect the attached reference product photo and any visible packaging text, OCR labels, voltage/battery numbers, structure, ports, heads, or attachments.
${contextHint}

Produce an exact Identity Card v2 JSON for matching this specific product across Amazon and TikTok while rejecting different product types:

1. nameEn: Exact commercial product title used on Amazon US (3 to 7 English words, NO brand names). Include the mechanism and form factor when printed on box or visually clear (e.g., "Photocatalyst Suction Type Mosquito Killer Lamp" or "Cordless Electric Power Drill with Tool Kit").
2. nameAr: Clear Arabic commercial name.
3. category: Specific product category in English.
4. primaryColor: Dominant color(s) of the product in English.
5. formFactor:
   - shape: Exact 3D geometry & silhouette.
   - approximateSize: Tabletop/handheld/portable/wall-mounted size class.
   - orientationPlacement: How it sits or is held during use.
6. mechanism:
   - howItWorks: Physical operating mechanism.
   - powerSource: e.g. "USB 5V cable", "18V/20V/21V removable lithium battery pack", "12V DC car adapter", "manual hand tool".
   - keyComponents: Array of 3-6 visible physical parts (include any visible OCR specs like voltage, battery count, chuck type, kit contents).
7. mustMatch: MANDATORY non-empty array of 3-6 attributes.
   CRITICAL ATTRIBUTE QUALITY RULES:
   - NO TAUTOLOGICAL ATTRIBUTES: Do NOT restate the product type/category as an attribute (the product type is checked by a separate TYPE GATE).
   - NO VAGUE "X design" ATTRIBUTES: Never write vague phrases like "Pistol-grip cordless drill design" or "ergonomic design".
   - Put at most 3 BINARY, IMAGE-OBSERVABLE, DISCRIMINATIVE structural attributes first (e.g., "Keyless drill chuck", "Removable slide-in battery pack", "Torque clutch ring"), followed by secondary features (which will be classified as SOFT).
8. variableAttributes: Array of 4-7 attributes that MAY vary freely and must NEVER cause rejection (always include: ["body color", "grip contour details", "carrying case or box slot layout", "brand name or logo", "battery voltage or count", "accessory bit count"]).
9. mustNotBe: MANDATORY non-empty array of 5-10 DIFFERENT PRODUCT TYPES sold in the same category that must be strictly REJECTED.
10. queries:
   - amazonEn: 4 distinct high-volume Amazon US English seller-title style queries (3-6 words each, diversified by features like voltage, brushless, battery count, kit).
   - amazonAr: 2 Arabic search queries for Amazon AE/SA/EG.
   - tiktokEn: 4 short TikTok creator/review search phrases (2-4 words each).
   - tiktokAr: 2 short Arabic TikTok search phrases.
   - tradeNamesEn: 4 alternative commercial synonyms / generic trade names.
11. hashtags: 5 relevant TikTok hashtags (without #).
12. confidence: Number 0.0 to 1.0 indicating visual clarity.
13. ambiguity: Array of any visual uncertainties (empty array if clear).`;

    let lastErrorDetail = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        params.onAttemptLog?.(
          `[IdentityCardV2] Attempt ${attempt}/${MAX_ATTEMPTS} (timeout=${ATTEMPT_TIMEOUT_MS}ms)...`
        );

        if (params.simulateFailure) {
          throw new Error(`Simulated Gemini vision timeout/failure on attempt ${attempt}`);
        }

        const parsed = params.simulatedEmptyAttributes
          ? { nameEn: 'Test Product', mustMatch: [], mustNotBe: [] }
          : JSON.parse(
              (
                await generateContentWithModelFallback(
                  (model) => ({
                    model,
                    contents: {
                      parts: [
                        { inlineData: { data: optimized.base64, mimeType: optimized.mimeType } },
                        { text: promptText },
                      ],
                    },
                    config: {
                      responseMimeType: 'application/json',
                      responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                          nameEn: { type: Type.STRING },
                          nameAr: { type: Type.STRING },
                          category: { type: Type.STRING },
                          primaryColor: { type: Type.STRING },
                          formFactor: {
                            type: Type.OBJECT,
                            properties: {
                              shape: { type: Type.STRING },
                              approximateSize: { type: Type.STRING },
                              orientationPlacement: { type: Type.STRING },
                            },
                            required: ['shape', 'approximateSize', 'orientationPlacement'],
                          },
                          mechanism: {
                            type: Type.OBJECT,
                            properties: {
                              howItWorks: { type: Type.STRING },
                              powerSource: { type: Type.STRING },
                              keyComponents: { type: Type.ARRAY, items: { type: Type.STRING } },
                            },
                            required: ['howItWorks', 'powerSource', 'keyComponents'],
                          },
                          mustMatch: { type: Type.ARRAY, items: { type: Type.STRING } },
                          variableAttributes: { type: Type.ARRAY, items: { type: Type.STRING } },
                          mustNotBe: { type: Type.ARRAY, items: { type: Type.STRING } },
                          queries: {
                            type: Type.OBJECT,
                            properties: {
                              amazonEn: { type: Type.ARRAY, items: { type: Type.STRING } },
                              amazonAr: { type: Type.ARRAY, items: { type: Type.STRING } },
                              tiktokEn: { type: Type.ARRAY, items: { type: Type.STRING } },
                              tiktokAr: { type: Type.ARRAY, items: { type: Type.STRING } },
                              tradeNamesEn: { type: Type.ARRAY, items: { type: Type.STRING } },
                            },
                            required: ['amazonEn', 'amazonAr', 'tiktokEn', 'tiktokAr', 'tradeNamesEn'],
                          },
                          hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
                          confidence: { type: Type.NUMBER },
                          ambiguity: { type: Type.ARRAY, items: { type: Type.STRING } },
                        },
                        required: [
                          'nameEn',
                          'nameAr',
                          'category',
                          'primaryColor',
                          'formFactor',
                          'mechanism',
                          'mustMatch',
                          'variableAttributes',
                          'mustNotBe',
                          'queries',
                          'hashtags',
                          'confidence',
                          'ambiguity',
                        ],
                      },
                    },
                  }),
                  { maxRetries: 0, baseMs: 400, timeoutMs: ATTEMPT_TIMEOUT_MS }
                )
              ).text?.trim() || '{}'
            );

        const nameEn = String(parsed.nameEn || '').trim();
        const mustMatch = cleanStringArray(parsed.mustMatch, 10);
        const mustNotBe = cleanStringArray(parsed.mustNotBe, 12);

        // FAIL CLOSED: Never accept an identity card with empty nameEn, empty mustMatch, or empty mustNotBe
        if (!nameEn || mustMatch.length === 0 || mustNotBe.length === 0) {
          throw new Error(
            `IDENTITY_CARD_INCOMPLETE (nameEn="${nameEn}", mustMatch=${mustMatch.length}, mustNotBe=${mustNotBe.length})`
          );
        }

        const rawCard: IdentityCardV2 = {
          imageHash,
          nameEn,
          nameAr: String(parsed.nameAr || nameEn).trim(),
          category: String(parsed.category || 'General').trim(),
          primaryColor: String(parsed.primaryColor || 'Unknown').trim(),
          formFactor: {
            shape: String(parsed.formFactor?.shape || '').trim() || 'Standard commercial form factor',
            approximateSize: String(parsed.formFactor?.approximateSize || 'Portable / Tabletop').trim(),
            orientationPlacement: String(parsed.formFactor?.orientationPlacement || 'Standard').trim(),
          },
          mechanism: {
            howItWorks: String(parsed.mechanism?.howItWorks || '').trim() || 'Standard operation',
            powerSource: String(parsed.mechanism?.powerSource || 'Standard').trim(),
            keyComponents: cleanStringArray((parsed as any).mechanism?.keyComponents, 8),
          },
          mustMatch,
          attributeStrengths: classifyIdentityAttributeStrengths(mustMatch, undefined, {
            nameEn,
            category: String(parsed.category || 'General').trim(),
          }),
          variableAttributes: cleanStringArray(
            (parsed as any).variableAttributes?.length
              ? (parsed as any).variableAttributes
              : ['color', 'brand name', 'logo', 'retail box artwork', 'cable length', 'minor accessories'],
            8
          ),
          mustNotBe,
          queries: {
            amazonEn: cleanStringArray([nameEn, ...((parsed as any).queries?.amazonEn || [])], 6),
            amazonAr: cleanStringArray((parsed as any).queries?.amazonAr, 4),
            tiktokEn: cleanStringArray((parsed as any).queries?.tiktokEn || [nameEn], 6),
            tiktokAr: cleanStringArray((parsed as any).queries?.tiktokAr, 4),
            tradeNamesEn: cleanStringArray((parsed as any).queries?.tradeNamesEn, 6),
          },
          hashtags: cleanStringArray((parsed as any).hashtags, 8).map((h) => h.replace(/^#+/, '')),
          confidence: Math.max(0, Math.min(1, Number((parsed as any).confidence) || 0.85)),
          ambiguity: cleanStringArray((parsed as any).ambiguity, 5),
          createdAt: new Date().toISOString(),
        };

        const card = sanitizeIdentityCardAttributes(rawCard);
        identityMemoryCache.set(imageHash, card);
        saveIdentityCacheToDisk();
        return card;
      } catch (err: unknown) {
        lastErrorDetail = (err as Error)?.message || String(err);
        params.onAttemptLog?.(
          `[IdentityCardV2] Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastErrorDetail}`
        );
        if (attempt < MAX_ATTEMPTS) {
          const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
          params.onAttemptLog?.(`[IdentityCardV2] Backing off ${delayMs}ms before attempt ${attempt + 1}...`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    throw new IdentityResolutionFailedError(lastErrorDetail, MAX_ATTEMPTS);
  })();

  if (!params.simulateFailure && !params.simulatedEmptyAttributes) {
    inflightIdentityMap.set(imageHash, workPromise);
  }
  try {
    return await workPromise;
  } finally {
    inflightIdentityMap.delete(imageHash);
  }
}

export function getCachedIdentityByHash(imageHash: string, nameEnFallback?: string): IdentityCardV2 | undefined {
  if (!imageHash && !nameEnFallback) return undefined;
  const cleanHash = String(imageHash || '').trim();
  if (cleanHash) {
    const exact = identityMemoryCache.get(cleanHash);
    if (exact) return exact;
    for (const [k, v] of identityMemoryCache.entries()) {
      if (cleanHash.length >= 12 && (k.startsWith(cleanHash) || cleanHash.startsWith(k))) {
        return v;
      }
    }
  }
  if (nameEnFallback) {
    const lowerName = nameEnFallback.trim().toLowerCase();
    for (const v of identityMemoryCache.values()) {
      if (v.nameEn.trim().toLowerCase() === lowerName && v.category !== 'General') {
        return v;
      }
    }
  }
  return undefined;
}

export function upsertManualIdentityCard(params: {
  imageHash?: string;
  base64Data?: string;
  nameEn: string;
  nameAr?: string;
  formFactorShape?: string;
  mechanismHowItWorks?: string;
  discriminators?: DiscriminatorSpec[];
  sameCategoryLookalikes?: string[];
  mustMatch: string[];
  attributeStrengths?: Record<string, AttributeStrength>;
  mustNotBe: string[];
  variableAttributes?: string[];
}): IdentityCardV2 {
  const cleanNameEn = String(params.nameEn || '').trim();
  const mustMatch = cleanStringArray(params.mustMatch, 12);
  const mustNotBe = cleanStringArray(params.mustNotBe, 16);
  if (!cleanNameEn || mustMatch.length === 0 || mustNotBe.length === 0) {
    throw new IdentityResolutionFailedError(
      'Manual identity card requires non-empty nameEn, mustMatch, and mustNotBe',
      1
    );
  }
  const hash =
    params.imageHash ||
    (params.base64Data
      ? crypto
          .createHash('sha256')
          .update(params.base64Data.replace(/^data:[^;]+;base64,/, ''))
          .digest('hex')
      : `manual_${crypto.createHash('sha1').update(cleanNameEn).digest('hex').slice(0, 16)}`);

  const existing = getCachedIdentityByHash(hash, cleanNameEn);
  const canonicalHash = existing?.imageHash || hash;

  const rawCard: IdentityCardV2 = {
    imageHash: canonicalHash,
    nameEn: cleanNameEn,
    nameAr: String(params.nameAr || existing?.nameAr || cleanNameEn).trim(),
    category: existing?.category && existing.category !== 'General' ? existing.category : 'Automotive & Consumer Goods',
    primaryColor: existing?.primaryColor || 'Standard',
    formFactor: {
      shape: String(params.formFactorShape || existing?.formFactor.shape || cleanNameEn).trim(),
      approximateSize: existing?.formFactor.approximateSize || 'Standard',
      orientationPlacement: existing?.formFactor.orientationPlacement || 'Standard',
    },
    mechanism: {
      howItWorks: String(params.mechanismHowItWorks || existing?.mechanism.howItWorks || cleanNameEn).trim(),
      powerSource: existing?.mechanism.powerSource || 'Standard',
      keyComponents: existing?.mechanism.keyComponents || mustMatch.slice(0, 4),
    },
    discriminators: params.discriminators || existing?.discriminators,
    sameCategoryLookalikes: params.sameCategoryLookalikes || existing?.sameCategoryLookalikes,
    mustMatch,
    attributeStrengths: classifyIdentityAttributeStrengths(
      mustMatch,
      params.attributeStrengths || existing?.attributeStrengths,
      { nameEn: cleanNameEn, category: existing?.category }
    ),
    variableAttributes: cleanStringArray(
      params.variableAttributes?.length
        ? params.variableAttributes
        : existing?.variableAttributes || [
            'body color',
            'brand name or logo',
            'retail box artwork',
            'cable length',
          ],
      10
    ),
    mustNotBe,
    queries: existing?.queries?.amazonEn && existing.queries.amazonEn.length > 1
      ? existing.queries
      : {
          amazonEn: [cleanNameEn, `${cleanNameEn} universal`, `${cleanNameEn} organizer`],
          amazonAr: params.nameAr ? [params.nameAr] : existing?.queries?.amazonAr || [],
          tiktokEn: existing?.queries?.tiktokEn?.length ? existing.queries.tiktokEn : [cleanNameEn],
          tiktokAr: params.nameAr ? [params.nameAr] : existing?.queries?.tiktokAr || [],
          tradeNamesEn: existing?.queries?.tradeNamesEn || [],
        },
    hashtags: existing?.hashtags || [],
    confidence: 1.0,
    ambiguity: [],
    createdAt: new Date().toISOString(),
  };

  const card = sanitizeIdentityCardAttributes(rawCard);
  identityMemoryCache.set(canonicalHash, card);
  if (hash !== canonicalHash) {
    identityMemoryCache.set(hash, card);
  }
  saveIdentityCacheToDisk();
  return card;
}

export function updateCachedIdentityCard(
  imageHash: string,
  updates: Partial<
    Pick<
      IdentityCardV2,
      | 'nameEn'
      | 'nameAr'
      | 'mustMatch'
      | 'mustNotBe'
      | 'variableAttributes'
      | 'attributeStrengths'
      | 'discriminators'
      | 'sameCategoryLookalikes'
    >
  >
): IdentityCardV2 | null {
  const existing = getCachedIdentityByHash(imageHash, updates.nameEn);
  if (!existing) return null;
  const nextMustMatch = Array.isArray(updates.mustMatch)
    ? cleanStringArray(updates.mustMatch, 12)
    : existing.mustMatch;
  const nextStrengths = classifyIdentityAttributeStrengths(nextMustMatch, {
    ...(existing.attributeStrengths || {}),
    ...(updates.attributeStrengths || {}),
  });
  const rawUpdated: IdentityCardV2 = {
    ...existing,
    ...(updates.nameEn ? { nameEn: updates.nameEn.trim() } : {}),
    ...(updates.nameAr ? { nameAr: updates.nameAr.trim() } : {}),
    mustMatch: nextMustMatch,
    attributeStrengths: nextStrengths,
    ...(Array.isArray(updates.discriminators) ? { discriminators: updates.discriminators.slice(0, 5) } : {}),
    ...(Array.isArray(updates.sameCategoryLookalikes)
      ? { sameCategoryLookalikes: cleanStringArray(updates.sameCategoryLookalikes, 6) }
      : {}),
    ...(Array.isArray(updates.mustNotBe) ? { mustNotBe: cleanStringArray(updates.mustNotBe, 16) } : {}),
    ...(Array.isArray(updates.variableAttributes)
      ? { variableAttributes: cleanStringArray(updates.variableAttributes, 10) }
      : {}),
  };
  const updated = sanitizeIdentityCardAttributes(rawUpdated);
  identityMemoryCache.set(existing.imageHash, updated);
  if (imageHash && imageHash !== existing.imageHash) {
    identityMemoryCache.set(imageHash, updated);
  }
  saveIdentityCacheToDisk();
  return updated;
}

export function identityCardToVisualAttribute(card: IdentityCardV2): VisualAttribute {
  return {
    category: card.category,
    suggestedNameAr: card.nameAr,
    suggestedNameEn: card.nameEn,
    shape: card.formFactor.shape,
    dimensions: card.formFactor.approximateSize,
    material: card.mechanism.keyComponents.join(', '),
    color: card.primaryColor,
    mechanism: `${card.mechanism.howItWorks} (${card.mechanism.powerSource})`,
    headDesign: card.formFactor.orientationPlacement,
    handleType: card.mechanism.powerSource,
    distinctiveGeometry: `${card.formFactor.shape} — ${card.mechanism.howItWorks}`,
    mustMatchAttributes: card.mustMatch,
    allowedDifferences: card.variableAttributes,
    excludeKeywords: card.mustNotBe,
    confidence: card.confidence,
    multilingualQueries: {
      ar: card.queries.amazonAr,
      en: [...card.queries.amazonEn, ...card.queries.tradeNamesEn],
    },
    identityCardV2: card,
  } as VisualAttribute & { identityCardV2: IdentityCardV2 };
}
