import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAwareFetch} from './search.ts';

test('the UI can accept every unique review from the selected listing and reject unrelated rows', async t=>{
  const origin='https://creative-raadar-production.up.railway.app';
  const bus=new EventTarget();
  const postMessage=(message:any)=>{
    const reply={id:message.id,channel:'cr-browser-response',protocol:2,browserNavigation:true};
    queueMicrotask(()=>bus.dispatchEvent(Object.assign(new Event('message'),{data:reply,source:bus,origin})));
  };
  Object.assign(bus,{postMessage});
  const descriptors=['window','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  Object.defineProperty(globalThis,'window',{configurable:true,value:bus});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin}});
  t.after(()=>{for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  const listing='https://www.amazon.com/dp/B0GVFWT8C9';
  const rows=Array.from({length:10},(_,i)=>({searchId:'nested',mediaType:'video',productListingUrl:listing,reviewId:'RTEST'+i,mediaUrl:'https://m.media-amazon.com/'+i+'.mp4'}));
  const response=await browserAwareFetch('/api/stream-search',{method:'POST',body:JSON.stringify({
    searchId:'visible',sourcePlatform:'amazon',productUrl:listing,mediaType:'video',targetVideoCount:10
  })},async()=>new Response([{...rows[0],productListingUrl:'https://www.amazon.com/dp/B0BLGGCLF4'},rows[0],...rows]
    .map(asset=>JSON.stringify({type:'result',asset})+'\n').join('')));
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  const accepted=events.filter(e=>e.type==='result'&&e.searchId==='visible'&&e.asset.searchId==='visible');
  assert.equal(accepted.length,10);
  assert.equal(new Set(accepted.map(e=>e.asset.reviewId)).size,10);
  assert.ok(accepted.every(e=>e.asset.productListingUrl===listing));
  assert.equal(events.at(-1).type,'completed');
});
