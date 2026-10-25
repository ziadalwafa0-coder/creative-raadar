import {type VisualScore} from './productIdentity';
let worker:Worker|undefined;
/** Aborting stops inference/download, not merely the UI; no late image can affect a new product. */
export function scoreProductImage(image:Blob,labels:string[],signal:AbortSignal,progress:(text:string)=>void):Promise<VisualScore[]>{
 signal.throwIfAborted();
 if(!worker)worker=new Worker(new URL('./productVision.worker.ts',import.meta.url),{type:'module'});
 const active=worker;const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);active.removeEventListener('message',receive);active.removeEventListener('error',fail);signal.removeEventListener('abort',abort);};
  const stop=()=>{active.terminate();if(worker===active)worker=undefined;};
  const abort=()=>{cleanup();stop();reject(signal.reason||new DOMException('Aborted','AbortError'));};
  const fail=()=>{cleanup();stop();reject(Error('تعذر تشغيل تحليل الصورة على هذا الجهاز'));};
  const receive=(event:MessageEvent)=>{if(event.data.id!==id)return;if(event.data.progress){progress(event.data.progress);return;}cleanup();if(event.data.error)reject(Error(event.data.error));else resolve(event.data.scores);};
  const timer=setTimeout(()=>{cleanup();stop();reject(Error('تحميل نموذج الصورة استغرق وقتًا طويلًا؛ أعد المحاولة على اتصال أسرع'));},300000);
  active.addEventListener('message',receive);active.addEventListener('error',fail);signal.addEventListener('abort',abort,{once:true});
  active.postMessage({id,image,labels});
 });
}
