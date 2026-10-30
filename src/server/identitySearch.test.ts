import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchProductIdentity,identitySearchPlan} from './identitySearch.ts';
import {normalizeProductProfile} from './productProfile.ts';
import {productComparisonImageUrl} from './amazonHttp.ts';

const profile=normalizeProductProfile({suggestedNameEn:'Spray Mop',confidence:'high',multilingualQueries:{en:['Spray Mop Refillable Bottle','ممسحة','123']}});
const input={query:'Spray Mop',productName:'مساحة وبخاخة',profile,referenceImage:'data:image/jpeg;base64,'+'A'.repeat(100)};
const candidate=(i:number)=>({asin:'B0'+String(i).padStart(8,'0'),title:'Spray Mop Refillable Bottle with Microfiber Pads',url:'https://www.amazon.com/dp/B0'+String(i).padStart(8,'0'),imageUrl:'https://m.media-amazon.com/images/I/image._AC_UL320_.jpg',ratingCount:100});
const verdict=(asin:string,approved:boolean)=>({asin,approved,matchScore:approved ? 96 : 30,matchCategory:approved ? 'exact_design' as const : 'mismatched' as const,userFacingLabelAr:'',reasonAr:''});

test('an empty first batch continues to a distinct commercial query and never returns rejected listings',async()=>{
  const calls:string[]=[];let verified=0;
  const result=await searchProductIdentity(input,new AbortController().signal,{
    ready:()=>true,
    search:async query=>{calls.push(query);return {fromCache:false,candidates:query==='Spray Mop' ? Array.from({length:8},(_,i)=>candidate(i+1)) : [candidate(9)]};},
    picture:async()=>({base64:'photo',mimeType:'image/jpeg'}),
    verify:async(_image,_mime,_name,_profile,rows)=>{verified++;return new Map(rows.map(row=>[row.asin,verdict(row.asin,verified===2)]));},
  });
  assert.deepEqual(calls,['Spray Mop','Spray Mop Refillable Bottle']);
  assert.equal(result.diagnostics.checkedCount,9);
  assert.deepEqual(result.products.map(product=>product.asin),[candidate(9).asin]);
});

test('a provider failure is reported as incomplete verification, not a completed visual mismatch',async()=>{
  const result=await searchProductIdentity(input,new AbortController().signal,{
    ready:()=>true,search:async()=>({fromCache:false,candidates:[candidate(1)]}),picture:async()=>({base64:'photo',mimeType:'image/jpeg'}),verify:async()=>null,
  });
  assert.equal(result.verification,'unavailable');
  assert.equal(result.diagnostics.reason,'VERIFICATION_UNAVAILABLE');
  assert.equal(result.products.length,0);
});

test('repeated listings are checked once, with a bounded search and no forced nearest result',async()=>{
  let checked=0,searches=0;
  const result=await searchProductIdentity(input,new AbortController().signal,{
    ready:()=>true,search:async()=>{searches++;return {fromCache:false,candidates:[candidate(1)]};},picture:async()=>({base64:'photo',mimeType:'image/jpeg'}),
    verify:async(_image,_mime,_name,_profile,rows)=>{checked+=rows.length;return new Map(rows.map(row=>[row.asin,verdict(row.asin,false)]));},
  });
  assert.equal(searches,3);assert.equal(checked,1);assert.equal(result.products.length,0);
  assert.equal(result.diagnostics.reason,'NO_CONFIRMED_MATCH');
  assert.equal(identitySearchPlan('spray mop',profile).length,3);
});

test('image loading failures and product changes cannot become false match verdicts',async()=>{
  const controller=new AbortController();
  const deps={ready:()=>true,search:async()=>({fromCache:false,candidates:[candidate(1)]}),picture:async()=>null,verify:async()=>{throw new Error('must not verify missing images');}};
  const result=await searchProductIdentity(input,controller.signal,deps);
  assert.equal(result.diagnostics.reason,'INCOMPLETE_IMAGES');assert.equal(result.diagnostics.checkedCount,0);
  controller.abort();await assert.rejects(()=>searchProductIdentity(input,controller.signal,deps),{name:'AbortError'});
});

test('visual comparisons use a larger version of the same Amazon image, not a replacement image',()=>{
  assert.equal(productComparisonImageUrl('https://m.media-amazon.com/images/I/ABC._AC_UL320_.jpg'),'https://m.media-amazon.com/images/I/ABC._SL800_.jpg');
  assert.equal(productComparisonImageUrl('https://example.com/images/I/ABC._AC_UL320_.jpg'),'https://example.com/images/I/ABC._AC_UL320_.jpg');
  assert.deepEqual(profile.multilingualQueries.en,['Spray Mop','Spray Mop Refillable Bottle']);
});
