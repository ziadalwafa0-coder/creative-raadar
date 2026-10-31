import {chromeRequest} from '../utils/chromeBridge.ts';
import {parseCustomerVideoBlocks} from './parser.ts';
import {parseRatingsCount,safeMediaUrl,videoIdentity} from './utils.ts';

type Fetcher=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
type BrowserProduct={asin:string;title:string;imageUrl:string;ratingCount:number};
const market='amazon.com';
async function session<T>(signal:AbortSignal,run:(jobId:string)=>Promise<T>){
  const jobId=crypto.randomUUID();
  await chromeRequest('begin_browser',{jobId},signal,5000);
  try{return await run(jobId);}finally{
    window.postMessage({channel:'cr-browser-request',operation:'stop_browser',jobId,id:crypto.randomUUID()},location.origin);
  }
}
async function readSearch(query:string,page:number,jobId:string,signal:AbortSignal):Promise<BrowserProduct[]>{
  const result=await chromeRequest('search',{query,page:String(page),market,jobId,transport:'tab'},signal);
  if(result.transport!=='tab'||result.page!==page||result.market!==market)throw Error('تعذّر تأكيد صفحة بحث أمازون.');
  const doc=new DOMParser().parseFromString(result.html,'text/html');
  return Array.from(doc.querySelectorAll('[data-asin]'),row=>({
    asin:row.getAttribute('data-asin')||'',title:row.querySelector('h2')?.textContent||'',
    imageUrl:row.querySelector('img')?.getAttribute('src')||'',
    ratingCount:parseRatingsCount(row.querySelector('a')?.getAttribute('aria-label')||'')
  })).slice(0,100);
}
async function findCandidates(body:any,jobId:string,signal:AbortSignal,fetcher:Fetcher,excluded:ReadonlySet<string>=new Set()){
  const seen=new Set<string>(excluded);
  const alt=body.profile?.commercialNameEn;
  const plan=alt&&alt!==body.query?[[body.query,1],[alt,1],[body.query,2]]:[[body.query,1],[body.query,2],[body.query,3]];
  let last:Response|undefined;
  for(const [query,page] of plan){
    const rows=await readSearch(query,page,jobId,signal);
    const fresh=rows.filter(r=>!seen.has(r.asin));
    for(const r of fresh)seen.add(r.asin);
    if(!fresh.length&&last)continue;
    last=await fetcher('/api/product-identity/candidates',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,query,browserProducts:fresh})});
    if(!last.ok)return last;
    const verdict=await last.clone().json();
    if(verdict.products?.length||verdict.diagnostics?.reason==='REFERENCE_UNCERTAIN')return last;
  }
  return last!;
}
async function collect(body:any,jobId:string,signal:AbortSignal,emit:(event:any)=>void,fetcher:Fetcher){
  const match=new URL(body.productUrl).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/);
  if(!match)throw Error('تعذّر تحديد معرّف المنتج من الرابط.');
  const videoLimit=body.mediaType==='photo'?0:body.targetVideoCount;
  const photoLimit=body.mediaType==='video'?0:body.targetPhotoCount;
  const seen=new Set<string>(), reviews=new Set<string>(), inspected=new Set<string>();let videos=0,photos=0;
  const full=()=>videos>=videoLimit&&photos>=photoLimit;
  function add(asset:any){
    const video=asset.mediaType==='video';
    const key=video?videoIdentity(asset.mediaUrl):asset.mediaUrl;
    const review=String(asset.reviewId||asset.sourceUrl?.match(/\/customer-reviews\/(R[A-Z0-9]+)/i)?.[1]||'');
    if(seen.has(key)||video&&(videos>=videoLimit||review&&reviews.has(review))||!video&&photos>=photoLimit)return;
    seen.add(key);if(video){videos++;if(review)reviews.add(review);}else photos++;
    emit({type:'result',asset:{...asset,id:crypto.randomUUID()}});
  }
  async function readPublicListing(asin:string){
    const listing='https://www.amazon.com/dp/'+asin;
    const response=await fetcher('/api/stream-search',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({
      searchId:crypto.randomUUID(),productName:body.productName,productUrl:listing,sourcePlatform:'amazon',mediaType:body.mediaType,
      targetVideoCount:videoLimit,targetPhotoCount:photoLimit
    })});
    if(!response.ok||!response.body)return;
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    try{
      while(!full()){
        const part=await reader.read();buffer+=decoder.decode(part.value,{stream:!part.done});
        const lines=buffer.split('\n');buffer=lines.pop()||'';
        for(const line of lines){if(!line.trim())continue;const e=JSON.parse(line),a=e.asset;
          if(e.type==='result'&&a?.productListingUrl===listing&&safeMediaUrl(a.mediaUrl)&&
            (a.mediaType==='photo'||a.mediaType==='video'&&/^R[A-Z0-9]+$/.test(a.reviewId)))add(a);
        }
        if(part.done)break;
      }
    }finally{await reader.cancel().catch(()=>{});}
  }
  async function readProduct(asin:string){
    inspected.add(asin);
    emit({type:'progress',message:'قراءة ريفيوهات أمازون للمنتج '+asin});
    try{await readPublicListing(asin);}catch{signal.throwIfAborted();}
    for(let pass=0;pass<3&&!full();pass++){
      const result=await chromeRequest('product',{asin,market,jobId,transport:'tab'},signal);
      if(result.asin!==asin||result.market!==market||result.transport!=='tab')throw Error('صفحة أمازون لا تخص المنتج المحدد.');
      const doc=new DOMParser().parseFromString(result.html,'text/html');
      const listing='https://www.amazon.com/dp/'+asin, before=seen.size;
      const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),node=>node.getAttribute('data-video-items')||'');
      for(const video of parseCustomerVideoBlocks(blocks,asin,market)){
        const key=videoIdentity(video.url);
        if(videos>=videoLimit||seen.has(key)||!video.sourceUrl.includes('/customer-reviews/'))continue;
        add({mediaType:'video',platform:'amazon',mediaUrl:video.url,downloadUrl:video.url,sourceUrl:video.sourceUrl,productListingUrl:listing,title:video.title,thumbnailUrl:video.poster});
      }
      for(const review of doc.querySelectorAll('[data-hook="review"]')){
        const variant=review.querySelector('[data-hook="format-strip"]')?.getAttribute('href');
        if(variant && variant!=='/dp/'+asin)continue;
        for(const img of review.querySelectorAll('[data-hook="review-image-tile"]')){
          const url=img.getAttribute('src')||'';
          if(photos>=photoLimit||!safeMediaUrl(url)||seen.has(url))continue;
          add({mediaType:'photo',platform:'amazon',mediaUrl:url,downloadUrl:url,sourceUrl:listing,productListingUrl:listing,title:'صورة ريفيو عميل',thumbnailUrl:url});
        }
      }
      if(seen.size===before)break;
    }
  }
  await readProduct(match[1]);
  const expansion=body.verifiedExpansion;
  while(!full()&&expansion?.referenceImage&&inspected.size<5){
    const response=await findCandidates({...expansion,productName:body.productName},jobId,signal,fetcher,inspected);
    if(!response.ok)break;
    const data=await response.json();
    const next=Array.from(new Set<string>(data.approvedAsins||[])).filter(asin=>!inspected.has(asin));
    if(!next.length)break;
    for(const asin of next){if(full()||inspected.size>=5)break;await readProduct(asin);}
  }
  emit({type:'completed',reasonIfPartial:full()?undefined:'العدد المتاح في الريفيوهات المقروءة أقل من العدد المطلوب.'});
}
export async function browserAwareFetch(input:RequestInfo|URL,init:RequestInit,fetcher:Fetcher):Promise<Response>{
  const isIdentity=input==='/api/product-identity/candidates', isStream=input==='/api/stream-search';
  if(!isIdentity&&!isStream)return fetcher(input,init);
  const body=JSON.parse(String(init.body));
  if(isStream&&(!body.productUrl||body.sourcePlatform!=='amazon'))return fetcher(input,init);
  const signal=init.signal||new AbortController().signal;
  let ping;
  try{ping=await chromeRequest('ping',{},signal,1200);}catch{signal.throwIfAborted();return fetcher(input,init);}
  if(!ping.browserNavigation)return fetcher(input,init);
  if(isIdentity)return session(signal,jobId=>findCandidates(body,jobId,signal,fetcher));
  const controller=new AbortController();
  const stop=AbortSignal.any([signal,controller.signal]);
  const stream=new ReadableStream<Uint8Array>({
    start(writer){
      const emit=(evt:any)=>{if(!stop.aborted)writer.enqueue(new TextEncoder().encode(JSON.stringify({...evt,searchId:body.searchId})+'\n'));};
      void session(stop,jobId=>collect(body,jobId,stop,emit,fetcher)).catch(error=>emit({type:'failed',error:error.message})).finally(()=>{try{writer.close();}catch{}});
    },cancel(){controller.abort();}
  });
  return new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}});
}
