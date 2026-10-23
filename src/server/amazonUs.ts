import { ProvenanceClassification } from '../types/index.ts';
import { isSafeExternalUrl } from '../utils/security.ts';
import { translateArabicToAmazonQuery } from './gemini.ts';

export const AMAZON_US_HEADERS: Record<string, string> = {
  'User-Agent': 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const AMAZON_US_PRODUCT_PAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const AMAZON_SEARCH_HEADER_PROFILES: ReadonlyArray<Record<string, string>> = [
  {
    'User-Agent': 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  },
];

export const AMAZON_PRODUCT_PAGE_HEADER_PROFILES: ReadonlyArray<Record<string, string>> = [
  AMAZON_US_PRODUCT_PAGE_HEADERS,
  {
    'User-Agent': 'WhatsApp/2.23.20.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent': 'Twitterbot/1.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent':
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent': 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  },
];

let searchHeaderCursor = 0;
let productPageHeaderCursor = 0;

export interface ExtractedAmazonVideo {
  title: string;
  sourceUrl: string;
  productListingUrl: string;
  mediaUrl: string;
  thumbnailUrl: string;
  reviewerOrChannel: string;
  provenance: ProvenanceClassification;
  reviewId?: string;
  incentiveDisclosure?: string;
  contentDescription: string;
  isCustomerReview: boolean;
  sentiment: 'positive';
}

const EGYPTIAN_ARABIC_ECOMMERCE_DICTIONARY: Array<[RegExp, string]> = [
  [/جزام[ةه]/gi, 'shoe rack organizer'],
  [/ستاند\s*ملابس|علاق[ةه]\s*ملابس|شماعه\s*ملابس/gi, 'garment clothes rack'],
  [/ا?ستاند\s*معدن[يية]?|وحد[ةه]\s*أ?رفف\s*معدني[ةه]?|رف\s*تخزين\s*معدن[يية]?/gi, 'foldable metal storage rack shelves'],
  [/ستاند\s*لابتوب|حامل\s*لابتوب/gi, 'laptop stand'],
  [/ستاند\s*موبايل|حامل\s*موبايل|حامل\s*هاتف/gi, 'phone stand holder'],
  [/دور|أدوار|ادوار/gi, 'tier'],
  [/بغطاء|بالغطاء/gi, 'with cover'],
  [/وساد[ةه]\s*(?:استرخاء|رقب[ةه]|طبي[ةه])|مصحح\s*(?:انحناء|الانحناء)\s*(?:الطبيعي\s*)?(?:للرقب[ةه]|الرقب[ةه])/gi, 'RESTCLOUD Neck and Shoulder Relaxer Cervical Traction Device Pillow'],
  [/مخد[ةه]\s*(?:مساج|تدليك)|وساد[ةه]\s*(?:مساج|تدليك)/gi, 'Electric Shiatsu Neck and Back Massager Pillow with Heat'],
  [/ماكين[ةه]\s*قهو[ةه]|ماكين[ةه]\s*اسبريسو|إسبريسو/gi, 'espresso coffee maker'],
  [/مكوا[ةه]\s*بخار/gi, 'handheld garment steamer'],
  [/قلاي[ةه]\s*هوائي[ةه]|اير\s*فراير/gi, 'air fryer'],
  [/خلاط\s*محمول/gi, 'portable blender'],
  [/منظم\s*مكياج/gi, 'makeup organizer'],
  [/منظم\s*مطبخ/gi, 'kitchen organizer rack'],
  [/رف\s*حمام|منظم\s*حمام/gi, 'bathroom shelf organizer'],
  [/ممسح[ةه]|جردل/gi, 'spin mop and bucket'],
  [/فرشا[ةه]\s*شعر|استشوار/gi, 'hair dryer brush styler'],
  [/سماع[ةه]|سماعات/gi, 'wireless headphones earbuds'],
  [/مبخر[ةه]/gi, 'electric incense burner'],
  [/كشاف|اضاء[ةه]|إضاء[ةه]/gi, 'led light lamp'],
  [/ساع(?:ات|[ةه])?\s*منبه|منبه(?:ات)?|ساع(?:ات|[ةه])?\s*رقمي[ةه]|ساع(?:ات|[ةه])?\s*مكتب/gi, 'digital alarm clock for bedroom'],
  [/شعل[ةه]\s*فحم|ولاع[ةه]\s*فحم|سخان\s*فحم|موقد\s*فحم/gi, 'electric charcoal starter burner'],
  [/غالق\s*باب|قفل\s*باب\s*سحاب/gi, 'punch-free automatic door closer'],
  [/منشار\s*كهربائي|ميني\s*شينسو|منشار\s*شجر/gi, 'mini chainsaw cordless'],
  [/حوامل\s*غسال[ةه]|قواعد\s*غسال[ةه]/gi, 'anti vibration washing machine support pads'],
  [/فحص\s*نهائي|العملية|الحديثة|الجديدة|الأصلية|الاصليه/gi, ' '],
];

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

const NEGATIVE_REVIEW_PATTERNS: RegExp[] = [
  /\bnot\s+(?:as\s+)?(?:sturdy|easy|strong|stable|soft|comfortable|worth|good|working|recommended|described)\b/i,
  /\bdon['’]?t\s+waste\b/i,
  /\bwaste\s+(?:of\s+)?(?:your\s+)?money\b/i,
  /\b(?:do\s+not|don['’]?t)\s+buy\b/i,
  /\bwhy\s+did\s+i\s+buy\b/i,
  /\bsilly\s+thing\b/i,
  /\b(?:extremely|too|to|very|way\s+too)\s+(?:hard|stiff|firm|small|short|narrow|flimsy|weak|cheap|heavy|bulky|loud|noisy)\b/i,
  /\b(?:hard|difficult|pain|impossible)\s+to\s+(?:assemble|put\s+together|install|use)\b/i,
  /\bnot\s+what\s+i\s+expected\b/i,
  /\b(?:bad|poor|terrible|horrible|awful|worst|cheap|low|inferior)\s+(?:quality|design|product|material|construction|video|experience)\b/i,
  /\bdefective\b/i,
  /\b(?:broke|broken|ripped|tore|torn|cracked|snapped|bent|collapsed|collapses|fell\s+apart|falls\s+apart)\b/i,
  /\b(?:flimsy|wobbly|unstable|shak[ey]|cheaply\s+made|junk|trash|garbage|useless|pointless|worthless)\b/i,
  /\b(?:disappointed|disappointing|disappointment|regret|underwhelmed|frustrating)\b/i,
  /\b(?:returned|returning|return\s+it|refund|sent\s+it\s+back|sending\s+back|going\s+back)\b/i,
  /\b(?:uncomfortable|painful|caused\s+pain|made\s+it\s+worse|hurts\s+my)\b/i,
  /\b(?:odor|smell|smells|stinks|stinky|fumes|toxic)\b/i,
  /\bwatch\s+before\s+(?:you\s+)?buy(?:ing)?\b/i,
  /\bbefore\s+you\s+buy\b/i,
  /\bworth\s+it\s*\?/i,
  /\bstruggle\s+to\b/i,
  /\b(?:missing\s+parts?|wrong\s+item|wrong\s+size|stopped\s+working|doesn['’]?t\s+work|does\s+not\s+work|didn['’]?t\s+work)\b/i,
  /\b(?:1|one|2|two)\s*[- ]?\s*stars?\b/i,
  /\b(?:scam|fake|misleading|false\s+advertising|beware|warning|avoid)\b/i,
];

/**
 * Strictly checks that an Amazon review video is 100% POSITIVE and contains zero negative/critical/complaint signals.
 */
export function isPositiveReviewVideo(
  videoTitle: string,
  reviewSnippetHtml?: string
): boolean {
  const cleanTitle = decodeHtmlEntities(videoTitle || '').trim();
  if (!cleanTitle) return false;

  for (const pattern of NEGATIVE_REVIEW_PATTERNS) {
    if (pattern.test(cleanTitle)) {
      return false;
    }
  }

  if (reviewSnippetHtml) {
    // Reject if the associated customer review block has 1, 2, or 3 stars
    if (
      /\ba-star-(?:1|2|3)\b/i.test(reviewSnippetHtml) ||
      /\b[123]\.0\s+out\s+of\s+5\s+stars\b/i.test(reviewSnippetHtml)
    ) {
      return false;
    }
    const strippedSnippet = decodeHtmlEntities(reviewSnippetHtml.replace(/<[^>]+>/g, ' '));
    for (const pattern of NEGATIVE_REVIEW_PATTERNS) {
      if (pattern.test(strippedSnippet)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Converts an Arabic or mixed product name into an accurate English search query for Amazon US (amazon.com).
 */
export async function buildAmazonUsQuery(
  rawName: string,
  suggestedNameEn?: string,
  enQueries?: string[],
  signal?: AbortSignal
): Promise<string> {
  // 1. If Gemini provided a valid English name (containing ASCII letters and no Arabic script), prefer it
  const hasArabic = (s?: string) => Boolean(s && /[\u0600-\u06FF]/.test(s));
  const hasLatin = (s?: string) => Boolean(s && /[a-zA-Z]{3,}/.test(s));

  const stripMetricDimensions = (s: string) =>
    s
      .replace(/\d+\s*[*×xX]\s*\d+(?:\s*[*×xX]\s*\d+)?\s*(?:سم|مم|cm|mm)?/gi, ' ')
      .replace(/(?:عمق|عرض|طول|ارتفاع|مقاس|حجم|depth|width|height|size)\s*\d+(?:\.\d+)?\s*(?:سم|متر|مم|cm|mm|m)?/gi, ' ')
      .replace(/\b\d+(?:\.\d+)?\s*(?:سم|مم|cm|mm)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  if (
    suggestedNameEn &&
    hasLatin(suggestedNameEn) &&
    !hasArabic(suggestedNameEn) &&
    suggestedNameEn.toLowerCase() !== 'product' &&
    suggestedNameEn.toLowerCase() !== 'search by image'
  ) {
    const cleaned = stripMetricDimensions(suggestedNameEn);
    if (hasLatin(cleaned)) return cleaned;
  }

  if (enQueries && enQueries.length > 0) {
    const cleanEn = enQueries.find((q) => hasLatin(q) && !hasArabic(q));
    if (cleanEn) {
      const cleaned = stripMetricDimensions(
        cleanEn.replace(/\b(customer|review|video|unboxing|amazon)\b/gi, '')
      );
      if (hasLatin(cleaned)) return cleaned;
    }
  }

  // 2. Clean rawName, strip raw metric dimension numbers (e.g. "125*80 عمق 32 سم"), and apply e-commerce dictionary replacements
  let working = stripMetricDimensions(rawName || '')
    .replace(/[—–\-_|*×]+/g, ' ')
    .trim();
  for (const [pattern, replacement] of EGYPTIAN_ARABIC_ECOMMERCE_DICTIONARY) {
    working = working.replace(pattern, ` ${replacement} `);
  }
  working = working.replace(/\s+/g, ' ').trim();

  // If dictionary produced English keywords, extract them immediately and ignore remaining Arabic filler words
  if (hasLatin(working)) {
    const latinOnly = working
      .replace(/[\u0600-\u06FF]+/g, ' ')
      .replace(/\b\d{2,}\b(?!\s*tier)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (latinOnly.length >= 3) {
      return latinOnly;
    }
  }

  // 3. Translate any remaining purely Arabic words via Gemini first, then fallback to public translation
  if (hasArabic(working)) {
    try {
      const geminiTranslated = await translateArabicToAmazonQuery(working);
      if (geminiTranslated && hasLatin(geminiTranslated) && !hasArabic(geminiTranslated)) {
        return geminiTranslated;
      }
    } catch {}

    try {
      const timeoutSig = AbortSignal.timeout(3000);
      const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=en&dt=t&q=' +
        encodeURIComponent(working);
      const res = await fetch(url, { signal: combinedSig });
      if (res.ok) {
        const data = await res.json();
        const translated =
          data?.[0]
            ?.map((part: unknown) => (Array.isArray(part) ? String(part[0] || '') : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim() || '';
        if (hasLatin(translated) && !hasArabic(translated)) {
          return translated;
        }
      }
    } catch {
      // Fallback to whatever Latin words we extracted
    }
  }

  const latinOnly = working.replace(/[\u0600-\u06FF]+/g, ' ').replace(/\s+/g, ' ').trim();
  return latinOnly || working || 'product';
}

export interface AmazonUsProductCandidate {
  asin: string;
  url: string;
  title: string;
  imageUrl?: string;
  isSponsored?: boolean;
  reviewOrSalesScore?: number;
}

export interface StrictTitleMatchResult {
  approved: boolean;
  matchCategory: 'exact_design' | 'permitted_variation' | 'mismatched';
  matchScore: number;
  userFacingLabelAr: string;
  reasonAr: string;
}

const GENERIC_QUERY_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'without',
  'from',
  'that',
  'this',
  'new',
  'modern',
  'practical',
  'best',
  'high',
  'quality',
  'heavy',
  'duty',
  'large',
  'small',
  'tall',
  'short',
  'wide',
  'narrow',
  'tier',
  'tiers',
  'layer',
  'layers',
  'organizer',
  'storage',
  'holder',
  'stand',
  'rack',
  'shelf',
  'shelves',
  'unit',
  'set',
  'pack',
  'pcs',
  'piece',
  'portable',
  'electric',
  'manual',
  'automatic',
  'wireless',
  'home',
  'room',
  'bedroom',
  'closet',
  'entryway',
  'hallway',
  'kitchen',
  'bathroom',
  'office',
  'black',
  'white',
  'gray',
  'grey',
  'brown',
  'silver',
  'gold',
  'blue',
  'product',
  'review',
  'video',
  'customer',
  'amazon',
  'relief',
  'pain',
  'device',
  'alignment',
  'support',
  'natural',
  'spine',
  'tmj',
  'muscle',
]);

/**
 * Evaluates whether an Amazon product title strictly matches the target product type and mandatory structural attributes.
 * Acts both as a fast pre-filter and as a deterministic strict gate.
 */
export function evaluateStrictProductTitleMatch(
  candidateTitle: string,
  expectedEnglishQuery: string,
  rawUserProductName: string,
  mustMatchAttributes: string[] = []
): StrictTitleMatchResult {
  const cleanTitle = decodeHtmlEntities(candidateTitle || '').toLowerCase().trim();
  const cleanExpected = (expectedEnglishQuery || '').toLowerCase().trim();
  const cleanRaw = (rawUserProductName || '').toLowerCase().trim();
  const combinedMustMatch = mustMatchAttributes.join(' ').toLowerCase();
  const fullContext = `${cleanExpected} ${cleanRaw} ${combinedMustMatch}`;

  // If title is just a fallback placeholder like "shoe rack (B0...)", allow it to be inspected on its product page
  if (!cleanTitle || /\([a-z0-9]{10}\)$/i.test(cleanTitle)) {
    return {
      approved: true,
      matchCategory: 'exact_design',
      matchScore: 80,
      userFacingLabelAr: 'نفس التصميم',
      reasonAr: 'سيتم التحقق من تفاصيل صفحة المنتج',
    };
  }

  // 1. Reject obvious accessories, replacement parts only, or cleaners when searching for a main product
  const accessoryConflicts = [
    /\breplacement\s+(?:cover|parts?|cloth|bag|filter|head)\s+only\b/i,
    /\b(?:shoe\s+horn|shoe\s+stretcher|shoe\s+cleaner|shoe\s+polish|shoe\s+deodorizer|insole|insoles|shoelaces)\b/i,
    /\b(?:gift\s+card|sticker|decal|poster|keychain)\b/i,
  ];
  for (const rx of accessoryConflicts) {
    if (rx.test(cleanTitle) && !rx.test(cleanExpected)) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 15,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: 'تم الاستبعاد: إكسسوار أو قطعة غيار وليس المنتج الأساسي',
      };
    }
  }

  // 2. Strict Structural Conflict Rules for Neck Relaxer / Cervical Traction Pillow
  const isNeckRelaxerPillowTarget =
    /\b(?:neck\s+and\s+shoulder\s+relaxer|restcloud|cervical\s+traction|neck\s+stretcher|neck\s+relaxer)\b/i.test(
      fullContext
    ) && !/\b(?:inflatable|electric|cordless|back\s+brace)\b/i.test(fullContext);

  if (isNeckRelaxerPillowTarget) {
    // Strictly reject inflatable collars, mechanical neck braces, electric heated vibrating massagers, back posture straps, sleeping bed pillows, or flat orthotic blocks
    if (
      /\b(?:inflatable|air\s+pump|collar|brace|posture\s+corrector|back\s+support|clavicle|strap|harness|cordless|rechargeable|electric|vibration|vibrating|heated|heating|remote\s+control|shiatsu|cooling\s+pillow|cozy\s+sleeping|bed\s+pillow|memory\s+foam\s+pillow\s+for\s+sleeping|traction\s+block|orthotic\s+traction\s+block|equipment|hammock|over\s+door|3\s*in\s*1|three\s+in\s+one)\b/i.test(
        cleanTitle
      )
    ) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 15,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr:
          'تم الاستبعاد: منتج مختلف عن وسادة استرخاء الرقبة المرفوعة (طوق هوائي / جهاز كهربائي / حزام ظهر / مخدة نوم)',
      };
    }

    // Must explicitly be a Neck Relaxer / Neck Stretcher / Cervical Traction Pillow
    if (!/\b(?:neck\s+and\s+shoulder\s+relaxer|neck\s+stretcher|neck\s+relaxer|cervical\s+traction)\b/i.test(cleanTitle)) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 20,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: 'تم الاستبعاد: لا يطابق وسادة استرخاء وتقويم الرقبة المرفوعة',
      };
    }
  }

  // 3. Extract core subject nouns from expected query (e.g., "shoe", "espresso", "coffee", "headphones", "laptop", "garment", "steamer", "mop")
  const queryTokens = cleanExpected
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));

  const coreSubjectNouns = queryTokens.filter((w) => !GENERIC_QUERY_STOPWORDS.has(w));
  const structureTokens = queryTokens.filter((w) =>
    ['rack', 'organizer', 'shelf', 'cabinet', 'stand', 'holder', 'maker', 'machine', 'steamer', 'fryer', 'blender', 'mop', 'brush', 'headphones', 'earbuds', 'lamp', 'light', 'burner'].includes(w)
  );

  // Must match at least one core subject noun (if any exist)
  if (coreSubjectNouns.length > 0) {
    const matchedSubject = coreSubjectNouns.some((noun) => {
      const stem = noun.replace(/s$/, '');
      return cleanTitle.includes(stem);
    });
    if (!matchedSubject) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 20,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: `تم الاستبعاد: المنتج لا يطابق نوع المنتج المطلوب (${coreSubjectNouns.join(' ')})`,
      };
    }
  }

  // Must match at least one structural form factor token if specified
  if (structureTokens.length > 0) {
    const synonyms: Record<string, string[]> = {
      rack: ['rack', 'shelf', 'shelves', 'organizer', 'cabinet', 'closet', 'storage', 'tower', 'stand'],
      organizer: ['organizer', 'rack', 'shelf', 'shelves', 'cabinet', 'storage', 'closet', 'holder'],
      stand: ['stand', 'holder', 'rack', 'mount', 'riser'],
      maker: ['maker', 'machine', 'brewer', 'press'],
    };
    const matchedStruct = structureTokens.some((st) => {
      const allowed = synonyms[st] || [st];
      return allowed.some((word) => cleanTitle.includes(word));
    });
    if (!matchedStruct) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 30,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: 'تم الاستبعاد: هيكل المنتج مختلف عن المطلوب',
      };
    }
  }

  // 4. Strict Structural Constraint: "With Cover" / Zippered Dustproof Cover (بغطاء)
  const requiresCover =
    /بغطاء|بالغطاء/.test(cleanRaw) ||
    /\b(?:with\s+cover|dust\s*cover|zippered\s+cover|fabric\s+cover|covered|dustproof)\b/i.test(
      `${cleanExpected} ${combinedMustMatch}`
    );

  if (requiresCover) {
    // Reject plastic shoe boxes, hanging over-door pockets, or benches
    if (
      /\b(?:clear\s+plastic\s+shoe\s+boxes?|plastic\s+shoe\s+boxes?|shoe\s+boxes?\s+clear|stackable\s+shoe\s+boxes?|over\s+the\s+door|hanging\s+shoe|shoe\s+bench|bamboo\s+shoe\s+rack|wood\s+shoe\s+rack|wooden\s+shoe)\b/i.test(
        cleanTitle
      )
    ) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 25,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: 'تم الاستبعاد: تصميم المنتج مختلف (صناديق بلاستيك أو رف خشبي/مقعد وليس جزامة بغطاء)',
      };
    }

    const hasCoverIndicator =
      /\b(?:cover|covers|covered|dustproof|dust-proof|dust\s+cover|zipper|zippered|enclosed|non-woven|fabric\s+shoe\s+cabinet|portable\s+closet\s+wardrobe)\b/i.test(
        cleanTitle
      );
    if (!hasCoverIndicator) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 35,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: 'تم الاستبعاد: هذا المنتج بدون غطاء بينما المنتج المرفوع بغطاء',
      };
    }
  }

  // 5. Calculate match score & category (exact vs permitted variation like tier count/color)
  const targetTierMatch = `${cleanRaw} ${cleanExpected}`.match(/\b(\d+)\s*(?:tier|tiers|layer|layers|دور|أدوار|ادوار)\b/i);
  const candidateTierMatch = cleanTitle.match(/\b(\d+)[\s-]*(?:tier|tiers|layer|layers)\b/i);

  if (targetTierMatch && candidateTierMatch) {
    const targetTiers = parseInt(targetTierMatch[1], 10);
    const candTiers = parseInt(candidateTierMatch[1], 10);
    if (Math.abs(targetTiers - candTiers) > 3) {
      return {
        approved: false,
        matchCategory: 'mismatched',
        matchScore: 45,
        userFacingLabelAr: 'منتج مختلف (مستبعد)',
        reasonAr: `تم الاستبعاد: اختلاف كبير في الحجم (${candTiers} دور بدلاً من ${targetTiers} دور)`,
      };
    }
    if (targetTiers === candTiers) {
      return {
        approved: true,
        matchCategory: 'exact_design',
        matchScore: 95,
        userFacingLabelAr: 'نفس المنتج (تطابق 100%)',
        reasonAr: `تطابق تام مع المنتج المرفوع (${candTiers} دور${requiresCover ? ' بغطاء' : ''})`,
      };
    }
    return {
      approved: true,
      matchCategory: 'permitted_variation',
      matchScore: 88,
      userFacingLabelAr: 'نفس تصميم المنتج',
      reasonAr: `نفس تصميم وهيكل المنتج المرفوع (${candTiers} دور)`,
    };
  }

  return {
    approved: true,
    matchCategory: 'exact_design',
    matchScore: 92,
    userFacingLabelAr: 'نفس المنتج (تطابق 100%)',
    reasonAr: 'تطابق تام مع مواصفات وهيكل المنتج المرفوع',
  };
}

/**
 * Fetches an Amazon product thumbnail image as base64 for multimodal Gemini comparison.
 */
export async function fetchProductImageAsBase64(
  imageUrl?: string,
  signal?: AbortSignal
): Promise<{ base64: string; mimeType: string } | null> {
  if (!imageUrl || !isSafeExternalUrl(imageUrl).safe) return null;
  try {
    const timeoutSig = AbortSignal.timeout(2500);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': AMAZON_US_HEADERS['User-Agent'],
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: combinedSig,
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 4 * 1024 * 1024) return null;
    return {
      base64: buf.toString('base64'),
      mimeType: ct,
    };
  } catch {
    return null;
  }
}

/**
 * Searches Amazon US (https://www.amazon.com/s?k=...) across multiple pages and query variants,
 * rotating resilient bot and browser headers to prevent 503/captcha blocks.
 */
export async function searchAmazonUsProductPages(
  query: string,
  maxProducts = 25,
  signal?: AbortSignal
): Promise<AmazonUsProductCandidate[]> {
  const rawTrimmed = query.trim();
  if (!rawTrimmed) return [];

  const firstClause = rawTrimmed
    .split(/[,;|—–/]+/)[0]
    .replace(/\b[vc][\s-]+shaped\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanQuery = rawTrimmed
    .replace(/\b[vc][\s-]+shaped\b/gi, '')
    .replace(/[,;|/\\()[\]—–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanQuery) return [];

  const organicFound: AmazonUsProductCandidate[] = [];
  const sponsoredFound: AmazonUsProductCandidate[] = [];
  const seenAsins = new Set<string>();

  const queryVariants: string[] = [];
  const addVariant = (v: string) => {
    const trimmed = v.replace(/\s+/g, ' ').trim();
    if (trimmed.length >= 3 && !queryVariants.some((x) => x.toLowerCase() === trimmed.toLowerCase())) {
      queryVariants.push(trimmed);
    }
  };

  // Add high-yield domain-specific query variants if applicable
  if (
    /\b(?:cervical\s+traction|neck\s+and\s+shoulder\s+relaxer|restcloud|neck\s+stretcher|neck\s+relaxer)\b/i.test(cleanQuery) &&
    !/\b(?:electric|shiatsu|kneading|heated|massager)\b/i.test(cleanQuery)
  ) {
    addVariant('Neck and Shoulder Relaxer Cervical Traction');
    addVariant('RESTCLOUD Neck and Shoulder Relaxer');
    addVariant('Neck Stretcher Chiropractic Pillow');
    addVariant('Cervical Traction Device for Neck Pain Relief');
  } else if (/\b(?:shiatsu|kneading|massager)\b/i.test(cleanQuery) && /\b(?:pillow|neck|back)\b/i.test(cleanQuery)) {
    addVariant('Shiatsu Neck and Back Massager Pillow with Heat');
    addVariant('Electric Kneading Massage Pillow for Neck Back');
  } else if (/\b(?:shoe|rack|tier|closet)\b/i.test(cleanQuery)) {
    addVariant('Shoe Rack Organizer with Dustproof Cover');
    addVariant('Portable Closet Shoe Storage Cabinet');
  } else if (/\b(?:washing|machine|anti|vibration|pads?)\b/i.test(cleanQuery)) {
    addVariant('Anti Vibration Washing Machine Pads');
  }

  const firstClauseWords = firstClause.split(/\s+/).filter(Boolean);
  if (firstClauseWords.length >= 2 && firstClauseWords.length <= 7) {
    addVariant(firstClause);
  }

  const words = cleanQuery.split(/\s+/).filter((w) => w.length >= 2);
  const meaningfulWords = words.filter(
    (w) => !/^(?:and|for|with|the|from|that|this|into|onto|pain|relief|alignment|shaped)$/i.test(w)
  );

  if (words.length > 6) {
    addVariant(words.slice(0, 5).join(' '));
    addVariant(meaningfulWords.slice(0, 5).join(' '));
    addVariant(meaningfulWords.slice(0, 4).join(' '));
  } else {
    addVariant(cleanQuery);
    if (meaningfulWords.length >= 3) {
      addVariant(meaningfulWords.slice(0, 4).join(' '));
    }
  }

  const maxPagesPerQuery = Math.min(6, Math.max(2, Math.ceil(maxProducts / 16)));

  const fetchAndParseSearchPage = async (qVariant: string, page: number) => {
    if (signal?.aborted) return;
    const pageParam = page > 1 ? `&page=${page}` : '';
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(qVariant)}${pageParam}`;

    let blocks: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) break;
      const headers =
        AMAZON_SEARCH_HEADER_PROFILES[
          (searchHeaderCursor++) % AMAZON_SEARCH_HEADER_PROFILES.length
        ];
      try {
        const timeoutSig = AbortSignal.timeout(5000);
        const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
        const res = await fetch(searchUrl, {
          headers,
          signal: combinedSig,
        });
        if (!res.ok) continue;

        const html = await res.text();
        if (html.length < 5000) continue; // skip small captcha or 503 fallback pages

        const rawBlocks = html.split(/data-asin="([A-Z0-9]{10})"/);
        if (rawBlocks.length >= 5) {
          blocks = rawBlocks;
          break;
        }
      } catch {
        // retry with next rotating header
      }
    }

    if (blocks.length < 3) return;

    for (let i = 1; i < blocks.length; i += 2) {
      const asin = blocks[i].toUpperCase();
      if (seenAsins.has(asin)) continue;

      const chunk = blocks[i + 1]?.slice(0, 6500) || '';
      const imgTagMatch = chunk.match(/<img[^>]+class="[^"]*s-image[^"]*"[^>]*>/i);
      if (!imgTagMatch) continue;

      const srcMatch = imgTagMatch[0].match(
        /src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i
      );
      const altMatch = imgTagMatch[0].match(/alt="([^"]+)"/i);
      if (!srcMatch || !altMatch) continue;

      const rawAlt = decodeHtmlEntities(altMatch[1]).trim();
      const isSponsored = /^Sponsored Ad\s*[-–—]/i.test(rawAlt) || chunk.includes('sp_atk');
      const cleanTitle = rawAlt.replace(/^Sponsored Ad\s*[-–—]\s*/i, '').trim();
      if (!cleanTitle) continue;

      seenAsins.add(asin);

      let reviewOrSalesScore = 0;
      const boughtMatch = chunk.match(/([0-9.]+)\s*k\+?\s*bought/i);
      if (boughtMatch) {
        reviewOrSalesScore += parseFloat(boughtMatch[1]) * 1000;
      } else if (/bought in past month/i.test(chunk)) {
        reviewOrSalesScore += 500;
      }
      if (/overall pick|amazon'?s choice|best seller/i.test(chunk)) {
        reviewOrSalesScore += 2500;
      }
      const reviewCountMatch =
        chunk.match(/([0-9,]{2,8})\s*(?:ratings?|reviews?)/i) ||
        chunk.match(/#customerReviews[^>]*>[\s\S]*?([0-9,]{2,8})/i) ||
        chunk.match(/class="[^"]*s-underline-text[^"]*"[^>]*>([0-9,]{2,8})/i);
      if (reviewCountMatch) {
        reviewOrSalesScore += parseInt(reviewCountMatch[1].replace(/,/g, ''), 10);
      }

      const candidate: AmazonUsProductCandidate = {
        asin,
        url: `https://www.amazon.com/dp/${asin}`,
        title: cleanTitle,
        imageUrl: srcMatch[1],
        isSponsored,
        reviewOrSalesScore,
      };

      if (isSponsored) {
        sponsoredFound.push(candidate);
      } else {
        organicFound.push(candidate);
      }
    }
  };

  // 1. Direct Amazon US multi-page search in parallel batches
  for (const qVariant of queryVariants) {
    if (organicFound.length >= maxProducts || signal?.aborted) break;

    const pagesToFetch: number[] = [];
    for (let page = 1; page <= maxPagesPerQuery; page++) {
      pagesToFetch.push(page);
    }

    // Fetch up to 4 pages in parallel per query variant
    for (let i = 0; i < pagesToFetch.length; i += 4) {
      if (organicFound.length >= maxProducts || signal?.aborted) break;
      const pageChunk = pagesToFetch.slice(i, i + 4);
      await Promise.all(pageChunk.map((p) => fetchAndParseSearchPage(qVariant, p)));
    }
  }

  // Prioritize products with highest reviews and sales volume first so they yield rich customer review videos immediately!
  const combined = [...organicFound, ...sponsoredFound]
    .sort((a, b) => (b.reviewOrSalesScore || 0) - (a.reviewOrSalesScore || 0))
    .slice(0, maxProducts);

  // 2. Fallback via DuckDuckGo HTML search for site:amazon.com/dp if direct search returned < 4 ASINs
  // Always fetches real product title and main image from the product page — never fabricates titles!
  if (combined.length < 4 && !signal?.aborted) {
    try {
      const ddgUrl =
        'https://html.duckduckgo.com/html/?q=' +
        encodeURIComponent(`site:amazon.com/dp ${queryVariants[0] || cleanQuery}`);
      const timeoutSig = AbortSignal.timeout(8000);
      const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const res = await fetch(ddgUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: combinedSig,
      });
      if (res.ok) {
        const rawHtml = await res.text();
        const decodedHtml = rawHtml.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
          try {
            return decodeURIComponent(m);
          } catch {
            return m;
          }
        });
        const dpRegex = /https?:\/\/(?:www\.)?amazon\.com\/(?:[^\s"'<>\\&]*\/)?dp\/([A-Z0-9]{10})/gi;
        const ddgAsins: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = dpRegex.exec(decodedHtml)) !== null) {
          const asin = match[1].toUpperCase();
          if (!seenAsins.has(asin)) {
            seenAsins.add(asin);
            ddgAsins.push(asin);
            if (ddgAsins.length >= 30) break;
          }
        }
        for (const asin of ddgAsins) {
          if (combined.length >= maxProducts) break;
          try {
            const pUrl = `https://www.amazon.com/dp/${asin}`;
            const pRes = await fetch(pUrl, {
              headers: AMAZON_US_PRODUCT_PAGE_HEADERS,
              signal: AbortSignal.timeout(6000),
            });
            if (!pRes.ok) continue;
            const pHtml = await pRes.text();
            const meta = extractAmazonProductPageMetadata(pHtml);
            if (meta.pageTitle) {
              combined.push({
                asin,
                url: pUrl,
                title: meta.pageTitle,
                imageUrl: meta.pageImageUrl,
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  return combined;
}

/**
 * Extracts the product title and main product image from an Amazon US product page HTML.
 */
export function extractAmazonProductPageMetadata(
  rawHtml: string
): { pageTitle?: string; pageImageUrl?: string } {
  const titleMatch =
    rawHtml.match(/<span[^>]+id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) ||
    rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/Amazon\.com\s*:\s*/i, '')).replace(/\s+/g, ' ').trim()
    : undefined;

  const imgMatch =
    rawHtml.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.(?:jpg|jpeg|png|webp))"/i) ||
    rawHtml.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i) ||
    rawHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/[^"']+)["']/i);

  return {
    pageTitle,
    pageImageUrl: imgMatch?.[1],
  };
}

/**
 * Extracts POSITIVE review videos from an Amazon US product page HTML.
 * Strictly filters out:
 * 1) "Videos for related products" / other competitor carousels
 * 2) Multi-product influencer roundups tagging 3+ unrelated ASINs
 * 3) Negative, critical, or complaint review videos (only 100% positive videos are returned)
 * Extracts from both:
 * - data-video-items carousel
 * - ImageBlock gallery JSON ('videos': A.$.parseJSON('[...]'))
 * Prioritizes real Customer Review Videos FIRST.
 */
export function parseAmazonUsVideosFromHtml(
  rawHtml: string,
  pageUrl: string,
  includeSellerDemos = true,
  onlyOrganicCustomers = false
): ExtractedAmazonVideo[] {
  const customerReviews: ExtractedAmazonVideo[] = [];
  const creatorReviews: ExtractedAmazonVideo[] = [];
  const sellerVideos: ExtractedAmazonVideo[] = [];
  const seenVideoUrls = new Set<string>();
  const seenVideoStreamUuids = new Set<string>();

  const extractStreamUuid = (url: string): string => {
    const m = url.match(/vse-vms-transcoding-artifact-[^/]+\/([a-f0-9-]{16,})/i);
    return m ? m[1].toLowerCase() : url;
  };

  const pageAsinMatch = pageUrl.match(/\/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i);
  const pageAsin = pageAsinMatch ? pageAsinMatch[1].toUpperCase() : undefined;

  // 1. Parse structured data-video-items JSON blocks
  const videoItemsRegex = /data-video-items="([^"]+)"/g;
  let match: RegExpExecArray | null;
  let foundStructuredBlock = false;

  while ((match = videoItemsRegex.exec(rawHtml)) !== null) {
    try {
      const decodedJson = decodeHtmlEntities(match[1]);
      const items = JSON.parse(decodedJson);
      if (!Array.isArray(items)) continue;
      foundStructuredBlock = true;

      for (const item of items) {
        const videoUrl = typeof item.videoURL === 'string' ? item.videoURL.trim() : '';
        if (!videoUrl || !isSafeExternalUrl(videoUrl).safe) continue;
        if (seenVideoUrls.has(videoUrl)) continue;

        const streamUuid = extractStreamUuid(videoUrl);
        if (seenVideoStreamUuids.has(streamUuid)) continue;

        // STRICT FILTER 1: Reject "Videos for related products" / competitor carousels
        const segmentName = String(item.segmentName || '').trim().toLowerCase();
        if (
          segmentName &&
          segmentName !== 'videos for this product' &&
          (segmentName.includes('related') || segmentName.includes('other') || segmentName.includes('brand'))
        ) {
          continue;
        }

        // STRICT FILTER 2: If productAsin is specified on the video item, it must match this page's ASIN (or parentAsin)
        const itemProductAsin = String(item.productAsin || '').trim().toUpperCase();
        const itemParentAsin = String(item.parentAsin || '').trim().toUpperCase();
        const relatedAsinsRaw = String(item.relatedProductsAsins || '').trim().toUpperCase();
        const relatedAsinsList = relatedAsinsRaw
          ? relatedAsinsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : [];

        if (pageAsin && itemProductAsin && itemProductAsin.length === 10) {
          if (itemProductAsin !== pageAsin && itemParentAsin !== pageAsin) {
            continue;
          }
        }

        const creatorType = String(item.creatorType || '').toLowerCase();
        const fullReviewLink = typeof item.fullReviewLink === 'string' ? item.fullReviewLink.trim() : '';
        const videoDetailPageLink =
          typeof item.videoDetailPageLink === 'string' ? item.videoDetailPageLink.trim() : '';
        const aciContentId = typeof item.aciContentId === 'string' ? item.aciContentId.trim() : '';
        const mediaObjectId = typeof item.mediaObjectId === 'string' ? item.mediaObjectId.trim() : '';
        const uniqueReviewOrVideoId = aciContentId || mediaObjectId || undefined;

        const isCustomer =
          creatorType === 'customer' ||
          fullReviewLink.includes('customer-reviews') ||
          aciContentId.startsWith('amzn1.productreview.');
        const isInfluencer = creatorType === 'influencer';

        // STRICT FILTER 3: Reject multi-product influencer roundups that tag other unrelated ASINs
        const nonSelfRelatedAsins = relatedAsinsList.filter(
          (a) => a !== pageAsin && a !== itemProductAsin && a !== itemParentAsin
        );
        if (!isCustomer && nonSelfRelatedAsins.length > 0) {
          continue;
        }

        const reviewerName = String(item.publicName || item.vendorName || '').trim();
        const rawTitle = decodeHtmlEntities(String(item.title || '').trim());

        // STRICT FILTER 4: 100% POSITIVE REVIEWS ONLY — Reject any negative, complaint, or critical review video
        let reviewBlockHtml: string | undefined;
        const reviewIdFromLink = fullReviewLink.match(/customer-reviews\/([A-Z0-9]+)/i)?.[1];
        if (reviewIdFromLink) {
          const idx = rawHtml.indexOf(`customer_review-${reviewIdFromLink}`);
          if (idx !== -1) {
            reviewBlockHtml = rawHtml.slice(idx, idx + 2500);
          }
        }
        const effectiveTitleToCheck = rawTitle || `مراجعة عميل — ${reviewerName || 'Amazon US'}`;
        if (!isPositiveReviewVideo(effectiveTitleToCheck, reviewBlockHtml)) {
          continue;
        }

        seenVideoUrls.add(videoUrl);
        seenVideoStreamUuids.add(streamUuid);

        const thumb = String(
          item.videoImageUrlUnchanged || item.hiResVideoImageUrl || item.videoImageUrl || ''
        ).trim();

        let sourceUrl = pageUrl;
        if (fullReviewLink) {
          try {
            sourceUrl = new URL(fullReviewLink, 'https://www.amazon.com').href;
          } catch {}
        } else if (videoDetailPageLink) {
          try {
            sourceUrl = new URL(videoDetailPageLink, 'https://www.amazon.com').href;
          } catch {}
        }

        if (isCustomer) {
          customerReviews.push({
            title: rawTitle || `مراجعة عميل إيجابية — ${reviewerName || 'Amazon US'}`,
            sourceUrl,
            productListingUrl: pageUrl,
            mediaUrl: videoUrl,
            thumbnailUrl: thumb,
            reviewerOrChannel: reviewerName || 'عميل أمازون أمريكا',
            provenance: 'unverified_customer_review',
            reviewId: uniqueReviewOrVideoId,
            contentDescription: `فيديو مراجعة عميل إيجابية من أمازون أمريكا${reviewerName ? ` (${reviewerName})` : ''}`,
            isCustomerReview: true,
            sentiment: 'positive',
          });
        } else if (isInfluencer) {
          creatorReviews.push({
            title: rawTitle || `تجربة إيجابية للمنتج — ${reviewerName || 'Amazon US'}`,
            sourceUrl,
            productListingUrl: pageUrl,
            mediaUrl: videoUrl,
            thumbnailUrl: thumb,
            reviewerOrChannel: reviewerName || 'صانع محتوى أمازون',
            provenance: 'affiliate_creator_demo',
            reviewId: uniqueReviewOrVideoId,
            incentiveDisclosure: item.disclosureText || 'Earns commissions',
            contentDescription: `مراجعة إيجابية وتجربة للمنتج على أمازون أمريكا${reviewerName ? ` (${reviewerName})` : ''}`,
            isCustomerReview: false,
            sentiment: 'positive',
          });
        } else {
          sellerVideos.push({
            title: rawTitle || 'فيديو توضيحي للمنتج — أمازون أمريكا',
            sourceUrl,
            productListingUrl: pageUrl,
            mediaUrl: videoUrl,
            thumbnailUrl: thumb,
            reviewerOrChannel: reviewerName || 'البائع على أمازون',
            provenance: 'seller_manufacturer_demo',
            reviewId: uniqueReviewOrVideoId,
            contentDescription: 'فيديو استعراض المنتج من صفحة أمازون أمريكا',
            isCustomerReview: false,
            sentiment: 'positive',
          });
        }
      }
    } catch {
      // ignore malformed JSON block
    }
  }

  // 2. Parse ImageBlock gallery JSON ('videos': A.$.parseJSON('[...]'))
  const imageBlockVideosMatch = rawHtml.match(/'videos'\s*:\s*A\.\$\.parseJSON\('(\[[^']+\])'\)/);
  if (imageBlockVideosMatch) {
    try {
      const parsedGallery = JSON.parse(imageBlockVideosMatch[1].replace(/\\'/g, "'"));
      if (Array.isArray(parsedGallery)) {
        for (const gv of parsedGallery) {
          const gvUrl = typeof gv.url === 'string' ? gv.url.trim() : '';
          if (!gvUrl || !isSafeExternalUrl(gvUrl).safe) continue;
          if (seenVideoUrls.has(gvUrl)) continue;

          const streamUuid = extractStreamUuid(gvUrl);
          if (seenVideoStreamUuids.has(streamUuid)) continue;

          const gvTitle = decodeHtmlEntities(String(gv.title || '').trim());
          if (gvTitle && !isPositiveReviewVideo(gvTitle)) continue;

          seenVideoUrls.add(gvUrl);
          seenVideoStreamUuids.add(streamUuid);

          sellerVideos.push({
            title: gvTitle || 'فيديو استعراض المنتج الرسمي — أمازون أمريكا',
            sourceUrl: pageUrl,
            productListingUrl: pageUrl,
            mediaUrl: gvUrl,
            thumbnailUrl: String(gv.slateUrl || gv.thumb || '').trim(),
            reviewerOrChannel: 'Amazon US',
            provenance: 'seller_manufacturer_demo',
            reviewId: typeof gv.mediaObjectId === 'string' ? gv.mediaObjectId : undefined,
            contentDescription: 'فيديو استعراض المنتج الأصلي من صفحة أمازون أمريكا',
            isCustomerReview: false,
            sentiment: 'positive',
          });
        }
      }
    } catch {}
  }

  // 3. Fallback: ONLY if the page had NO structured blocks, look for raw VSE HLS/MP4 URLs
  if (!foundStructuredBlock && customerReviews.length === 0 && creatorReviews.length === 0 && sellerVideos.length === 0) {
    const normalized = decodeHtmlEntities(rawHtml);
    const mediaMatches =
      normalized.match(
        /https:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact-[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi
      ) || [];
    for (const url of mediaMatches) {
      if (url.includes('videopreview.jobtemplate') || url.includes('gandalf_preview')) {
        continue;
      }
      const streamUuid = extractStreamUuid(url);
      if (!seenVideoUrls.has(url) && !seenVideoStreamUuids.has(streamUuid) && isSafeExternalUrl(url).safe) {
        seenVideoUrls.add(url);
        seenVideoStreamUuids.add(streamUuid);
        sellerVideos.push({
          title: 'فيديو مراجعة إيجابية من أمازون أمريكا',
          sourceUrl: pageUrl,
          productListingUrl: pageUrl,
          mediaUrl: url,
          thumbnailUrl: '',
          reviewerOrChannel: 'Amazon US',
          provenance: 'unresolved_source',
          contentDescription: 'فيديو مستخرج من صفحة المنتج على أمازون أمريكا',
          isCustomerReview: false,
          sentiment: 'positive',
        });
      }
    }
  }

  // If onlyOrganicCustomers is requested: return ONLY genuine customer reviews (no marketers/affiliates/creators, no sellers)
  if (onlyOrganicCustomers) {
    return customerReviews;
  }
  if (!includeSellerDemos) {
    return [...customerReviews, ...creatorReviews];
  }
  return [...customerReviews, ...creatorReviews, ...sellerVideos];
}

/**
 * Fetches an Amazon US product page and extracts its positive customer review videos and metadata.
 * Rotates across verified header profiles (Facebook, WhatsApp, Twitter, LinkedIn, Discord, Chrome)
 * to ensure data-video-items and gallery videos are always returned without rate limits.
 */
export async function fetchAmazonUsProductVideos(
  pageUrl: string,
  signal?: AbortSignal,
  includeSellerDemos = false,
  onlyOrganicCustomers = true
): Promise<ExtractedAmazonVideo[]> {
  const targetUrl = pageUrl.startsWith('http') ? pageUrl : `https://www.amazon.com/dp/${pageUrl}`;
  if (!isSafeExternalUrl(targetUrl).safe) return [];

  const startIndex = (productPageHeaderCursor++) % AMAZON_PRODUCT_PAGE_HEADER_PROFILES.length;
  const profilesToTry: Array<Record<string, string>> = [];
  for (let i = 0; i < 2; i++) {
    profilesToTry.push(
      AMAZON_PRODUCT_PAGE_HEADER_PROFILES[
        (startIndex + i) % AMAZON_PRODUCT_PAGE_HEADER_PROFILES.length
      ]
    );
  }

  for (const headers of profilesToTry) {
    if (signal?.aborted) break;
    try {
      const timeoutSig = AbortSignal.timeout(4500); // Fast 4.5s timeout for high responsiveness
      const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const res = await fetch(targetUrl, {
        headers,
        signal: combinedSig,
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 5000) continue; // skip 503/captcha blocks

      if (html.includes('data-video-items') || html.includes("'videos': A.$.parseJSON")) {
        const extracted = parseAmazonUsVideosFromHtml(html, targetUrl, includeSellerDemos, onlyOrganicCustomers);
        if (extracted.length > 0) {
          return extracted;
        }
      }

      // If page loaded cleanly (HTTP 200, full HTML) but has no video blocks, don't waste time trying again!
      if (html.length > 20000 && (html.includes('id="dp"') || html.includes('id="productTitle"'))) {
        return [];
      }
    } catch {
      // try next rotating profile only on network error/timeout
    }
  }
  return [];
}

