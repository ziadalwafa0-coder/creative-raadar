import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, CandidateAsset } from '../types/index.ts';
import { RequestScope } from '../utils/requestScope.ts';
import { prepareSearchIdentity, productInputFingerprint } from '../utils/productIdentity.ts';

// No private project DB, real API, Amazon request or media download is used.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radaar-isolation-'));
process.env.CREATIVE_RADAAR_DATA_DIR = scratch;
process.env.GEMINI_API_KEY = 'offline-simulation-not-a-real-key';
const amazon = await import('./amazonUs.ts');
const { ai } = await import('./gemini.ts');
const { StorageService } = await import('./storage.ts');
const { JobWorker } = await import('./worker.ts');
const originalFetch = globalThis.fetch;
const originalGenerate = ai.models.generateContent;
after(() => { globalThis.fetch = originalFetch; ai.models.generateContent = originalGenerate; });

function fixture(id = 'isolation-case', name = '9 Tier Shoe Rack with Dustproof Cover'): Project {
  return {id, name, sessionId:'isolation-owner', createdAt:'2026-10-24', updatedAt:'2026-10-24', referenceImages:[], mediaTypeRequested:'video', targetVideoCount:1, targetPhotoCount:1,
    settings:{strictness:'exact', contentSources:'customer_only', sourcePriority:['amazon'], preferredMarketplaces:['US'], preferredLanguages:['en'], excludeWorkspaceProjects:false, minDurationSeconds:0, preserveAudio:true, maxSearchDepth:1, maxProcessingTimeSeconds:10, estimatedBudgetUsd:0},
    jobState:'idle', logs:[], candidates:[], counters:{candidatesDiscovered:0,sourcesInspected:0,visuallyMatchedAssets:0,downloadedAssets:0,verifiedAssets:0,rejectedDuplicates:0,targetCount:1}};
}
function oldAsset(project: Project): CandidateAsset {
  return {id:'old-shoe-video',projectId:project.id,title:'Old shoe rack review',mediaType:'video',platform:'amazon',sourceUrl:'https://www.amazon.com/review/OLD',thumbnailUrl:'',provenance:'unverified_customer_review', matchCategory:'exact_design',matchScore:95,userFacingMatchLabel:'old',visibleDifferences:[],supportingObservations:[],unknowns:[],contentDescription:'',downloadStatus:'source_only',collectedAt:'2026-10-24',rightsStatus:'unknown',selectedForExport:true,searchInputFingerprint:project.searchInputFingerprint};
}

for (const name of ['Double Rail Clothes Garment Rack with Wheels','3 Tier Kitchen Spice Rack','Portable Washing Machine','Anti Snoring Device']) {
  test(`real search function does not drift to shoe queries: ${name}`, async () => {
    const queries: string[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'www.amazon.com') queries.push(url.searchParams.get('k') || '');
      return new Response('',{status:503});
    };
    await amazon.searchAmazonUsProductPages(name,4);
    assert.equal(queries[0],name);
    assert.ok(queries.every(q => !/shoe|closet/i.test(q)));
    if (name === 'Portable Washing Machine') assert.ok(queries.every(q=>!/pads/i.test(q)));
  });
}

test('explicit new product beats conflicting old profile', async () => {
  assert.doesNotMatch(await amazon.buildAmazonUsQuery('ستاند ملابس زوجي بعجل','9 Tier Shoe Rack with Dustproof Cover'),/shoe/i);
});
test('same niche is not same product', () => {
  assert.equal(amazon.evaluateStrictProductTitleMatch('9 Tier Shoe Rack with Cover','Double Rail Clothes Garment Rack with Wheels','ستاند ملابس').approved,false);
});
test('6 tiers cannot masquerade as requested 9 tiers', () => {
  assert.equal(amazon.evaluateStrictProductTitleMatch('6 Tier Shoe Rack with Dustproof Cover','9 Tier Shoe Rack with Cover','جزامة 9 دور بغطاء').approved,false);
});
test('exact 9-tier covered product remains eligible', () => {
  assert.equal(amazon.evaluateStrictProductTitleMatch('9 Tier Shoe Rack with Dustproof Cover','9 Tier Shoe Rack with Cover','جزامة 9 دور بغطاء').approved,true);
});
test('missing and fabricated titles cannot be approved', () => {
  for (const title of ['', 'Shoe Rack (B012345678)']) assert.equal(amazon.evaluateStrictProductTitleMatch(title,'Shoe Rack','جزامة').approved,false);
});
test('changed image resets old profile and results even with the same name', () => {
  const p = fixture(); p.referenceImages=[{id:'1',url:'data:image/png;base64,AAA',base64Data:'AAA',mimeType:'image/png',fileName:'a.png'}];
  const before=prepareSearchIdentity(p); p.candidates=[oldAsset(p)]; p.productProfile={suggestedNameEn:'Old shoe rack',confidence:'high'} as any;
  p.referenceImages[0].base64Data='BBB';
  assert.notEqual(prepareSearchIdentity(p),before); assert.equal(p.candidates.length,0); assert.equal(p.productProfile,undefined);
  assert.equal(p.previousSearches?.[0].candidates[0].id,'old-shoe-video');
});
test('unchanged input retains its own results; UI image IDs do not change identity', () => {
  const p=fixture(); p.referenceImages=[{id:'1',url:'same-image',mimeType:'image/png',fileName:'a.png'}];
  const fingerprint=prepareSearchIdentity(p); p.candidates=[oldAsset(p)]; p.referenceImages[0].id='2';
  assert.equal(productInputFingerprint(p),fingerprint); prepareSearchIdentity(p); assert.equal(p.candidates.length,1);
});
test('legacy unbound results are archived, never silently stamped as new product', () => {
  const p=fixture(); p.candidates=[oldAsset(p)]; prepareSearchIdentity(p);
  assert.equal(p.candidates.length,0); assert.equal(p.previousSearches?.length,1);
});
test('foreign project and stale fingerprint candidates never enter a search', () => {
  const p=fixture();prepareSearchIdentity(p);const own=oldAsset(p);
  p.candidates=[own,{...own,id:'foreign',projectId:'another-project'},{...own,id:'stale',searchInputFingerprint:'wrong'}];
  prepareSearchIdentity(p);assert.deepEqual(p.candidates.map(c=>c.id),['old-shoe-video']);
});
test('late A response cannot overwrite B, nor a later revisit of A', async () => {
  const scope=new RequestScope(); const oldA=scope.current();
  let release!:()=>void; const delayed=new Promise<void>(r=>{release=r;});
  let selected='A'; const oldRequest=delayed.then(()=>{if(scope.accepts(oldA))selected='A-old';});
  scope.invalidate(); selected='B'; release(); await oldRequest; assert.equal(selected,'B');
  scope.invalidate(); selected='A'; assert.equal(scope.accepts(oldA),false); assert.equal(selected,'A');
});
test('late image-reader result is discarded after a new file is chosen', () => {
  const scope=new RequestScope(); const imageA=scope.invalidate(); const imageB=scope.invalidate();
  assert.equal(scope.accepts(imageA),false); assert.equal(scope.accepts(imageB),true);
});

const searchHtml = ' '.repeat(5100) + ['B000000001','B000000002','B000000003','B000000004'].map(asin=>`<div data-asin="${asin}"><img class="s-image" src="https://m.media-amazon.com/images/I/fixture.jpg" alt="9 Tier Shoe Rack with Dustproof Cover"></div>`).join('');
function imageFixture(id:string): Project {
  const p=fixture(id); p.referenceImages=[{id:'reference',url:'data:image/png;base64,AAA',base64Data:'AAA',mimeType:'image/png',fileName:'reference.png'}];
  prepareSearchIdentity(p); p.productProfile={confidence:'high',suggestedNameEn:p.name,multilingualQueries:{en:[]},mustMatchAttributes:[]} as any;
  return p;
}
test('real worker: failed visual verifier cannot fall back to title-only approval', async () => {
  let visualCalls=0, reviewFetches=0;
  ai.models.generateContent = (async () => {visualCalls++;throw Object.assign(new Error('offline quota 429'),{status:429});}) as any;
  globalThis.fetch = async input => {
    const u=String(input);
    if(u.includes('/images/I/')) return new Response(new Uint8Array(600),{headers:{'content-type':'image/jpeg'}});
    if(u.includes('amazon.com/s?')) return new Response(searchHtml);
    if(u.includes('/dp/')) reviewFetches++;
    return new Response('',{status:503});
  };
  const p=imageFixture('worker-visual-failure'); const db=StorageService.getInstance();db.upsertProject(p);
  await JobWorker.getInstance().runProjectSearch(p.id);
  assert.ok(visualCalls>0); assert.equal(reviewFetches,0); assert.equal(db.getProject(p.id)?.candidates.length,0);
});
test('real worker: cancellation retains lock until original request has unwound', async () => {
  let release!:()=>void; let started!:()=>void;
  const pending=new Promise<void>(r=>{release=r;}); const entered=new Promise<void>(r=>{started=r;});
  globalThis.fetch = async () => {started();await pending; return new Response('',{status:503});};
  const p=fixture('worker-cancel','Double Rail Clothes Garment Rack with Wheels');prepareSearchIdentity(p);
  const db=StorageService.getInstance();db.upsertProject(p);const worker=JobWorker.getInstance();
  const old=worker.runProjectSearch(p.id);await entered; worker.cancelJob(p.id);
  assert.equal(worker.isRunning(p.id),true); await worker.runProjectSearch(p.id);assert.equal(worker.isRunning(p.id),true);
  release();await old;assert.equal(worker.isRunning(p.id),false);assert.equal(db.getProject(p.id)?.jobState,'cancelled');
});

test('real worker: approving page identity does not approve a mismatching video thumbnail', async () => {
  let videoChecks=0, mediaDownloads=0;
  ai.models.generateContent = (async (args:any) => {
    const text=JSON.stringify(args.contents);
    if(text.includes('VIDEO #')) {videoChecks++; return {text:JSON.stringify({decisions:[{index:0,approved:false,sentiment:'negative',matchScore:0,reasonAr:'Different product in thumbnail'}]})};}
    return {text:JSON.stringify({decisions:['B000000001','B000000002','B000000003','B000000004'].map(asin=>({asin,approved:true,matchCategory:'exact_design',matchScore:95,reasonAr:'Same product fixture'}))})};
  }) as any;
  const videoJson=JSON.stringify([{videoURL:'https://m.media-amazon.com/fixture.mp4',creatorType:'customer',title:'Great shoe rack',fullReviewLink:'/gp/customer-reviews/R123',videoImageUrl:'https://m.media-amazon.com/images/I/video.jpg'}]).replace(/"/g,'&quot;');
  globalThis.fetch=async input=>{
    const u=String(input);
    if(u.includes('/images/I/'))return new Response(new Uint8Array(600),{headers:{'content-type':'image/jpeg'}});
    if(u.includes('/fixture.mp4')) {mediaDownloads++;return new Response('',{status:503});}
    if(u.includes('amazon.com/s?'))return new Response(searchHtml);
    if(u.includes('/dp/'))return new Response(' '.repeat(5100)+`<div data-video-items="${videoJson}"></div>`);
    return new Response('',{status:503});
  };
  const p=imageFixture('worker-wrong-video'); const db=StorageService.getInstance();db.upsertProject(p);
  await JobWorker.getInstance().runProjectSearch(p.id);
  assert.ok(videoChecks>0);assert.equal(db.getProject(p.id)?.candidates.length,0);assert.equal(mediaDownloads,0);
});
test('neutral high-confidence video is not silently converted to positive', async () => {
  const { verifyVideosPositiveAndExactMatch }=await import('./gemini.ts');
  ai.models.generateContent=(async()=>({text:JSON.stringify({decisions:[{index:0,approved:true,sentiment:'neutral',matchScore:99,reasonAr:'Unknown sentiment'}]})})) as any;
  const verdict=await verifyVideosPositiveAndExactMatch('AAA','image/png','Shoe Rack',undefined,[{index:0,title:'Review',reviewer:'Customer',thumbBase64:'BBB'}]);
  assert.equal(verdict?.get(0)?.approved,false);
});
test('real worker: matching positive customer video remains available with its own identity and source', async () => {
  let videoChecks=0;
  ai.models.generateContent=(async(args:any)=>{
    if(JSON.stringify(args.contents).includes('VIDEO #')) {videoChecks++;return {text:JSON.stringify({decisions:[{index:0,approved:true,sentiment:'positive',matchScore:95,reasonAr:'Positive review of reference product'}]})};}
    return {text:JSON.stringify({decisions:['B000000001','B000000002','B000000003','B000000004'].map(asin=>({asin,approved:true,matchCategory:'exact_design',matchScore:95,reasonAr:'Same product fixture'}))})};
  }) as any;
  const items=JSON.stringify([{videoURL:'https://m.media-amazon.com/matching-fixture.mp4',creatorType:'customer',title:'Great shoe rack',fullReviewLink:'/gp/customer-reviews/RPOSITIVE',videoImageUrl:'https://m.media-amazon.com/images/I/video.jpg'}]).replace(/"/g,'&quot;');
  globalThis.fetch=async input=>{
    const u=String(input);
    if(u.includes('/images/I/')) return new Response(new Uint8Array(600),{headers:{'content-type':'image/jpeg'}});
    if(u.includes('amazon.com/s?'))return new Response(searchHtml);
    if(u.includes('/dp/'))return new Response(' '.repeat(5100)+`<div data-video-items="${items}"></div>`);
    return new Response('',{status:503});
  };
  const p=imageFixture('worker-correct-video');const db=StorageService.getInstance();db.upsertProject(p);
  await JobWorker.getInstance().runProjectSearch(p.id);
  const results=db.getProject(p.id)!.candidates;
  assert.ok(videoChecks>0);assert.equal(results.length,1);
  assert.equal(results[0].projectId,p.id);assert.equal(results[0].searchInputFingerprint,p.searchInputFingerprint);
  assert.equal(results[0].sentiment,'positive');assert.match(results[0].sourceUrl,/RPOSITIVE/);
  assert.doesNotMatch(results[0].userFacingMatchLabel,/100%/);
  assert.notEqual(results[0].downloadStatus,'verified_available'); // HTTP 503 is not a verified media file.
});
test('real worker: missing vision configuration stops instead of accepting image search by name', async () => {
  const p=imageFixture('worker-missing-config');const db=StorageService.getInstance();db.upsertProject(p);
  const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='';let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('',{status:503});};
  try {await JobWorker.getInstance().runProjectSearch(p.id);} finally {process.env.GEMINI_API_KEY=previous;}
  assert.equal(db.getProject(p.id)?.jobState,'needs_configuration');assert.equal(db.getProject(p.id)?.candidates.length,0);assert.equal(calls,0);
});
