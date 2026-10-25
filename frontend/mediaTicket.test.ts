import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mediaTicket,SessionExpired} from './mediaTicket';
test('expired authentication is distinguishable from an unavailable customer video',async()=>{
 const signal=new AbortController().signal;
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>new Response('{}',{status:401})),SessionExpired);
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>new Response('{}',{status:502})),e=>e instanceof Error&&!(e instanceof SessionExpired));
 const path=await mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>Response.json({path:'/api/media?ticket=public-test'}));assert.equal(path,'/api/media?ticket=public-test');
 await assert.rejects(mediaTicket('https://api.example','token','https://m.media-amazon.com/a.mp4',signal,async()=>Response.json({path:'https://evil.test/'})));
});
