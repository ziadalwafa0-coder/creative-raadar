import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {browserRequest,readAmazonDocument,readBrowserProducts,readCustomerImages,searchInBrowser,collectApprovedProduct} from './browserCollector';
Object.assign(globalThis,{DOMParser});
const asin='B000000001';const other='B000000002';
const media=(i:number)=>`https://m.media-amazon.com/test-${i}.mp4`;
const searchHtml=`<html><head><title>Amazon</title></head><body><div data-component-type="s-search-result" data-asin="${asin}"><h2>Rack one</h2><a aria-label="12 ratings"></a></div><div data-component-type="s-search-result" data-asin="${other}"><h2>Rack two</h2><a aria-label="1.2K ratings"></a></div></body></html>`;
const productHtml=(source:string,items:object[])=>`<html><body><div id="customer-reviews_feature_div"></div><div data-video-items='${JSON.stringify(items)}'></div></body></html>`;
test('confirming one product never fetches other ASINs to fill a request for 50 videos',async()=>{
 const calls:any[]=[];const events:any[]=[];
 const request=async(operation:string,payload:any)=>{calls.push({operation,...payload});return{html:productHtml(asin,[{creatorType:'customer',productAsin:asin,videoURL:media(1)},{creatorType:'customer',productAsin:other,videoURL:media(2)},{creatorType:'seller',productAsin:asin,videoURL:media(3)}])};};
 await collectApprovedProduct({asin,title:'Confirmed model',ratingsCount:100,url:`https://www.amazon.com/dp/${asin}`},'amazon.com','exact',new AbortController().signal,e=>events.push(e),{videos:50,images:0},request);
 assert.deepEqual(calls,[{operation:'product',asin,market:'amazon.com'}]);
 assert.equal(events.filter(e=>e.type==='video').length,1);assert(events.some(e=>e.type==='warn'));assert.equal(events.at(-1).count,1);
});
test('browser parser sorts actual search-card counts and recognizes error-image page',()=>{
 assert.deepEqual(readBrowserProducts(readAmazonDocument(searchHtml),'amazon.com').map(h=>h.asin),[other,asin]);
 assert.throws(()=>readAmazonDocument('<html><head><title>Sorry! Something went wrong!</title></head><body></body></html>'),/رفض الطلب/);
});
test('visual identity filters wrong products and continues if an entire search page is unrelated',async()=>{
 const events:any[]=[];const inspected:string[]=[];const pages:string[]=[];
 const request=async(operation:string,payload:any)=>{
  if(operation==='ping')return{pagination:true};
  if(operation==='search'){pages.push(payload.page);return{page:Number(payload.page),html:payload.page==='1'?searchHtml:payload.page==='2'?searchHtml.replaceAll(asin,'B000000003').replaceAll(other,'B000000004').replace('Rack one','9 Tier Shoe Rack with Cover'): '<html><body>No results for this</body></html>'};}
  inspected.push(payload.asin);return{html:productHtml(payload.asin,[{creatorType:'customer',productAsin:payload.asin,videoURL:media(1)}])};
 };
 await searchInBrowser('9 Tier Shoe Rack with Cover','amazon.com','identity',new AbortController().signal,e=>events.push(e),request,{videos:1,images:0},p=>p.title.includes('9 Tier'));
 assert.deepEqual(pages,['1','2']);assert.deepEqual(inspected,['B000000003']);assert.equal(events.filter(e=>e.type==='video').length,1);
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
 const ready:any=await new Promise(resolve=>listener({operation:'ping'},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:8}},resolve));
 assert.equal(ready.protocol,2);assert.equal(ready.version,'1.2.1');assert.equal(ready.pagination,true);
 assert(requestUrl({operation:'search',market:'amazon.com',query:'rack',page:'2'}).endsWith('&page=2'));
 assert.throws(()=>requestUrl({operation:'search',market:'amazon.com',query:'rack',page:'99'}));
 const original=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{called=String(url);options=init;return new Response('<html></html>');};
 try{
  const response:any=await new Promise(resolve=>listener({operation:'product',market:'amazon.com',asin},{url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:8}},resolve));
  assert.equal(response.html,'<html></html>');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert(called.endsWith(asin));
  assert.equal(listener({operation:'product',market:'amazon.com',asin},{url:'https://evil.test/',frameId:0,tab:{id:8}},()=>{throw Error('must not respond');}),false);
 }finally{globalThis.fetch=original;}
});
test('40 requested videos continue onto page two instead of stopping after 20 products',async()=>{
 const pages:string[]=[];let inspected=0;const events:any[]=[];
 const request=async(operation:string,payload:any)=>{
  if(operation==='ping')return{ready:true,pagination:true};
  if(operation==='search'){
   pages.push(payload.page);const offset=(Number(payload.page)-1)*20;
   return{html:'<html><body>'+Array.from({length:20},(_,i)=>`<div data-component-type="s-search-result" data-asin="B${String(offset+i+1).padStart(9,'0')}"><h2>Rack</h2><a aria-label="100 ratings"></a></div>`).join('')+'</body></html>'};
  }
  inspected++;return{html:productHtml(payload.asin,[{creatorType:'customer',productAsin:payload.asin,videoURL:media(inspected)}])};
 };
 await searchInBrowser('clothes rack','amazon.com','forty',new AbortController().signal,e=>events.push(e),request,{videos:40,images:0});
 assert.equal(events.filter(e=>e.type==='video').length,40);assert.equal(inspected,40);assert.deepEqual(pages,['1','2']);assert.equal(events.at(-1).count,40);
});
test('customer photos exclude seller pictures, unsafe hosts and mismatched variants',()=>{
 const doc=readAmazonDocument(`<html><body><img src="https://m.media-amazon.com/seller.jpg"><div data-hook="review"><a data-hook="review-title">Good rack</a><img data-hook="review-image-tile" src="https://m.media-amazon.com/customer.jpg"><img data-hook="review-image-tile" src="https://evil.test/a.jpg"></div><div data-hook="review"><a data-hook="format-strip" href="/dp/B000000099"></a><img data-hook="review-image-tile" src="https://m.media-amazon.com/wrong.jpg"></div></body></html>`);
 assert.deepEqual(readCustomerImages(doc,asin,'amazon.com').map(i=>i.url),['https://m.media-amazon.com/customer.jpg']);
});
test('images-only mode returns requested photos and no videos',async()=>{
 const events:any[]=[];const request=async(operation:string,payload:any)=>operation==='ping'?{}:operation==='search'?{html:searchHtml}:{html:`<html><body><div data-hook="review">${Array.from({length:5},(_,i)=>`<img data-hook="review-image-tile" src="https://m.media-amazon.com/photo${i}.jpg">`).join('')}</div></body></html>`};
 await searchInBrowser('clothes rack','amazon.com','photos',new AbortController().signal,e=>events.push(e),request,{videos:0,images:3});
 assert.equal(events.filter(e=>e.type==='image').length,3);assert.equal(events.filter(e=>e.type==='video').length,0);
});
test('old extension replies cannot win a race against the current worker protocol',async()=>{
 const oldWindow=(globalThis as any).window,oldLocation=(globalThis as any).location;
 const fake=new EventTarget() as any;const origin='http://127.0.0.1:5173';
 fake.postMessage=(message:any)=>{
  if(message.channel!=='cr-browser-request')return;
  queueMicrotask(()=>{
   for(const data of [{channel:'cr-browser-response',id:message.id,ready:true,version:'1.2.0'},{channel:'cr-browser-response',id:message.id,protocol:2,ready:true,version:'1.2.1'}]){
    const event=new Event('message');Object.assign(event,{source:fake,origin,data});fake.dispatchEvent(event);
   }
  });
 };
 Object.assign(globalThis,{window:fake,location:{origin}});
 try{const result=await browserRequest('ping',{},new AbortController().signal,1000);assert.equal(result.version,'1.2.1');assert.equal(result.protocol,2);}
 finally{if(oldWindow===undefined)delete(globalThis as any).window;else(globalThis as any).window=oldWindow;if(oldLocation===undefined)delete(globalThis as any).location;else(globalThis as any).location=oldLocation;}
});
