const VERSION='1.3.2';
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
async function loaded(tabId,url,signal){
 const current=await chrome.tabs.get(tabId);
 if(current.status==='complete'&&samePage(current.url,url))return;
 await new Promise((resolve,reject)=>{
  const clean=()=>{clearTimeout(timer);chrome.tabs.onUpdated.removeListener(update);signal.removeEventListener('abort',abort);};
  const abort=()=>{clean();reject(error('تم إيقاف البحث'));};
  const update=(id,change,tab)=>{
   if(id!==tabId)return;
   if(change.status==='complete'){
    clean();samePage(tab.url,url)?resolve():reject(error('أمازون انتقل لصفحة مختلفة؛ توقفت القراءة دون اعتماد نتائج','BLOCKED'));
   }
  };
  const timer=setTimeout(()=>{clean();reject(error('صفحة أمازون لم تكتمل؛ راجع التبويب الظاهر'));},30000);
  chrome.tabs.onUpdated.addListener(update);signal.addEventListener('abort',abort,{once:true});
  // Close the check/listener race without reloading the page.
  chrome.tabs.get(tabId).then(t=>{if(t.status==='complete')update(tabId,{status:'complete'},t);}).catch(abort);
  if(signal.aborted)abort();
 });
}
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
async function navigateAndRead(owner,workspace,message,signal){
 const url=requestUrl(message);signal.throwIfAborted();
 const gap=Math.max(0,nextNavigation-Date.now());if(gap)await pause(gap,signal);
 signal.throwIfAborted();
 if(workspaces.get(owner)!==workspace||workspace.closed)throw error('أُغلق تبويب العمل أو بدأ بحث جديد');
 if(workspace.blocked)throw error('أمازون أوقف هذا البحث. راجع تبويبه بنفسك؛ لن نحاول تحميل صفحة أخرى تلقائيًا','BLOCKED');
 let source;
 if(workspace.tabId!==undefined){
  source=await chrome.tabs.get(workspace.tabId).catch(()=>null);
  if(!source){workspace.closed=true;throw error('أُغلق تبويب أمازون؛ ابدأ بحثًا جديدًا عند الرغبة');}
  if(workspace.url&&!samePage(source.url,workspace.url)){workspace.closed=true;throw error('تغير تبويب العمل يدويًا؛ لم نستخدمه لمنتج آخر');}
 }
 nextNavigation=Date.now()+2200;
 workspace.url=url;
 if(!source){source=await chrome.tabs.create({url,active:true});workspace.tabId=source.id;}
 else await chrome.tabs.update(source.id,{url,...(source.frozen||source.discarded?{active:true}:{})});
 signal.throwIfAborted();await loaded(source.id,url,signal);signal.throwIfAborted();
 const result=await readRendered(source.id,message.operation,signal,url);signal.throwIfAborted();
 if(workspaces.get(owner)!==workspace)throw error('وصل رد لبحث قديم');
 // Return to the app only if our work tab still has focus; never interrupt an unrelated user tab.
 const current=await chrome.tabs.get(source.id);
 if(current.active)await chrome.tabs.update(owner,{active:true}).catch(()=>{});
 return {...result,page:message.operation==='search'?Number(message.page||1):undefined,transport:'tab'};
}
chrome.tabs?.onRemoved?.addListener(tabId=>{
 for(const [owner,w] of workspaces){if(owner===tabId){w.controller?.abort();workspaces.delete(owner);}else if(w.tabId===tabId){w.closed=true;w.tabId=undefined;w.controller?.abort();}}
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
 if(!origins.has(origin)||sender.frameId!==0||!Number.isInteger(sender.tab?.id))return false;
 const owner=sender.tab.id;
 if(message.operation==='ping'){respond({ready:true,protocol:2,version:VERSION,pagination:true,openPageReader:true,browserNavigation:true,directFetch:false,reviewReveal:true});return false;}
 if(message.operation==='begin_browser'){
  if(typeof message.jobId!=='string'||message.jobId.length>100){respond({protocol:2,error:'معرّف بحث غير صالح'});return false;}
  const old=workspaces.get(owner);old?.controller?.abort();
  // Do not automatically navigate away from an Amazon refusal/challenge.
  if(old?.blocked){respond({protocol:2,error:'أمازون طلب مراجعة الصفحة. استخدم التبويب الظاهر أو القراءة اليدوية؛ لا توجد محاولة آلية بعد الرفض.',code:'BLOCKED'});return false;}
  const workspace=old||{};Object.assign(workspace,{jobId:message.jobId,closed:false,controller:undefined,requestId:undefined});workspaces.set(owner,workspace);
  respond({protocol:2,ok:true,transport:'tab'});return false;
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
 if(!workspace||workspace.jobId!==message.jobId||message.transport!=='tab'){respond({protocol:2,transport:'tab',error:'ابدأ بحثًا جديدًا لتفعيل القراءة من Chrome'});return false;}
 workspace.controller?.abort();const controller=new AbortController();workspace.controller=controller;workspace.requestId=message.id;
 const task=queue.then(()=>navigateAndRead(owner,workspace,message,controller.signal));queue=task.catch(()=>{});
 void task.then(result=>respond({protocol:2,...result}),e=>{
  if(workspace.jobId===message.jobId&&!controller.signal.aborted&&['BLOCKED','CAPTCHA','LOGIN_WALL'].includes(e?.code))workspace.blocked=true;
  respond({protocol:2,transport:'tab',error:controller.signal.aborted?'تم إيقاف البحث':e?.message||'تعذرت قراءة تبويب أمازون',code:e?.code||'NETWORK'});
 });return true;
});
