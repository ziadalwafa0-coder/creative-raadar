import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {readAmazonDocument,readBrowserProducts,searchInBrowser} from './browserCollector';
Object.assign(globalThis,{DOMParser});
const asin='B000000001';const other='B000000002';
const media=(i:number)=>`https://m.media-amazon.com/test-${i}.mp4`;
const searchHtml=`<html><head><title>Amazon</title></head><body><div data-component-type="s-search-result" data-asin="${asin}"><h2>Rack one</h2><a aria-label="12 ratings"></a></div><div data-component-type="s-search-result" data-asin="${other}"><h2>Rack two</h2><a aria-label="1.2K ratings"></a></div></body></html>`;
const productHtml=(source:string,items:object[])=>`<html><body><div id="customer-reviews_feature_div"></div><div data-video-items='${JSON.stringify(items)}'></div></body></html>`;
test('browser parser sorts actual search-card counts and recognizes error-image page',()=>{
 assert.deepEqual(readBrowserProducts(readAmazonDocument(searchHtml),'amazon.com').map(h=>h.asin),[other,asin]);
 assert.throws(()=>readAmazonDocument('<html><head><title>Sorry! Something went wrong!</title></head><body></body></html>'),/رفض الطلب/);
});
test('browser pipeline filters seller and wrong product, deduplicates and caps at 50',async()=>{
 const events:any[]=[];const calls:string[]=[];
 const request=async(operation:string,payload:any)=>{calls.push(operation);if(operation==='ping')return{ready:true};if(operation==='search')return{html:searchHtml};
 return{html:productHtml(payload.asin,[{creatorType:'seller',productAsin:payload.asin,videoURL:media(90)},{creatorType:'customer',productAsin:'B000000099',videoURL:media(91)},...Array.from({length:60},(_,i)=>({creatorType:'customer',productAsin:payload.asin,videoURL:media(i)}))])};};
 await searchInBrowser('clothes rack','amazon.com','run1',new AbortController().signal,e=>events.push(e),request);
 const videos=events.filter(e=>e.type==='video');assert.equal(videos.length,50);assert(videos.every(e=>e.video.sourceAsin===other));assert.equal(events.at(-1).count,50);assert.deepEqual(calls,['ping','search','product']);
});
test('new search cancellation discards a late product response',async()=>{
 const controller=new AbortController();const events:any[]=[];
 const request=async(operation:string)=>{if(operation==='ping')return{};if(operation==='search')return{html:searchHtml};controller.abort();return{html:productHtml(other,[{creatorType:'customer',productAsin:other,videoURL:media(1)}])};};
 await assert.rejects(searchInBrowser('clothes rack','amazon.com','old',controller.signal,e=>events.push(e),request));
 assert.equal(events.filter(e=>e.type==='video').length,0);assert.equal(events.filter(e=>e.done).length,0);
});
test('challenge stops the run instead of repeatedly hitting more products',async()=>{
 let products=0;const events:any[]=[];
 const request=async(operation:string)=>{if(operation==='ping')return{};if(operation==='search')return{html:searchHtml};products++;return{html:'<html><body>Robot Check</body></html>'};};
 await searchInBrowser('clothes rack','amazon.com','run',new AbortController().signal,e=>events.push(e),request);
 assert.equal(products,1);assert(events.some(e=>e.code===undefined&&e.type==='warn'&&e.reason.includes('تحقق')));assert.equal(events.at(-1).count,0);
});
test('extension worker only permits fixed public Amazon operations and omits credentials',async()=>{
 let listener:any;let options:any;let called='';
 Object.assign(globalThis,{chrome:{runtime:{onMessage:{addListener:(fn:any)=>{listener=fn;}}}}});
 const {requestUrl}=await import('../extension/worker.js');
 assert.throws(()=>requestUrl({operation:'search',market:'evil.test',query:'rack'}));
 assert.throws(()=>requestUrl({operation:'product',market:'amazon.com',asin:'../../ap/signin'}));
 assert.equal(requestUrl({operation:'product',market:'amazon.com',asin}),`https://www.amazon.com/dp/${asin}`);
 const original=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{called=String(url);options=init;return new Response('<html></html>');};
 try{
  const response:any=await new Promise(resolve=>listener({operation:'product',market:'amazon.com',asin},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:8}},resolve));
  assert.equal(response.html,'<html></html>');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert(called.endsWith(asin));
  assert.equal(listener({operation:'product',market:'amazon.com',asin},{url:'https://evil.test/',frameId:0,tab:{id:8}},()=>{throw Error('must not respond');}),false);
 }finally{globalThis.fetch=original;}
});
