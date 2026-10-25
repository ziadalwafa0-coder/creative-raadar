const origins = new Set(['https://creative-raadar.vercel.app','http://127.0.0.1:5173','http://localhost:5173']);
const markets = new Set(['amazon.com','amazon.eg','amazon.sa','amazon.ae']);
const active = new Map();
let nextRequest = 0;
const blockedUntil=new Map();
export function requestUrl(message) {
  if (!markets.has(message.market)) throw Error('متجر غير مسموح');
  const base = `https://www.${message.market}`;
  if (message.operation === 'search' && typeof message.query === 'string' && message.query.trim().length >= 3 && message.query.length <= 200) {
    const page=Number(message.page||1);if(!Number.isInteger(page)||page<1||page>5)throw Error('صفحة بحث غير صالحة');
    return `${base}/s?k=${encodeURIComponent(message.query.trim())}${page>1?`&page=${page}`:''}`;
  }
  if (message.operation === 'product' && /^[A-Z0-9]{10}$/.test(message.asin)) return `${base}/dp/${message.asin}`;
  throw Error('طلب غير صالح');
}
export function openedProduct(url){
 try{const u=new URL(url);const market=u.hostname.replace(/^www\./,'');const asin=u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  if(u.protocol==='https:'&&u.hostname==='www.'+market&&markets.has(market)&&asin)return{market,asin,url:`https://www.${market}/dp/${asin}`};
 }catch{}return null;
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
  if(!origins.has(origin)||sender.frameId!==0||!Number.isInteger(sender.tab?.id))return false;
  const tab=sender.tab.id;
  if(message.operation==='ping'){respond({ready:true,protocol:2,version:'1.2.2',pagination:true,openPageReader:true});return false;}
  if(message.operation==='list_open_products'||message.operation==='read_open_product'){
   void(async()=>{try{
    if(message.operation==='list_open_products'){
     const tabs=await chrome.tabs.query({url:[...markets].map(m=>`https://www.${m}/*`)});
     respond({protocol:2,tabs:tabs.flatMap(t=>{const p=openedProduct(t.url);return p&&Number.isInteger(t.id)?[{id:t.id,...p,title:String(t.title||p.asin).slice(0,500)}]:[]})});return;
    }
    const id=Number(message.tabId);if(!Number.isInteger(id)||id<0)throw Error('صفحة غير صالحة');
    const target=await chrome.tabs.get(id);const product=openedProduct(target.url);if(!product)throw Error('اختر صفحة منتج أمازون مسموحة');
    const result=await chrome.tabs.sendMessage(id,{operation:'cr-read-open-product'},{frameId:0});
    if(result?.error){respond({protocol:2,error:result.error,code:result.code});return;}
    if(result?.asin!==product.asin||result?.market!==product.market||typeof result?.html!=='string'||result.html.length>4*1024*1024)throw Error('بيانات الصفحة لا تطابق المنتج المختار');
    respond({protocol:2,...result});
   }catch{respond({protocol:2,error:'تعذر قراءة الصفحة المفتوحة. بعد تحديث الإضافة أعد تحميل صفحة أمازون مرة واحدة، وتأكد أنها صفحة منتج ظاهرة بشكل طبيعي.',code:'NETWORK'});}})();return true;
  }
  if(message.operation==='cancel'){const current=active.get(tab);if(current?.id===message.target){current.controller.abort();active.delete(tab);}respond({ok:true});return false;}
  let url;try{url=requestUrl(message);}catch(e){respond({error:e.message});return false;}
  const remaining=(blockedUntil.get(message.market)||0)-Date.now();
  if(remaining>0){respond({protocol:2,error:`أمازون رفض القراءة مؤخرًا. انتظر ${Math.ceil(remaining/1000)} ثانية قبل طلب آلي آخر، أو استخدم قراءة الصفحة التي فتحتها بنفسك.`,code:'BLOCKED'});return false;}
  active.get(tab)?.controller.abort();const controller=new AbortController();active.set(tab,{id:message.id,controller});
  void(async()=>{
    try{
      const wait=Math.max(0,nextRequest-Date.now());nextRequest=Date.now()+wait+1800;
      if(wait)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,wait);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('تم إلغاء البحث'));},{once:true});});
      controller.signal.throwIfAborted();
      const paused=(blockedUntil.get(message.market)||0)-Date.now();
      if(paused>0){const error=new Error(`توقف الجلب مؤقتًا بعد رفض أمازون؛ انتظر ${Math.ceil(paused/1000)} ثانية أو اقرأ صفحة فتحتها بنفسك.`);error.code='BLOCKED';throw error;}
      const response=await fetch(url,{credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':message.market==='amazon.com'?'en-US,en;q=0.9':'ar,en;q=0.8'},referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
      if(!response.ok){
       if([403,429,503].includes(response.status)){
        const retry=response.headers.get('retry-after');const seconds=retry&&/^\d+$/.test(retry)?Number(retry)*1000:retry?Date.parse(retry)-Date.now():0;
        blockedUntil.set(message.market,Date.now()+Math.max(60000,Number.isFinite(seconds)?seconds:0));
       }
       const error=new Error(`تعذر قراءة أمازون (${response.status}). توقف الجلب الآلي؛ يمكنك قراءة صفحة منتج فتحتها بنفسك من الخيار أدناه.`);error.code=[403,429,503].includes(response.status)?'BLOCKED':'NETWORK';throw error;
      }
      const reader=response.body.getReader();let bytes=0;const decoder=new TextDecoder();let html='';
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>8*1024*1024)throw Error('صفحة المصدر أكبر من الحد المسموح');html+=decoder.decode(chunk.value,{stream:true});}html+=decoder.decode();}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      respond({protocol:2,html,page:message.operation==='search'?Number(message.page||1):undefined});
    }catch(e){respond({protocol:2,error:controller.signal.aborted?'تم إلغاء البحث':e instanceof Error?e.message:'تعذر الاتصال بأمازون',code:e?.code});}
    finally{if(active.get(tab)?.controller===controller)active.delete(tab);}
  })();return true;
});
