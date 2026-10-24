(() => {
  const pending = new Set();
  window.addEventListener('message', async event => {
    const m=event.data;
    if(event.source!==window||event.origin!==location.origin||m?.channel!=='cr-browser-request'||typeof m.id!=='string'||m.id.length>100)return;
    if(m.operation==='ping'){window.postMessage({channel:'cr-browser-response',id:m.id,ready:true,pagination:true,version:chrome.runtime.getManifest().version},location.origin);return;}
    if(!['search','product','cancel'].includes(m.operation)||pending.size>=3)return;
    pending.add(m.id);
    try{
      const result=await chrome.runtime.sendMessage({id:m.id,target:m.target,operation:m.operation,query:m.query,page:m.page,asin:m.asin,market:m.market});
      window.postMessage({channel:'cr-browser-response',id:m.id,...result},location.origin);
    }catch{window.postMessage({channel:'cr-browser-response',id:m.id,error:'أعد تحميل الصفحة بعد تفعيل الإضافة'},location.origin);}
    finally{pending.delete(m.id);}
  });
})();
