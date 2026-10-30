import {fetchAmazonSearchPage, type AmazonUsProductCandidate} from './amazonSearch.ts';
import {fetchProductImageAsBase64} from './amazonHttp.ts';
import {evaluateStrictProductTitleMatch} from './queryBuilder.ts';
import {isGeminiConfigured, verifyAmazonProductsBatchVisually, type ProductMatchVerdict} from './gemini.ts';
import {normalizeProductProfile,parseReferenceImage} from './productProfile.ts';

const services={search:fetchAmazonSearchPage,picture:fetchProductImageAsBase64,verify:verifyAmazonProductsBatchVisually,ready:isGeminiConfigured};

// Every additional listing is checked against the ORIGINAL image on the server.
// Client-provided URLs or "approved" flags are never an admission rule.
export async function* collectVerifiedListings(input:unknown, name:string, excluded:Set<string>, signal:AbortSignal,
  progress:(message:string)=>void, shouldStop:()=>boolean=()=>false, dependencies=services):AsyncGenerator<Array<{page:AmazonUsProductCandidate; verdict:ProductMatchVerdict}>> {
  if (!input || typeof input !== 'object' || !dependencies.ready()) return;
  const data=input as Record<string,any>;
  const reference=parseReferenceImage(data.referenceImage);
  const query=typeof data.query==='string' ? data.query.trim().slice(0,160) : '';
  if (!reference || !/[a-z]{3}/i.test(query) || /[\u0600-\u06ff]/.test(query)) return;
  let profile;
  try { profile=normalizeProductProfile(data.profile); } catch { return; }
  if (profile.confidence==='low') return;
  const seen=new Set(excluded);
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(90_000)]);
  for(let pageNumber=1;pageNumber<=3;pageNumber++) {
    if (shouldStop()) return;
    deadline.throwIfAborted();
    progress(`استكمال العدد: البحث في الصفحة ${pageNumber} ومقارنة الصور قبل قبول أي قائمة إضافية…`);
    const {candidates}=await dependencies.search(query,pageNumber,deadline);
    const fresh=candidates.filter(candidate=>!seen.has(candidate.asin) && candidate.imageUrl && evaluateStrictProductTitleMatch(candidate.title,query,name).approved)
      .sort((a,b)=>b.ratingCount-a.ratingCount).slice(0,16);
    for(const candidate of fresh) seen.add(candidate.asin);
    for(let i=0;i<fresh.length;i+=8) {
      if (shouldStop()) return;
      deadline.throwIfAborted();
      const batch=fresh.slice(i,i+8);
      const photos=await Promise.all(batch.map(async candidate=>({candidate,picture:await dependencies.picture(candidate.imageUrl,deadline)})));
      if (shouldStop()) return;
      const decisions=await dependencies.verify(reference.base64,reference.mimeType,name,profile,
        photos.map(({candidate,picture})=>({asin:candidate.asin,title:candidate.title,imageBase64:picture?.base64,imageMimeType:picture?.mimeType})),undefined,deadline);
      if (!decisions) { progress('تعذرت مقارنة الصور الإضافية؛ لم نُضف أي منتج غير مؤكد.'); return; }
      const approved=photos.flatMap(({candidate,picture})=>{
        const verdict=decisions.get(candidate.asin);
        return picture && verdict?.approved ? [{page:candidate,verdict}] : [];
      });
      if (approved.length) yield approved;
    }
  }
}
