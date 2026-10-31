/** Same-origin bridge to the locally installed, user-authorized collector. */
export function chromeRequest(operation:string,payload:Record<string,unknown>,signal:AbortSignal,timeout=60000):Promise<any>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const clean=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
    const abort=()=>{clean();window.postMessage({channel:'cr-browser-request',id:crypto.randomUUID(),operation:'cancel',target:id},location.origin);reject(signal.reason||new Error('تم إلغاء البحث'));};
    const receive=(event:MessageEvent)=>{
      if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='cr-browser-response'||event.data.id!==id||event.data.protocol!==2)return;
      clean();if(event.data.error)reject(new Error(event.data.error));else resolve(event.data);
    };
    const timer=setTimeout(()=>{clean();reject(new Error(operation==='ping'?'إضافة Chrome غير متصلة. فعّل 1.4.0 وأعد تحميل الموقع.':'انتهت مهلة قراءة تبويب أمازون.'));},timeout);
    window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
    window.postMessage({channel:'cr-browser-request',id,operation,...payload},location.origin);
  });
}
