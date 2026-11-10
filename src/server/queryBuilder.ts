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
]);

const ACCESSORY_PART_KEYWORDS = /\b(?:replacement\s+parts?|spare\s+parts?|disposable\s+paper\s+liners?|parchment\s+paper\s+liners?|refill\s+pack|carrying\s+case\s+only|protective\s+cover\s+only|adapter\s+only|cable\s+only|charger\s+only|mount\s+only|strap\s+only|drill\s+bit\s+sets?|screwdriver\s+bit\s+sets?|impact\s+(?:driver\s+)?bit\s+sets?|titanium\s+(?:nitride\s+)?(?:coated\s+)?(?:pilot\s+point\s+)?(?:drill\s+)?bit\s+sets?|masonry\s+drill\s+bits?|step\s+drill\s+bits?|router\s+bits?|saw\s+blades?|sanding\s+discs?|scrubber\s+brush|brush\s+attachments?|holster\s+only|tool\s+bag\s+only|battery\s+only|replacement\s+battery)\b/i;

const BEAUTY_NAIL_DRILL_KEYWORDS = /\b(?:nail\s+drill|acrylic\s+nails?|gel\s+nails?|manicure|pedicure|cuticle|e-file|nail\s+file|foot\s+callus)\b/i;

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
    .replace(/\b\d+(?:\.\d+)?\s*(?:cm|mm|m|inch|inches|in|ft|oz|ml|l|lb|lbs|kg|g|w|watt|watts|mah)\b/gi, ' ')
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

const ARABIC_COMMERCIAL_FALLBACKS: Array<{ pattern: RegExp; queries: string[] }> = [
  {
    pattern: /(?:كمبروسر|كومبروسر|منفاخ|اطارات|إطارات|كاوتش|كفرات|بستم)/i,
    queries: [
      'Dual Cylinder Heavy Duty 12V Portable Air Compressor Tire Inflator',
      '12V Portable Air Compressor Tire Inflator',
      'Car Tire Inflator Air Compressor Pump',
    ],
  },
  {
    pattern: /(?:دريل|شنيور|مثقاب|مفك كهربائي)/i,
    queries: ['20V Cordless Drill Set', 'Cordless Power Drill Driver'],
  },
  {
    pattern: /(?:فرشاة تنظيف|فرشاه تنظيف|سكرابر)/i,
    queries: ['Electric Spin Scrubber Cordless Cleaning Brush', 'Cordless Electric Spin Scrubber'],
  },
  {
    pattern: /(?:قلاية|قلايه هوائيه|اير فراير)/i,
    queries: ['Digital Air Fryer Oven', 'Compact Air Fryer'],
  },
  {
    pattern: /(?:مكنسة|مكنسه|شفاط)/i,
    queries: ['Cordless Handheld Vacuum Cleaner', 'Portable Car Vacuum Cleaner'],
  },
  {
    pattern: /(?:كشاف|مصباح|اضاءة|إضاءة)/i,
    queries: ['Rechargeable LED Flashlight High Lumens', 'Portable LED Work Light'],
  },
];

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
    if (clean && clean.length >= 3) {
      const exists = candidates.some((c) => c.toLowerCase() === clean.toLowerCase());
      if (!exists) candidates.push(clean);
    }
  };

  const rawTrimmed = (productName || '').trim();
  const hasArabic = /[\u0600-\u06FF]/.test(rawTrimmed);
  const hasVisualCommercialName = Boolean(
    (suggestedNameEn && suggestedNameEn.trim().length >= 3) ||
      (Array.isArray(multilingualEnQueries) && multilingualEnQueries.length > 0)
  );

  // 1. If Gemini Vision identified the commercial English name from the product image, put it FIRST
  if (suggestedNameEn) {
    addCandidate(suggestedNameEn);
  }
  if (Array.isArray(multilingualEnQueries)) {
    for (const q of multilingualEnQueries) {
      addCandidate(q);
    }
  }

  // 2. If productName is already English, add it
  if (rawTrimmed && !hasArabic && /[a-zA-Z]{2,}/.test(rawTrimmed)) {
    addCandidate(rawTrimmed);
  }

  // 3. Use Gemini text translation when Arabic text is present
  if (hasArabic) {
    const translated = await translateArabicToAmazonQueries(rawTrimmed, signal);
    if (translated) {
      if (hasVisualCommercialName) {
        addCandidate(translated.primaryQuery);
        if (translated.secondaryQuery) {
          addCandidate(translated.secondaryQuery);
        }
      } else {
        const prev = [...candidates];
        candidates.length = 0;
        addCandidate(translated.primaryQuery);
        if (translated.secondaryQuery) {
          addCandidate(translated.secondaryQuery);
        }
        for (const p of prev) addCandidate(p);
      }
    } else {
      for (const entry of ARABIC_COMMERCIAL_FALLBACKS) {
        if (entry.pattern.test(rawTrimmed)) {
          for (const q of entry.queries) addCandidate(q);
          break;
        }
      }
    }
  }

  // 4. Fallback if Gemini key is missing or offline during tests
  if (candidates.length === 0) {
    const asciiOnly = rawTrimmed.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (asciiOnly.length >= 3) {
      candidates.push(asciiOnly);
    } else if (rawTrimmed) {
      candidates.push(rawTrimmed);
    } else {
      candidates.push('product');
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
    variants: candidates.slice(0, 4),
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

const MODIFIER_ONLY_WORDS = new Set([
  'ultramax',
  'super',
  'deluxe',
  'upgraded',
  'version',
  'generation',
  'gen',
  'original',
  'authentic',
  'genuine',
  'premium',
  'professional',
  'ultimate',
  'advanced',
  'extreme',
  'series',
  'model',
  'edition',
  'official',
  'brand',
  'new',
  'best',
  'top',
  'rated',
  'quality',
  'luxury',
  'multifunctional',
  'multi',
  'purpose',
  'all-in-one',
  'smart',
  'digital',
  'automatic',
  'auto',
  'fast',
  'quick',
  'high',
  'low',
  'power',
  'powerful',
  'heavy',
  'duty',
  'portable',
  'cordless',
  'wireless',
  'rechargeable',
  'electric',
  'electronic',
  'battery',
  'operated',
  'powered',
  'handheld',
  'compact',
  'mini',
  'small',
  'large',
  'big',
  'extra',
  'double',
  'dual',
  'single',
  'triple',
  'twin',
  'metal',
  'steel',
  'stainless',
  'aluminum',
  'alloy',
  'iron',
  'brass',
  'copper',
  'plastic',
  'rubber',
  'silicone',
  'wood',
  'wooden',
  'glass',
  'ceramic',
  'leather',
  'fabric',
  'handle',
  'grip',
  'ergonomic',
  'non-slip',
  'nonslip',
  'adjustable',
  'foldable',
  'folding',
  'collapsible',
  'extendable',
  'telescopic',
  'magnetic',
  'waterproof',
  'weatherproof',
  'dustproof',
  'shockproof',
  'quiet',
  'silent',
  'noiseless',
  'car',
  'auto',
  'automotive',
  'vehicle',
  'truck',
  'suv',
  'rv',
  'home',
  'house',
  'household',
  'kitchen',
  'bathroom',
  'bedroom',
  'office',
  'garden',
  'yard',
  'outdoor',
  'indoor',
  'camping',
  'travel',
  'emergency',
  'universal',
  'standard',
  'industrial',
  'commercial',
  'kit',
  'set',
  'pack',
  'bundle',
  'combo',
  'system',
  'unit',
  'device',
  'tool',
  'tools',
  'equipment',
  'machine',
  'appliance',
  'accessory',
  'accessories',
  'attachment',
  'attachments',
  'adapter',
  'charger',
  'cable',
  'cord',
  'hose',
  'bag',
  'case',
  'box',
  'storage',
  'carry',
  'carrying',
  'led',
  'light',
  'usb',
  'type-c',
  'psi',
  'volt',
  'volts',
  'watt',
  'watts',
  'amp',
  'amps',
]);

const PRODUCT_SYNONYM_FALLBACKS: Array<{ pattern: RegExp; alternatives: string[] }> = [
  {
    pattern: /\b(?:air\s+compressor|tire\s+inflator|tyre\s+inflator|air\s+pump|car\s+pump|كمبروسر|منفاخ)\b/i,
    alternatives: [
      'Portable Air Compressor Tire Inflator 12V',
      'Heavy Duty Car Tire Inflator Air Compressor',
      'Dual Cylinder Air Compressor Tire Inflator',
      '12V Car Air Pump Tire Inflator',
      'Portable Tire Inflator Air Compressor',
    ],
  },
  {
    pattern: /\b(?:cordless\s+drill|power\s+drill|electric\s+drill|impact\s+drill|driver\s+drill|دريل|شنيور|مثقاب)\b/i,
    alternatives: [
      '20V Cordless Drill Set with Battery',
      'Cordless Power Drill Driver Kit',
      'Electric Cordless Drill Set',
      'Power Drill Set Home Improvement',
    ],
  },
  {
    pattern: /\b(?:spin\s+scrubber|cleaning\s+brush|shower\s+scrubber|فرشاة\s+تنظيف)\b/i,
    alternatives: [
      'Electric Spin Scrubber Cordless Cleaning Brush',
      'Bathroom Shower Spin Scrubber with Extension Handle',
      'Cordless Electric Cleaning Brush Scrubber',
    ],
  },
  {
    pattern: /\b(?:steam\s+cleaner|steamer\s+for\s+cleaning|منظف\s+بخار)\b/i,
    alternatives: [
      'Handheld Pressurized Steam Cleaner Multi-Surface',
      'Portable Steam Cleaner for Home Use',
      'Multi Purpose Handheld Steam Cleaner',
    ],
  },
  {
    pattern: /\b(?:dash\s*cam|car\s+camera|داش\s+كام|كاميرا\s+سيارة)\b/i,
    alternatives: [
      'Dash Cam Front and Rear Car Camera',
      '1080P Dash Camera for Cars',
      '4K Dash Cam Built-in WiFi GPS',
    ],
  },
  {
    pattern: /\b(?:vacuum\s+cleaner|car\s+vacuum|handheld\s+vacuum|مكنسة)\b/i,
    alternatives: [
      'Portable Cordless Car Vacuum Cleaner High Power',
      'Handheld Vacuum Cordless Rechargeable',
      'Mini Car Vacuum Cleaner Portable',
    ],
  },
];

function extractHeadNounTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !MODIFIER_ONLY_WORDS.has(t.toLowerCase()));
}

/**
 * Generates an ordered list of progressively broader, high-recall Amazon US product names
 * when the initial chosen product name returns 0 matching products on Amazon.
 * Strictly preserves the core product head nouns so generic modifiers are never searched alone.
 */
export function buildProgressiveFallbackQueries(
  failedName: string,
  alreadyTried: string[] = [],
  mustMatchAttributes: string[] = []
): string[] {
  const triedLower = new Set(
    alreadyTried.map((q) => distillCanonicalSearchQueryFromTitle(q).toLowerCase()).filter(Boolean)
  );
  const rawClean = distillCanonicalSearchQueryFromTitle(failedName || '');
  if (rawClean) {
    triedLower.add(rawClean.toLowerCase());
  }

  // Extract tokens ONLY from failedName (never append mustMatchAttributes to the end of failedName)
  const asciiSource = (failedName || '')
    .replace(/[\u0600-\u06FF]+/g, ' ')
    .replace(/\b(?:model|type|ver|v|no|item)\s*[:#-]?\s*[a-z0-9-]+\b/gi, ' ')
    .replace(/\b(?=[a-z]*\d)[a-z0-9-]{2,}\b/gi, ' ')
    .replace(/[^a-zA-Z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const allTokens = asciiSource
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));

  const headNouns = extractHeadNounTokens(allTokens);

  const results: string[] = [];
  const pushUnique = (candidate: string) => {
    const cleaned = distillCanonicalSearchQueryFromTitle(
      candidate
        .replace(/[\u0600-\u06FF]+/g, ' ')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    if (!cleaned || cleaned.length < 3) return;
    const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
    if (words.length < 2) return;

    // Every fallback query MUST contain at least one non-modifier product head noun!
    const candTokens = tokenizeNormalized(cleaned);
    const candHeadNouns = extractHeadNounTokens(candTokens);
    if (candHeadNouns.length === 0) return;

    const normalized = words.join(' ');
    const lower = normalized.toLowerCase();
    if (triedLower.has(lower)) return;
    if (results.some((r) => r.toLowerCase() === lower)) return;
    results.push(normalized);
  };

  // 1. Add known high-volume Amazon US synonym alternatives if the query matches a known product family
  const combinedInput = `${failedName || ''} ${alreadyTried.join(' ')} ${(mustMatchAttributes || []).join(' ')}`;
  for (const entry of PRODUCT_SYNONYM_FALLBACKS) {
    if (entry.pattern.test(combinedInput)) {
      for (const alt of entry.alternatives) {
        pushUnique(alt);
      }
    }
  }

  // 2. Progressive token combinations that always preserve headNouns
  if (headNouns.length >= 2) {
    pushUnique(headNouns.slice(-3).join(' '));
    pushUnique(headNouns.slice(-2).join(' '));
  }
  if (allTokens.length >= 3 && headNouns.length >= 1) {
    pushUnique(allTokens.slice(-3).join(' '));
    pushUnique([allTokens[0], ...headNouns.slice(-2)].join(' '));
  }
  if (allTokens.length >= 2 && headNouns.length >= 1) {
    pushUnique(allTokens.slice(-2).join(' '));
  }

  // 3. Combine mustMatchAttributes with the core head nouns (never alone!)
  if (Array.isArray(mustMatchAttributes) && mustMatchAttributes.length > 0 && headNouns.length >= 1) {
    const coreNounPhrase = headNouns.slice(-2).join(' ');
    for (const attr of mustMatchAttributes.slice(0, 2)) {
      const cleanAttr = (attr || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
      if (cleanAttr && !coreNounPhrase.toLowerCase().includes(cleanAttr.toLowerCase())) {
        pushUnique(`${cleanAttr} ${coreNounPhrase}`);
      }
    }
  }

  return results.slice(0, 6);
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
 * Evaluates whether an Amazon product title matches the searched query and optional visual form-factor attributes.
 * Strictly requires matching the core product head noun (rejects products that only share modifiers like "Heavy Duty" or "Grip").
 */
export function evaluateStrictProductTitleMatch(
  candidateTitle: string,
  amazonQuery: string,
  rawProductName = '',
  mustMatchAttributes: string[] = [],
  excludeKeywords: string[] = []
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
  const titleLower = titleClean.toLowerCase();

  // 1. Exclude standalone accessories / bit sets / replacement parts unless explicitly searched
  const searchingForAccessory = ACCESSORY_PART_KEYWORDS.test(queryCombined);
  if (!searchingForAccessory && ACCESSORY_PART_KEYWORDS.test(titleClean)) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 10,
      userFacingLabelAr: 'ملحق أو طقم ريش فقط (مستبعد)',
      reasonAr: 'تم استبعاد الملحقات أو أطقم الريش المنفصلة لعدم تطابقها مع الجهاز الأساسي',
    };
  }

  // 2. Prevent Nail Drills / Manicure tools from matching Hardware Power Drills
  const searchingForNailDrill = BEAUTY_NAIL_DRILL_KEYWORDS.test(queryCombined);
  if (!searchingForNailDrill && BEAUTY_NAIL_DRILL_KEYWORDS.test(titleClean)) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 5,
      userFacingLabelAr: 'فئة منتج مختلفة تماماً (مستبعد)',
      reasonAr: 'تم استبعاد أدوات العناية بالأظافر لأن البحث عن معدة/جهاز مختلف',
    };
  }

  // 2b. Prevent Locking Pliers / Vise Grips / Water Pump Pliers from matching Interchangeable Head Pliers
  if (/\b(interchangeable|replaceable\s+head|detachable|5\s*in\s*1)\b/i.test(queryCombined)) {
    if (/\b(locking\s+plier|vise\s*grip|vice\s*grip|water\s*pump|slip\s*joint|groove\s*joint|channellock|pipe\s*wrench)\b/i.test(titleLower)) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 10,
        userFacingLabelAr: 'نوع كماشة مختلف (مستبعد)',
        reasonAr: 'تم استبعاد المنتج لأنه كماشة من نوع مختلف (Locking / Vise-Grip / Water Pump) وليس طقم الرؤوس القابلة للتبديل',
      };
    }
  }

  // 3. Enforce Gemini Vision excludeKeywords
  if (Array.isArray(excludeKeywords) && excludeKeywords.length > 0) {
    const queryLower = queryCombined.toLowerCase();
    for (const rawEx of excludeKeywords) {
      const ex = (rawEx || '').trim().toLowerCase();
      if (ex.length >= 3 && !queryLower.includes(ex) && titleLower.includes(ex)) {
        return {
          approved: false,
          matchCategory: 'mismatched',
          matchScore: 15,
          userFacingLabelAr: 'تصميم مختلف عن الصورة (مستبعد)',
          reasonAr: `تم استبعاد المنتج لاحتوائه على سمة غير مطابقة للصورة المرفوعة (${rawEx})`,
        };
      }
    }
  }

  const queryTokens = tokenizeNormalized(amazonQuery || rawProductName);
  const titleTokens = new Set(tokenizeNormalized(titleClean));

  // Do NOT approve when query has no valid English tokens (e.g., failed translation of "بحث بالصورة")
  const englishQueryTokens = queryTokens.filter((t) => /^[a-z0-9]+$/i.test(t));
  if (englishQueryTokens.length === 0) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: 0,
      userFacingLabelAr: 'استعلام غير مكتمل',
      reasonAr: 'لم يتم تحديد اسم المنتج الإنجليزي للبحث في أمازون',
    };
  }

  // CRITICAL: Require matching at least one core product head noun (not just modifiers like "heavy", "duty", "grip", "handle")
  const headNounTokens = extractHeadNounTokens(englishQueryTokens);
  if (headNounTokens.length > 0) {
    let headNounMatched = 0;
    for (const hn of headNounTokens) {
      if (titleTokens.has(hn) || titleLower.includes(hn)) {
        headNounMatched++;
      }
    }
    if (headNounMatched === 0) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 15,
        userFacingLabelAr: 'منتج مختلف تماماً (مستبعد)',
        reasonAr: 'عنوان المنتج لا يحتوي على الاسم الأساسي للمنتج المطلوب',
      };
    }
  }

  let matchedCount = 0;
  for (const qt of englishQueryTokens) {
    if (titleTokens.has(qt) || titleLower.includes(qt)) {
      matchedCount++;
    }
  }

  const overlapRatio = matchedCount / englishQueryTokens.length;
  const minRequiredMatches =
    englishQueryTokens.length <= 2 ? englishQueryTokens.length : Math.max(2, Math.ceil(englishQueryTokens.length * 0.45));

  if (matchedCount < minRequiredMatches && overlapRatio < 0.45) {
    return {
      approved: false,
      matchCategory: 'mismatched',
      matchScore: Math.round(overlapRatio * 100),
      userFacingLabelAr: 'منتج مختلف (مستبعد)',
      reasonAr: 'عنوان المنتج لا يتطابق مع الكلمات الأساسية للبحث',
    };
  }

  // 4. Evaluate visual form-factor attributes from Gemini Vision layer if provided
  let attributeBonus = 0;
  if (Array.isArray(mustMatchAttributes) && mustMatchAttributes.length > 0) {
    let attrHits = 0;
    for (const attr of mustMatchAttributes) {
      const attrLower = (attr || '').trim().toLowerCase();
      if (!attrLower) continue;
      if (titleLower.includes(attrLower)) {
        attrHits += 2;
        continue;
      }
      const attrTokens = tokenizeNormalized(attrLower);
      if (attrTokens.length > 0 && attrTokens.every((t) => titleTokens.has(t) || titleLower.includes(t))) {
        attrHits += 2;
      } else if (attrTokens.length > 0 && attrTokens.some((t) => titleTokens.has(t) || titleLower.includes(t))) {
        attrHits += 1;
      }
    }
    if (attrHits === 0) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 30,
        userFacingLabelAr: 'مواصفات غير مطابقة للصورة (مستبعد)',
        reasonAr: 'عنوان المنتج يفتقر للسمات والمواصفات الشكلية والآلية المميزة للصورة المرفوعة',
      };
    }
    if (attrHits >= 3) {
      attributeBonus = 15;
    } else if (attrHits >= 1) {
      attributeBonus = 7;
    }
  }

  const score = Math.min(99, Math.max(60, Math.round(55 + overlapRatio * 38 + attributeBonus)));
  const category = score >= 82 || overlapRatio >= 0.65 ? 'exact_design' : 'permitted_variation';

  return {
    approved: true,
    matchCategory: category,
    matchScore: score,
    userFacingLabelAr: category === 'exact_design' ? 'نفس التصميم والتصنيف التجاري' : 'منتج مشابه مطابق',
    reasonAr: 'تطابق مع الاسم التجاري ومواصفات المنتج المطلوب',
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
