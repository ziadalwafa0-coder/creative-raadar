import {SourceError,type Marketplace,type VideoSource,type SearchEvent} from './types.ts';
import type {MediaCache} from './cache.ts';
import {dedupeVideos,safeMediaUrl} from './utils.ts';
export type DebugResult={status:'ok'|'empty'|'error';count:number;error?:string;durationMs:number;source:string;at:string};
export async function* searchVideos(q:string,market:Marketplace,id:string,source:VideoSource,cache:MediaCache,signal:AbortSignal,debug:(asin:string,result:DebugResult)=>void=()=>{}):AsyncGenerator<SearchEvent>{
 let count=0;const seen=new Set<string>();
 const drain=()=>('drainWarnings'in source?(source as VideoSource&{drainWarnings:()=>SourceError[]}).drainWarnings():[]).map(error=>({type:'warn' as const,id,reason:error.message,code:error.code}));
 yield {type:'progress',id,index:0,total:0};
 try{
  signal.throwIfAborted();let products=await cache.getSearch(market,q);const searchCached=products!==undefined;
  if(!products){products=await source.search(q,market,signal);signal.throwIfAborted();await cache.setSearch(market,q,products);}
  for(const warning of drain())yield warning;
  products=[...new Map(products.slice(0,20).map(hit=>[hit.asin,hit])).values()].sort((a,b)=>b.ratingsCount-a.ratingsCount).slice(0,10);
  if(!products.length)yield {type:'warn',id,reason:'لا توجد منتجات مطابقة لهذا البحث'};
  for(let index=0;index<products.length&&count<12;index++){
   signal.throwIfAborted();const product=products[index];const started=Date.now();let fromCache=false;
   yield {type:'progress',id,index:index+1,total:products.length,asin:product.asin,cached:searchCached};
   try{
    let videos=await cache.getProduct(market,product.asin);fromCache=videos!==undefined;
    if(!videos){videos=await source.getCustomerVideos(product.asin,market,signal);signal.throwIfAborted();videos=dedupeVideos(videos.filter(v=>v.customerReview===true&&v.sourceAsin===product.asin&&safeMediaUrl(v.url)));await cache.setProduct(market,product.asin,videos);}
    for(const warning of drain())yield warning;
    debug(product.asin,{status:videos.length?'ok':'empty',count:videos.length,durationMs:Date.now()-started,source:fromCache?'cache':('lastSource'in source?String(source.lastSource):source.name),at:new Date().toISOString()});
    for(const video of videos){signal.throwIfAborted();if(count>=12)break;if(seen.has(video.url)||video.sourceAsin!==product.asin||video.customerReview!==true||!safeMediaUrl(video.url))continue;seen.add(video.url);count++;yield {type:'video',id,video};}
   }catch(error){
    signal.throwIfAborted();const typed=error instanceof SourceError?error:new SourceError('NETWORK','فشل الاتصال بمصدر الفيديوهات');
    debug(product.asin,{status:'error',count:0,error:typed.code,durationMs:Date.now()-started,source:source.name,at:new Date().toISOString()});
    for(const warning of drain())yield warning;
    yield {type:'warn',id,reason:typed.message,code:typed.code};
   }
  }
  if(!count&&products.length)yield {type:'warn',id,reason:'لم تتوفر فيديوهات عملاء قابلة للعرض؛ راجع التحذيرات لمعرفة إن كان السبب حظرًا أو عدم وجود فيديوهات'};
 }catch(error){signal.throwIfAborted();for(const warning of drain())yield warning;const typed=error instanceof SourceError?error:new SourceError('NETWORK','فشل الاتصال');yield {type:'warn',id,reason:typed.message,code:typed.code};}
 yield {done:true,id,count};
}
