import {test} from 'node:test';
import assert from 'node:assert/strict';
import {translateProductName} from './translateProduct';
const signal=()=>new AbortController().signal;
test('English product names bypass translation services',async()=>{
 let calls=0;const result=await translateProductName('  cordless water flosser ',signal(),{runtime:null,fetcher:async()=>{calls++;throw Error('must not call');}});
 assert.equal(result,'cordless water flosser');assert.equal(calls,0);
});
test('Arabic names use free fallback and cache only the translation in memory',async()=>{
 let calls=0;const cache=new Map<string,string>();const fetcher:typeof fetch=async(url,init)=>{calls++;const u=new URL(String(url));assert.equal(u.searchParams.get('langpair'),'ar|en');assert.equal(u.searchParams.get('q'),'أداة تنظيف صغيرة');assert.equal(init?.credentials,'omit');return Response.json({responseStatus:200,responseData:{translatedText:'Small cleaning tool'}});};
 assert.equal(await translateProductName('أداة تنظيف صغيرة',signal(),{runtime:null,fetcher,cache}),'Small cleaning tool');
 assert.equal(await translateProductName('أداة تنظيف صغيرة',signal(),{runtime:null,fetcher,cache}),'Small cleaning tool');assert.equal(calls,1);
});
test('native Chrome translation avoids the external provider and is destroyed',async()=>{
 let destroyed=false;const runtime={availability:async()=>'available',create:async()=>({translate:async()=>'water flosser',destroy:()=>{destroyed=true;}})};
 assert.equal(await translateProductName('أداة تنظيف محمولة',signal(),{runtime,cache:new Map(),fetcher:async()=>{throw Error('must not call');}}),'water flosser');assert(destroyed);
});
test('quota errors and untranslated Arabic never become Amazon search queries',async()=>{
 for(const data of [{quotaFinished:true,responseStatus:200,responseData:{translatedText:'MYMEMORY WARNING: FREE TRANSLATIONS'}},{responseStatus:200,responseData:{translatedText:'اسم عربي'}}])await assert.rejects(translateProductName('منتج للاختبار',signal(),{runtime:null,cache:new Map(),fetcher:async()=>Response.json(data)}));
});
test('a cancelled translation cannot return or cache a late response',async()=>{
 const controller=new AbortController();const cache=new Map<string,string>();
 await assert.rejects(translateProductName('اسم مختلف',controller.signal,{runtime:null,cache,fetcher:async()=>{controller.abort();return Response.json({responseStatus:200,responseData:{translatedText:'different name'}});}}));assert.equal(cache.size,0);
});
