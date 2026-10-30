import type { Request, Response } from 'express';
import { fetchAmazonSearchPage } from './amazonSearch.ts';
import { fetchProductImageAsBase64 } from './amazonHttp.ts';
import { evaluateStrictProductTitleMatch } from './queryBuilder.ts';
import { analyzeProductImage, isGeminiConfigured, verifyAmazonProductsBatchVisually } from './gemini.ts';
import { normalizeProductProfile } from './productProfile.ts';

export function parseReferenceImage(value: unknown) {
  if (typeof value !== 'string' || value.length > 6 * 1024 * 1024) return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  return match && match[2].length >= 64 ? {mimeType: match[1], base64: match[2]} : null;
}

const analysisRate = new Map<string, {count: number; until: number}>();
export async function handleProductImageAnalysis(req: Request, res: Response): Promise<void> {
  if (!isGeminiConfigured()) {
    res.status(503).json({code:'GEMINI_NOT_CONFIGURED', error:'Gemini غير مفعّل على السيرفر؛ استخدم التحليل المحلي المجاني.'});
    return;
  }
  const image = parseReferenceImage(req.body?.referenceImage);
  if (!image) { res.status(400).json({error:'صورة التحليل غير صالحة أو كبيرة جدًا.'}); return; }
  const owner = String((req as any).sessionId);
  const now = Date.now();
  for (const [key, value] of analysisRate) if (value.until <= now) analysisRate.delete(key);
  const rate = analysisRate.get(owner) || {count:0, until:now + 60_000};
  if (rate.count >= 10) { res.status(429).json({error:'تم بلوغ حد تحليل الصور لهذه الدقيقة. استخدم التحليل المحلي أو انتظر قليلًا.'}); return; }
  rate.count++; analysisRate.set(owner, rate);
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const name = typeof req.body.productName === 'string' ? req.body.productName.slice(0, 200) : '';
  const profile = await analyzeProductImage(image.base64, image.mimeType, undefined, undefined, name,
    AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
  if (!controller.signal.aborted) res.json({provider:'gemini', query:profile.commercialNameEn || profile.suggestedNameEn, profile});
}

// Preview only: no review collection starts until the browser identifies a listing.
export async function handleProductCandidates(req: Request, res: Response): Promise<void> {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 160) : '';
  const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim().slice(0, 160) : '';
  if (!/[a-z]{3}/i.test(query) || /[\u0600-\u06ff]/.test(query)) {
    res.status(400).json({ error: 'اكتب اسم البحث التجاري بالإنجليزية لتحديد نفس المنتج أولًا.' });
    return;
  }
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const { candidates } = await fetchAmazonSearchPage(query, 1, signal);
  const relevant = candidates.filter(c => c.imageUrl && evaluateStrictProductTitleMatch(c.title, query, productName).approved)
    .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0) || b.ratingCount - a.ratingCount).slice(0, 8);
  const products: Array<{ asin: string; title: string; url: string; image: string }> = [];
  for (let index = 0; index < relevant.length; index += 3) {
    signal.throwIfAborted();
    const batch = await Promise.all(relevant.slice(index, index + 3).map(async candidate => {
      const picture = await fetchProductImageAsBase64(candidate.imageUrl, signal);
      return picture ? { asin: candidate.asin, title: candidate.title, url: candidate.url, image: `data:${picture.mimeType};base64,${picture.base64}` } : null;
    }));
    products.push(...batch.filter((p): p is NonNullable<typeof p> => p !== null));
  }
  let verification: 'gemini' | 'unavailable' | 'not-requested' = 'not-requested';
  let approvedAsins: string[] = [];
  const reference = parseReferenceImage(req.body?.referenceImage);
  if (reference && isGeminiConfigured() && products.length) {
    let profile;
    try { profile = normalizeProductProfile(req.body.profile); } catch { profile = undefined; }
    const decisions = await verifyAmazonProductsBatchVisually(reference.base64, reference.mimeType, productName || query, profile,
      products.map(product => ({asin:product.asin, title:product.title,
        imageBase64:product.image.split(',')[1], imageMimeType:product.image.slice(5, product.image.indexOf(';'))})), undefined, signal);
    verification = decisions ? 'gemini' : 'unavailable';
    approvedAsins = profile?.confidence === 'low' ? [] : products.filter(product => decisions?.get(product.asin)?.approved).map(product => product.asin);
  }
  if (!controller.signal.aborted) res.json({ query, products, verification, approvedAsins });
}
