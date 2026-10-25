import {markets,type Marketplace,type ProductHit,type SearchEvent,SourceError} from '../backend/src/types';
import {parseCustomerVideoBlocks} from '../backend/src/parser';
import {parseRatingsCount,isAmazonErrorPage} from '../backend/src/utils';
import {safeMediaUrl} from '../backend/src/utils';
export interface ReviewImage {url:string;sourceAsin:string;sourceUrl:string;title:string}
export type BrowserProduct=ProductHit&{imageUrl?:string};
export type BrowserEvent=SearchEvent|{id:string;type:'image';image:ReviewImage};
export interface MediaLimits {videos:number;images:number}
export interface ReviewDiagnostics {reviews:number;videoBlocks:number;videoItems:number;hasReviewsSection:boolean;scrolled?:boolean;clickedTab?:boolean}
export function describeEmptyProduct(asin:string,d?:ReviewDiagnostics){
 if(!d)return `${asin}: تعذر تشخيص الريفيوهات؛ حدّث الإضافة إلى 1.3.1.`;
 if(!d.hasReviewsSection)return `${asin}: قسم الريفيوهات ما ظهرش في الصفحة المقروءة.`;
 if(d.videoItems)return `${asin}: لقينا ${d.videoItems} فيديو واترفضوا (مش ريفيو عميل أو لموديل تاني).`;
 return `${asin}: لقينا ${d.reviews} ريفيو بس مفيش قسم فيديوهات للعملاء${d.clickedTab?' بعد فتح تبويب الفيديوهات':''}.`;
}
function reviewDiagnostics(doc:Document):ReviewDiagnostics{
 const blocks=Array.from(doc.querySelectorAll('[data-video-items]'));let videoItems=0;
 for(const b of blocks)try{const items=JSON.parse(b.getAttribute('data-video-items')||'[]');if(Array.isArray(items))videoItems+=items.length;}catch{}
 return{reviews:doc.querySelectorAll('[data-hook="review"]').length,videoBlocks:blocks.length,videoItems,hasReviewsSection:Boolean(doc.querySelector('#customer-reviews_feature_div,#localTopReviews,#reviewsMedley,#cm-cr-dp-review-list,[data-hook="review"]'))};
}
const browserJobs=new WeakMap<AbortSignal,string>();
export function inheritBrowserSession(parent:AbortSignal,child:AbortSignal){const job=browserJobs.get(parent);if(job)browserJobs.set(child,job);return child;}
export async function beginBrowserSession(jobId:string,signal:AbortSignal){
 const capability=await browserRequest('ping',{},signal,1800);
 if(capability.multipleCollectors)throw Error('في أكثر من نسخة للإضافة مفعّلة. اقفل النسخ القديمة وسيب Creative Radaar 1.3.1 فقط ثم أعد تحميل الموقع.');
 if(!capability.directFetch||!capability.reviewReveal)throw Error('البحث الجديد يحتاج إضافة Creative Radaar 1.3.1؛ حدّثها لتفعيل الجلب بدون فتح تبويبات.');
 signal.throwIfAborted();browserJobs.set(signal,jobId);
 // Chrome may suspend an idle MV3 worker while local image inference is running.
 // This heartbeat reads no Amazon page and ends with the ephemeral search session.
 const heartbeat=setInterval(()=>window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),operation:'ping'},location.origin),20000);
 const stop=()=>{clearInterval(heartbeat);window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),operation:'stop_browser',jobId},location.origin);};
 signal.addEventListener('abort',stop,{once:true});
 try{await browserRequest('begin_browser',{jobId},signal,5000);return()=>clearInterval(heartbeat);}
 catch(e){clearInterval(heartbeat);signal.removeEventListener('abort',stop);browserJobs.delete(signal);throw e;}
}

export function browserRequest(operation:string,payload:Record<string,string>,signal:AbortSignal,timeout=60000):Promise<any>{
 signal.throwIfAborted();const id=crypto.randomUUID();
 const automated=operation==='search'||operation==='product';
 const jobId=browserJobs.get(signal);
 if(automated&&!jobId)return Promise.reject(Error('ابدأ البحث من الموقع لتفعيل جلسة Chrome الجديدة.'));
 return new Promise((resolve,reject)=>{
  let pingTimer:ReturnType<typeof setTimeout>|undefined;const pingReplies:any[]=[];
  const cleanup=()=>{clearTimeout(timer);clearTimeout(pingTimer);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),target:id,operation:'cancel'},location.origin);reject(signal.reason||Error('تم إلغاء البحث'));};
  const receive=(event:MessageEvent)=>{
   if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='cr-browser-response'||event.data.id!==id)return;
   if(operation==='ping'){
    pingReplies.push(event.data);
    if(event.data.protocol===2&&!pingTimer)pingTimer=setTimeout(()=>{
     cleanup();const valid=pingReplies.filter(r=>r.protocol===2&&!r.error).sort((a,b)=>String(b.version).localeCompare(String(a.version),undefined,{numeric:true}));
     if(!valid.length)reject(Error('الإضافة لم ترد بشكل صحيح'));else resolve({...valid[0],multipleCollectors:pingReplies.length>1});
    },250);
    return;
   }
   if(event.data.protocol!==2||automated&&event.data.transport!=='http')return;
   cleanup();
   if(event.data.error)reject(['BLOCKED','NETWORK','CAPTCHA','LOGIN_WALL'].includes(event.data.code)?new SourceError(event.data.code,event.data.error):Error(event.data.error));
   else if(operation==='search'&&event.data.page!==Number(payload.page||1))reject(Error('نسخة الإضافة المحمّلة قديمة؛ حمّل النسخة الجديدة وفكها في نفس فولدر الإضافة ثم اضغط Reload. النسخة القديمة تعيد أول صفحة بدل الانتقال للصفحات التالية.'));
   else resolve(event.data);
  };
  const timer=setTimeout(()=>{cleanup();if(automated)window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),target:id,operation:'cancel'},location.origin);reject(Error(operation==='ping'?'ثبّت إضافة Creative Radaar المجانية ثم أعد تحميل الصفحة':operation==='read_open_product'?'صفحة أمازون لم ترد. ارجع إليها حتى تظهر بشكل طبيعي، ثم ارجع للموقع واقرأها مرة أخرى.':'تبويب أمازون لم يكتمل في الوقت المحدد؛ راجعه قبل بدء بحث آخر.'));},timeout);
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('message',receive);
  window.postMessage({channel:'cr-browser-request',id,operation,...payload,...(automated?{transport:'http',jobId}:{})},location.origin);
 });
}
export function readAmazonDocument(html:string):Document{
 const doc=new DOMParser().parseFromString(html,'text/html');const text=doc.body.textContent||'';
 if(isAmazonErrorPage(doc.title,text))throw new SourceError('BLOCKED','أمازون رفض الطلب من اتصالك؛ جرّب لاحقًا');
 if(/Click the button below to continue shopping/i.test(text))throw new SourceError('BLOCKED','أمازون أوقف الوصول للصفحة؛ تم إيقاف الفحص دون اعتماد منتجات بديلة');
 if(/Robot Check|validateCaptcha|Enter the characters you see below|verify.*human/i.test(text))throw new SourceError('CAPTCHA','أمازون طلب تحققًا بشريًا؛ تم إيقاف الجلب');
 if(doc.querySelector('form[name="signIn"]'))throw new SourceError('LOGIN_WALL','أمازون طلب تسجيل الدخول؛ الجلب المجاني يقرأ الصفحات العامة فقط');
 return doc;
}
export function readBrowserProducts(doc:Document,market:Marketplace):BrowserProduct[]{
 const hits:BrowserProduct[]=[];
 for(const row of doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')){
  const asin=row.getAttribute('data-asin')||'';
  const titleNode=row.querySelector('h2[aria-label],a.a-text-normal h2,a[href*="/dp/"] h2')||row.querySelector('h2');
  const title=titleNode?.getAttribute('aria-label')||titleNode?.textContent?.trim()||row.querySelector('img.s-image')?.getAttribute('alt')||'';
  if(!/^[A-Z0-9]{10}$/.test(asin)||!title)continue;
  const count=row.querySelector('a[aria-label*="ratings"], a[aria-label*="تقييم"]')?.getAttribute('aria-label')||row.querySelector('.s-underline-text')?.textContent;
  const image=row.querySelector('img.s-image')?.getAttribute('src')||'';
  hits.push({asin,title,ratingsCount:parseRatingsCount(count),url:`https://${markets[market].host}/dp/${asin}`,...(safeMediaUrl(image)?{imageUrl:image}:{})});if(hits.length===100)break;
 }
 if(!hits.length&&!/No results for|لم نعثر|لا توجد نتائج/i.test(doc.body.textContent||''))throw new SourceError('PARSE_EMPTY','لم تظهر نتائج منتجات قابلة للقراءة');
 return [...new Map(hits.map(h=>[h.asin,h])).values()].sort((a,b)=>b.ratingsCount-a.ratingsCount);
}
export function readCustomerImages(doc:Document,asin:string,market:Marketplace):ReviewImage[]{
 const found:ReviewImage[]=[];const seen=new Set<string>();
 for(const review of doc.querySelectorAll('[data-hook="review"]')){
  const variant=review.querySelector('a[data-hook="format-strip"]')?.getAttribute('href')?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];if(variant&&variant!==asin)continue;
  const title=review.querySelector('[data-hook="review-title"]')?.textContent?.trim()||'صورة عميل';
  for(const image of review.querySelectorAll('img[data-hook="review-image-tile"],img.review-image-tile')){
   const url=image.getAttribute('data-src')||image.getAttribute('src')||'';
   if(!safeMediaUrl(url)||seen.has(url))continue;seen.add(url);found.push({url,sourceAsin:asin,sourceUrl:`https://${markets[market].host}/dp/${asin}`,title});
  }
 }
 return found;
}
/** Image-approved searches are pinned to one ASIN, never broadened to fill the requested count. */
export async function collectApprovedProduct(product:BrowserProduct,market:Marketplace,id:string,signal:AbortSignal,emit:(event:BrowserEvent)=>void,requested:MediaLimits,request=browserRequest){
 if(!/^[A-Z0-9]{10}$/.test(product.asin))throw Error('معرّف منتج غير صحيح');
 signal.throwIfAborted();emit({id,type:'progress',index:1,total:1,asin:product.asin});
 const result=await request('product',{asin:product.asin,market},signal);signal.throwIfAborted();
 return collectProductDocument(result.html,product.asin,market,id,signal,emit,requested,result.diagnostics);
}
export function collectProductDocument(html:string,asin:string,market:Marketplace,id:string,signal:AbortSignal,emit:(event:BrowserEvent)=>void,requested:MediaLimits,diagnostics?:ReviewDiagnostics){
 if(!/^[A-Z0-9]{10}$/.test(asin)||!(market in markets))throw Error('بيانات منتج غير صحيحة');
 if(Object.values(requested).some(n=>!Number.isInteger(n)||n<0||n>50)||!requested.videos&&!requested.images)throw Error('حدد عددًا صحيحًا من 1 إلى 50 لكل نوع مطلوب');
 signal.throwIfAborted();
 const doc=readAmazonDocument(html);
 const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),n=>n.getAttribute('data-video-items')||'');
 const videos=parseCustomerVideoBlocks(blocks,asin,market);
 const images=readCustomerImages(doc,asin,market);
 if(requested.videos&&!videos.length)emit({id,type:'warn',reason:describeEmptyProduct(asin,diagnostics||reviewDiagnostics(doc))});
 const seen=new Set<string>();let count=0,photos=0;
 for(const video of videos){if(count>=requested.videos)break;if(seen.has(video.url))continue;seen.add(video.url);count++;emit({id,type:'video',video});}
 seen.clear();for(const image of images){if(photos>=requested.images)break;if(seen.has(image.url))continue;seen.add(image.url);photos++;emit({id,type:'image',image});}
 if(count<requested.videos||photos<requested.images)emit({id,type:'warn',reason:'العدد المتاح يخص المنتج المؤكّد فقط؛ لم نضف ريفيوهات منتجات أخرى لاستكمال العدد.'});
 signal.throwIfAborted();emit({id,done:true,count});
}
export async function searchInBrowser(query:string,market:Marketplace,id:string,signal:AbortSignal,emit:(event:BrowserEvent)=>void,request=browserRequest,requested:MediaLimits={videos:50,images:0},acceptProduct?:(product:ProductHit)=>boolean,preferredAsin?:string,history={videos:new Set<string>(),images:new Set<string>(),asins:new Set<string>()}){
 const limits={videos:Math.max(0,Math.min(50,Math.floor(requested.videos)||0)),images:Math.max(0,Math.min(50,Math.floor(requested.images)||0))};
 if(!limits.videos&&!limits.images)throw Error('حدد عدد فيديوهات أو صور أكبر من صفر');
 const capability=await request('ping',{},signal,1500);signal.throwIfAborted();
 const seen=new Set<string>();const seenImages=new Set<string>();const visited=history.asins;let blocked=false,inspected=0;const reasons:string[]=[];
 for(let page=1;page<=5&&(seen.size<limits.videos||seenImages.size<limits.images)&&!blocked;page++){
  if(page>1&&capability.pagination!==true)throw Error('حدّث الإضافة بالضغط على Reload في صفحة إضافات Chrome لتفعيل البحث في الصفحات التالية');
  const result=await request('search',{query,market,page:String(page)},signal);signal.throwIfAborted();
  if(result.page!==undefined&&result.page!==page)throw Error('أعد تحميل الإضافة والصفحة لتفعيل الانتقال الصحيح بين صفحات البحث');
  const {html}=result;
  const pageProducts=readBrowserProducts(readAmazonDocument(html),market).filter(product=>!visited.has(product.asin));
  if(!pageProducts.length)break;
  const products=pageProducts.filter(product=>!acceptProduct||acceptProduct(product));
  products.sort((a,b)=>Number(b.asin===preferredAsin)-Number(a.asin===preferredAsin));
  for(const product of pageProducts)if(!products.includes(product))visited.add(product.asin);
  const total=visited.size+products.length;
  for(let index=0;index<products.length&&(seen.size<limits.videos||seenImages.size<limits.images);index++){
  signal.throwIfAborted();const product=products[index];visited.add(product.asin);emit({id,type:'progress',index:visited.size,total,asin:product.asin});
  try{
   inspected++;const result=await request('product',{asin:product.asin,market},signal);signal.throwIfAborted();const doc=readAmazonDocument(result.html);
   const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),n=>n.getAttribute('data-video-items')||'');
   const videos=parseCustomerVideoBlocks(blocks,product.asin,market);
   const images=readCustomerImages(doc,product.asin,market);
   if(limits.videos&&!videos.length&&reasons.length<3)reasons.push(describeEmptyProduct(product.asin,result.diagnostics||reviewDiagnostics(doc)));
   for(const video of videos){if(seen.size>=limits.videos)break;if(seen.has(video.url)||history.videos.has(video.url))continue;seen.add(video.url);history.videos.add(video.url);emit({id,type:'video',video});}
   for(const image of images){if(seenImages.size>=limits.images)break;if(seenImages.has(image.url)||history.images.has(image.url))continue;seenImages.add(image.url);history.images.add(image.url);emit({id,type:'image',image});}
  }catch(error){signal.throwIfAborted();emit({id,type:'warn',reason:error instanceof Error?error.message:'تعذر فحص المنتج',code:error instanceof SourceError?error.code:undefined});if(error instanceof SourceError&&['CAPTCHA','BLOCKED','LOGIN_WALL'].includes(error.code))throw error;}
  }
 }
 signal.throwIfAborted();if(!seen.size&&!seenImages.size)emit({id,type:'warn',reason:`فحصنا ${inspected} منتج وما لقيناش ${limits.videos?'فيديوهات ريفيو عملاء':'صور عملاء'} في أي واحد منهم. `+reasons.join(' ')});emit({id,done:true,count:seen.size});
}
