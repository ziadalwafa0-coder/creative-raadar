import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import type { VisualAttribute, SearchSettings, MatchCategory, CreativeHookAnalysis } from '../types/index.ts';
import { buildFallbackCreativeAnalysis } from '../utils/rules.ts';
import { GEMINI_API_KEY, GEMINI_MODELS } from './config.ts';
import {
  executeWithGeminiRetry,
  isQuotaExhaustedError,
  QuotaExhaustedError,
} from './geminiRetry.ts';

export const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export function isGeminiConfigured(): boolean {
  return Boolean(GEMINI_API_KEY && GEMINI_API_KEY.length > 5 && GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
}

/**
 * Single unified model-fallback helper using GEMINI_MODELS from config.ts.
 */
export async function generateContentWithModelFallback(
  buildRequest: (model: string) => Parameters<typeof ai.models.generateContent>[0],
  retryOptions: { maxRetries?: number; baseMs?: number; timeoutMs?: number } = {
    maxRetries: 1,
    baseMs: 350,
    timeoutMs: 8000,
  }
) {
  let lastErr: unknown;
  let allQuotaExhausted = true;
  const timeoutMs = retryOptions.timeoutMs ?? 8000;

  for (const model of GEMINI_MODELS) {
    try {
      return await executeWithGeminiRetry(
        async () => {
          const req = buildRequest(model);
          return await ai.models.generateContent({
            ...req,
            config: {
              ...req.config,
              abortSignal: req.config?.abortSignal || AbortSignal.timeout(timeoutMs),
            },
          });
        },
        {
          maxRetries: retryOptions.maxRetries ?? 1,
          baseMs: retryOptions.baseMs ?? 350,
        }
      );
    } catch (err: unknown) {
      lastErr = err;
      if (!isQuotaExhaustedError(err)) {
        allQuotaExhausted = false;
      }
      console.warn(`[GeminiFallback] Model "${model}" failed:`, (err as Error)?.message || err);
    }
  }

  if (allQuotaExhausted && lastErr) {
    throw new QuotaExhaustedError();
  }
  throw lastErr || new Error('GEMINI_CALL_FAILED');
}

/**
 * Translates an Arabic e-commerce product name into accurate Amazon US English search queries.
 */
export async function translateArabicToAmazonQueries(
  arabicText: string,
  signal?: AbortSignal
): Promise<{ primaryQuery: string; secondaryQuery?: string } | null> {
  if (!isGeminiConfigured() || !arabicText || !arabicText.trim()) return null;
  try {
    const response = await generateContentWithModelFallback(
      (model) => ({
        model,
        contents: `Translate this product name into 2 concise, high-volume Amazon US English search queries (3 to 5 words each).
Product name: "${arabicText.trim()}"
Return JSON with primaryQuery and secondaryQuery.`,
        config: {
          abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4500)]) : undefined,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              primaryQuery: { type: Type.STRING },
              secondaryQuery: { type: Type.STRING },
            },
            required: ['primaryQuery'],
          },
        },
      }),
      { maxRetries: 0, baseMs: 200, timeoutMs: 4500 }
    );
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const p = String(parsed.primaryQuery || '').replace(/["'`]+/g, '').trim();
    const s = String(parsed.secondaryQuery || '').replace(/["'`]+/g, '').trim();
    if (p && /[a-zA-Z]{2,}/.test(p) && !/[\u0600-\u06FF]/.test(p)) {
      return {
        primaryQuery: p,
        secondaryQuery: s && s.toLowerCase() !== p.toLowerCase() && !/[\u0600-\u06FF]/.test(s) ? s : undefined,
      };
    }
    return null;
  } catch (err: unknown) {
    console.warn('[GeminiTranslate] Translation failed:', (err as Error)?.message || err);
    return null;
  }
}

export async function translateArabicToAmazonQuery(
  arabicText: string,
  signal?: AbortSignal
): Promise<string | null> {
  const res = await translateArabicToAmazonQueries(arabicText, signal);
  return res?.primaryQuery || null;
}

/**
 * Generates alternative commercial Amazon US product names when the initial chosen product name
 * fails to find matching products on Amazon. Ordered from specific commercial names to broader category names.
 */
export async function generateAlternativeAmazonQueries(params: {
  failedName: string;
  alreadyTried: string[];
  categoryHint?: string;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!isGeminiConfigured()) return [];
  const failedName = (params.failedName || '').trim();
  if (!failedName && !params.referenceImageBase64) return [];

  const triedLower = new Set(params.alreadyTried.map((q) => q.trim().toLowerCase()).filter(Boolean));
  if (failedName) triedLower.add(failedName.toLowerCase());

  try {
    const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];
    if (params.referenceImageBase64 && params.referenceImageBase64.length > 50) {
      parts.push({
        inlineData: {
          data: params.referenceImageBase64.replace(/^data:[^;]+;base64,/, ''),
          mimeType: params.referenceImageMimeType || 'image/jpeg',
        },
      });
    }
    parts.push({
      text: `You are an Amazon US search recovery specialist.
The user searched Amazon US for the product name: "${failedName}" (Category hint: "${params.categoryHint || 'General'}").
Already tried queries that returned 0 matching products on Amazon: ${JSON.stringify(params.alreadyTried)}.

Generate 5 DIFFERENT, high-volume commercial English product names used by best-selling listings on Amazon US for this exact product.
Rules:
1. Order them from specific (3-4 words) to broader common Amazon category names (2-3 words).
2. Remove obscure brand names, model numbers, or overly narrow measurements that cause 0 results.
3. Use standard Amazon US buyer keywords (synonyms, common commercial titles).
4. Do NOT repeat any query in the already-tried list.
Return JSON with an array "alternativeQueries" of strings.`,
    });

    const response = await generateContentWithModelFallback(
      (model) => ({
        model,
        contents: { parts },
        config: {
          abortSignal: params.signal
            ? AbortSignal.any([params.signal, AbortSignal.timeout(5000)])
            : undefined,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              alternativeQueries: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['alternativeQueries'],
          },
        },
      }),
      { maxRetries: 0, baseMs: 200, timeoutMs: 5000 }
    );

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const rawList = Array.isArray(parsed.alternativeQueries) ? parsed.alternativeQueries : [];
    const results: string[] = [];
    for (const item of rawList) {
      const clean = String(item || '')
        .replace(/["'`]+/g, '')
        .replace(/[\u0600-\u06FF]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean && clean.length >= 3 && /[a-zA-Z]{2,}/.test(clean)) {
        const lower = clean.toLowerCase();
        if (!triedLower.has(lower) && !results.some((r) => r.toLowerCase() === lower)) {
          results.push(clean);
        }
      }
    }
    return results.slice(0, 5);
  } catch (err: unknown) {
    console.warn('[GeminiAltQueries] Alternative query generation failed:', (err as Error)?.message || err);
    return [];
  }
}

/**
 * Server-side Gemini Vision layer to inspect an uploaded product image and identify its
 * exact Identity Card v2 (formFactor, mechanism, mustMatch, variableAttributes, mustNotBe, queries, hashtags).
 */
export async function analyzeProductImage(
  base64Data: string,
  mimeType: string,
  userNotes?: string,
  productListingUrl?: string,
  explicitProductName?: string
): Promise<VisualAttribute> {
  const { resolveIdentityCardV2, identityCardToVisualAttribute } = await import(
    './pipeline/identity.ts'
  );
  const card = await resolveIdentityCardV2({
    base64Data,
    mimeType,
    userNotes,
    productListingUrl,
    explicitProductName,
  });
  return identityCardToVisualAttribute(card);
}

export interface ProductMatchVerdict {
  asin: string;
  approved: boolean;
  matchCategory: MatchCategory;
  matchScore: number;
  userFacingLabelAr: string;
  reasonAr: string;
}

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
    parts.push({
      text: 'REFERENCE PRODUCT IMAGE (THE TARGET PRODUCT WE MUST MATCH):',
    });
    parts.push({
      inlineData: {
        data: referenceBase64.replace(/^data:[^;]+;base64,/, ''),
        mimeType: referenceMimeType || 'image/jpeg',
      },
    });
  }

  parts.push({
    text: `You are a strict visual product verification filter for Amazon US.
Target Product: "${profile?.suggestedNameEn || productName}" (Category: ${profile?.category || 'General'}).
Required Geometry/Structure: "${profile?.distinctiveGeometry || ''}" | Must-Match Attributes: ${JSON.stringify(profile?.mustMatchAttributes || [])}.

STRICT RULES:
1. Compare each candidate's image and title against the REFERENCE PRODUCT IMAGE.
2. Approve (approved=true, matchScore>=75) ONLY candidates that are the SAME physical product type, same mechanical form-factor, and same structural design as the reference image (brand or minor accessory count differences are allowed).
3. REJECT (approved=false, matchCategory="mismatched", matchScore<=30) any candidate that:
   - Has a different mechanical form-factor or different sub-type:
     * If the reference is an interchangeable/modular head plier set, REJECT any single fixed plier, locking plier, vise grip, water pump plier, or crimper that does not have interchangeable heads!
     * If the reference is a dual cylinder air compressor, REJECT single-cylinder or handheld cordless pumps!
     * If the reference is a power drill, REJECT nail drills, manicure tools, or rotary pen tools!
   - Is only an accessory, bit set, replacement part, or carrying case without the main machine.`,
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
    const response = await generateContentWithModelFallback(
      (model) => ({
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
                      enum: ['exact_design', 'permitted_variation', 'mismatched'],
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
      }),
      { maxRetries: 0, baseMs: 150, timeoutMs: 6500 }
    );

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const map = new Map<string, ProductMatchVerdict>();

    for (const d of decisions) {
      const asin = String(d.asin || '').toUpperCase();
      if (!asin) continue;
      const rawScore = typeof d.matchScore === 'number' ? d.matchScore : d.approved ? 90 : 20;
      const score = rawScore <= 10 ? rawScore * 10 : rawScore;
      const isApproved = Boolean(d.approved) && score >= 70;
      const category: MatchCategory = isApproved
        ? d.matchCategory === 'permitted_variation'
          ? 'permitted_variation'
          : 'exact_design'
        : 'mismatched';

      map.set(asin, {
        asin,
        approved: isApproved,
        matchCategory: category,
        matchScore: score,
        userFacingLabelAr: isApproved ? 'مطابق بصرياً للمنتج المرفوع' : 'منتج مختلف بصرياً',
        reasonAr: String(d.reasonAr || (isApproved ? 'تطابق بصري مع المنتج المطلوب' : 'تصميم مختلف عن الصورة المرفوعة')),
      });
    }

    return map;
  } catch (err: unknown) {
    console.warn('[GeminiBatchVerify] Visual verification failed:', (err as Error)?.message || err);
    if (isQuotaExhaustedError(err) && onQuotaExhausted) {
      onQuotaExhausted();
    }
    return null;
  }
}

export async function discoverProductWebSources(
  profile: VisualAttribute,
  _settings: SearchSettings,
  onQuotaExhausted?: () => void
): Promise<Array<{ url: string; title: string; snippet?: string }>> {
  if (!isGeminiConfigured()) {
    return [];
  }

  const primaryName = profile.suggestedNameEn || profile.suggestedNameAr;
  const query = `${primaryName} customer review video amazon`;
  const results: Array<{ url: string; title: string; snippet?: string }> = [];
  const seenUrls = new Set<string>();

  try {
    const response = await generateContentWithModelFallback((model) => ({
      model,
      contents: `Find real Amazon product listings and customer review pages for: "${query}".`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    }));

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks && Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (chunk.web?.uri && !seenUrls.has(chunk.web.uri)) {
          seenUrls.add(chunk.web.uri);
          results.push({
            url: chunk.web.uri,
            title: chunk.web.title || primaryName,
            snippet: response.text?.slice(0, 200),
          });
        }
      }
    }
  } catch (err: unknown) {
    console.warn('[SearchGrounding] Failed:', (err as Error)?.message || err);
    if (isQuotaExhaustedError(err) && onQuotaExhausted) {
      onQuotaExhausted();
    }
  }

  return results;
}

export async function verifyVideosPositiveAndExactMatch(
  _referenceBase64?: string,
  _referenceMimeType?: string,
  _productName?: string,
  _profile?: VisualAttribute,
  _videos?: Array<{ index: number; title: string; reviewer: string; thumbBase64?: string; thumbMimeType?: string }>,
  _onQuotaExhausted?: () => void
): Promise<Map<number, { index: number; approved: boolean; sentiment: 'positive'; matchScore: number; reasonAr: string }> | null> {
  return null;
}

const creativeBriefCache = new Map<string, { analysis: CreativeHookAnalysis; expiresAt: number }>();

/**
 * Generates an actionable Creative Hook Bank, Marketing Angle, Offer/CTA, and UGC Video Script Brief
 * using Gemini (inspired by ad-scout + swipefile). Falls back deterministically if quota is exhausted.
 */
export async function generateCreativeHookAnalysis(params: {
  productName: string;
  assetTitle?: string;
  platform?: string;
  reviewerOrChannel?: string;
  sampleTitles?: string[];
}): Promise<CreativeHookAnalysis> {
  const productName = (params.productName || params.assetTitle || 'المنتج').trim();
  const assetTitle = (params.assetTitle || productName).trim();
  const platform = params.platform || 'amazon';
  const cacheKey = `${productName.toLowerCase()}::${assetTitle.toLowerCase()}::${platform}`;

  const cached = creativeBriefCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.analysis;
  }

  if (!isGeminiConfigured()) {
    return buildFallbackCreativeAnalysis(productName, assetTitle, platform);
  }

  try {
    const sampleContext =
      Array.isArray(params.sampleTitles) && params.sampleTitles.length > 0
        ? `Real discovered customer/creator video titles:\n- ${params.sampleTitles.slice(0, 6).join('\n- ')}`
        : `Video title / review context: "${assetTitle}" by ${params.reviewerOrChannel || 'customer'}`;

    const response = await generateContentWithModelFallback(
      (model) => ({
        model,
        contents: `You are a senior direct-response performance marketer and UGC creative strategist for Arabic & US e-commerce.
Analyze this product and customer video context to create a high-converting Hook Bank, Marketing Angle, Offer/CTA, and 25-second UGC video script brief.

Product: "${productName}"
Platform: "${platform}"
${sampleContext}

Return JSON with:
- hooksAr: 4 scroll-stopping Arabic video hooks (natural Egyptian/Gulf performance marketing tone, first 3 seconds)
- hooksEn: 3 scroll-stopping English video hooks (direct-response TikTok/Reels style)
- marketingAngleAr: The primary winning marketing angle in Arabic
- marketingAngleEn: The primary winning marketing angle in English
- offerCtaAr: High-converting Arabic Offer + Call To Action
- scriptBriefAr: A structured 4-step Arabic video script brief ([00:00-00:03] Hook, [00:03-00:10] Problem/Demo, [00:10-00:18] Proof, [00:18-00:25] CTA)
- whyItWorksAr: Concise Arabic explanation of why this creative angle converts.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hooksAr: { type: Type.ARRAY, items: { type: Type.STRING } },
              hooksEn: { type: Type.ARRAY, items: { type: Type.STRING } },
              marketingAngleAr: { type: Type.STRING },
              marketingAngleEn: { type: Type.STRING },
              offerCtaAr: { type: Type.STRING },
              scriptBriefAr: { type: Type.STRING },
              whyItWorksAr: { type: Type.STRING },
            },
            required: [
              'hooksAr',
              'hooksEn',
              'marketingAngleAr',
              'marketingAngleEn',
              'offerCtaAr',
              'scriptBriefAr',
              'whyItWorksAr',
            ],
          },
        },
      }),
      { maxRetries: 1, baseMs: 300, timeoutMs: 7000 }
    );

    const parsed = JSON.parse(response.text?.trim() || '{}');
    const fallback = buildFallbackCreativeAnalysis(productName, assetTitle, platform);

    const analysis: CreativeHookAnalysis = {
      hooksAr:
        Array.isArray(parsed.hooksAr) && parsed.hooksAr.length > 0
          ? parsed.hooksAr.map(String)
          : fallback.hooksAr,
      hooksEn:
        Array.isArray(parsed.hooksEn) && parsed.hooksEn.length > 0
          ? parsed.hooksEn.map(String)
          : fallback.hooksEn,
      marketingAngleAr: String(parsed.marketingAngleAr || fallback.marketingAngleAr),
      marketingAngleEn: String(parsed.marketingAngleEn || fallback.marketingAngleEn),
      offerCtaAr: String(parsed.offerCtaAr || fallback.offerCtaAr),
      scriptBriefAr: String(parsed.scriptBriefAr || fallback.scriptBriefAr),
      whyItWorksAr: String(parsed.whyItWorksAr || fallback.whyItWorksAr),
      generatedAt: new Date().toISOString(),
    };

    creativeBriefCache.set(cacheKey, {
      analysis,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    return analysis;
  } catch (err) {
    console.warn('[GeminiCreativeBrief] Falling back to deterministic brief:', (err as Error)?.message || err);
    return buildFallbackCreativeAnalysis(productName, assetTitle, platform);
  }
}

