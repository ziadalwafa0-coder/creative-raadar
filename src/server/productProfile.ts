import type { VisualAttribute, MatchCategory } from '../types/index.ts';

export interface ProductMatchVerdict {
  asin: string; approved: boolean; matchCategory: MatchCategory; matchScore: number; userFacingLabelAr: string; reasonAr: string;
}

export function parseVisualDecisions(raw: unknown, eligibleAsins: string[]): Map<string, ProductMatchVerdict> {
  const rows = Array.isArray((raw as any)?.decisions) ? (raw as any).decisions : [];
  const allowed = new Set(eligibleAsins);
  const result = new Map<string, ProductMatchVerdict>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const asin = typeof row.asin === 'string' ? row.asin.toUpperCase() : '';
    if (!allowed.has(asin)) continue;
    if (result.has(asin)) duplicates.add(asin);
    const score = typeof row.matchScore === 'number' && Number.isFinite(row.matchScore) ? row.matchScore : 0;
    const approved = row.approved === true && score >= 90 && score <= 100 && ['exact_design','permitted_variation'].includes(row.matchCategory);
    result.set(asin, {asin, approved, matchScore:score, matchCategory:approved ? row.matchCategory : 'mismatched',
      userFacingLabelAr:approved ? 'تطابق بصري قوي؛ الموديل غير مؤكد' : 'المطابقة غير مؤكدة',
      reasonAr:clean(row.reasonAr, 300) || 'المقارنة البصرية غير حاسمة'});
  }
  for (const asin of duplicates) result.set(asin, {...result.get(asin)!, approved:false, matchCategory:'mismatched'});
  return result;
}

const clean = (value: unknown, limit = 160) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const list = (value: unknown) => Array.isArray(value) ? value.map(x => clean(x, 120)).filter(Boolean).slice(0, 12) : [];
const knownText = (value: string) => !/^(?:unknown|none|n\/a|not visible|unbranded|generic|غير معروف|غير واضح)$/i.test(value);

export function parseReferenceImage(value: unknown) {
  if (typeof value !== 'string' || value.length > 6 * 1024 * 1024) return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  return match && match[2].length >= 64 ? {mimeType: match[1], base64: match[2]} : null;
}

export function normalizeProductProfile(raw: unknown): VisualAttribute {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid image identity');
  const data = raw as Record<string, any>;
  const suggestedNameEn = clean(data.suggestedNameEn);
  if (!/[a-z]{3}/i.test(suggestedNameEn) || /[\u0600-\u06ff]/.test(suggestedNameEn) || /^(?:unknown|product|object|item)$/i.test(suggestedNameEn)) {
    throw new Error('لم يمكن تحديد اسم تجاري صالح من الصورة؛ استخدم صورة أوضح أو اكتب الاسم بالإنجليزية.');
  }
  const brandOrModelText = list(data.brandOrModelText).filter(knownText);
  const proposedCommercial = clean(data.commercialNameEn);
  const commercialNameEn = brandOrModelText.length && /[a-z]{3}/i.test(proposedCommercial) && !/[\u0600-\u06ff]/.test(proposedCommercial) ? proposedCommercial : suggestedNameEn;
  return {
    category: clean(data.category), suggestedNameAr: clean(data.suggestedNameAr), suggestedNameEn,
    commercialNameEn, brandOrModelText, distinctiveGeometry: clean(data.distinctiveGeometry, 500),
    components: list(data.components), materials: list(data.materials), colors: list(data.colors),
    visibleAccessories: list(data.visibleAccessories), mechanism: clean(data.mechanism, 300),
    mustMatchAttributes: list(data.mustMatchAttributes), allowedDifferences: list(data.allowedDifferences),
    unknownAttributes: list(data.unknownAttributes), confidence: ['high','medium','low'].includes(data.confidence) ? data.confidence : 'low',
    multilingualQueries: {ar: list(data.multilingualQueries?.ar), en: [...new Set([commercialNameEn,...list(data.multilingualQueries?.en).filter(query=>/[a-z]{3}/i.test(query) && !/[\u0600-\u06ff]/.test(query))])].slice(0,3)},
  };
}
