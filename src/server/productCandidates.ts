import type { Request, Response } from 'express';
import { analyzeProductImage, isGeminiConfigured } from './gemini.ts';
import { parseReferenceImage } from './productProfile.ts';
import {searchProductIdentity} from './identitySearch.ts';
export {parseReferenceImage} from './productProfile.ts';

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
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  const result=await searchProductIdentity({...req.body,query,productName},signal);
  if(!controller.signal.aborted) res.status(result.verification==='unavailable' ? 503 : 200).json({
    ...result,error:result.verification==='unavailable' ? 'تعذّر استكمال مقارنة الصور الآن؛ أعد المحاولة. لم نحكم بأن المنتج غير موجود.' : undefined,
  });
}
