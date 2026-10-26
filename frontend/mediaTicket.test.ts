import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mediaTicket,SessionExpired} from './mediaTicket';
import {timedRequest} from './request';
test('expired authentication is distinguishable from an unavailable customer video',async()=>{
 const signal=new AbortController().signal;
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>new Response('{}',{status:401})),SessionExpired);
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>new Response('{}',{status:502})),e=>e instanceof Error&&!(e instanceof SessionExpired));
 const path=await mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>Response.json({path:'/api/media?ticket=public-test'}));assert.equal(path,'/api/media?ticket=public-test');
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>Response.json({path:'https://evil.test/'})));
});

test('stalled API requests terminate once without retrying; explicit cancellation stays distinguishable',async()=>{
 let calls=0;
 const stalled:typeof fetch=async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>{const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});};
 // A real network socket keeps a browser alive; keep this unit-test event loop alive too.
 const keepAlive=setInterval(()=>{},1000);
 try{
  await assert.rejects(timedRequest('https://api.example',{},10,stalled),/السيرفر لم يرد/);
  assert.equal(calls,1);
  const controller=new AbortController();const pending=timedRequest('https://api.example',{signal:controller.signal},5000,stalled);controller.abort(Error('product changed'));
  await assert.rejects(pending,/product changed/);assert.equal(calls,2);
 }finally{clearInterval(keepAlive);}
});
