import React,{useEffect,useRef,useState} from 'react';
import type {ReviewVideo} from '../backend/src/types';
import {SearchSession} from './ndjson';
import {ReviewPlayer} from './ReviewPlayer';
import {translateProductName,hasArabic} from './translateProduct';
import {identifyProduct,findIdentityCandidates,type IdentityProposal} from './identifyProduct';
import {matchesIdentity,productFamilies} from './productIdentity';
import {IdentityReview} from './IdentityReview';
import {searchInBrowser,browserRequest,type ReviewImage} from './browserCollector';
import type {Marketplace} from '../backend/src/types';
const input='w-full p-3 rounded-xl bg-[#f9fbf9] border border-[#dce4df]';
export function CustomerReviewsApp({api}:{api:string}){
 const [token,setToken]=useState(()=>sessionStorage.getItem('cr_reviews_token')||'');const [authorized,setAuthorized]=useState(false);const [code,setCode]=useState('');
 const [query,setQuery]=useState('');const [translatedQuery,setTranslatedQuery]=useState('');const [market,setMarket]=useState('amazon.com');const [videos,setVideos]=useState<ReviewVideo[]>([]);const [running,setRunning]=useState(false);
 const [status,setStatus]=useState('');const [warnings,setWarnings]=useState<string[]>([]);const [error,setError]=useState('');const [failed,setFailed]=useState(0);const [image,setImage]=useState('');
 const [installed,setInstalled]=useState<boolean|null>(null);const [extensionVersion,setExtensionVersion]=useState('');const [kind,setKind]=useState('videos');const [videoCount,setVideoCount]=useState(50);const [photoCount,setPhotoCount]=useState(10);const [photos,setPhotos]=useState<ReviewImage[]>([]);
 const [proposal,setProposal]=useState<IdentityProposal|null>(null);const [identityQuery,setIdentityQuery]=useState('');const [nameOnly,setNameOnly]=useState(false);const imageFile=useRef<File|undefined>(undefined);
 const session=useRef(new SearchSession());const imageUrl=useRef('');const pendingDownloads=useRef(new Set<AbortController>());const objectUrls=useRef(new Set<string>());
 const clear=()=>{session.current.clear();for(const controller of pendingDownloads.current)controller.abort();pendingDownloads.current.clear();for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();setVideos([]);setPhotos([]);setTranslatedQuery('');setProposal(null);setIdentityQuery('');setWarnings([]);setError('');setStatus('');setRunning(false);setFailed(0);};
 useEffect(()=>{
  const abort=new AbortController();if(token)fetch(api+'/api/auth/session',{headers:{Authorization:`Bearer ${token}`},signal:abort.signal}).then(r=>{if(r.ok)setAuthorized(true);else{setToken('');sessionStorage.removeItem('cr_reviews_token');}}).catch(()=>{if(!abort.signal.aborted)setError('فشل الاتصال بسيرفر البحث');});
  return()=>abort.abort();
 },[api,token]);
 useEffect(()=>()=>{session.current.clear();for(const controller of pendingDownloads.current)controller.abort();for(const url of objectUrls.current)URL.revokeObjectURL(url);if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);},[]);
 const login=async(e:React.FormEvent)=>{e.preventDefault();setError('');try{const r=await fetch(api+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const data=await r.json();if(!r.ok)throw Error(data.error||'تعذر تسجيل الدخول');sessionStorage.setItem('cr_reviews_token',data.token);setToken(data.token);setAuthorized(true);setCode('');}catch(e){setError(e instanceof TypeError?'فشل الاتصال بسيرفر البحث':e instanceof Error?e.message:'فشل الاتصال');}};
 const search=async(e?:React.FormEvent,approved?:{identity:IdentityProposal;query:string;asin:string})=>{
  e?.preventDefault();if(query.trim().length<3){setError('اكتب اسم المنتج');return;}
  const limits={videos:kind==='images'?0:videoCount,images:kind==='videos'?0:photoCount};
  if(Object.values(limits).some(n=>!Number.isInteger(n)||n<0||n>50)||(!limits.videos&&!limits.images)){setError('حدد عددًا صحيحًا من 1 إلى 50 لكل نوع مطلوب');return;}
  clear();const run=session.current.start();setRunning(true);setStatus('جاري البحث…');let foundVideos=0,foundPhotos=0;
  try{
   setStatus(!approved&&hasArabic(query)?'جاري ترجمة اسم المنتج إلى الإنجليزية…':'جاري البحث…');
   const englishName=approved?.query||await translateProductName(query,run.signal);run.signal.throwIfAborted();if(!session.current.current(run.id))return;
   setTranslatedQuery(englishName);
   if(imageFile.current&&!nameOnly&&!approved){
    setStatus('جاري فهم الصورة والاسم…');
    const result=await identifyProduct(imageFile.current,englishName,market as Marketplace,run.signal,text=>{if(session.current.current(run.id))setStatus(text);},identity=>{if(session.current.current(run.id)){setProposal(identity);setIdentityQuery(identity.query);setTranslatedQuery(identity.query);}});
    run.signal.throwIfAborted();if(!session.current.current(run.id))return;
    setProposal(result);setIdentityQuery(result.query);setTranslatedQuery(result.query);setStatus('اختر أقرب منتج من ترشيحات أمازون لتأكيد البحث');return;
   }
   if(imageFile.current&&nameOnly)setWarnings(['البحث بالاسم فقط؛ لم يتم تأكيد مطابقة الصورة.']);
   await searchInBrowser(englishName,market as Marketplace,run.id,run.signal,event=>{
    if(!session.current.current(run.id)||event.id!==run.id)return;
    if('type' in event&&event.type==='video'){foundVideos++;setVideos(previous=>previous.some(v=>v.url===event.video.url)?previous:[...previous,event.video]);}
    if('type' in event&&event.type==='image'){foundPhotos++;setPhotos(previous=>previous.some(v=>v.url===event.image.url)?previous:[...previous,event.image]);}
    if('type' in event&&event.type==='progress')setStatus('جاري فحص المنتج '+event.index+' من '+event.total);
    if('type' in event&&event.type==='warn')setWarnings(previous=>previous.includes(event.reason)?previous:[...previous,event.reason]);
    if('done' in event)setStatus('انتهى الفحص — '+foundVideos+' فيديو و'+foundPhotos+' صورة'+(foundVideos<limits.videos||foundPhotos<limits.images?'؛ المصدر لم يوفر العدد المطلوب بالكامل':''));
   },browserRequest,limits,approved?p=>matchesIdentity(p.title,approved.query,approved.identity.family):undefined,approved?.asin);
   if(session.current.current(run.id))setInstalled(true);
  }catch(e){if(session.current.current(run.id)){setStatus('توقف البحث');setError(e instanceof Error?e.message:'تعذر الاتصال');}}
  finally{if(session.current.current(run.id))setRunning(false);}
 };
 const download=async(video:ReviewVideo)=>{
  const controller=new AbortController();pendingDownloads.current.add(controller);
  try{
   let url=video.url;
   if(video.type==='hls')url=url.replace(/\/embedded\.cc\.default\.vertical\.jobtemplate\.hls\.m3u8.*$/i,'/default.vertical.jobtemplate.mp4.480.mp4').replace(/\.hls\.m3u8.*$/i,'.mp4.480.mp4');
   const ticketResponse=await fetch(api+'/api/media-ticket',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({url}),signal:controller.signal});
   if(!ticketResponse.ok)throw Error('تعذر تجهيز رابط التنزيل');const ticket=await ticketResponse.json();
   const response=await fetch(api+ticket.path+'&download=1',{signal:controller.signal});if(!response.ok)throw Error('المصدر لم يوفّر MP4 لهذا الفيديو؛ يظل التشغيل متاحًا');
   const blob=await response.blob();controller.signal.throwIfAborted();const object=URL.createObjectURL(blob);objectUrls.current.add(object);const anchor=document.createElement('a');anchor.href=object;anchor.download=`Creative-Radaar-${video.sourceAsin}-${Date.now()}.mp4`;anchor.click();setTimeout(()=>{URL.revokeObjectURL(object);objectUrls.current.delete(object);},30000);
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'تعذر التنزيل');}finally{pendingDownloads.current.delete(controller);}
 };
 const refineIdentity=async(nextQuery:string)=>{
  if(!proposal||!imageFile.current)return;
  const previous=proposal;const family=productFamilies.find(f=>f[2].test(nextQuery))||productFamilies.find(f=>f[0]==='custom')!;
  clear();const run=session.current.start();setRunning(true);
  setProposal({...previous,query:nextQuery,family:family[0],products:[]});setIdentityQuery(nextQuery);setTranslatedQuery(nextQuery);
  try{
   const result=await findIdentityCandidates(imageFile.current,{...previous,query:nextQuery,family:family[0]},market as Marketplace,run.signal,text=>{if(session.current.current(run.id))setStatus(text);});
   run.signal.throwIfAborted();if(!session.current.current(run.id))return;setProposal(result);setIdentityQuery(nextQuery);setTranslatedQuery(nextQuery);setStatus('راجع الترشيحات ثم اختر أقرب منتج');
  }catch(e){if(session.current.current(run.id))setError(e instanceof Error?e.message:'تعذر فحص البديل');}
  finally{if(session.current.current(run.id))setRunning(false);}
 };
 const pickImage=(file?:File)=>{if(!file?.type.startsWith('image/'))return;if(file.size>12*1024*1024){setError('اختر صورة أقل من 12 ميجابايت');return;}clear();imageFile.current=file;setNameOnly(false);if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current=URL.createObjectURL(file);setImage(imageUrl.current);};
 useEffect(()=>{
  let controller:AbortController|undefined;let disposed=false;
  const detect=()=>{controller?.abort();const abort=new AbortController();controller=abort;browserRequest('ping',{},abort.signal,1500).then(result=>{if(!disposed){setInstalled(true);setExtensionVersion(result.version||'1.0.0');}}).catch(()=>{if(!disposed&&!abort.signal.aborted)setInstalled(false);});};
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
 return <main data-extension-version={extensionVersion} dir="rtl" className="min-h-screen bg-[#f5f7f3] text-[#19251f]"><header className="bg-white border-b p-4 flex justify-between"><h1 className="text-xl font-bold text-[#247c72]">Creative Radaar</h1><button onClick={async()=>{clear();await fetch(api+'/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});sessionStorage.removeItem('cr_reviews_token');setToken('');setAuthorized(false);}}>خروج</button></header><div className="max-w-5xl mx-auto p-5 space-y-5"><p className="text-sm text-[#5a6e62]">صور وفيديوهات ريفيوهات العملاء — نزّل ما تحتاجه. النتائج تختفي عند تغيير المنتج أو تحديث الصفحة.</p>{installed===false&&<aside className="bg-white border rounded-xl p-4"><p>ثبّت إضافة Chrome المجانية مرة واحدة ثم أعد تحميل الصفحة.</p><a className="underline text-[#247c72]" href="/creative-radaar-extension.zip" download>تنزيل الإضافة</a> · <a className="underline" href="/extension-install.html" target="_blank" rel="noreferrer">طريقة التثبيت</a> · <button type="button" className="underline" onClick={diagnoseExtension}>فحص الاتصال</button></aside>}<form onSubmit={search} className="bg-white border rounded-2xl p-6 space-y-4"><label className="block">اسم المنتج<input className={input} value={query} onChange={e=>{clear();setQuery(e.target.value);}} required/></label>{translatedQuery&&<p className="text-sm text-[#247c72]">اسم البحث على أمازون: <span dir="ltr">{translatedQuery}</span></p>}<label className="block">المتجر<select className={input} value={market} onChange={e=>{clear();setMarket(e.target.value);}}>{['amazon.com','amazon.eg','amazon.sa','amazon.ae'].map(m=><option key={m}>{m}</option>)}</select></label><label className="block" htmlFor="media-kind">المطلوب</label><select id="media-kind" className={input} value={kind} onChange={e=>{clear();setKind(e.target.value);}}><option value="videos">فيديوهات</option><option value="images">صور</option><option value="both">صور وفيديوهات</option></select><div className="grid sm:grid-cols-2 gap-4">{kind!=='images'&&<label>عدد الفيديوهات<input className={input} type="number" min="1" max="50" step="1" value={videoCount||''} onChange={e=>{clear();setVideoCount(Number(e.target.value));}} required/></label>}{kind!=='videos'&&<label>عدد الصور<input className={input} type="number" min="1" max="50" step="1" value={photoCount||''} onChange={e=>{clear();setPhotoCount(Number(e.target.value));}} required/></label>}</div><label className="block">صورة المنتج لتحسين دقة البحث (اختياري)<div className="border border-dashed rounded-xl p-3" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();pickImage(e.dataTransfer.files[0]);}}><input type="file" accept="image/*" onChange={e=>pickImage(e.target.files?.[0])}/>{image&&<img src={image} alt="صورة المنتج" className="h-24 mt-3 object-contain"/>}</div></label><p className="text-xs text-[#6a786f]">مع الصورة: تحليل بصري محلي ثم تأكيد منتج من أمازون. أول مرة يتم تنزيل نموذج بحوالي 150 ميجابايت؛ الصور لا تُرفع لخدمة تحليل. بدون صورة: بحث بالاسم فقط. الريفيوهات قد تكون إيجابية أو سلبية.</p>{image&&<button type="button" className="text-sm underline" onClick={()=>{clear();imageFile.current=undefined;if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current='';setImage('');setNameOnly(false);}}>حذف الصورة</button>}{image&&<label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={nameOnly} onChange={e=>{clear();setNameOnly(e.target.checked);}}/>البحث بالاسم فقط وتخطي تحليل الصورة</label>}<div className="flex gap-3"><button className="bg-[#247c72] text-white p-3 rounded-xl flex-1">{running?'بحث جديد وإلغاء الحالي':'ابحث'}</button><button type="button" onClick={()=>search()} className="border rounded-xl p-3">ابدأ من جديد</button>{running&&<button type="button" onClick={()=>{session.current.clear();setRunning(false);setStatus('تم إيقاف البحث');}} className="border rounded-xl p-3">إيقاف</button>}</div></form>{proposal&&<IdentityReview loading={running} proposal={proposal} query={identityQuery} onQuery={setIdentityQuery} onAlternative={refineIdentity} onConfirm={asin=>search(undefined,{identity:proposal,query:identityQuery,asin})}/>}{(running||videos.length>0||photos.length>0)&&<div className="bg-white border rounded-xl p-4 flex gap-6" role="status" aria-live="polite">{kind!=='images'&&<p>الفيديوهات: <strong>{videos.length}</strong> من {videoCount}</p>}{kind!=='videos'&&<p>الصور: <strong>{photos.length}</strong> من {photoCount}</p>}</div>}<p role="status" aria-live="polite">{status}</p>{failed>0&&<p className="text-sm">تعذر تشغيل {failed} فيديو وتم إخفاؤه تلقائيًا.</p>}{warnings.length>0&&<div role="status" className="bg-amber-50 text-amber-900 border rounded-xl p-4 space-y-2">{warnings.map(w=><p key={w}>{w}</p>)}</div>}{error&&<p role="alert" className="bg-red-50 text-red-800 p-4 rounded-xl">{error}</p>}<section aria-label="فيديوهات العملاء" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{videos.map(video=><article key={video.url} className="bg-white border rounded-2xl p-3 space-y-3"><ReviewPlayer api={api} token={token} video={video} onFailed={()=>{setVideos(previous=>previous.filter(v=>v.url!==video.url));setFailed(n=>n+1);}}/><h2 className="font-semibold">{video.title||'ريفيو عميل'}</h2><div className="flex justify-between"><button className="text-[#247c72]" onClick={()=>download(video)}>تنزيل</button><a href={video.sourceUrl} target="_blank" rel="noreferrer">المصدر ↗</a><a href={`https://${market}/dp/${video.sourceAsin}`} target="_blank" rel="noreferrer">المنتج ↗</a></div></article>)}</section><section aria-label="صور العملاء" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{photos.map(photo=><article key={photo.url} className="bg-white border rounded-2xl p-3 space-y-3"><img src={photo.url} alt={photo.title} loading="lazy" className="w-full h-56 object-contain"/><div className="flex justify-between"><button className="text-[#247c72]" onClick={()=>downloadPhoto(photo)}>تنزيل الصورة</button><a href={photo.sourceUrl} target="_blank" rel="noreferrer">المصدر ↗</a></div></article>)}</section></div></main>;
}
