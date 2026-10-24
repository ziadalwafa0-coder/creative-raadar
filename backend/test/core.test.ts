import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRatingsCount,dedupeVideos,safeMediaUrl} from '../src/utils.ts';
import {publicAddress,rewriteManifest} from '../src/media.ts';
import {parseCustomerVideoBlocks} from '../src/parser.ts';
import {SourceError,type VideoSource,type ReviewVideo,type ProductHit} from '../src/types.ts';
import {Cache} from '../src/cache.ts';
import {searchVideos} from '../src/pipeline.ts';
import {createAuth} from '../src/auth.ts';
import {buildApp} from '../src/index.ts';
import {SearchSession,readNdjson} from '../../frontend/ndjson.ts';
import fs from 'node:fs';

const media=(i:number)=>`https://m.media-amazon.com/images/S/test-${i}.mp4`;
const video=(i:number,asin='B000000002'):ReviewVideo=>({url:media(i),type:'mp4',sourceAsin:asin,sourceUrl:`https://www.amazon.com/dp/${asin}`,customerReview:true});
const hit=(asin:string,count:number):ProductHit=>({asin,title:'Double rod clothes rack',ratingsCount:count,url:`https://www.amazon.com/dp/${asin}`});
const freshCache=()=>new Cache({warn:()=>{}},'','');
const collect=async(source:VideoSource,cache=freshCache())=>{const events=[];for await(const event of searchVideos('clothes rack','amazon.com','123',source,cache,new AbortController().signal))events.push(event);return events;};

test('ratings support K, separators, Arabic-Indic and Persian digits',()=>{
 for(const [input,expected]of [['1.2K',1200],['12,345',12345],['١٢٬٣٤٥ تقييم',12345],['۱٫۲K',1200],['٢ ألف',2000],['0',0],['not a number',0]] as const)assert.equal(parseRatingsCount(input),expected);
});
test('dedupe uses URLs and preserves different customer videos',()=>{assert.equal(dedupeVideos([video(1),video(1),video(2)]).length,2);});
test('media allowlist rejects internal IPs, spoofed hosts, credentials, ports and HTTP',()=>{
 for(const url of ['http://m.media-amazon.com/a.mp4','https://127.0.0.1/a','https://[::1]/a','https://m.media-amazon.com.evil.test/a','https://m.media-amazon.com@evil.test/a','https://m.media-amazon.com:444/a'])assert.equal(safeMediaUrl(url),false);
 assert.equal(safeMediaUrl(media(1)),true);for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1'])assert.equal(publicAddress(ip),false);
});
test('HLS manifest rewrites segments and keys and rejects external URLs',()=>{
 const input='#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nchunk.ts';
 const result=rewriteManifest(input,'https://m.media-amazon.com/a/master.m3u8',u=>'proxy?'+encodeURIComponent(u));
 assert.match(result,/proxy\?/);assert.ok(!result.split('\n').includes('chunk.ts'));
 assert.throws(()=>rewriteManifest('#EXTM3U\nhttp://127.0.0.1/x','https://m.media-amazon.com/a/master.m3u8',u=>u));
});
test('parser accepts critical customer reviews and excludes sellers, affiliates and wrong ASINs',()=>{
 const records=[{creatorType:'customer',title:'Broke, disappointed',videoURL:media(1),productAsin:'B000000002'},{creatorType:'influencer',title:'Great',videoURL:media(2)},{creatorType:'seller',videoURL:media(3)},{creatorType:'customer',videoURL:media(4),productAsin:'B000000099'}];
 const videos=parseCustomerVideoBlocks([JSON.stringify(records)],'B000000002','amazon.com');assert.equal(videos.length,1);assert.equal(videos[0].title,'Broke, disappointed');assert.equal(videos[0].sentiment,undefined);
});
test('pipeline sorts ratings, skips an empty product, caps at 12 and serves repeats from cache',async()=>{
 const checked:string[]=[];let searches=0;
 const source:VideoSource={name:'fixture',async search(){searches++;return [hit('B000000002',20),hit('B000000001',100)];},async getCustomerVideos(asin){checked.push(asin);return asin==='B000000001'?[]:[...Array.from({length:15},(_,i)=>video(i)),video(0)];}};
 const cache=freshCache();const first=await collect(source,cache);assert.deepEqual(checked,['B000000001','B000000002']);assert.equal(first.filter(e=>'type'in e&&e.type==='video').length,12);assert.deepEqual(first.at(-1),{done:true,id:'123',count:12});
 await collect(source,cache);assert.equal(searches,1);assert.equal(checked.length,2);
});
test('blocked products emit explicit warnings and are not negative-cached',async()=>{
 let inspections=0;const source:VideoSource={name:'fixture',async search(){return [hit('B000000001',1)];},async getCustomerVideos(){inspections++;throw new SourceError('CAPTCHA','أمازون طلب تحققًا بشريًا');}};
 const cache=freshCache();const events=await collect(source,cache);assert.ok(events.some(e=>'type'in e&&e.type==='warn'&&e.code==='CAPTCHA'));const last=events.at(-1);assert.ok(last&&'count'in last);assert.equal(last.count,0);await collect(source,cache);assert.equal(inspections,2);
});
test('new search aborts old stream and cannot accept old search IDs',async()=>{
 const session=new SearchSession();const a=session.start();const b=session.start();assert.equal(a.signal.aborted,true);assert.equal(session.current(a.id),false);assert.equal(session.current(b.id),true);
 const encoder=new TextEncoder();const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode('{"id":"one","type":"warn","reason":"سطر"}\n{"done":'));controller.enqueue(encoder.encode('true}\n'));controller.close();}});
 const events:any[]=[];await readNdjson(stream,b.signal,e=>events.push(e));assert.equal(events.length,2);assert.equal(events[0].reason,'سطر');
 session.clear();assert.equal(session.current(b.id),false);
});
test('HTTP API streams its first video before fetching the next product',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const auth=createAuth();const source:VideoSource={name:'fixture',async search(){return [hit('B000000001',2),hit('B000000002',1)];},async getCustomerVideos(asin){if(asin==='B000000002')await gate;return [video(asin==='B000000001'?1:2,asin)];}};
 const app=await buildApp({source,auth,cache:freshCache(),logging:false});await app.listen({host:'127.0.0.1',port:0});
 const base=app.listeningOrigin;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 try{
  assert.equal((await app.inject({url:'/api/search?q=rack&id=123'})).statusCode,401);
  const response=await fetch(base+'/api/search?'+new URLSearchParams({q:'clothes rack',id:crypto.randomUUID()}),{headers:{Authorization:`Bearer ${auth.issue('session','test')}`},signal:controller.signal});
  assert.equal(response.status,200);const events:any[]=[];
  const reading=readNdjson(response.body!,controller.signal,event=>{events.push(event);if(event.type==='video'&&event.video.sourceAsin==='B000000001')release();});
  await reading;assert.equal(events.filter(e=>e.type==='video').length,2);assert.equal(events.at(-1).done,true);
 }finally{release();clearTimeout(timer);controller.abort();await app.close();}
});
test('active source contains no review-list navigation or Amazon account login',()=>{
 const files=['../src/sources/public.ts','../src/sources/provider.ts','../src/index.ts'];
 for(const file of files){const content=fs.readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(content,/\/product-reviews\//);assert.doesNotMatch(content,/storageState\s*:|addCookies\s*\(|\/ap\/signin/);}
});
