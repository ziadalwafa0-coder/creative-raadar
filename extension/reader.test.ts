import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import {parseCustomerVideoBlocks} from '../backend/src/parser';
const reader=fs.readFileSync(new URL('./amazon-reader.js',import.meta.url),'utf8');
const worker=fs.readFileSync(new URL('./worker.js',import.meta.url),'utf8').replaceAll('export ','');
const asin='B000000001';
function read(body:string,sender='own',operation='cr-read-open-product',url=`https://www.amazon.com/dp/${asin}`){
 const {document,window}=parseHTML('<html><body>'+body+'</body></html>');let handler:any;let result:any;
 Object.defineProperty(document,'cookie',{get(){throw Error('cookies must not be read');}});
 vm.runInNewContext(reader,{document,MutationObserver:window.MutationObserver,setTimeout,clearTimeout,location:new URL(url),URL,chrome:{runtime:{id:'own',onMessage:{addListener(fn:any){handler=fn;}}}}});
 return new Promise<any>(resolve=>{const accepted=handler({operation},{id:sender},resolve);if(accepted===false)resolve(undefined);});
}
test('open-page reader exports public review fields only, not account data, forms or cookies',async()=>{
 const items=[{creatorType:'customer',productAsin:asin,videoURL:'https://m.media-amazon.com/customer.mp4',title:'Real review',cookie:'PRIVATE_TOKEN'}];
 const result=await read(`<nav>PRIVATE_ADDRESS</nav><input value="PRIVATE_FORM"><span id="productTitle">Public product</span><input id="ASIN" value="${asin}"><div data-video-items='${JSON.stringify(items)}'></div><script>PRIVATE_SCRIPT</script>`);
 assert.equal(result.asin,asin);assert.equal(result.title,'Public product');
 for(const secret of ['PRIVATE_ADDRESS','PRIVATE_FORM','PRIVATE_SCRIPT','PRIVATE_TOKEN'])assert(!result.html.includes(secret));
 const {document,window}=parseHTML(result.html);const blocks=[...document.querySelectorAll('[data-video-items]')].map(n=>n.getAttribute('data-video-items')!);
 assert.equal(parseCustomerVideoBlocks(blocks,asin,'amazon.com').length,1);
 assert.equal(await read('<span id="productTitle">Public product</span>','another-extension'),undefined);
});
test('reader refuses challenges, login pages and mismatched variants without clicking or navigating',async()=>{
 assert.equal((await read('Click the button below to continue shopping')).code,'CAPTCHA');
 assert.equal((await read('<input type="password">')).code,'LOGIN_WALL');
 assert.equal((await read(`<span id="productTitle">Product</span><input id="ASIN" value="B000000099">`)).code,'PARSE_EMPTY');
});
test('reader adds no hosts or powerful extension permissions',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.version,'1.3.0');assert.equal(manifest.permissions,undefined);
 assert.deepEqual(manifest.host_permissions,['https://www.amazon.com/*','https://www.amazon.eg/*','https://www.amazon.sa/*','https://www.amazon.ae/*']);
 assert(manifest.content_scripts.some((s:any)=>s.js.includes('amazon-reader.js')));
});

test('rendered search reader copies only public product cards, not the account or search form',async()=>{
 const result=await read(`<nav>PRIVATE_ACCOUNT</nav><input value="PRIVATE_SEARCH"><div data-component-type="s-search-result" data-asin="${asin}"><h2>BRAND_ONLY</h2><a class="a-text-normal" href="/dp/${asin}"><h2 aria-label="Portable iron">Portable iron</h2></a><a aria-label="123 ratings"></a><img class="s-image" src="https://m.media-amazon.com/iron.jpg"></div>`,'own','cr-read-search','https://www.amazon.com/s?k=Portable+Iron');
 assert.equal(result.kind,'search');assert(result.html.includes('Portable iron'));assert(!result.html.includes('BRAND_ONLY'));assert(result.html.includes(asin));assert(!result.html.includes('PRIVATE_ACCOUNT'));assert(!result.html.includes('PRIVATE_SEARCH'));
});
