import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchAmazonUsProductVideos,nextAmazonReviewPage} from './amazonVideos.ts';
import {detectAmazonBlock} from './amazonHttp.ts';
import {collectVerifiedListings} from './verifiedCollection.ts';

const asin='B012345678';
const review=(id:number)=>`<div id="customer_review-RTEST${id}"><span class="a-profile-name">Customer ${id}</span>https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/stream00000${id}/video.m3u8</div>`;
const next=(page:number)=>`<li class="a-last"><a href="/product-reviews/${asin}?pageNumber=${page}&amp;mediaType=media_reviews_only">Next</a></li>`;

test('review pagination streams first results, follows same-product next pages and deduplicates videos',async()=>{
  const emitted:string[]=[]; const requests:string[]=[];
  const videos=await fetchAmazonUsProductVideos(asin,undefined,{limit:3,onVideo:video=>emitted.push(video.streamUuid),fetchHtml:async(url)=>{
    requests.push(url);
    if(url.includes('pageNumber=2')) { assert.equal(emitted.length,2,'first videos must appear before fetching the next page'); return review(2)+review(3); }
    return url.includes('product-reviews') ? review(2)+next(2) : review(1);
  }});
  assert.equal(videos.length,3); assert.equal(new Set(emitted).size,3);
  assert.equal(requests.length,3);
});

test('repeated pagination pages cannot inflate counts or create a loop',async()=>{
  let requests=0; let limited=false;
  const videos=await fetchAmazonUsProductVideos(asin,undefined,{limit:10,onLimited:()=>{limited=true;},fetchHtml:async()=>{requests++; return review(1)+next(2);}});
  assert.equal(videos.length,1); assert.equal(requests,5); assert.equal(limited,true);
  assert.equal(nextAmazonReviewPage(`<li class="a-last"><a href="https://evil.test/product-reviews/${asin}?pageNumber=2">Next</a></li>`,'https://www.amazon.com',asin),null);
  assert.equal(nextAmazonReviewPage(next(2),'https://www.amazon.com','B099999999'),null);
  assert.equal(nextAmazonReviewPage(next(2).replace('a-last','a-last a-disabled'),'https://www.amazon.com',asin),null);
});

test('sign-in is an access restriction rather than an exhausted review list',()=>{
  assert.equal(detectAmazonBlock(200,'<title dir="ltr">Sign in</title><form id="ap_login_form">'+' '.repeat(5000)).blocked,true);
});

test('reviews already emitted by another listing do not consume the remaining requested count',async()=>{
  const seen=new Set(['stream000001']);
  const videos=await fetchAmazonUsProductVideos(asin,undefined,{limit:2,excludeStreamUuids:seen,onVideo:video=>seen.add(video.streamUuid),fetchHtml:async url=>url.includes('product-reviews') ? review(3) : review(1)+review(2)});
  assert.deepEqual(videos.map(video=>video.streamUuid).sort(),['stream000002','stream000003']);
});

test('rotating same-ASIN carousel subsets are accumulated instead of replacing older videos',async()=>{
  let views=0;
  const videos=await fetchAmazonUsProductVideos(asin,undefined,{limit:10,fetchHtml:async url=>{
    if(url.includes('product-reviews')) return '';
    views++;
    return Array.from({length:4},(_,index)=>review((views-1)*3+index+1)).join('');
  }});
  assert.equal(videos.length,10); assert.equal(new Set(videos.map(video=>video.reviewId)).size,10);
  assert.equal(views,3);
});

test('extra listings require image evidence and a server visual approval; client approvals are ignored',async()=>{
  const approved='B011111111',rejected='B022222222';
  let verificationCalls=0;
  const input={referenceImage:'data:image/jpeg;base64,'+'A'.repeat(100),query:'Spray Mop',profile:{suggestedNameEn:'Spray Mop',confidence:'high'},approvedAsins:[rejected]};
  const rows=[];
  const dependencies={ready:()=>true,search:async()=>({fromCache:false,candidates:[approved,rejected].map(id=>({asin:id,title:'Spray Mop Refillable Bottle',url:`https://www.amazon.com/dp/${id}`,ratingCount:100,imageUrl:'https://m.media-amazon.com/images/I/photo.jpg'}))}),picture:async()=>({base64:'photo-data',mimeType:'image/jpeg'}),verify:async()=>{
    verificationCalls++;
    return new Map([approved,rejected].map(id=>[id,{asin:id,approved:id===approved,matchScore:95,matchCategory:'exact_design' as const,userFacingLabelAr:'test',reasonAr:'test'}]));
  }};
  for await(const batch of collectVerifiedListings(input,'مساحة',new Set(),new AbortController().signal,()=>{},()=>rows.length>0,dependencies)) rows.push(...batch);
  assert.deepEqual(rows.map(row=>row.page.asin),[approved]); assert.equal(verificationCalls,1);
  const failed={...dependencies,verify:async()=>null};
  const rejectedRows=[];
  for await(const batch of collectVerifiedListings(input,'مساحة',new Set(),new AbortController().signal,()=>{},()=>false,failed)) rejectedRows.push(...batch);
  assert.equal(rejectedRows.length,0);
});
