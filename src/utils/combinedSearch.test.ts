import test from 'node:test';
import assert from 'node:assert/strict';
import {combinedSearch} from './combinedSearch.ts';
const body={searchId:'parent',sourcePlatform:'all',productName:'Spray Mop',mediaType:'video',targetVideoCount:10,targetPhotoCount:0,productUrl:'https://www.amazon.com/dp/B0GVFWT8C9'};
test('combined collection keeps one active search, a total quota, and separate source requests',async()=>{
  const requests:any[]=[];
  const response=combinedSearch({method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify(body)},async(_url,init)=>{
    const b=JSON.parse(String(init?.body));requests.push(b);
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test');
    return new Response(Array.from({length:b.targetVideoCount},(_,i)=>JSON.stringify({type:'result',searchId:b.searchId,
      asset:{searchId:b.searchId,mediaType:'video',platform:b.sourcePlatform,mediaUrl:'https://example.com/'+b.sourcePlatform+i+'.mp4'}})).join('\n'));
  });
  const events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));
  const results=events.filter(e=>e.type==='result');
  assert.equal(results.length,10);assert.ok(results.every(e=>e.searchId==='parent'&&e.asset.searchId==='parent'));
  assert.equal(requests[0].targetVideoCount,5);assert.equal(requests[1].targetVideoCount,5);
  assert.equal(requests[1].productUrl,undefined);assert.equal(events.at(-1).type,'completed');
});
test('a TikTok failure preserves Amazon results and reports a partial result',async()=>{
  const response=combinedSearch({method:'POST',body:JSON.stringify(body)},async(_url,init)=>{
    const b=JSON.parse(String(init?.body));
    const events=b.sourcePlatform==='amazon'?[{type:'result',asset:{mediaType:'video',mediaUrl:'https://example.com/one.mp4'}}]:[{type:'failed',error:'TikTok unavailable'}];
    return new Response(events.map(e=>JSON.stringify(e)).join('\n'));
  });
  const events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(events.filter(e=>e.type==='result').length,1);
  assert.equal(events.at(-1).foundCount,1);
  assert.match(events.at(-1).reasonIfPartial,/TikTok unavailable/);
});

test('Amazon fills an unavailable TikTok share without counting replayed videos',async()=>{
  const response=combinedSearch({method:'POST',body:JSON.stringify(body)},async(_url,init)=>{
    const req=JSON.parse(String(init?.body));
    const events=req.sourcePlatform==='tiktok'?[]:Array.from({length:req.targetVideoCount},(_,i)=>({
      type:'result',asset:{mediaType:'video',mediaUrl:'https://example.com/'+i+'.mp4'}
    }));
    return new Response(events.map(event=>JSON.stringify(event)).join('\n'));
  });
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(new Set(events.filter(event=>event.asset).map(event=>event.asset.mediaUrl)).size,10);
  assert.equal(events.at(-1).foundCount,10);
});
