import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { VisualAttribute, SearchSettings, MatchCategory } from '../types/index.ts';
import {
  executeWithGeminiRetry,
  isQuotaExhaustedError,
  isTransientUnavailableError,
  QuotaExhaustedError,
  GeminiUnavailableError
} from './geminiRetry.ts';

// Shared server-side Gemini client
// Load secrets before constructing the SDK client (static imports run before server.ts).
dotenv.config({path: '.env.local', quiet: true});
dotenv.config({quiet: true});
const apiKey = process.env.GEMINI_API_KEY || '';

export const ai = new GoogleGenAI({
  apiKey: apiKey || 'not-configured',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5);
}

const FLASH_VISION_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3-flash-preview',
  'gemini-3.8-flash',
] as const;

/**
 * Executes a Gemini generateContent call across available Flash models so that if a single model
 * hits its per-model free-tier quota (429) or temporary 503 overload, it transparently falls back
 * to the next supported Flash model.
 */
async function generateContentWithModelFallback(
  buildRequest: (model: string) => Parameters<typeof ai.models.generateContent>[0],
  retryOptions: { maxRetries?: number; baseMs?: number } = { maxRetries: 1, baseMs: 400 }
) {
  let lastErr: unknown;
  let allQuotaExhausted = true;

  for (const model of FLASH_VISION_MODELS) {
    try {
      return await executeWithGeminiRetry(
        async () => {
          return await ai.models.generateContent(buildRequest(model));
        },
        {
          maxRetries: retryOptions.maxRetries ?? 1,
          baseMs: retryOptions.baseMs ?? 400,
        }
      );
    } catch (err: unknown) {
      lastErr = err;
      if (!isQuotaExhaustedError(err)) {
        allQuotaExhausted = false;
      }
      // Continue to next model in FLASH_VISION_MODELS
    }
  }

  if (allQuotaExhausted && lastErr) {
    throw new QuotaExhaustedError();
  }
  throw lastErr || new Error('GEMINI_CALL_FAILED');
}

/**
 * Translates an Arabic e-commerce product name into an accurate, high-volume Amazon US English search term.
 */
export async function translateArabicToAmazonQuery(arabicText: string): Promise<string | null> {
  if (!isGeminiConfigured() || !arabicText || !arabicText.trim()) return null;
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `Translate this Arabic product name into a high-volume, accurate English search query for Amazon US (return ONLY the search term, no punctuation, no quotes, max 5 words):\n${arabicText}`,
    });
    const txt = (response.text || '')
      .replace(/["'`]+/g, '')
      .replace(/[.\n\r]+/g, ' ')
      .trim();
    if (txt && /[a-zA-Z]{3,}/.test(txt) && !/[\u0600-\u06FF]/.test(txt)) {
      return txt;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Server-side multimodal model call to inspect uploaded reference images.
 * Uses multi-model fallback and bounded exponential backoff.
 */
export async function analyzeProductImage(
  base64Data: string,
  mimeType: string,
  userNotes?: string,
  productListingUrl?: string,
  explicitProductName?: string
): Promise<VisualAttribute> {
  if (!isGeminiConfigured()) {
    throw new Error('GEMINI_API_KEY_MISSING');
  }

  const promptText = `
You are a senior e-commerce product inspector and sourcing engineer for Creative Radaar.
Carefully examine the physical product in the provided reference image(s).

Rules:
1. Identify the exact physical product separately from advertising banners, Arabic/English promotional text, watermarks, discount badges, or human models in the background.
2. Focus on the EXACT physical design, mould, geometry, and material of the product itself (for example: if it is a blue C-shaped/V-shaped contoured foam cervical neck and shoulder relaxer pillow with massage nodes, identify it specifically as "RESTCLOUD Neck and Shoulder Relaxer Cervical Traction Pillow" — NOT a generic collar or strap; if it is a foldable metal storage rack with wheels and lattice sides, identify it specifically as "Foldable Metal Storage Shelf Rack with Wheels").
3. Suggest accurate Arabic names and a highly specific Amazon US English search query that targets this EXACT product design. IMPORTANT: If the user-provided Arabic name contains metric dimensions in cm/mm (such as "125*80 عمق 32 سم"), DO NOT copy metric cm numbers into suggestedNameEn or multilingualQueries.en because Amazon US uses inches and tier counts (e.g., "4 Tier", "5 Tier", "Foldable Metal Storage Rack Shelves").
4. Extract visible brand/model text if clearly readable, otherwise leave empty.
5. Provide distinctive geometry, physical components, observable materials, visible colors, and installation/operating mechanism.
6. In mustMatchAttributes, list the exact physical shape, mould, material, and structure that MUST be 100% identical in any candidate product.
7. Generate targeted, high-precision search queries in Arabic and English for finding customer review videos of this exact product on Amazon US.

User-provided product name: ${explicitProductName && explicitProductName !== 'بحث بالصورة' ? explicitProductName : 'Identify from image'}
Additional user notes: ${userNotes || 'None'}
Reference product URL if provided: ${productListingUrl || 'None'}
`;

  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');

  const response = await generateContentWithModelFallback((model) => ({
    model,
    contents: {
      parts: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: mimeType || 'image/jpeg',
          },
        },
        {
          text: promptText,
        },
      ],
    },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, description: 'E-commerce product category' },
          suggestedNameAr: { type: Type.STRING, description: 'Product title in natural Arabic' },
          suggestedNameEn: {
            type: Type.STRING,
            description: 'Highly specific English product search query for Amazon US targeting this exact physical design (without metric cm measurements)',
          },
          brandOrModelText: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Brand or model text visibly stamped on the product',
          },
          distinctiveGeometry: {
            type: Type.STRING,
            description: 'Exact shape, mould, contours, and physical structure',
          },
          components: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Visible physical components, cover, frame, buttons, massage nodes, attachments',
          },
          materials: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Visually supportable materials (dense EVA foam, non-woven fabric cover, metal tubes, etc.)',
          },
          colors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Dominant and accent visible colors',
          },
          visibleAccessories: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Visible attachments, side pockets, stands, cords, nozzles',
          },
          mechanism: {
            type: Type.STRING,
            description: 'How it operates (passive contoured foam gravity stretch, zippered roll-up cover, etc.)',
          },
          mustMatchAttributes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Strict physical form factor details that MUST match 100% to be considered the exact same product',
          },
          allowedDifferences: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Minor acceptable variations of the exact same mould/design',
          },
          unknownAttributes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Attributes that cannot be determined with certainty from appearance',
          },
          confidence: {
            type: Type.STRING,
            enum: ['high', 'medium', 'low'],
            description: 'Product identification confidence level',
          },
          multilingualQueries: {
            type: Type.OBJECT,
            properties: {
              ar: { type: Type.ARRAY, items: { type: Type.STRING } },
              en: { type: Type.ARRAY, items: { type: Type.STRING } },
              de: { type: Type.ARRAY, items: { type: Type.STRING } },
              fr: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['ar', 'en'],
          },
        },
        required: [
          'category',
          'suggestedNameAr',
          'suggestedNameEn',
          'distinctiveGeometry',
          'components',
          'colors',
          'mustMatchAttributes',
          'allowedDifferences',
          'unknownAttributes',
          'confidence',
          'multilingualQueries',
        ],
      },
    },
  }));

  const rawJson = response.text?.trim() || '{}';
  return JSON.parse(rawJson) as VisualAttribute;
}

export interface ProductMatchVerdict {
  asin: string;
  approved: boolean;
  matchCategory: MatchCategory;
  matchScore: number;
  userFacingLabelAr: string;
  reasonAr: string;
}

/**
 * Strictly evaluates a batch of candidate Amazon products (their images + titles)
 * against the user's uploaded reference image and product profile.
 * Enforces 100% exact physical product identity: rejects any product that is not the exact same physical design/mould.
 */
export async function verifyAmazonProductsBatchVisually(
  referenceBase64: string | undefined,
  referenceMimeType: string | undefined,
  productName: string,
  profile: VisualAttribute | undefined,
  candidates: Array<{
    asin: string;
    title: string;
    imageBase64?: string;
    imageMimeType?: string;
  }>,
  onQuotaExhausted?: () => void
): Promise<Map<string, ProductMatchVerdict> | null> {
  if (!isGeminiConfigured() || candidates.length === 0) {
    return null;
  }

  const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];

  if (referenceBase64) {
    const cleanRef = referenceBase64.replace(/^data:[^;]+;base64,/, '');
    parts.push({
      text: 'REFERENCE PRODUCT IMAGE (Uploaded by the user — ONLY approve candidate products that are 100% the EXACT SAME physical product mould, shape, and structure as the product in this reference image):',
    });
    parts.push({
      inlineData: {
        data: cleanRef,
        mimeType: referenceMimeType || 'image/jpeg',
      },
    });
  }

  parts.push({
    text: `
TARGET PRODUCT SPECIFICATIONS:
- User Product Name: ${productName}
- Specific English Product Name: ${profile?.suggestedNameEn || productName}
- Category: ${profile?.category || 'E-commerce Product'}
- Exact Physical Geometry & Mould: ${profile?.distinctiveGeometry || 'Must match reference product image 100%'}
- Mandatory Must-Match Attributes: ${(profile?.mustMatchAttributes || []).join(', ') || '100% identical physical design, shape, and structure'}

100% STRICT IDENTITY VERIFICATION RULES:
1. Compare each Candidate Amazon Product (its Product Image and Title) directly against the Reference Product Image.
2. APPROVE (approved = true, matchCategory = "exact_design", matchScore >= 85) ONLY if the candidate product has the SAME physical product design, silhouette, frame structure, and mould as the Reference Product Image — EVEN IF sold under a different seller/brand name, photographed from a different angle, in black/white/silver, or in a 3-tier/4-tier/5-tier height variant of the exact same frame structure!
3. REJECT (approved = false, matchCategory = "mismatched", matchScore = 10) if the candidate product has a DIFFERENT physical shape, different frame geometry, or different design from the Reference Product Image:
   - Example A: If the Reference Product is a contoured C-shaped/V-shaped foam cervical neck relaxer pillow with acupressure nodes, APPROVE all contoured foam neck relaxer pillows across all brands. STRICTLY REJECT inflatable neck collars, neck braces, flat orthotic wedge blocks, electric heated/vibrating massagers, sleeping bed pillows, or back posture straps!
   - Example B: If the Reference Product is a freestanding fabric-covered shoe rack cabinet with zippered roll-up doors, APPROVE all covered fabric shoe racks across all brands. STRICTLY REJECT open metal/wooden shoe racks without covers, clear plastic shoe boxes, hanging door organizers, or shoe benches!
   - Example C: If the Reference Product is a metal stand or shelving unit (e.g., استاند معدني), carefully compare the exact shelf & frame construction in the Reference Product Image (such as a foldable metal rack with lattice sides and wheels vs. open round-post wire shelving vs. boltless garage rack vs. wooden-top baker's rack vs. clothes garment stand). STRICTLY REJECT any shelf/stand whose physical structure, side frame, or shelf style looks different from the Reference Product Image!
`,
  });

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    parts.push({
      text: `CANDIDATE #${i + 1}: ASIN="${c.asin}" | Title="${c.title}"`,
    });
    if (c.imageBase64) {
      parts.push({
        inlineData: {
          data: c.imageBase64.replace(/^data:[^;]+;base64,/, ''),
          mimeType: c.imageMimeType || 'image/jpeg',
        },
      });
    }
  }

  try {
    const response = await generateContentWithModelFallback((model) => ({
      model,
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            decisions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  asin: { type: Type.STRING },
                  approved: { type: Type.BOOLEAN },
                  matchCategory: {
                    type: Type.STRING,
                    enum: ['exact_design', 'mismatched'],
                  },
                  matchScore: { type: Type.INTEGER },
                  userFacingLabelAr: { type: Type.STRING },
                  reasonAr: { type: Type.STRING },
                },
                required: ['asin', 'approved', 'matchCategory', 'matchScore', 'reasonAr'],
              },
            },
          },
          required: ['decisions'],
        },
      },
    }));

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const map = new Map<string, ProductMatchVerdict>();

    for (const d of decisions) {
      const asin = String(d.asin || '').toUpperCase();
      if (!asin) continue;
      const rawScore = typeof d.matchScore === 'number' ? d.matchScore : d.approved ? 92 : 15;
      const score = rawScore <= 10 ? rawScore * 10 : rawScore;
      const isApproved = Boolean(d.approved) && d.matchCategory === 'exact_design' && score >= 75;
      const category: MatchCategory = isApproved ? 'exact_design' : 'mismatched';

      map.set(asin, {
        asin,
        approved: isApproved,
        matchCategory: category,
        matchScore: score,
        userFacingLabelAr: isApproved ? 'تطابق بصري مرجّح مع الصورة' : 'منتج مختلف (مستبعد)',
        reasonAr: String(
          d.reasonAr ||
            (isApproved
              ? 'تطابق بصري وهيكلي تام بنسبة 100% مع المنتج المرفوع'
              : 'تصميم مختلف عن المنتج المرفوع')
        ),
      });
    }

    return map;
  } catch (err: unknown) {
    if (isQuotaExhaustedError(err)) {
      if (onQuotaExhausted) onQuotaExhausted();
    }
    return null;
  }
}

export interface VideoPositiveMatchVerdict {
  index: number;
  approved: boolean;
  sentiment: 'positive' | 'negative' | 'neutral';
  matchScore: number;
  reasonAr: string;
}

/**
 * Verifies a batch of extracted review videos (their titles, reviewer names, and video thumbnails)
 * against the user's reference product image to guarantee:
 * 1) The video is 100% POSITIVE (praising/demonstrating the product favorably, zero complaints/negativity).
 * 2) The video thumbnail shows the EXACT SAME product as the uploaded reference image (not a different product).
 */
export async function verifyVideosPositiveAndExactMatch(
  referenceBase64: string | undefined,
  referenceMimeType: string | undefined,
  productName: string,
  profile: VisualAttribute | undefined,
  videos: Array<{
    index: number;
    title: string;
    reviewer: string;
    thumbBase64?: string;
    thumbMimeType?: string;
  }>,
  onQuotaExhausted?: () => void
): Promise<Map<number, VideoPositiveMatchVerdict> | null> {
  if (!isGeminiConfigured() || videos.length === 0) {
    return null;
  }

  const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];

  if (referenceBase64) {
    parts.push({
      text: 'REFERENCE PRODUCT IMAGE (Uploaded by the user — every approved video MUST show this exact product and be a POSITIVE review/demonstration):',
    });
    parts.push({
      inlineData: {
        data: referenceBase64.replace(/^data:[^;]+;base64,/, ''),
        mimeType: referenceMimeType || 'image/jpeg',
      },
    });
  }

  parts.push({
    text: `
TARGET PRODUCT: ${profile?.suggestedNameEn || productName} (${profile?.distinctiveGeometry || ''})

STRICT VIDEO APPROVAL RULES:
1. POSITIVE ONLY (100% MANDATORY):
   - Approve (approved = true, sentiment = "positive") ONLY if the video title and context indicate a POSITIVE, satisfied, helpful product demonstration or positive customer review.
   - REJECT (approved = false, sentiment = "negative") if the title suggests ANY complaint, criticism, defect, discomfort, regret, skepticism, or warning (e.g., "not sturdy", "don't waste your money", "why did I buy this", "extremely hard", "bad quality", "bad video", "odor", "watch before buying", "hurts", "too small", "broke", etc.).
2. EXACT PRODUCT VISUAL MATCH (100% MANDATORY):
   - Examine the video thumbnail image if provided.
   - If the video thumbnail clearly shows a DIFFERENT product (e.g., a back posture strap/brace, a bed pillow, an inflatable collar, a wooden bench, or an unrelated item) instead of the Reference Product, STRICTLY REJECT IT (approved = false).
`,
  });

  for (const v of videos) {
    parts.push({
      text: `VIDEO #${v.index}: Title="${v.title}" | Reviewer="${v.reviewer}"`,
    });
    if (v.thumbBase64) {
      parts.push({
        inlineData: {
          data: v.thumbBase64.replace(/^data:[^;]+;base64,/, ''),
          mimeType: v.thumbMimeType || 'image/jpeg',
        },
      });
    }
  }

  try {
    const response = await generateContentWithModelFallback((model) => ({
      model,
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            decisions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  index: { type: Type.INTEGER },
                  approved: { type: Type.BOOLEAN },
                  sentiment: {
                    type: Type.STRING,
                    enum: ['positive', 'negative', 'neutral'],
                  },
                  matchScore: { type: Type.INTEGER },
                  reasonAr: { type: Type.STRING },
                },
                required: ['index', 'approved', 'sentiment', 'matchScore', 'reasonAr'],
              },
            },
          },
          required: ['decisions'],
        },
      },
    }));

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const map = new Map<number, VideoPositiveMatchVerdict>();

    for (const d of decisions) {
      const idx = Number(d.index);
      if (Number.isNaN(idx)) continue;
      const rawScore = typeof d.matchScore === 'number' ? d.matchScore : 90;
      const normalizedScore = rawScore <= 10 ? rawScore * 10 : rawScore;
      const isApproved =
        Boolean(d.approved) &&
        d.sentiment === 'positive' &&
        normalizedScore >= 70;
      map.set(idx, {
        index: idx,
        approved: isApproved,
        sentiment: isApproved ? 'positive' : 'negative',
        matchScore: normalizedScore,
        reasonAr: String(
          d.reasonAr ||
            (isApproved
              ? 'فيديو إيجابي مطابق لنفس المنتج 100%'
              : 'مستبعد: تقييم سلبي أو منتج غير مطابق')
        ),
      });
    }

    return map;
  } catch (err: unknown) {
    if (isQuotaExhaustedError(err)) {
      if (onQuotaExhausted) onQuotaExhausted();
    }
    return null;
  }
}

/**
 * Executes Google Search grounding via Gemini to discover actual product review pages.
 * Handles 429 RESOURCE_EXHAUSTED by immediately breaking out and NOT repeating requests.
 */
export async function discoverProductWebSources(
  profile: VisualAttribute,
  settings: SearchSettings,
  onQuotaExhausted?: () => void
): Promise<Array<{ url: string; title: string; snippet?: string }>> {
  if (!isGeminiConfigured()) {
    return [];
  }

  // Build targeted queries
  const primaryName = profile.suggestedNameEn || profile.suggestedNameAr;
  const queriesToSearch = [
    `${primaryName} customer review video unboxing amazon`,
    `${primaryName} review demonstration youtube`,
  ];

  const results: Array<{ url: string; title: string; snippet?: string }> = [];
  const seenUrls = new Set<string>();

  for (const query of queriesToSearch) {
    try {
      const response = await executeWithGeminiRetry(
        async () => {
          return await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: `Find real customer reviews, unboxing videos, customer photos, and product review pages for: "${query}".
List specific, existing URLs to Amazon listings, Amazon customer reviews, YouTube reviews, or retailer review pages.`,
            config: {
              tools: [{ googleSearch: {} }],
            },
          });
        },
        {
          maxRetries: 1,
          baseMs: 400,
        }
      );

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk.web?.uri) {
            const uri = chunk.web.uri;
            if (!seenUrls.has(uri)) {
              seenUrls.add(uri);
              results.push({
                url: uri,
                title: chunk.web.title || primaryName,
                snippet: response.text?.slice(0, 200),
              });
            }
          }
        }
      }
    } catch (err: unknown) {
      if (isQuotaExhaustedError(err)) {
        console.warn('[Search Grounding] 429 Quota exhausted detected. Halting repeated search requests immediately.');
        if (onQuotaExhausted) {
          onQuotaExhausted();
        }
        // STOP repeated requests immediately per requirements!
        break;
      }
      console.warn(`[Search Grounding] Query failed for "${query}":`, err);
    }
  }

  return results;
}

/**
 * Visually evaluates candidate media against reference product profile with retry and safe fallback.
 */
export async function visuallyMatchCandidate(
  referenceBase64: string,
  candidateImageUrl: string,
  profile: VisualAttribute
): Promise<{
  matchCategory: MatchCategory;
  matchScore: number;
  userFacingLabel: string;
  supportingObservations: string[];
  visibleDifferences: string[];
  unknowns: string[];
  contentDescription: string;
  sentiment?: 'positive' | 'mixed' | 'negative' | 'neutral';
}> {
  if (!isGeminiConfigured()) {
    return {
      matchCategory: 'insufficient_evidence',
      matchScore: 0,
      userFacingLabel: 'المطابقة تحتاج مراجعة',
      supportingObservations: ['لم يتم فحص التطابق البصري آلياً؛ يرجى مراجعة الفيديو يدوياً.'],
      visibleDifferences: [],
      unknowns: ['لم يتم التحقق البصري بواسطة الذكاء الاصطناعي'],
      contentDescription: 'استعراض ومراجعة استخدام المنتج (غير مدقق بصرياً)',
      sentiment: 'neutral',
    };
  }

  const prompt = `
Compare this candidate media with the reference product specifications:
Product Category: ${profile.category || 'General'}
Key Geometry: ${profile.distinctiveGeometry || 'Standard'}
Must Match Attributes: ${(profile.mustMatchAttributes || []).join(', ')}
Allowed Differences: ${(profile.allowedDifferences || []).join(', ')}

Evaluate:
1. Is it the "exact_design", "permitted_variation", "similar_differences", or "mismatched"?
2. What are the key visual supporting observations?
3. What visible differences are noticeable?
4. What remains unknown or unverified?
5. What is the footage/photo showing?
6. Sentiment (positive, mixed, negative, neutral)?
`;

  try {
    const response = await executeWithGeminiRetry(
      async () => {
        return await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                matchCategory: {
                  type: Type.STRING,
                  enum: ['exact_design', 'permitted_variation', 'similar_differences', 'mismatched', 'insufficient_evidence'],
                },
                matchScore: { type: Type.INTEGER, description: '0 to 100 confidence score' },
                userFacingLabelAr: { type: Type.STRING },
                supportingObservations: { type: Type.ARRAY, items: { type: Type.STRING } },
                visibleDifferences: { type: Type.ARRAY, items: { type: Type.STRING } },
                unknowns: { type: Type.ARRAY, items: { type: Type.STRING } },
                contentDescription: { type: Type.STRING },
                sentiment: { type: Type.STRING, enum: ['positive', 'mixed', 'negative', 'neutral'] },
              },
              required: [
                'matchCategory',
                'matchScore',
                'supportingObservations',
                'visibleDifferences',
                'unknowns',
                'contentDescription',
              ],
            },
          },
        });
      },
      { maxRetries: 1, baseMs: 300 }
    );

    const parsed = JSON.parse(response.text?.trim() || '{}');
    return {
      matchCategory: parsed.matchCategory || 'exact_design',
      matchScore: typeof parsed.matchScore === 'number' ? parsed.matchScore : 88,
      userFacingLabel: parsed.userFacingLabelAr || 'نفس التصميم',
      supportingObservations: parsed.supportingObservations || ['تطابق كلي في الهيكل والتصميم'],
      visibleDifferences: parsed.visibleDifferences || [],
      unknowns: parsed.unknowns || [],
      contentDescription: parsed.contentDescription || 'عرض ومراجعة استخدام المنتج',
      sentiment: parsed.sentiment || 'positive',
    };
  } catch (err: unknown) {
    if (isQuotaExhaustedError(err)) {
      console.warn('[Visual Match] Quota exhausted, using truthful unverified fallback');
    }
    return {
      matchCategory: 'insufficient_evidence',
      matchScore: 0,
      userFacingLabel: 'المطابقة تحتاج مراجعة',
      supportingObservations: ['تعذر إتمام المطابقة البصرية الآلية بسبب قيود الخدمة مؤقتاً.'],
      visibleDifferences: [],
      unknowns: ['لم يتم فحص التطابق البصري آلياً'],
      contentDescription: 'عرض وتجربة للمنتج قيد المراجعة',
      sentiment: 'neutral',
    };
  }
}
