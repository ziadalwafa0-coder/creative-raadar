import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTikTokProviderRows,searchTikTokProvider} from './tiktokProvider.ts';
const video={id:'7543693751290481942',webVideoUrl:'https://www.tiktok.com/@tester/video/7543693751290481942',text:'Spray mop demo',mediaUrls:['https://api.apify.com/v2/key-value-stores/example/records/video.mp4']};
test('TikTok rows require a real permalink, safe video media and unique video IDs',()=>{
  const rows=[{...video,webVideoUrl:'https://evil.example/video'}, {...video,mediaUrls:['http://127.0.0.1/private']},video,video,{...video,isSlideshow:true}];
  assert.equal(parseTikTokProviderRows(rows,10).length,1);
});
test('a paid or unverified plan never starts a TikTok provider run',async()=>{
  let calls=0;
  const request=async()=>{calls++;return Response.json({data:{plan:{tier:'STARTER',monthlyBasePriceUsd:19}}});};
  await assert.rejects(searchTikTokProvider('mop',10,new AbortController().signal,request as typeof fetch,'test'),'');
  assert.equal(calls,1);
});
test('free-plan provider requests are bounded and return actual media records',async()=>{
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const request=async(url:any,init?:RequestInit)=>{
    calls.push({url:String(url),init});
    return calls.length===1?Response.json({data:{plan:{tier:'FREE',monthlyBasePriceUsd:0},isPaying:false}}):Response.json([video]);
  };
  const results=await searchTikTokProvider('spray mop',500,new AbortController().signal,request as typeof fetch,'test');
  assert.equal(results.length,1);
  assert.equal(JSON.parse(String(calls[1].init?.body)).resultsPerPage,50);
  assert.ok(calls[1].url.includes('maxTotalChargeUsd=0.1'));
  assert.ok(!calls[1].url.includes('test'));
});
