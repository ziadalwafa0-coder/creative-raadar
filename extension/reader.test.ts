import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import {parseCustomerVideoBlocks} from '../backend/src/parser';
const reader=fs.readFileSync(new URL('./amazon-reader.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8').replaceAll('export function','function');
const asin='B000000001';
function read(body:string,sender='own'){
 const {document}=parseHTML('<html><body>'+body+'</body></html>');let handler:any;let result:any;
 Object.defineProperty(document,'cookie',{get(){throw Error('cookies must not be read');}});
 vm.runInNewContext(reader,{document,location:new URL(`https://www.amazon.com/dp/${asin}`),URL,chrome:{runtime:{id:'own',onMessage:{addListener(fn:any){handler=fn;}}}}});
 handler({operation:'cr-read-open-product'},{id:sender},(data:any)=>{result=data;});return result;
}
test('open-page reader exports public review fields only, not account data, forms or cookies',()=>{
 const items=[{creatorType:'customer',productAsin:asin,videoURL:'https://m.media-amazon.com/customer.mp4',title:'Real review',cookie:'PRIVATE_TOKEN'}];
 const result=read(`<nav>PRIVATE_ADDRESS</nav><input value="PRIVATE_FORM"><span id="productTitle">Public product</span><input id="ASIN" value="${asin}"><div data-video-items='${JSON.stringify(items)}'></div><script>PRIVATE_SCRIPT</script>`);
 assert.equal(result.asin,asin);assert.equal(result.title,'Public product');
 for(const secret of ['PRIVATE_ADDRESS','PRIVATE_FORM','PRIVATE_SCRIPT','PRIVATE_TOKEN'])assert(!result.html.includes(secret));
 const {document}=parseHTML(result.html);const blocks=[...document.querySelectorAll('[data-video-items]')].map(n=>n.getAttribute('data-video-items')!);
 assert.equal(parseCustomerVideoBlocks(blocks,asin,'amazon.com').length,1);
 assert.equal(read('<span id="productTitle">Public product</span>','another-extension'),undefined);
});
test('reader refuses challenges, login pages and mismatched variants without clicking or navigating',()=>{
 assert.equal(read('Click the button below to continue shopping').code,'CAPTCHA');
 assert.equal(read('<input type="password">').code,'LOGIN_WALL');
 assert.equal(read(`<span id="productTitle">Product</span><input id="ASIN" value="B000000099">`).code,'PARSE_EMPTY');
});
test('503 stops automatic traffic and an explicit already-open page can be read without any fetch',async()=>{
 let handler:any,fetches=0,messages=0;
 const context:any={
  URL,AbortController,AbortSignal,TextDecoder,Response,setTimeout,clearTimeout,
  fetch:async()=>{fetches++;return new Response('Service unavailable',{status:503,headers:{'retry-after':'120'}});},
  chrome:{
   runtime:{onMessage:{addListener(fn:any){handler=fn;}}},
   tabs:{
    query:async()=>[{id:4,url:`https://www.amazon.com/dp/${asin}`,title:'Public product'},{id:5,url:'https://example.com/private',title:'Private'}],
    get:async()=>({id:4,url:`https://www.amazon.com/dp/${asin}`}),
    sendMessage:async()=>{messages++;return{asin,market:'amazon.com',html:'<html></html>',title:'Public product'};},
   },
  },
 };

 vm.runInNewContext(worker,context);
 const sender={url:'https://creative-raadar.vercel.app/',frameId:0,tab:{id:7}};
 const send=(message:any)=>new Promise<any>(resolve=>handler(message,sender,resolve));
 assert.equal((await send({operation:'product',market:'amazon.com',asin,id:'first'})).code,'BLOCKED');
 assert.equal((await send({operation:'product',market:'amazon.com',asin,id:'second'})).code,'BLOCKED');assert.equal(fetches,1);
 const tabs=await send({operation:'list_open_products'});assert.equal(tabs.tabs.length,1);assert.equal(tabs.tabs[0].id,4);
 const opened=await send({operation:'read_open_product',tabId:'4'});assert.equal(opened.asin,asin);assert.equal(messages,1);assert.equal(fetches,1);
});
test('reader adds no hosts or powerful extension permissions',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.version,'1.2.2');assert.equal(manifest.permissions,undefined);
 assert.deepEqual(manifest.host_permissions,['https://www.amazon.com/*','https://www.amazon.eg/*','https://www.amazon.sa/*','https://www.amazon.ae/*']);
 assert(manifest.content_scripts.some((s:any)=>s.js.includes('amazon-reader.js')));
});
