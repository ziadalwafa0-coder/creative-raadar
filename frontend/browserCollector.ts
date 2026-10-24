import {markets,type Marketplace,type ProductHit,type SearchEvent,SourceError} from '../backend/src/types';
import {parseCustomerVideoBlocks} from '../backend/src/parser';
import {parseRatingsCount,isAmazonErrorPage} from '../backend/src/utils';

export function browserRequest(operation:string,payload:Record<string,string>,signal:AbortSignal,timeout=30000):Promise<any>{
 signal.throwIfAborted();const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),target:id,operation:'cancel'},location.origin);reject(signal.reason||Error('تم إلغاء البحث'));};
  const receive=(event:MessageEvent)=>{if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='cr-browser-response'||event.data.id!==id)return;cleanup();if(event.data.error)reject(Error(event.data.error));else resolve(event.data);};
  const timer=setTimeout(()=>{cleanup();reject(Error(operation==='ping'?'ثبّت إضافة Creative Radaar المجانية ثم أعد تحميل الصفحة':'انقطع اتصال الإضافة؛ أعد المحاولة'));},timeout);
  signal.addEventListener('abort',abort,{once:true});window.addEventListener('message',receive);
  window.postMessage({channel:'cr-browser-request',id,operation,...payload},location.origin);
 });
}
export function readAmazonDocument(html:string):Document{
 const doc=new DOMParser().parseFromString(html,'text/html');const text=doc.body.textContent||'';
 if(isAmazonErrorPage(doc.title,text))throw new SourceError('BLOCKED','أمازون رفض الطلب من اتصالك؛ جرّب لاحقًا');
 if(/Robot Check|validateCaptcha|Enter the characters you see below|verify.*human/i.test(text))throw new SourceError('CAPTCHA','أمازون طلب تحققًا بشريًا؛ تم إيقاف الجلب');
 if(doc.querySelector('form[name="signIn"]'))throw new SourceError('LOGIN_WALL','أمازون طلب تسجيل الدخول؛ الجلب المجاني يقرأ الصفحات العامة فقط');
 return doc;
}
export function readBrowserProducts(doc:Document,market:Marketplace):ProductHit[]{
 const hits:ProductHit[]=[];
 for(const row of doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')){
  const asin=row.getAttribute('data-asin')||'';const title=row.querySelector('h2')?.textContent?.trim()||row.querySelector('img.s-image')?.getAttribute('alt')||'';
  if(!/^[A-Z0-9]{10}$/.test(asin)||!title)continue;
  const count=row.querySelector('a[aria-label*="ratings"], a[aria-label*="تقييم"]')?.getAttribute('aria-label')||row.querySelector('.s-underline-text')?.textContent;
  hits.push({asin,title,ratingsCount:parseRatingsCount(count),url:`https://${markets[market].host}/dp/${asin}`});if(hits.length===20)break;
 }
 if(!hits.length&&!/No results for|لم نعثر|لا توجد نتائج/i.test(doc.body.textContent||''))throw new SourceError('PARSE_EMPTY','لم تظهر نتائج منتجات قابلة للقراءة');
 return [...new Map(hits.map(h=>[h.asin,h])).values()].sort((a,b)=>b.ratingsCount-a.ratingsCount);
}
export async function searchInBrowser(query:string,market:Marketplace,id:string,signal:AbortSignal,emit:(event:SearchEvent)=>void,request=browserRequest){
 await request('ping',{},signal,1500);signal.throwIfAborted();
 const {html}=await request('search',{query,market},signal);signal.throwIfAborted();
 const products=readBrowserProducts(readAmazonDocument(html),market);const seen=new Set<string>();
 for(let index=0;index<products.length&&seen.size<50;index++){
  signal.throwIfAborted();const product=products[index];emit({id,type:'progress',index:index+1,total:products.length,asin:product.asin});
  try{
   const {html}=await request('product',{asin:product.asin,market},signal);signal.throwIfAborted();const doc=readAmazonDocument(html);
   const blocks=Array.from(doc.querySelectorAll('[data-video-items]'),n=>n.getAttribute('data-video-items')||'');
   const videos=parseCustomerVideoBlocks(blocks,product.asin,market);
   if(!videos.length&&!doc.querySelector('#customer-reviews_feature_div,#localTopReviews,#localTopReviewsList'))throw Error('قسم مراجعات العملاء لم يظهر لهذا المنتج');
   for(const video of videos){if(seen.has(video.url))continue;seen.add(video.url);emit({id,type:'video',video});if(seen.size>=50)break;}
  }catch(error){signal.throwIfAborted();emit({id,type:'warn',reason:error instanceof Error?error.message:'تعذر فحص المنتج'});if(error instanceof SourceError&&['CAPTCHA','BLOCKED','LOGIN_WALL'].includes(error.code))break;}
 }
 signal.throwIfAborted();emit({id,done:true,count:seen.size});
}
