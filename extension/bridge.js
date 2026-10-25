(() => {
  const pending = new Set();
  window.addEventListener('message', async event => {
    const m=event.data;
    if(event.source!==window||event.origin!==location.origin||m?.channel!=='cr-browser-request'||typeof m.id!=='string'||m.id.length>100)return;
    if(!['ping','search','product','cancel','list_open_products','read_open_product','begin_browser','stop_browser','resume_browser'].includes(m.operation)||pending.size>=3&&!['cancel','stop_browser'].includes(m.operation))return;
    pending.add(m.id);
    try{
      const result=await chrome.runtime.sendMessage({id:m.id,target:m.target,operation:m.operation,query:m.query,page:m.page,asin:m.asin,market:m.market,tabId:m.tabId,jobId:m.jobId,transport:m.transport});
      if(result?.protocol===2)window.postMessage({channel:'cr-browser-response',id:m.id,...result},location.origin);
    }catch{window.postMessage({channel:'cr-browser-response',id:m.id,protocol:2,error:'أعد تحميل الصفحة بعد تفعيل الإضافة'},location.origin);}
    finally{pending.delete(m.id);}
  });
})();
