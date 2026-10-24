import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {Cache,type MediaCache} from './cache.ts';
import {markets,type Marketplace,type VideoSource,SourceError} from './types.ts';
import {PublicPageSource} from './sources/public.ts';
import {ApiProviderSource} from './sources/provider.ts';
import {AutoSource} from './sources/auto.ts';
import {searchVideos,type DebugResult} from './pipeline.ts';
import {createAuth,validCode} from './auth.ts';
import {openMedia,rewriteManifest} from './media.ts';
import {safeMediaUrl} from './utils.ts';

export async function buildApp(options:{source?:VideoSource;cache?:MediaCache;logging?:boolean;auth?:ReturnType<typeof createAuth>}={}){
 const app=Fastify({bodyLimit:65536,trustProxy:process.env.TRUST_PROXY==='true'?(_address:string,hop:number)=>hop<1:false,logger:options.logging===false?false:{redact:['req.headers.authorization','req.headers.cookie','req.headers.x-admin-key'],serializers:{req:req=>({method:req.method,path:String(req.url).split('?')[0]})}}});
 const origins=(process.env.FRONTEND_ORIGINS||'https://creative-raadar.vercel.app,http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim());
 await app.register(cors,{origin:origins,allowedHeaders:['Content-Type','Authorization','Range','X-Admin-Key'],exposedHeaders:['Content-Range','Accept-Ranges','Content-Length'],methods:['GET','POST','OPTIONS']});
 await app.register(rateLimit,{global:false});
 const auth=options.auth||createAuth();const cache=options.cache||new Cache(app.log);const publicSource=new PublicPageSource(app.log);const provider=new ApiProviderSource();
 const diagnostics=new Map<string,DebugResult>();
 const activeOwners=new Map<string,AbortController>();let streams=0;
 const bearer=(request:any)=>String(request.headers.authorization||'').replace(/^Bearer\s+/i,'');
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
  const path=req.url.split('?')[0];if(req.method==='OPTIONS'||path==='/health'||path==='/api/health'||path==='/api/auth/login'||path.startsWith('/api/debug/'))return;
  if(path==='/api/media'){
   const q=req.query as any;if(auth.verify(String(q.ticket||''),'media',String(q.u||'')))return;
  }
  if(!auth.verify(bearer(req),'session'))return reply.code(401).send({error:'سجل الدخول أولًا'});
 });
 const health=async()=>({ok:true,mode:'public-customer-reviews',source:process.env.SOURCE||'public',cache:process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_KEY?'supabase':'memory',persistentMedia:false});
 app.get('/health',health);app.get('/api/health',health);
 app.post('/api/auth/login',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
  if(!validCode((req.body as any)?.code))return reply.code(401).send({error:'كود الدخول غير صحيح'});
  return {token:auth.issue('session','authorized'),authenticated:true};
 });
 app.get('/api/auth/session',async()=>({authenticated:true}));
 app.post('/api/auth/logout',async(req)=>{auth.revoke(bearer(req));return {authenticated:false};});
 app.get('/api/debug/:asin',async(req,reply)=>{
  const expected=process.env.ADMIN_KEY;const actual=String(req.headers['x-admin-key']||'');
  if(!expected||Buffer.byteLength(expected)!==Buffer.byteLength(actual)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return reply.code(403).send({error:'غير مسموح'});
  const {asin}=req.params as any;const market=(req.query as any).marketplace||'amazon.com';return diagnostics.get(`${market}:${asin}`)||{status:'not_checked'};
 });
 app.get('/api/search',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const {q,marketplace='amazon.com',id}=req.query as any;
  if(typeof q!=='string'||q.trim().length<3||q.length>300||typeof marketplace!=='string'||!Object.hasOwn(markets,marketplace)||typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))return reply.code(400).send({error:'اسم المنتج أو المتجر أو معرّف البحث غير صالح'});
  const owner=bearer(req);
  const previous=activeOwners.get(owner);previous?.abort();
  if(streams>=8&&!previous)return reply.code(429).send({error:'السيرفر مشغول مؤقتًا؛ جرّب بعد لحظة'});
  const controller=new AbortController();activeOwners.set(owner,controller);streams++;
  const abort=()=>controller.abort();const timer=setTimeout(abort,8*60000);reply.raw.on('close',abort);
  const reportWarning=(error:SourceError)=>app.log.warn({id,code:error.code,snapshot:error.code==='PARSE_EMPTY'?error.snapshot?.slice(0,51200):undefined},'source warning');
  const source=options.source||(process.env.SOURCE==='provider'?provider:process.env.SOURCE==='auto'?new AutoSource(publicSource,provider,reportWarning):publicSource);
  reply.header('Content-Type','application/x-ndjson; charset=utf-8').header('X-Accel-Buffering','no');
  reply.hijack();for(const [key,value]of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(key,typeof value==='number'?String(value):value);reply.raw.statusCode=200;reply.raw.flushHeaders();
  try{
   for await(const event of searchVideos(q.trim(),marketplace as Marketplace,id,source,cache,controller.signal,(asin,result)=>{
    if(diagnostics.size>=1000)diagnostics.delete(diagnostics.keys().next().value!);
    diagnostics.set(`${marketplace}:${asin}`,result);app.log.info({id,asin,...result},'product inspected');
   })){
    if(!reply.raw.write(JSON.stringify(event)+'\n'))await once(reply.raw,'drain',{signal:controller.signal});
   }
  }catch(error){if(!controller.signal.aborted)app.log.error({id,errorType:error instanceof Error?error.name:'unknown'},'search failed');}
  finally{clearTimeout(timer);reply.raw.off('close',abort);controller.abort();if(!reply.raw.destroyed)reply.raw.end();if(activeOwners.get(owner)===controller)activeOwners.delete(owner);streams--;}
 });
 app.post('/api/media-ticket',async(req,reply)=>{
  const url=String((req.body as any)?.url||'');if(!safeMediaUrl(url))return reply.code(400).send({error:'رابط ميديا غير مسموح'});
  return {path:'/api/media?'+new URLSearchParams({u:url,ticket:auth.issue('media',url,15*60000)}).toString()};
 });
 app.get('/api/media',async(req,reply)=>{
  const q=req.query as any;const url=String(q.u||'');if(!safeMediaUrl(url))return reply.code(400).send({error:'رابط ميديا غير مسموح'});
  const range=req.headers.range;if(range&&!/^bytes=\d*-\d*$/.test(range))return reply.code(416).send();
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);const abort=()=>controller.abort();reply.raw.on('close',abort);
  let close:(()=>Promise<void>)|undefined;
  try{
   const opened=await openMedia(url,{...(range?{Range:range}:{}),Referer:'https://www.amazon.com/'},controller.signal);close=opened.close;
   const remote=opened.response;
   if(![200,206,416].includes(remote.status)){await remote.body?.cancel();return reply.code(502).send({error:'مصدر الفيديو غير متاح'});}
   const type=remote.headers.get('content-type')||'';
   if(remote.status===416){const cr=remote.headers.get('content-range');if(cr)reply.header('Content-Range',cr);await remote.body?.cancel();return reply.code(416).send();}
   if(/mpegurl/i.test(type)||/\.m3u8(?:[?#]|$)/i.test(url)){
    const reader=remote.body!.getReader();let size=0;const parts:Uint8Array[]=[];
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw Error('manifest too large');}parts.push(value);}
    const text=Buffer.concat(parts).toString('utf8');if(!text.startsWith('#EXTM3U'))throw Error('invalid manifest');
    return reply.type('application/vnd.apple.mpegurl').send(rewriteManifest(text,url,value=>'/api/media?'+new URLSearchParams({u:value,ticket:auth.issue('media',value,15*60000)}).toString()));
   }
   if(!/^(video\/|audio\/|application\/octet-stream)/i.test(type)){await remote.body?.cancel();return reply.code(422).send({error:'المصدر لم يرجع ملف فيديو'});}
   reply.code(remote.status).type(type);
   for(const name of ['content-range','accept-ranges','content-length']){const value=remote.headers.get(name);if(value)reply.header(name,value);}
   if(q.download==='1')reply.header('Content-Disposition','attachment; filename="creative-radaar.mp4"');
   reply.hijack();for(const [key,value]of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(key,typeof value==='number'?String(value):value);reply.raw.statusCode=remote.status;await pipeline(Readable.fromWeb(remote.body as any),reply.raw,{signal:controller.signal});
  }catch{if(!reply.raw.headersSent)return reply.code(502).send({error:'تعذر تشغيل الفيديو من المصدر'});reply.raw.destroy();}
  finally{clearTimeout(timer);reply.raw.off('close',abort);await close?.();}
 });
 app.addHook('onClose',async()=>{await publicSource.close();});
 return app;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const app=await buildApp();await app.listen({host:'0.0.0.0',port:Number(process.env.PORT)||4320});
 const close=async()=>{await app.close();process.exit(0);};process.once('SIGTERM',close);process.once('SIGINT',close);
}
