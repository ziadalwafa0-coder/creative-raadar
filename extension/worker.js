const VERSION='1.3.1';
const origins=new Set(['https://creative-raadar.vercel.app','http://127.0.0.1:5173','http://localhost:5173']);
const markets=new Set(['amazon.com','amazon.eg','amazon.sa','amazon.ae']);
const workspaces=new Map();
let queue=Promise.resolve();
let nextNavigation=0;
export function requestUrl(message){
 if(!markets.has(message.market))throw Error('متجر غير مسموح');
 const base=`https://www.${message.market}`;
 if(message.operation==='search'&&typeof message.query==='string'&&message.query.trim().length>=3&&message.query.length<=200){
  const page=Number(message.page||1);if(!Number.isInteger(page)||page<1||page>5)throw Error('صفحة غير صالحة');
  return `${base}/s?k=${encodeURIComponent(message.query.trim())}${page>1?`&page=${page}`:''}`;
 }
 if(message.operation==='product'&&/^[A-Z0-9]{10}$/.test(message.asin))return `${base}/dp/${message.asin}`;
 throw Error('طلب غير صالح');
}
export function openedProduct(url){
 try{const u=new URL(url),market=u.hostname.replace(/^www\./,''),asin=u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  if(u.protocol==='https:'&&u.hostname==='www.'+market&&markets.has(market)&&asin)return{market,asin,url:`https://www.${market}/dp/${asin}`};
 }catch{}return null;
}
export function samePage(actual,expected){
 try{
  const a=new URL(actual),e=new URL(expected);
  if(a.origin!==e.origin)return false;
  const product=openedProduct(expected);if(product)return openedProduct(actual)?.asin===product.asin;
  return /^\/s\/?$/.test(a.pathname)&&a.searchParams.get('k')===e.searchParams.get('k')&&Number(a.searchParams.get('page')||1)===Number(e.searchParams.get('page')||1);
 }catch{return false;}
}
function error(message,code='NETWORK'){return Object.assign(new Error(message),{code});}
function pause(ms,signal){return new Promise((resolve,reject)=>{
 const abort=()=>{clearTimeout(timer);reject(error('تم إيقاف البحث'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
function until(promise,signal,ms=10000){return new Promise((resolve,reject)=>{
 const done=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value);};
 const abort=()=>done(reject,error('تم إيقاف البحث'));
 const timer=setTimeout(()=>done(reject,error('صفحة أمازون لم تكتمل في الوقت المحدد')),ms);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
 promise.then(value=>done(resolve,value),reason=>done(reject,reason));
});}
async function readRendered(tabId,operation,signal,url){
 const before=await chrome.tabs.get(tabId);if(!samePage(before.url,url))throw error('تغير تبويب المصدر؛ لم نقرأ الصفحة المختلفة','BLOCKED');
 let response;
 // A content script may register just after tabs.onUpdated. Message retry only; no navigation retry.
 for(let i=0;i<2;i++){
  try{response=await until(chrome.tabs.sendMessage(tabId,{operation:operation==='search'?'cr-read-search':'cr-read-open-product'},{frameId:0}),signal,20000);break;}
  catch(e){signal.throwIfAborted();if(i||!/receiving end|establish connection/i.test(String(e?.message)))throw e;await pause(300,signal);}
 }
 if(response?.error)throw error(response.error,response.code||'PARSE_EMPTY');
 const final=await chrome.tabs.get(tabId);
 if(!samePage(final.url,url)||!samePage(response?.url||'',url))throw error('تغيّرت صفحة المصدر أثناء القراءة؛ لم نعتمد بياناتها','BLOCKED');
 if(typeof response.html!=='string'||response.html.length>4*1024*1024)throw error('بيانات المصدر غير صالحة');
 return response;
}
async function fetchPublic(owner,workspace,message,signal){
 const url=requestUrl(message);signal.throwIfAborted();
 const gap=Math.max(0,nextNavigation-Date.now());if(gap)await pause(gap,signal);
 if(workspaces.get(owner)!==workspace||workspace.closed)throw error('بدأ بحث جديد أو تم إيقاف البحث');
 if(workspace.blocked)throw error('أمازون رفض هذا البحث؛ توقف الجلب','BLOCKED');
 nextNavigation=Date.now()+2200;
 const response=await fetch(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(25000)])});
 if([403,429,503].includes(response.status))throw error('أمازون رفض الجلب المباشر بدون تبويب ('+response.status+'). لم نفتح أي تبويب ولم نغيّر طريقة الوصول.','BLOCKED');
 if(!response.ok)throw error('تعذر قراءة صفحة أمازون ('+response.status+')');
 if(!samePage(response.url,url))throw error('رابط المصدر لا يطابق البحث المطلوب','BLOCKED');
 if(!/text\/html/i.test(response.headers.get('content-type')||''))throw error('أمازون لم يرجع صفحة قابلة للقراءة');
 const reader=response.body?.getReader();if(!reader)throw error('استجابة فارغة');
 const chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6*1024*1024)throw error('الصفحة أكبر من الحد المسموح');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const html=await new Blob(chunks).text();signal.throwIfAborted();
 if(/validateCaptcha|captchacharacters|Click the button below to continue shopping/i.test(html))throw error('أمازون طلب تحققًا بشريًا؛ توقف الجلب المباشر','CAPTCHA');
 if(/<title[^>]*>[^<]*(?:Sorry! Something went wrong|Service Unavailable|Robot Check)/i.test(html))throw error('أمازون رفض الصفحة؛ توقف البحث','BLOCKED');
 if(/<form[^>]+name=["']signIn["']/i.test(html))throw error('أمازون طلب تسجيل الدخول؛ توقف الجلب','LOGIN_WALL');
 if(workspaces.get(owner)!==workspace)throw error('وصل رد لبحث قديم');
 return{html,market:message.market,asin:message.asin,page:message.operation==='search'?Number(message.page||1):undefined,transport:'http'};
}
chrome.tabs?.onRemoved?.addListener(tabId=>{
 for(const [owner,w] of workspaces){if(owner===tabId){w.controller?.abort();workspaces.delete(owner);}else if(w.tabId===tabId){w.closed=true;w.tabId=undefined;w.controller?.abort();}}
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
 if(!origins.has(origin)||sender.frameId!==0||!Number.isInteger(sender.tab?.id))return false;
 const owner=sender.tab.id;
 if(message.operation==='ping'){respond({ready:true,protocol:2,version:VERSION,pagination:true,openPageReader:true,browserNavigation:false,directFetch:true,reviewReveal:true});return false;}
 if(message.operation==='begin_browser'){
  if(typeof message.jobId!=='string'||message.jobId.length>100){respond({protocol:2,error:'معرّف بحث غير صالح'});return false;}
  const old=workspaces.get(owner);old?.controller?.abort();
  workspaces.set(owner,{jobId:message.jobId,tabId:old?.tabId,url:old?.url,closed:false});
  respond({protocol:2,ok:true,transport:'http'});return false;
 }
 if(message.operation==='stop_browser'){
  const w=workspaces.get(owner);if(w?.jobId===message.jobId){w.controller?.abort();w.closed=true;}
  respond({protocol:2,ok:true});return false;
 }
 if(message.operation==='resume_browser'){
  void(async()=>{try{
   const w=workspaces.get(owner);if(!w?.tabId||!w.url)throw error('لا يوجد تبويب عمل لهذا الموقع');
   const operation=openedProduct(w.url)?'product':'search';
   await readRendered(w.tabId,operation,new AbortController().signal,w.url);
   w.blocked=false;respond({protocol:2,ok:true});
  }catch(e){respond({protocol:2,error:e?.message||'الصفحة لم تكتمل',code:e?.code||'NETWORK'});}})();return true;
 }
 if(message.operation==='cancel'){
  const w=workspaces.get(owner);if(w?.requestId===message.target)w.controller?.abort();respond({protocol:2,ok:true});return false;
 }
 if(message.operation==='list_open_products'||message.operation==='read_open_product'){
  void(async()=>{try{
   if(message.operation==='list_open_products'){
    const tabs=await chrome.tabs.query({url:[...markets].map(m=>`https://www.${m}/*`)});
    respond({protocol:2,tabs:tabs.flatMap(t=>{const p=openedProduct(t.url);return p&&Number.isInteger(t.id)?[{id:t.id,...p,title:String(t.title||p.asin).slice(0,500)}]:[]})});return;
   }
   const tabId=Number(message.tabId);if(!Number.isInteger(tabId)||tabId<0)throw error('صفحة غير صالحة');
   const tab=await chrome.tabs.get(tabId);const product=openedProduct(tab.url);if(!product)throw error('اختر صفحة منتج أمازون');
   const result=await readRendered(tabId,'product',new AbortController().signal,product.url);
   if(result.asin!==product.asin||result.market!==product.market)throw error('الصفحة لا تطابق المنتج');
   respond({protocol:2,...result});
  }catch(e){respond({protocol:2,error:e?.message||'تعذر قراءة الصفحة المفتوحة',code:e?.code||'NETWORK'});}})();return true;
 }
 if(!['search','product'].includes(message.operation))return false;
 let url;try{url=requestUrl(message);}catch(e){respond({protocol:2,error:e.message});return false;}
 const workspace=workspaces.get(owner);
 if(!workspace||workspace.jobId!==message.jobId||message.transport!=='http'){respond({protocol:2,transport:'http',error:'ابدأ بحثًا جديدًا لتفعيل القراءة من Chrome'});return false;}
 workspace.controller?.abort();const controller=new AbortController();workspace.controller=controller;workspace.requestId=message.id;
 const task=queue.then(()=>fetchPublic(owner,workspace,message,controller.signal));queue=task.catch(()=>{});
 void task.then(result=>respond({protocol:2,...result}),e=>{
  if(['BLOCKED','CAPTCHA','LOGIN_WALL'].includes(e?.code))workspace.blocked=true;
  respond({protocol:2,transport:'http',error:controller.signal.aborted?'تم إيقاف البحث':e?.message||'تعذرت قراءة تبويب أمازون',code:e?.code||'NETWORK'});
 });return true;
});
