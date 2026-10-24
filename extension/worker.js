const origins = new Set(['https://creative-raadar.vercel.app','http://127.0.0.1:5173','http://localhost:5173']);
const markets = new Set(['amazon.com','amazon.eg','amazon.sa','amazon.ae']);
const active = new Map();
let nextRequest = 0;
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
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
  if(!origins.has(origin)||sender.frameId!==0||!Number.isInteger(sender.tab?.id))return false;
  const tab=sender.tab.id;
  if(message.operation==='cancel'){const current=active.get(tab);if(current?.id===message.target){current.controller.abort();active.delete(tab);}respond({ok:true});return false;}
  let url;try{url=requestUrl(message);}catch(e){respond({error:e.message});return false;}
  active.get(tab)?.controller.abort();const controller=new AbortController();active.set(tab,{id:message.id,controller});
  void(async()=>{
    try{
      const wait=Math.max(0,nextRequest-Date.now());nextRequest=Date.now()+wait+1800;
      if(wait)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,wait);controller.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('تم إلغاء البحث'));},{once:true});});
      controller.signal.throwIfAborted();
      const response=await fetch(url,{credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':message.market==='amazon.com'?'en-US,en;q=0.9':'ar,en;q=0.8'},referrerPolicy:'no-referrer',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
      if(!response.ok){const error=new Error(`أمازون لم يسمح بقراءة الصفحة (${response.status})`);error.code=response.status===403||response.status===503?'BLOCKED':'NETWORK';throw error;}
      const reader=response.body.getReader();let bytes=0;const decoder=new TextDecoder();let html='';
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>8*1024*1024)throw Error('صفحة المصدر أكبر من الحد المسموح');html+=decoder.decode(chunk.value,{stream:true});}html+=decoder.decode();}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      respond({html,page:message.operation==='search'?Number(message.page||1):undefined});
    }catch(e){respond({error:controller.signal.aborted?'تم إلغاء البحث':e instanceof Error?e.message:'تعذر الاتصال بأمازون',code:e.code});}
    finally{if(active.get(tab)?.controller===controller)active.delete(tab);}
  })();return true;
});
