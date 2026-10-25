import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8').replaceAll('export ','');
function setup(){
 let handler:any,clock=100000,status=200,wrong=false,body='<html><title>Amazon</title><body>Public product</body></html>';let release:()=>void=()=>{};let hold=false;
 const requests:any[]=[];
 const sender={url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:7}};
 vm.runInNewContext(source,{URL,AbortController,AbortSignal,Blob,setTimeout,clearTimeout,Date:{now:()=>clock},fetch:async(url:string,options:any)=>{requests.push({url,options});if(hold){hold=false;await new Promise<void>(r=>release=r);}const r=new Response(body,{status,headers:{'content-type':'text/html'}});Object.defineProperty(r,'url',{value:wrong?'https://www.amazon.com/dp/B000000099':url});return r;},chrome:{tabs:{onRemoved:{addListener(){}},create(){throw Error('must not open tabs');},update(){throw Error('must not navigate');}},runtime:{onMessage:{addListener(fn:any){handler=fn;}}}}});
 const send=(message:any)=>{clock+=3000;return new Promise<any>(resolve=>handler(message,sender,resolve));};
 const request=(jobId='one')=>send({operation:'product',asin:'B000000001',market:'amazon.com',jobId,transport:'http',id:jobId});
 return{send,request,requests,setStatus:(n:number)=>status=n,setWrong:()=>wrong=true,setBody:(s:string)=>body=s,hold:()=>hold=true,release:()=>release()};
}
test('direct collection opens no tabs, uses fixed public URLs and omits account cookies',async()=>{
 const s=setup();const ping=await s.send({operation:'ping'});assert.equal(ping.version,'1.3.1');assert.equal(ping.directFetch,true);assert.equal(ping.reviewReveal,true);assert.equal(ping.browserNavigation,false);
 await s.send({operation:'begin_browser',jobId:'one'});const result=await s.request();assert.equal(result.transport,'http');assert.equal(s.requests.length,1);assert.equal(s.requests[0].options.credentials,'omit');assert.equal(s.requests[0].options.redirect,'error');assert.doesNotMatch(source,/chrome\.tabs\.(create|update)\(/);
});
test('403/429/503 stop the current job without retries or another transport',async()=>{
 for(const status of [403,429,503]){const s=setup();s.setStatus(status);await s.send({operation:'begin_browser',jobId:'one'});assert.equal((await s.request()).code,'BLOCKED');await s.request();assert.equal(s.requests.length,1);}
});
test('challenge bodies and source redirects are rejected',async()=>{
 const s=setup();s.setBody('<title>Robot Check</title><form action="validateCaptcha"></form>');await s.send({operation:'begin_browser',jobId:'one'});assert.equal((await s.request()).code,'CAPTCHA');
 const other=setup();other.setWrong();await other.send({operation:'begin_browser',jobId:'one'});assert.equal((await other.request()).code,'BLOCKED');
});
test('new jobs reject late old results and abort the previous fetch',async()=>{
 const s=setup();await s.send({operation:'begin_browser',jobId:'one'});s.hold();const old=s.request();await new Promise(r=>setTimeout(r,1));await s.send({operation:'begin_browser',jobId:'two'});assert.equal(s.requests[0].options.signal.aborted,true);s.release();assert((await old).error);assert((await s.request()).error);assert.equal((await s.request('two')).transport,'http');
});
test('explicit cancellation ends a job without another source request',async()=>{
 const s=setup();await s.send({operation:'begin_browser',jobId:'one'});await s.send({operation:'stop_browser',jobId:'one'});assert((await s.request()).error);assert.equal(s.requests.length,0);
});
