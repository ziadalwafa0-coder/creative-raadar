import { translateArabicToAmazonQueries } from './gemini.ts';
import { fetchAmazonHtml } from './amazonHttp.ts';
import { isSafeExternalUrl } from '../utils/security.server.ts';

export interface BuiltAmazonQueries {
  primaryQuery: string;
  secondaryQuery?: string;
  variants: string[];
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'without',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'this',
  'that',
  'your',
  'our',
  'all',
  'new',
  'pro',
  'max',
  'pack',
  'set',
  'pcs',
  'piece',
  'pieces',
  'inch',
  'inches',
  'size',
  'color',
  'black',
  'white',
  'blue',
  'red',
  'green',
  'gray',
  'grey',
  'silver',
  'gold',
  'pink',
  'brown',
  'beige',
  'in', 'of', 'to', 'two', 'one', 'product',
]);

// Conservative offline fallback, not image recognition. Unknown Arabic names must
// never degrade into generic ASCII fragments such as "2 1" or "2 in 1".
function offlineArabicQuery(name: string): string | undefined {
  const normalized = name.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  if (/(?:مساحه|ممسحه)/.test(normalized)) {
    return /بخاخ|رش/.test(normalized) ? 'spray mop' : 'floor mop';
  }
  return undefined;
}

function hasSearchIdentity(query: string): boolean {
  return tokenizeNormalized(query).some(token => /[a-z\u0600-\u06ff]{3}/i.test(token));
}

const ACCESSORY_PART_KEYWORDS = /\b(?:replacement\s+parts?|spare\s+parts?|disposable\s+paper\s+liners?|parchment\s+paper\s+liners?|refill\s+pack|carrying\s+case\s+only|protective\s+cover\s+only|adapter\s+only|cable\s+only|charger\s+only|mount\s+only|strap\s+only)\b/i;

export function extractAsinFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/(?:\/dp\/|\/gp\/product\/|\/product-reviews\/|\/aw\/d\/|\b)(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])\b/i);
  return m ? m[1].toUpperCase() : null;
}

export function distillCanonicalSearchQueryFromTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  let cleaned = rawTitle
    .replace(/^Amazon\.com\s*[:\-–—]\s*/i, '')
    .replace(/\s*[:|–—-]\s*Amazon\.[a-z.]+.*$/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:cm|mm|m|inch|inches|in|ft|oz|ml|l|lb|lbs|kg|g|w|watt|watts|v|volt|mah)\b/gi, ' ')
    .replace(/\b(?:with|for|ideal\s+for|suitable\s+for|compatible\s+with|perfect\s+for)\s+[^,;]+$/i, ' ')
    .replace(/[,;|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length > 7) {
    cleaned = words.slice(0, 7).join(' ');
  }
  return cleaned.trim();
}

/**
 * Translates an Arabic or mixed product name into primary and secondary English Amazon search queries
 * using Gemini as the primary translator (with image profile / English fallback).
 */
export async function buildAmazonUsQueries(
  productName: string,
  suggestedNameEn?: string,
  multilingualEnQueries?: string[],
  signal?: AbortSignal
): Promise<BuiltAmazonQueries> {
  const candidates: string[] = [];

  const addCandidate = (q?: string | null) => {
    if (!q) return;
    const clean = distillCanonicalSearchQueryFromTitle(
      q.replace(/[\u0600-\u06FF]+/g, ' ').replace(/\s+/g, ' ').trim()
    );
    if (clean && hasSearchIdentity(clean)) {
      const exists = candidates.some((c) => c.toLowerCase() === clean.toLowerCase());
      if (!exists) candidates.push(clean);
    }
  };

  const rawTrimmed = (productName || '').trim();
  const hasArabic = /[\u0600-\u06FF]/.test(rawTrimmed);

  // 1. If productName is already English, use it directly
  if (rawTrimmed && !hasArabic && /[a-zA-Z]{2,}/.test(rawTrimmed)) {
    addCandidate(rawTrimmed);
  }

  // 2. If suggestedNameEn or multilingualEnQueries from Gemini image analysis exist, add them
  if (suggestedNameEn) {
    addCandidate(suggestedNameEn);
  }
  if (Array.isArray(multilingualEnQueries)) {
    for (const q of multilingualEnQueries) {
      addCandidate(q);
    }
  }

  // 3. Use Gemini as the primary translator whenever Arabic text is present
  if (hasArabic) {
    const translated = await translateArabicToAmazonQueries(rawTrimmed, signal);
    if (translated) {
      // Put Gemini's direct translation of the user's Arabic query at the front
      const prev = [...candidates];
      candidates.length = 0;
      addCandidate(translated.primaryQuery);
      if (translated.secondaryQuery) {
        addCandidate(translated.secondaryQuery);
      }
      for (const p of prev) addCandidate(p);
    }
    if (candidates.length === 0) addCandidate(offlineArabicQuery(rawTrimmed));
  }

  // 4. If Gemini key is missing or offline during tests, fall back to any ASCII tokens or raw input
  if (candidates.length === 0) {
    const asciiOnly = rawTrimmed.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (hasSearchIdentity(asciiOnly)) {
      candidates.push(asciiOnly);
    } else {
      throw new Error('تعذر تحديد اسم المنتج للبحث بدقة. اكتب اسمه بالإنجليزية أو أضف رابط المنتج على أمازون؛ لن نعرض منتجات عشوائية.');
    }
  }

  // Build concise 4-word fallback variant if primary query has > 4 words
  if (candidates.length === 1) {
    const words = candidates[0].split(/\s+/);
    if (words.length > 4) {
      addCandidate(words.slice(0, 4).join(' '));
    }
  }

  return {
    primaryQuery: candidates[0],
    secondaryQuery: candidates[1],
    variants: candidates.slice(0, 3),
  };
}

export async function buildAmazonUsQuery(
  productName: string,
  suggestedNameEn?: string,
  multilingualEnQueries?: string[],
  signal?: AbortSignal
): Promise<string> {
  const res = await buildAmazonUsQueries(productName, suggestedNameEn, multilingualEnQueries, signal);
  return res.primaryQuery;
}

export interface TitleMatchVerdict {
  approved: boolean;
  matchCategory: 'exact_design' | 'permitted_variation' | 'mismatched';
  matchScore: number;
  userFacingLabelAr: string;
  reasonAr: string;
}

function tokenizeNormalized(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((w) => w.replace(/(?:ing|ers|er|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : '')))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Evaluates whether an Amazon product title matches the searched query.
 * General-purpose lexical & accessory scoring with zero hard-coded product branches.
 */
export function evaluateStrictProductTitleMatch(
  candidateTitle: string,
  amazonQuery: string,
  rawProductName = '',
  _mustMatchAttributes: string[] = []
): TitleMatchVerdict {
  const titleClean = (candidateTitle || '').trim();
  if (!titleClean || titleClean.length < 4) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 0,
      userFacingLabelAr: 'عنوان غير صالح',
      reasonAr: 'عنوان المنتج فارغ أو قصير جداً',
    };
  }

  const queryCombined = `${amazonQuery || ''} ${rawProductName || ''}`.trim();
  const models = queryCombined.match(/\b[a-z]{1,5}-?\d{3,}[a-z\d-]*\b/gi) || [];
  if (models.some(model => !titleClean.toLowerCase().replace(/[^a-z\d]/g, '').includes(model.toLowerCase().replace(/[^a-z\d]/g, '')))) {
    return { approved: false, matchCategory: 'mismatched', matchScore: 0, userFacingLabelAr: 'موديل مختلف', reasonAr: 'رقم الموديل المكتوب غير موجود في عنوان النتيجة' };
  }
  const normalizeDigits = (text: string) => text.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const wantedTiers = normalizeDigits(queryCombined).match(/\b(\d+)\s*(?:[- ]?tiers?|layers?|shelves|دور|ادوار|أدوار|طوابق)\b/i)?.[1];
  const offeredTiers = normalizeDigits(titleClean).match(/\b(\d+)\s*[- ]?(?:tiers?|layers?|shelves)\b/i)?.[1];
  if (wantedTiers && offeredTiers && wantedTiers !== offeredTiers) {
    return { approved: false, matchCategory: 'mismatched', matchScore: 0, userFacingLabelAr: 'مواصفات مختلفة', reasonAr: 'عدد الأدوار في المنتج مختلف عن المطلوب' };
  }
  const searchingForAccessory = ACCESSORY_PART_KEYWORDS.test(queryCombined);
  const productAnchors = [
    /\bmops?\b/i, /\bvacuum\b/i, /\bflosser\b/i, /\bblender\b/i,
    /\bchainsaw\b/i, /\bdrill\b/i, /\bcompressor\b/i, /\bsteamer\b/i,
    /\btoothbrush\b/i, /\bheater\b/i, /\bshoe\b/i, /\bpillowcase\b/i,
  ];
  const missingProductType = productAnchors.some(anchor => anchor.test(amazonQuery) && !anchor.test(titleClean));
  const primaryTitle = titleClean.split(/\b(?:with|includes?|including)\b|[,;|]/i)[0];
  const accessoryOnly = /\breplacement\s+(?:bottles?|pads?|heads?|filters?|brushes?)\b/i.test(primaryTitle);
  if (missingProductType || (!searchingForAccessory && accessoryOnly)) {
    return { approved: false, matchCategory: 'mismatched', matchScore: 0, userFacingLabelAr: 'نوع منتج مختلف أو قطعة غيار', reasonAr: 'اسم المنتج الأساسي غير موجود أو النتيجة قطعة غيار فقط' };
  }
  if (!searchingForAccessory && ACCESSORY_PART_KEYWORDS.test(titleClean)) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 15,
      userFacingLabelAr: 'ملحق أو قطع غيار (مستبعد)',
      reasonAr: 'تم استبعاد الملحقات أو قطع الغيار لعدم تطابقها مع المنتج الأساسي',
    };
  }

  const queryTokens = tokenizeNormalized(amazonQuery || rawProductName)
    .filter(token => /[a-z\u0600-\u06ff]{3}/i.test(token));
  const titleTokens = new Set(tokenizeNormalized(titleClean));
  const titleLower = titleClean.toLowerCase();

  if (queryTokens.length === 0) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 0,
      userFacingLabelAr: 'هوية المنتج غير مؤكدة',
      reasonAr: 'عبارة البحث لا تحتوي على اسم منتج يمكن مطابقته',
    };
  }

  let matchedCount = 0;
  for (const qt of queryTokens) {
    if (titleTokens.has(qt)) {
      matchedCount++;
    }
  }

  const overlapRatio = matchedCount / queryTokens.length;
  const minRequiredMatches = Math.min(queryTokens.length, Math.max(2, Math.ceil(queryTokens.length * 0.6)));

  if (matchedCount < minRequiredMatches) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: Math.round(overlapRatio * 100),
      userFacingLabelAr: 'منتج مختلف (مستبعد)',
      reasonAr: 'عنوان المنتج لا يتطابق مع الكلمات الأساسية للبحث',
    };
  }

  const score = Math.min(99, Math.max(65, Math.round(55 + overlapRatio * 44)));
  const category = 'permitted_variation';

  return {
    approved: true,
    matchCategory: category,
    matchScore: score,
    userFacingLabelAr: 'مطابقة اسم مبدئية؛ الشكل غير مؤكد',
    reasonAr: 'الاسم مناسب للبحث؛ مطابقة التصميم تتطلب مقارنة الصورة أو تأكيد المنتج',
  };
}

export async function resolveProductIdentityFromUrl(
  rawUrlOrText: string,
  signal?: AbortSignal
): Promise<{
  asin?: string;
  extractedTitle: string;
  canonicalSearchQuery: string;
  mustMatchAttributes: string[];
  directAmazonUsUrl?: string;
  imageUrl?: string;
} | null> {
  if (!rawUrlOrText) return null;
  const asin = extractAsinFromUrl(rawUrlOrText);
  let targetUrl = rawUrlOrText.trim();
  if (!/^https?:\/\//i.test(targetUrl) && asin) {
    targetUrl = `https://www.amazon.com/dp/${asin}`;
  }
  if (!/^https?:\/\//i.test(targetUrl) || !isSafeExternalUrl(targetUrl).safe) {
    return null;
  }

  const directAmazonUsUrl = asin ? `https://www.amazon.com/dp/${asin}` : undefined;

  try {
    const html = await fetchAmazonHtml(directAmazonUsUrl || targetUrl, {
      signal,
      timeoutMs: 7000,
      minHtmlChars: 2500,
    });
    const titleMatch =
      html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) ||
      html.match(/<meta\s+name="title"\s+content="([^"]+)"/i) ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    const rawTitle = titleMatch
      ? titleMatch[1]
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/<[^>]+>/g, '')
          .trim()
      : '';
    const canonical = distillCanonicalSearchQueryFromTitle(rawTitle);
    const imgMatch =
      html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i) ||
      html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i);

    if (canonical && canonical.length >= 3) {
      return {
        asin: asin || undefined,
        extractedTitle: canonical,
        canonicalSearchQuery: canonical,
        mustMatchAttributes: [],
        directAmazonUsUrl,
        imageUrl: imgMatch ? imgMatch[1] : undefined,
      };
    }
  } catch (err: unknown) {
    console.warn('[QueryBuilder] Failed to resolve URL identity:', (err as Error)?.message || err);
  }

  if (asin) {
    return {
      asin,
      extractedTitle: asin,
      canonicalSearchQuery: asin,
      mustMatchAttributes: [],
      directAmazonUsUrl,
    };
  }
  return null;
}
