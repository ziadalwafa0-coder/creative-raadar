import {fetchAmazonSearchPage} from './amazonSearch.ts';
import {fetchProductImageAsBase64} from './amazonHttp.ts';
import {isGeminiConfigured,verifyAmazonProductsBatchVisually} from './gemini.ts';
import {evaluateStrictProductTitleMatch} from './queryBuilder.ts';
import {normalizeProductProfile,parseReferenceImage} from './productProfile.ts';
import type {VisualAttribute} from '../types/index.ts';

const services={search:fetchAmazonSearchPage,picture:fetchProductImageAsBase64,verify:verifyAmazonProductsBatchVisually,ready:isGeminiConfigured};
export function identitySearchPlan(query:string,profile?:VisualAttribute) {
  const normalize=(text:string)=>text.toLowerCase().replace(/\s+/g,' ').trim();
  const alternate=[profile?.commercialNameEn,profile?.suggestedNameEn,...(profile?.multilingualQueries?.en || [])]
    .find(text=>text && /[a-z]{3}/i.test(text) && !/[\u0600-\u06ff]/.test(text) && normalize(text)!==normalize(query));
  return [{query,page:1}, alternate ? {query:alternate,page:1} : {query,page:2}, {query,page:alternate ? 2 : 3}];
}

export async function searchProductIdentity(input:Record<string,any>,signal:AbortSignal,dependencies=services) {
  const query=String(input.query || '').trim().slice(0,160), name=String(input.productName || '').slice(0,160);
  const reference=parseReferenceImage(input.referenceImage);
  let profile:VisualAttribute | undefined;
  try { profile=normalizeProductProfile(input.profile); } catch { /* Image comparison can still use the actual reference. */ }
  const cloud=Boolean(reference && dependencies.ready());
  const diagnostics={checkedCount:0,queriesTried:[] as string[],sourceIncomplete:false,reason:''};
  const products:Array<{asin:string;title:string;url:string;image:string}>=[];
  const finish=(verification:string)=>({query,products,verification,approvedAsins:verification==='gemini' ? products.map(product=>product.asin) : [],diagnostics});
  if(cloud && profile?.confidence==='low') { diagnostics.reason='REFERENCE_UNCERTAIN'; return finish('gemini'); }
  const seen=new Set<string>();
  for(const plan of identitySearchPlan(query,profile)) {
    signal.throwIfAborted();
    diagnostics.queriesTried.push(`${plan.query} (page ${plan.page})`);
    const {candidates}=await dependencies.search(plan.query,plan.page,signal);
    const relevant=candidates.filter(candidate=>!seen.has(candidate.asin) && candidate.imageUrl && evaluateStrictProductTitleMatch(candidate.title,plan.query,name).approved)
      .sort((a,b)=>b.ratingCount-a.ratingCount).slice(0,8);
    relevant.forEach(candidate=>seen.add(candidate.asin));
    const batch:typeof products=[];
    for(let offset=0;offset<relevant.length;offset+=3) {
      signal.throwIfAborted();
      const pictures=await Promise.all(relevant.slice(offset,offset+3).map(async candidate=>{
        const picture=await dependencies.picture(candidate.imageUrl,signal);
        if(!picture) { diagnostics.sourceIncomplete=true; return null; }
        return {asin:candidate.asin,title:candidate.title,url:candidate.url,image:`data:${picture.mimeType};base64,${picture.base64}`};
      }));
      batch.push(...pictures.filter((picture):picture is NonNullable<typeof picture>=>picture!==null));
    }
    signal.throwIfAborted();
    if(!cloud) { if(batch.length) { products.push(...batch); return finish('not-requested'); } continue; }
    if(!batch.length) continue;
    const decisions=await dependencies.verify(reference!.base64,reference!.mimeType,name||query,profile,
      batch.map(product=>({asin:product.asin,title:product.title,imageBase64:product.image.split(',')[1],imageMimeType:product.image.slice(5,product.image.indexOf(';'))})),undefined,signal);
    signal.throwIfAborted();
    if(!decisions) { diagnostics.reason='VERIFICATION_UNAVAILABLE'; return finish('unavailable'); }
    diagnostics.checkedCount+=batch.length;
    products.push(...batch.filter(product=>decisions.get(product.asin)?.approved));
    if(products.length) return finish('gemini');
  }
  diagnostics.reason=diagnostics.sourceIncomplete ? 'INCOMPLETE_IMAGES' : diagnostics.checkedCount ? 'NO_CONFIRMED_MATCH' : 'NO_READABLE_PRODUCTS';
  return finish(cloud ? 'gemini' : 'not-requested');
}
