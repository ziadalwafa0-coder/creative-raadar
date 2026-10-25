import React,{useEffect,useRef,useState} from 'react';
import type {ReviewVideo} from '../backend/src/types';
import {SearchSession} from './ndjson';
import {ReviewPlayer} from './ReviewPlayer';
import {translateProductName,hasArabic} from './translateProduct';
import {identifyProduct} from './identifyProduct';
import {aiAmazonQueries} from './aiAmazonQuery';
import {matchesIdentity,productFamilies} from './productIdentity';
import {searchInBrowser,collectProductDocument,browserRequest,beginBrowserSession,inheritBrowserSession,type BrowserEvent,type ReviewImage} from './browserCollector';
import {SourceError,markets,type Marketplace} from '../backend/src/types';
import {AmazonRecovery} from './AmazonRecovery';
import {mediaTicket,SessionExpired} from './mediaTicket';
import {productReference} from './productReference';
const input='w-full p-3 rounded-xl bg-[#f9fbf9] border border-[#dce4df]';
export function CustomerReviewsApp({api}:{api:string}){
 const [token,setToken]=useState(()=>sessionStorage.getItem('cr_reviews_token')||'');const [authorized,setAuthorized]=useState(false);const [code,setCode]=useState('');
 const [query,setQuery]=useState('');const [translatedQuery,setTranslatedQuery]=useState('');const [market,setMarket]=useState('amazon.com');const [videos,setVideos]=useState<ReviewVideo[]>([]);const [running,setRunning]=useState(false);
 const [status,setStatus]=useState('');const [warnings,setWarnings]=useState<string[]>([]);const [error,setError]=useState('');const [failed,setFailed]=useState(0);const [image,setImage]=useState('');
 const [installed,setInstalled]=useState<boolean|null>(null);const [extensionVersion,setExtensionVersion]=useState('');const [kind,setKind]=useState('videos');const [videoCount,setVideoCount]=useState(50);const [photoCount,setPhotoCount]=useState(10);const [photos,setPhotos]=useState<ReviewImage[]>([]);
 const [nameOnly,setNameOnly]=useState(false);const imageFile=useRef<File|undefined>(undefined);
 const [recovery,setRecovery]=useState(false);const [extensionOutdated,setExtensionOutdated]=useState(false);
 const expireSession=()=>{sessionStorage.removeItem('cr_reviews_token');setToken('');setAuthorized(false);setError(new SessionExpired().message);};
 const session=useRef(new SearchSession());const imageUrl=useRef('');const pendingDownloads=useRef(new Set<AbortController>());const objectUrls=useRef(new Set<string>());
 const clear=()=>{setRecovery(false);session.current.clear();for(const controller of pendingDownloads.current)controller.abort();pendingDownloads.current.clear();for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();setVideos([]);setPhotos([]);setTranslatedQuery('');setWarnings([]);setError('');setStatus('');setRunning(false);setFailed(0);};
 useEffect(()=>{
  const abort=new AbortController();if(token)fetch(api+'/api/auth/session',{headers:{Authorization:`Bearer ${token}`},signal:abort.signal}).then(r=>{if(r.ok)setAuthorized(true);else{setToken('');sessionStorage.removeItem('cr_reviews_token');}}).catch(()=>{if(!abort.signal.aborted)setError('فشل الاتصال بسيرفر البحث');});
  return()=>abort.abort();
 },[api,token]);
 useEffect(()=>()=>{session.current.clear();for(const controller of pendingDownloads.current)controller.abort();for(const url of objectUrls.current)URL.revokeObjectURL(url);if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);},[]);
 const login=async(e:React.FormEvent)=>{e.preventDefault();setError('');try{const r=await fetch(api+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const data=await r.json();if(!r.ok)throw Error(data.error||'تعذر تسجيل الدخول');sessionStorage.setItem('cr_reviews_token',data.token);setToken(data.token);setAuthorized(true);setCode('');}catch(e){setError(e instanceof TypeError?'فشل الاتصال بسيرفر البحث':e instanceof Error?e.message:'فشل الاتصال');}};
 const search=async(e?:React.FormEvent)=>{
  e?.preventDefault();if(query.trim().length<2){setError('اكتب اسم المنتج مع الصورة لتحسين البحث');return;}
  const limits={videos:kind==='images'?0:videoCount,images:kind==='videos'?0:photoCount};
  if(Object.values(limits).some(n=>!Number.isInteger(n)||n<0||n>50)||(!limits.videos&&!limits.images)){setError('حدد عددًا صحيحًا من 1 إلى 50 لكل نوع مطلوب');return;}
  clear();const run=session.current.start();setRunning(true);setStatus('جاري تجهيز البحث…');let releaseBrowser:(()=>void)|undefined;
  const seenVideos=new Set<string>(),seenPhotos=new Set<string>();
  const warn=(reason:string)=>{if(session.current.current(run.id))setWarnings(p=>p.includes(reason)?p:[...p,reason]);};
  const receive=(event:BrowserEvent)=>{
   if(!session.current.current(run.id)||event.id!==run.id)return;
   if('type' in event&&event.type==='video'&&!seenVideos.has(event.video.url)&&seenVideos.size<limits.videos){seenVideos.add(event.video.url);setVideos(p=>[...p,event.video]);}
   if('type' in event&&event.type==='image'&&!seenPhotos.has(event.image.url)&&seenPhotos.size<limits.images){seenPhotos.add(event.image.url);setPhotos(p=>[...p,event.image]);}
   if('type' in event&&event.type==='progress')setStatus('جاري فحص المنتج '+event.index+' من '+event.total);
   if('type' in event&&event.type==='warn')warn(event.reason);
  };
  try{
   const reference=productReference(query,market as Marketplace);
   releaseBrowser=await beginBrowserSession(run.id,run.signal);
   if(reference){
    setMarket(reference.market);setTranslatedQuery('ASIN: '+reference.asin);setStatus('جاري قراءة المنتج المحدد…');
    warn('الجمع من رابط المنتج المحدد فقط.');
    const result=await browserRequest('product',{asin:reference.asin,market:reference.market},run.signal);run.signal.throwIfAborted();
    collectProductDocument(result.html,reference.asin,reference.market,run.id,run.signal,receive,limits,result.diagnostics);
   }else{
    setStatus('جاري تجهيز اسم البحث المناسب لأمازون…');
    const aiQueries=await aiAmazonQueries(api,token,query,imageFile.current,market,run.signal);run.signal.throwIfAborted();
    const englishName=aiQueries?.[0]||await translateProductName(query,run.signal);run.signal.throwIfAborted();
    const queries=[...new Set([englishName,...(aiQueries||[])])];setTranslatedQuery(englishName);
    let preferredAsin:string|undefined;
    if(imageFile.current&&!nameOnly){
     try{
      const visualSignal=inheritBrowserSession(run.signal,AbortSignal.any([run.signal,AbortSignal.timeout(12000)]));
      const visual=await identifyProduct(imageFile.current,englishName,market as Marketplace,visualSignal,t=>{if(session.current.current(run.id))setStatus(t);});
      run.signal.throwIfAborted();preferredAsin=visual.products[0]?.asin;
      warn(preferredAsin?'الصورة طابقت منتجًا على أمازون؛ نبدأ به ثم نكمل نتائج الاسم والمواصفات لو العدد ناقص.':'الصورة ما طابقتش بدقة؛ نكمل بالاسم والمواصفات ومطابقة الموديل غير مؤكدة.');
     }catch(e){run.signal.throwIfAborted();if(e instanceof SourceError&&['BLOCKED','CAPTCHA','LOGIN_WALL'].includes(e.code))throw e;warn('تعذر إكمال مقارنة الصورة بسرعة؛ نكمل البحث بالاسم والمواصفات.');}
    }
    const history={videos:new Set<string>(),images:new Set<string>(),asins:new Set<string>()};let lastError:unknown;
    for(const q of queries){
     run.signal.throwIfAborted();const remaining={videos:limits.videos-seenVideos.size,images:limits.images-seenPhotos.size};if(!remaining.videos&&!remaining.images)break;
     const family=productFamilies.find(f=>f[2].test(q))?.[0]||'custom';
     try{await searchInBrowser(q,market as Marketplace,run.id,run.signal,receive,browserRequest,remaining,p=>matchesIdentity(p.title,q,family),preferredAsin,history);}
     catch(e){run.signal.throwIfAborted();if(e instanceof SourceError&&['BLOCKED','CAPTCHA','LOGIN_WALL'].includes(e.code))throw e;lastError=e;warn('بحث «'+q+'»: '+(e instanceof Error?e.message:'تعذر البحث'));}
    }
    if(lastError&&!seenVideos.size&&!seenPhotos.size)throw lastError;
   }
   if(session.current.current(run.id))setStatus('انتهى الفحص — '+seenVideos.size+' فيديو و'+seenPhotos.size+' صورة'+(seenVideos.size<limits.videos||seenPhotos.size<limits.images?'؛ المصدر لم يوفر العدد المطلوب بالكامل':''));
  }catch(e){if(session.current.current(run.id)){setStatus('توقف البحث');setError(e instanceof Error?e.message:'تعذر الاتصال');}}
  finally{releaseBrowser?.();if(session.current.current(run.id))setRunning(false);}
 };
 const importOpenProduct=async(tab:{id:number;asin:string;market:Marketplace})=>{
  clear();setRecovery(true);const run=session.current.start();setRunning(true);setStatus('قراءة ريفيوهات الصفحة التي اخترتها…');
  try{
   const result=await browserRequest('read_open_product',{tabId:String(tab.id)},run.signal,30000);run.signal.throwIfAborted();
   if(!session.current.current(run.id))return;
   if(result.asin!==tab.asin||result.market!==tab.market||!(result.market in markets))throw Error('الصفحة المفتوحة تغيرت؛ اختر صفحة المنتج الصحيح من جديد');
   setMarket(result.market);setQuery(result.title||tab.asin);setTranslatedQuery('');
   setWarnings(['تم الاختيار يدويًا من صفحة أمازون المفتوحة؛ لم يتم تأكيد مطابقة الصورة آليًا.']);
   let foundVideos=0,foundImages=0;
   collectProductDocument(result.html,tab.asin,tab.market,run.id,run.signal,event=>{
    if(!session.current.current(run.id))return;
    if('type' in event&&event.type==='video'){foundVideos++;setVideos(v=>[...v,event.video]);}
    if('type' in event&&event.type==='image'){foundImages++;setPhotos(v=>[...v,event.image]);}
    if('type' in event&&event.type==='warn')setWarnings(w=>[...w,event.reason]);
   },{videos:kind==='images'?0:videoCount,images:kind==='videos'?0:photoCount});
   setStatus(`تمت قراءة الصفحة — ${foundVideos} فيديو و${foundImages} صورة`);
   if(!foundVideos&&!foundImages)setWarnings(w=>[...w,'لم نجد بيانات ريفيوهات عملاء محمّلة في الصفحة. افتح قسم مراجعات العملاء والفيديوهات ثم اقرأ الصفحة مرة أخرى.']);
  }catch(e){if(session.current.current(run.id)){setError(e instanceof Error?e.message:'تعذر قراءة الصفحة');setStatus('لم تكتمل قراءة الصفحة');}}
  finally{if(session.current.current(run.id))setRunning(false);}
 };
 const download=async(video:ReviewVideo)=>{
  const controller=new AbortController();pendingDownloads.current.add(controller);
  try{
   let url=video.url;
   if(video.type==='hls')url=url.replace(/\/embedded\.cc\.default\.vertical\.jobtemplate\.hls\.m3u8.*$/i,'/default.vertical.jobtemplate.mp4.480.mp4').replace(/\.hls\.m3u8.*$/i,'.mp4.480.mp4');
   const path=await mediaTicket(api,token,url,controller.signal);
   const response=await fetch(api+path+'&download=1',{signal:controller.signal});if(!response.ok)throw Error('المصدر لم يوفّر MP4 لهذا الفيديو؛ يظل التشغيل متاحًا');
   const blob=await response.blob();controller.signal.throwIfAborted();const object=URL.createObjectURL(blob);objectUrls.current.add(object);const anchor=document.createElement('a');anchor.href=object;anchor.download=`Creative-Radaar-${video.sourceAsin}-${Date.now()}.mp4`;anchor.click();setTimeout(()=>{URL.revokeObjectURL(object);objectUrls.current.delete(object);},30000);
  }catch(e){if(!controller.signal.aborted){if(e instanceof SessionExpired)expireSession();else setError(e instanceof Error?e.message:'تعذر التنزيل');}}finally{pendingDownloads.current.delete(controller);}
 };
 const pickImage=(file?:File)=>{if(!file?.type.startsWith('image/'))return;if(file.size>12*1024*1024){setError('اختر صورة أقل من 12 ميجابايت');return;}clear();imageFile.current=file;setNameOnly(false);if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current=URL.createObjectURL(file);setImage(imageUrl.current);};
 useEffect(()=>{
  let controller:AbortController|undefined;let disposed=false;
  const detect=()=>{controller?.abort();const abort=new AbortController();controller=abort;browserRequest('ping',{},abort.signal,1500).then(result=>{if(!disposed){setInstalled(true);setExtensionVersion(result.version||'1.0.0');setExtensionOutdated(result.reviewReveal!==true||result.directFetch!==true);}}).catch(()=>{if(!disposed&&!abort.signal.aborted)setInstalled(false);});};
  detect();window.addEventListener('focus',detect);return()=>{disposed=true;controller?.abort();window.removeEventListener('focus',detect);};
 },[]);
 const downloadPhoto=async(photo:ReviewImage)=>{
  const abort=new AbortController();pendingDownloads.current.add(abort);
  try{const response=await fetch(photo.url,{credentials:'omit',signal:abort.signal});if(!response.ok)throw Error('تعذر تنزيل الصورة');const blob=await response.blob();abort.signal.throwIfAborted();const url=URL.createObjectURL(blob);objectUrls.current.add(url);const a=document.createElement('a');a.href=url;a.download='Creative-Radaar-'+photo.sourceAsin+'.jpg';a.click();setTimeout(()=>{URL.revokeObjectURL(url);objectUrls.current.delete(url);},30000);}
  catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'تعذر تنزيل الصورة');}finally{pendingDownloads.current.delete(abort);}
 };
 const diagnoseExtension=()=>{
  const id=crypto.randomUUID();const replies:string[]=[];
  const receive=(event:MessageEvent)=>{if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='cr-browser-response'||event.data.id!==id)return;replies.push('الإصدار '+(event.data.version||'غير معلوم')+'، بروتوكول '+(event.data.protocol||'قديم')+(event.data.error?'، '+event.data.error:''));};
  window.addEventListener('message',receive);window.postMessage({channel:'cr-browser-request',id,operation:'ping'},location.origin);
  setTimeout(()=>{window.removeEventListener('message',receive);setStatus(replies.length?replies.join(' | '):'لم يصل أي رد من الإضافة في هذا المتصفح');},1800);
 };
 if(!authorized)return <main dir="rtl" className="min-h-screen bg-[#f5f7f3] grid place-items-center p-5"><form onSubmit={login} className="bg-white border rounded-2xl p-8 w-full max-w-md space-y-5"><h1 className="font-bold text-2xl text-[#247c72]">Creative Radaar</h1><label className="block">كود الدخول<input className={input} type="password" value={code} onChange={e=>setCode(e.target.value)} required autoComplete="current-password"/></label>{error&&<p role="alert" className="text-red-700">{error}</p>}<button className="bg-[#247c72] text-white rounded-xl w-full p-3">دخول</button></form></main>;
 return <main data-extension-version={extensionVersion} dir="rtl" className="min-h-screen bg-[#f5f7f3] text-[#19251f]"><header className="bg-white border-b p-4 flex justify-between"><h1 className="text-xl font-bold text-[#247c72]">Creative Radaar</h1><button onClick={async()=>{clear();await fetch(api+'/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});sessionStorage.removeItem('cr_reviews_token');setToken('');setAuthorized(false);}}>خروج</button></header><div className="max-w-5xl mx-auto p-5 space-y-5"><p className="text-sm text-[#5a6e62]">صور وفيديوهات ريفيوهات العملاء — نزّل ما تحتاجه. النتائج تختفي عند تغيير المنتج أو تحديث الصفحة.</p>{installed===false&&<aside className="bg-white border rounded-xl p-4"><p>ثبّت إضافة Chrome المجانية مرة واحدة ثم أعد تحميل الصفحة.</p><a className="underline text-[#247c72]" href="/creative-radaar-extension.zip" download>تنزيل الإضافة</a> · <a className="underline" href="/extension-install.html" target="_blank" rel="noreferrer">طريقة التثبيت</a> · <button type="button" className="underline" onClick={diagnoseExtension}>فحص الاتصال</button></aside>}{extensionOutdated&&<aside role="alert" className="bg-amber-50 border rounded-xl p-4">نسخة الإضافة عندك قديمة ({extensionVersion}). <a href="/creative-radaar-extension.zip" download className="underline">نزّل 1.3.1</a> وفكها في فولدر الإضافة واضغط Reload من chrome://extensions ثم حدّث الصفحة.</aside>}<form onSubmit={search} className="bg-white border rounded-2xl p-6 space-y-4"><label className="block">اسم المنتج أو رابط أمازون<input className={input} value={query} onChange={e=>{clear();setQuery(e.target.value);}} required/></label>{translatedQuery&&<p className="text-sm text-[#247c72]">اسم البحث على أمازون: <span dir="ltr">{translatedQuery}</span></p>}<label className="block">المتجر<select className={input} value={market} onChange={e=>{clear();setMarket(e.target.value);}}>{['amazon.com','amazon.eg','amazon.sa','amazon.ae'].map(m=><option key={m}>{m}</option>)}</select></label><label className="block" htmlFor="media-kind">المطلوب</label><select id="media-kind" className={input} value={kind} onChange={e=>{clear();setKind(e.target.value);}}><option value="videos">فيديوهات</option><option value="images">صور</option><option value="both">صور وفيديوهات</option></select><div className="grid sm:grid-cols-2 gap-4">{kind!=='images'&&<label>عدد الفيديوهات<input className={input} type="number" min="1" max="50" step="1" value={videoCount||''} onChange={e=>{clear();setVideoCount(Number(e.target.value));}} required/></label>}{kind!=='videos'&&<label>عدد الصور<input className={input} type="number" min="1" max="50" step="1" value={photoCount||''} onChange={e=>{clear();setPhotoCount(Number(e.target.value));}} required/></label>}</div><label className="block">صورة المنتج (اختياري)<div className="border border-dashed rounded-xl p-3" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();pickImage(e.dataTransfer.files[0]);}}><input type="file" accept="image/*" onChange={e=>pickImage(e.target.files?.[0])}/>{image&&<img src={image} alt="صورة المنتج" className="h-24 mt-3 object-contain"/>}</div></label><p className="text-xs text-[#6a786f]">حط صورة المنتج واسمه، وحدد العدد واضغط ابحث. الجلب لا يفتح تبويبات أمازون. الصورة تساعد البحث ولا توقفه؛ مطابقة الموديل ليست مضمونة. قد تُرسل نسخة مصغرة 320 بكسل للسيرفر، ولـGoogle Gemini عند تفعيله، لتحسين اسم البحث دون تخزينها في التطبيق. لو معاك رابط أمازون اكتبه لجمع ريفيوهات نفس المنتج فقط.</p>{image&&<button type="button" className="text-sm underline" onClick={()=>{clear();imageFile.current=undefined;if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current='';setImage('');setNameOnly(false);}}>حذف الصورة</button>}{image&&<label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={nameOnly} onChange={e=>{clear();setNameOnly(e.target.checked);}}/>البحث بالاسم فقط وتخطي تحليل الصورة</label>}<div className="flex gap-3"><button className="bg-[#247c72] text-white p-3 rounded-xl flex-1">{running?'بحث جديد':'ابحث'}</button><button type="button" onClick={()=>search()} className="border rounded-xl p-3">ابدأ من جديد</button>{running&&<button type="button" onClick={()=>{session.current.clear();setRunning(false);setStatus('تم إيقاف البحث');}} className="border rounded-xl p-3">إيقاف</button>}</div></form><details><summary className="text-sm cursor-pointer">خيارات إضافية</summary><button type="button" className="text-sm underline text-[#247c72]" onClick={()=>{clear();setRecovery(true);}}>قراءة صفحة منتج مفتوحة على أمازون</button></details>{recovery&&<AmazonRecovery market={market as Marketplace} query={translatedQuery||query} onRead={importOpenProduct}/>}{(running||videos.length>0||photos.length>0)&&<div className="bg-white border rounded-xl p-4 flex gap-6" role="status" aria-live="polite">{kind!=='images'&&<p>الفيديوهات: <strong>{videos.length}</strong> من {videoCount}</p>}{kind!=='videos'&&<p>الصور: <strong>{photos.length}</strong> من {photoCount}</p>}</div>}<p role="status" aria-live="polite">{status}</p>{failed>0&&<p className="text-sm">تعذر تشغيل {failed} فيديو وتم إخفاؤه تلقائيًا.</p>}{warnings.length>0&&<div role="status" className="bg-amber-50 text-amber-900 border rounded-xl p-4 space-y-2">{warnings.map(w=><p key={w}>{w}</p>)}</div>}{error&&<div role="alert" className="bg-red-50 text-red-800 p-4 rounded-xl"><p>{error}</p>{error.includes('1.3.1')&&<a href="/creative-radaar-extension.zip" download className="underline">تنزيل الإضافة 1.3.1</a>}</div>}<section aria-label="فيديوهات العملاء" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{videos.map(video=><article key={video.url} className="bg-white border rounded-2xl p-3 space-y-3"><ReviewPlayer api={api} token={token} video={video} onAuthExpired={expireSession} onFailed={()=>{setVideos(previous=>previous.filter(v=>v.url!==video.url));setFailed(n=>n+1);}}/><h2 className="font-semibold">{video.title||'ريفيو عميل'}</h2><div className="flex justify-between"><button className="text-[#247c72]" onClick={()=>download(video)}>تنزيل</button><a href={video.sourceUrl} target="_blank" rel="noreferrer">المصدر ↗</a><a href={`https://${market}/dp/${video.sourceAsin}`} target="_blank" rel="noreferrer">المنتج ↗</a></div></article>)}</section><section aria-label="صور العملاء" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{photos.map(photo=><article key={photo.url} className="bg-white border rounded-2xl p-3 space-y-3"><img src={photo.url} alt={photo.title} loading="lazy" className="w-full h-56 object-contain"/><div className="flex justify-between"><button className="text-[#247c72]" onClick={()=>downloadPhoto(photo)}>تنزيل الصورة</button><a href={photo.sourceUrl} target="_blank" rel="noreferrer">المصدر ↗</a></div></article>)}</section></div></main>;
}
