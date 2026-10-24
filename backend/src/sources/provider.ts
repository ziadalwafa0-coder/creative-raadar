import {SourceError,markets,type Marketplace,type ProductHit,type ReviewVideo,type VideoSource} from '../types.ts';
import {dedupeVideos,parseRatingsCount,safeMediaUrl,videoType} from '../utils.ts';

/** Normalized provider gateway. Unwrangle's documented API is supported explicitly. */
export class ApiProviderSource implements VideoSource {
 readonly name='provider';
 private async call(operation:'search'|'reviews',payload:Record<string,unknown>,market:Marketplace,signal?:AbortSignal):Promise<any>{
  const key=process.env.PROVIDER_API_KEY;const endpoint=process.env.PROVIDER_API_URL;const kind=process.env.PROVIDER_KIND||'gateway';
  if(!key||!endpoint)throw new SourceError('CONFIG','الـProvider غير مُعدّ: أضف عنوان خدمته ومفتاحه على الباك');
  const url=new URL(endpoint);if(url.protocol!=='https:')throw new SourceError('CONFIG','عنوان الـProvider يجب أن يكون HTTPS');
  let init:RequestInit;
  if(kind==='unwrangle'){
   if(market!=='amazon.com')throw new SourceError('CONFIG','هذا المحوّل لـUnwrangle مُفعّل لمتجر أمريكا فقط؛ استخدم gateway لبقية المتاجر');
   url.search=new URLSearchParams({platform:operation==='search'?'amazon_search':'amazon_reviews',country_code:markets[market].country,api_key:key,...(operation==='search'?{search:String(payload.query)}:{asin:String(payload.asin),media_type:'media_reviews_only',filter_by_star:'all_stars',page:'1'})}).toString();
   init={method:'GET'};
  }else{
   init={method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({operation,marketplace:market,...payload,media_reviews_only:operation==='reviews',customer_reviews_only:true})};
  }
  const response=await fetch(url,{...init,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok)throw new SourceError(response.status===403||response.status===503?'BLOCKED':'PROVIDER_ERROR',`تعذر جلب بيانات الـProvider (${response.status})`);
  const data=await response.json() as any;if(data.success===false)throw new SourceError('PROVIDER_ERROR','الـProvider لم يوفر بيانات متاحة لهذا الطلب');return data;
 }
 async search(query:string,market:Marketplace,signal?:AbortSignal):Promise<ProductHit[]>{
  const data=await this.call('search',{query},market,signal);const rows=process.env.PROVIDER_KIND==='unwrangle'?data.results:data.products;
  if(!Array.isArray(rows))throw new SourceError('PARSE_EMPTY','استجابة الـProvider لا تحتوي قائمة منتجات');
  return rows.filter((row:any)=>/^[A-Z0-9]{10}$/.test(row.asin)&&typeof(row.title||row.name)==='string').slice(0,20).map((row:any)=>({asin:row.asin,title:row.title||row.name,ratingsCount:parseRatingsCount(row.ratingsCount??row.total_ratings??row.review_count??row.rating_count),rating:Number(row.rating)||undefined,url:`https://${markets[market].host}/dp/${row.asin}`}));
 }
 async getCustomerVideos(asin:string,market:Marketplace,signal?:AbortSignal):Promise<ReviewVideo[]>{
  const data=await this.call('reviews',{asin},market,signal);const found:ReviewVideo[]=[];
  if(process.env.PROVIDER_KIND==='unwrangle'){
   if(!Array.isArray(data.reviews))throw new SourceError('PARSE_EMPTY','الـProvider لم يُرجع قائمة مراجعات');
   for(const review of data.reviews){
    if(review.variant?.asin&&review.variant.asin!==asin)continue;
    for(const item of review.review_videos||[]){
     const url=typeof item==='string'?item:item.url;const type=typeof url==='string'?videoType(url):undefined;
     if(type&&safeMediaUrl(url))found.push({url,type,title:review.review_title,sourceAsin:asin,sourceUrl:`https://${markets[market].host}/dp/${asin}`,customerReview:true});
    }
   }
  }else{
   if(!Array.isArray(data.videos))throw new SourceError('PARSE_EMPTY','الـProvider لم يُرجع قائمة فيديوهات');
   for(const row of data.videos){
    const type=typeof row.url==='string'?videoType(row.url):undefined;
    // Provider must attest customer origin and the exact source ASIN. Never infer it from a title.
    if(!type||!safeMediaUrl(row.url)||row.customerReview!==true||row.sourceAsin!==asin)continue;
    found.push({url:row.url,type,poster:safeMediaUrl(row.poster||'')?row.poster:undefined,title:typeof row.title==='string'?row.title:undefined,sentiment:['positive','negative','mixed'].includes(row.sentiment)?row.sentiment:undefined,sourceAsin:asin,sourceUrl:`https://${markets[market].host}/dp/${asin}`,customerReview:true});
   }
  }
  return dedupeVideos(found);
 }
}
