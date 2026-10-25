import {markets,type Marketplace,type ProductHit,type SearchEvent,SourceError} from '../backend/src/types';
import {parseCustomerVideoBlocks} from '../backend/src/parser';
import {parseRatingsCount,isAmazonErrorPage} from '../backend/src/utils';
import {safeMediaUrl} from '../backend/src/utils';
export interface ReviewImage {url:string;sourceAsin:string;sourceUrl:string;title:string}
export type BrowserProduct=ProductHit&{imageUrl?:string};
export type BrowserEvent=SearchEvent|{id:string;type:'image';image:ReviewImage};
export interface MediaLimits {videos:number;images:number}

export function browserRequest(operation:string,payload:Record<string,string>,signal:AbortSignal,timeout=30000):Promise<any>{
 signal.throwIfAborted();const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),target:id,operation:'cancel'},location.origin);reject(signal.reason||Error('تم إلغاء البحث'));};
  const receive=(event:MessageEvent)=>{
   if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='cr-browser-response'||event.data.id!==id||event.data.protocol!==2)return;
   cleanup();
   if(event.data.error)reject(['BLOCKED','NETWORK','CAPTCHA','LOGIN_WALL'].includes(event.data.code)?new SourceError(event.data.code,event.data.error):Error(event.data.error));
   else if(operation==='search'&&event.data.page!==Number(payload.page||1))reject(Error('نسخة الإضافة المحمّلة قديمة؛ حمّل النسخة الجديدة وفكها في نفس فولدر الإضافة ثم اضغط Reload. النسخة القديمة تعيد أول صفحة بدل الانتقال للصفحات التالية.'));
   else resolve(event.data);
  };
  const timer=setTimeout(()=>{cleanup();reject(Error(operation==='ping'?'ثبّت إضافة Creative Radaar المجانية ثم أعد تحميل الصفحة':'انقطع اتصال الإضافة؛ أعد المحاولة'));},timeout);
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('message',receive);
  window.postMessage({channel:'cr-browser-request',id,operation,...payload},location.origin);
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
  const asin=row.getAttribute('data-asin')||'';const title=row.querySelector('h2')?.textContent?.trim()||row.querySelector('img.s-image')?.getAttribute('alt')||'';
  if(!/^[A-Z0-9]{10}$/.test(asin)||!title)continue;
  const count=row.querySelector('a[aria-label*="ratings"], a[aria-label*="تقييم"]')?.getAttribute('aria-label')||row.querySelector('.s-underline-text')?.textContent;
  const image=row.querySelector('img.s-image')?.getAttribute('src')||'';
  hits.push({asin,title,ratingsCount:parseRatingsCount(count),url:`https://${markets[market].host}/dp/${asin}`,...(safeMediaUrl(image)?{imageUrl:image}:{})});if(hits.length===20)break;
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
 const {html}=await request('product',{asin:product.asin,market},signal);signal.throwIfAborted();
 const doc=readAmazonDocument(html);
 const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),n=>n.getAttribute('data-video-items')||'');
 const videos=parseCustomerVideoBlocks(blocks,product.asin,market);
 const images=readCustomerImages(doc,product.asin,market);
 const seen=new Set<string>();let count=0,photos=0;
 for(const video of videos){if(count>=requested.videos)break;if(seen.has(video.url))continue;seen.add(video.url);count++;emit({id,type:'video',video});}
 seen.clear();for(const image of images){if(photos>=requested.images)break;if(seen.has(image.url))continue;seen.add(image.url);photos++;emit({id,type:'image',image});}
 if(count<requested.videos||photos<requested.images)emit({id,type:'warn',reason:'العدد المتاح يخص المنتج المؤكّد فقط؛ لم نضف ريفيوهات منتجات أخرى لاستكمال العدد.'});
 signal.throwIfAborted();emit({id,done:true,count});
}
export async function searchInBrowser(query:string,market:Marketplace,id:string,signal:AbortSignal,emit:(event:BrowserEvent)=>void,request=browserRequest,requested:MediaLimits={videos:50,images:0},acceptProduct?:(product:ProductHit)=>boolean,preferredAsin?:string){
 const limits={videos:Math.max(0,Math.min(50,Math.floor(requested.videos)||0)),images:Math.max(0,Math.min(50,Math.floor(requested.images)||0))};
 if(!limits.videos&&!limits.images)throw Error('حدد عدد فيديوهات أو صور أكبر من صفر');
 const capability=await request('ping',{},signal,1500);signal.throwIfAborted();
 const seen=new Set<string>();const seenImages=new Set<string>();const visited=new Set<string>();let blocked=false;
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
   const {html}=await request('product',{asin:product.asin,market},signal);signal.throwIfAborted();const doc=readAmazonDocument(html);
   const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),n=>n.getAttribute('data-video-items')||'');
   const videos=parseCustomerVideoBlocks(blocks,product.asin,market);
   const images=readCustomerImages(doc,product.asin,market);
   if(!videos.length&&!images.length&&!doc.querySelector('#customer-reviews_feature_div,#localTopReviews,#localTopReviewsList'))throw Error('قسم مراجعات العملاء لم يظهر لهذا المنتج');
   for(const video of videos){if(seen.size>=limits.videos)break;if(seen.has(video.url))continue;seen.add(video.url);emit({id,type:'video',video});}
   for(const image of images){if(seenImages.size>=limits.images)break;if(seenImages.has(image.url))continue;seenImages.add(image.url);emit({id,type:'image',image});}
  }catch(error){signal.throwIfAborted();emit({id,type:'warn',reason:error instanceof Error?error.message:'تعذر فحص المنتج'});if(error instanceof SourceError&&['CAPTCHA','BLOCKED','LOGIN_WALL'].includes(error.code)){blocked=true;break;}}
  }
 }
 signal.throwIfAborted();emit({id,done:true,count:seen.size});
}
