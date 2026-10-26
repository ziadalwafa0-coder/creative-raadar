import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8').replaceAll('export ','');
const asin='B000000001';
function setup(){
 let listener:any,clock=100000,challenge=false,wrongPage=false,hold=false,holdCreate=false;let finishRead:(value:any)=>void=()=>{},finishCreate:()=>void=()=>{};
 const updated=new Set<any>(),removed=new Set<any>();
 const pages=new Map<number,any>([[7,{id:7,url:'https://creative-raadar.vercel.app/',status:'complete',active:true}]]);
 const navigations:string[]=[];let fetches=0,next=100;
 const event=(listeners:Set<any>)=>({addListener:(f:any)=>listeners.add(f),removeListener:(f:any)=>listeners.delete(f)});
 const complete=(tab:any)=>queueMicrotask(()=>{tab.status='complete';for(const fn of updated)fn(tab.id,{status:'complete'},tab);});
 const tabs={onUpdated:event(updated),onRemoved:event(removed),
  create:async(options:any)=>{const tab={id:next++,...options,status:'loading'};pages.set(tab.id,tab);navigations.push(options.url);complete(tab);if(holdCreate)await new Promise<void>(resolve=>finishCreate=resolve);return tab;},
  get:async(id:number)=>{if(!pages.has(id))throw Error('No tab');return pages.get(id);},
  update:async(id:number,changes:any)=>{const tab=pages.get(id);if(!tab)throw Error('No tab');Object.assign(tab,changes);if(changes.url){navigations.push(changes.url);tab.status='loading';complete(tab);}return tab;},
  query:async()=>[...pages.values()],
  sendMessage:async(id:number)=>{
   if(challenge)return{error:'Robot Check',code:'CAPTCHA'};
   const tab=pages.get(id);const result={html:'<html>public reviews</html>',url:wrongPage?'https://www.amazon.com/dp/B000000099':tab.url,asin,market:'amazon.com'};
   if(hold)return new Promise(resolve=>{finishRead=resolve;});return result;
  },
 };
 vm.runInNewContext(source,{URL,AbortController,AbortSignal,setTimeout,clearTimeout,Date:{now:()=>clock},fetch:()=>{fetches++;throw Error('fetch must never run');},chrome:{tabs,runtime:{onMessage:{addListener(fn:any){listener=fn;}}}}});
 const send=(message:any)=>{clock+=3000;return new Promise<any>(resolve=>listener(message,{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:7}},resolve));};
 return{send,pages,navigations,updated,removed,fetches:()=>fetches,setChallenge:(value:boolean)=>{challenge=value;},setWrong:()=>{wrongPage=true;},setHold:(value=true)=>{hold=value;},finish:(value:any)=>finishRead(value),holdCreate:()=>{holdCreate=true;},finishCreate:()=>{holdCreate=false;finishCreate();}};
}
test('primary search and product collection navigate one visible tab and never fetch Amazon HTML',async()=>{
 const s=setup();await s.send({operation:'begin_browser',jobId:'job1'});
 const result=await s.send({operation:'search',market:'amazon.com',query:'Portable Iron',page:'1',jobId:'job1',transport:'tab',id:'a'});
 assert.equal(result.transport,'tab');assert.equal(result.page,1);assert.equal(s.pages.get(100).active,true);
 const product=await s.send({operation:'product',market:'amazon.com',asin,jobId:'job1',transport:'tab',id:'b'});
 assert.equal(product.transport,'tab');assert.equal(s.pages.size,2);assert.equal(s.navigations.length,2);assert.equal(s.fetches(),0);
});
test('a challenge stops the job, prevents another navigation and can only resume by reading the current page',async()=>{
 const s=setup();s.setChallenge(true);await s.send({operation:'begin_browser',jobId:'job1'});
 const blocked=await s.send({operation:'search',market:'amazon.com',query:'Portable Iron',jobId:'job1',transport:'tab',id:'a'});
 assert.equal(blocked.code,'CAPTCHA');assert.equal((await s.send({operation:'begin_browser',jobId:'job2'})).code,'BLOCKED');assert.equal(s.navigations.length,1);
 s.setChallenge(false);assert.equal((await s.send({operation:'resume_browser'})).ok,true);assert.equal(s.navigations.length,1);
});
test('wrong or stale page URLs cannot become a valid product response',async()=>{
 const s=setup();s.setWrong();await s.send({operation:'begin_browser',jobId:'job'});
 const response=await s.send({operation:'product',market:'amazon.com',asin,jobId:'job',transport:'tab',id:'a'});
 assert.equal(response.code,'BLOCKED');assert(!response.html);
});
test('closing the source tab stops the current job and cannot reopen it silently',async()=>{
 const s=setup();await s.send({operation:'begin_browser',jobId:'job'});await s.send({operation:'search',market:'amazon.com',query:'Portable Iron',jobId:'job',transport:'tab',id:'a'});
 s.pages.delete(100);for(const fn of s.removed)fn(100);
 const result=await s.send({operation:'product',market:'amazon.com',asin,jobId:'job',transport:'tab',id:'b'});
 assert(!result.html);assert.equal(s.navigations.length,1);
});
test('a new search cannot receive a response from an old job',async()=>{
 const s=setup();await s.send({operation:'begin_browser',jobId:'new'});
 const result=await s.send({operation:'search',market:'amazon.com',query:'old product',jobId:'old',transport:'tab',id:'late'});
 assert(!result.html);assert.equal(s.navigations.length,0);
});

test('cancellation aborts a pending page read and a late old response cannot enter a new job',async()=>{
 const s=setup();s.setHold();await s.send({operation:'begin_browser',jobId:'old'});
 const pending=s.send({operation:'search',market:'amazon.com',query:'Portable Iron',jobId:'old',transport:'tab',id:'old-request'});
 await new Promise(resolve=>setImmediate(resolve));
 await s.send({operation:'begin_browser',jobId:'new'});
 const cancelled=await pending;assert(!cancelled.html);
 s.setHold(false);s.finish({html:'OLD',url:'https://www.amazon.com/s?k=Portable%20Iron'});
 const next=await s.send({operation:'product',market:'amazon.com',asin,jobId:'new',transport:'tab',id:'new-request'});
 assert.equal(next.html,'<html>public reviews</html>');assert.equal(s.fetches(),0);
});

test('changing products while tab creation is pending still reuses exactly one work tab',async()=>{
 const s=setup();s.holdCreate();await s.send({operation:'begin_browser',jobId:'old'});
 const pending=s.send({operation:'search',market:'amazon.com',query:'old product',jobId:'old',transport:'tab',id:'old'});
 await new Promise(resolve=>setImmediate(resolve));await s.send({operation:'begin_browser',jobId:'new'});s.finishCreate();
 assert(!(await pending).html);
 const result=await s.send({operation:'product',market:'amazon.com',asin,jobId:'new',transport:'tab',id:'new'});
 assert(result.html);assert.equal(s.pages.size,2);assert.equal(s.fetches(),0);
});
