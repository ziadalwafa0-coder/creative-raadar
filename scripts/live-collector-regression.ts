// Real public-network regression of the same collector/worker under Node.
// This is separate from installed Chrome E2E evidence; only counts and ASINs are recorded.
import {DOMParser} from 'linkedom';
import {searchInBrowser} from '../frontend/browserCollector';
import fs from 'node:fs/promises';
let listener:any;Object.assign(globalThis,{DOMParser,chrome:{runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}}}});
await import('../extension/worker.js');
const queries=process.argv.slice(2).length?process.argv.slice(2):[
 '9 tier shoe rack with cover','car vacuum cleaner','12v dual cylinder air compressor',
 'foldable portable washing machine','washing machine anti vibration pads','automatic pull string door closer',
 'cordless mini chainsaw','electric charcoal burner','750w hammer drill tool kit',
 'uv toothbrush sanitizer holder','window mosquito net hook loop',
];
const results:any[]=[];
for(const query of queries){
 const started=Date.now();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),240000);let videos=0,images=0,firstVideoMs:number|undefined;const asins=new Set<string>();const warnings=new Set<string>();const pages=new Set<string>();let inspected=0,error:string|undefined;
 console.log(JSON.stringify({type:'start',query}));
 const request=async(operation:string,payload:Record<string,string>)=>{
  if(operation==='ping')return{ready:true,pagination:true};
  if(operation==='search')pages.add(payload.page);else if(operation==='product')inspected++;
  const id=crypto.randomUUID();return new Promise<any>((resolve,reject)=>{
   const abort=()=>listener({operation:'cancel',target:id},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:1}},()=>{});
   controller.signal.addEventListener('abort',abort,{once:true});
   listener({id,operation,...payload},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:1}},(result:any)=>{controller.signal.removeEventListener('abort',abort);if(result.error)reject(Error(result.error));else resolve(result);});
  });
 };
 try{
  await searchInBrowser(query,'amazon.com',crypto.randomUUID(),controller.signal,event=>{
   if('type'in event&&event.type==='video'){videos++;asins.add(event.video.sourceAsin);firstVideoMs??=Date.now()-started;}
   if('type'in event&&event.type==='image')images++;
   if('type'in event&&event.type==='warn')warnings.add(event.reason);
  },request,{videos:50,images:3});
 }catch(e){error=e instanceof Error?e.message:String(e);}finally{clearTimeout(timeout);}
 const result={query,requestedVideos:50,videos,images,pages:[...pages],productsInspected:inspected,firstVideoMs,elapsedMs:Date.now()-started,asins:[...asins],warnings:[...warnings],error};results.push(result);console.log(JSON.stringify({type:'result',...result}));
 await fs.writeFile('backend/LIVE-REGRESSION.json',JSON.stringify({method:'Node network test of shared collector; not Chrome E2E',results},null,2)+'\n');
 // A blocking response is evidence, not an invitation to hammer Amazon with the next query.
 if([error,...warnings].some(message=>message&&/503|403|رفض|تحقق/.test(message))){console.log('Stopped following an upstream block.');break;}
}
