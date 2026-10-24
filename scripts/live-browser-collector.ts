// Network smoke test of the same worker request code, running under Node, not an installed-extension E2E test.
import {DOMParser} from 'linkedom';
import {searchInBrowser} from '../frontend/browserCollector';
let listener:any;
Object.assign(globalThis,{DOMParser,chrome:{runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}}}});
await import('../extension/worker.js');
const started=Date.now();let count=0;
const request=async(operation:string,payload:Record<string,string>)=>{
 if(operation==='ping')return{ready:true};
 return new Promise<any>((resolve,reject)=>listener({id:crypto.randomUUID(),operation,...payload},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:1}},(result:any)=>result.error?reject(Error(result.error)):resolve(result)));
};
try{
 await searchInBrowser(process.argv[2]||'double rod clothes rack with wheels','amazon.com','live',AbortSignal.timeout(180000),event=>{
  if('type' in event&&event.type==='video'){count++;console.log(JSON.stringify({type:'video',count,asin:event.video.sourceAsin,elapsedMs:Date.now()-started}));}
  else console.log(JSON.stringify(event));
 },request);
}catch(error){console.log(JSON.stringify({error:error instanceof Error?error.message:String(error),count,elapsedMs:Date.now()-started}));process.exitCode=1;}
