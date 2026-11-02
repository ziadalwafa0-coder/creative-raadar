import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverTikTokStream} from './recoverTikTokStream.ts';

test('a shorter discovery query preserves the original match criteria and previously recovered clips',async()=>{
 const original=globalThis.fetch;
 const name='Hair Steamer Cap for Deep Conditioning';
 let checks=0;
 globalThis.fetch=async(input,init)=>{
   if(String(input)==='/api/tiktok/matches'){
     assert.equal(JSON.parse(String(init?.body)).productName,name);
     if(++checks===2)throw Error('temporary outage');
     return Response.json({sources:['https://www.tiktok.com/@demo/video/1234567890123']});
   }
   const short=new URL(String(input)).searchParams.get('keywords')==='Hair Steamer Cap';
   const id=short?'1234567890124':'1234567890123';
   return Response.json({code:0,data:{videos:[{video_id:id,author:{unique_id:'demo'},play:'https://v19.tiktokcdn.com/'+id,title:'Hair Steamer Cap'}]}});
 };
 try{
   const response=await recoverTikTokStream(new Response('{"type":"completed"}'),{body:JSON.stringify({searchId:'x',productName:name,selectedProductUrl:'https://www.amazon.com/dp/B0BZGYGBNZ',targetVideoCount:2})});
   assert.equal(JSON.parse((await response.text()).trim().split('\n').at(-1)!).foundCount,1);
   assert.equal(checks,2);
 }finally{globalThis.fetch=original;}
});

test('an accepted video is delivered before the upstream search finishes',async()=>{
 let source!:ReadableStreamDefaultController<Uint8Array>;
 const upstream=new Response(new ReadableStream<Uint8Array>({start(c){source=c;}}));
 const response=await recoverTikTokStream(upstream,{body:JSON.stringify({productName:'water flosser',targetVideoCount:1,searchId:'s'})});
 const reader=response.body!.getReader(),encode=new TextEncoder();
 source.enqueue(encode.encode(JSON.stringify({type:'result',asset:{sourceUrl:'first'}})+'\n'));
 const first=await reader.read();
 assert.equal(JSON.parse(new TextDecoder().decode(first.value)).asset.sourceUrl,'first');
 source.close();
 await reader.read();
});
