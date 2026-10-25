import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aiAmazonQueries} from './aiAmazonQuery';
import {describeEmptyProduct} from './browserCollector';
test('query helper filters malformed phrases and safely falls back on unavailable AI',async()=>{
 const call=(request:any)=>aiAmazonQueries('https://own.test','test-token','جزامة',undefined,'amazon.com',new AbortController().signal,request);
 assert.deepEqual(await call(async()=>Response.json({queries:['Shoe rack','Shoe rack','جزامة','','9 tier shoe rack']})),['Shoe rack','9 tier shoe rack']);
 for(const request of [async()=>Response.json({queries:['عربي','']}),async()=>new Response('',{status:501}),async()=>{throw Error('offline');}])assert.equal(await call(request),null);
 const abort=new AbortController();abort.abort();await assert.rejects(aiAmazonQueries('','','x',undefined,'amazon.com',abort.signal,async()=>{throw Error('must not request');}));
});
test('empty review diagnostics explain missing sections and rejected non-customer media',()=>{
 const base={reviews:3,videoBlocks:0,videoItems:0,hasReviewsSection:true};
 assert.match(describeEmptyProduct('ASIN'),/1.3.1/);assert.match(describeEmptyProduct('ASIN',{...base,hasReviewsSection:false}),/ما ظهرش/);
 assert.match(describeEmptyProduct('ASIN',base),/3 ريفيو/);assert.match(describeEmptyProduct('ASIN',{...base,clickedTab:true}),/بعد فتح/);
 assert.match(describeEmptyProduct('ASIN',{...base,videoItems:4}),/لموديل تاني/);
});
