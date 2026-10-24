import React,{useEffect,useRef,useState} from 'react';
import type {ReviewVideo} from '../backend/src/types';
import {SearchSession,readNdjson} from './ndjson';
import {ReviewPlayer} from './ReviewPlayer';
import {searchInBrowser} from './browserCollector';
import type {Marketplace} from '../backend/src/types';
const input='w-full p-3 rounded-xl bg-[#f9fbf9] border border-[#dce4df]';
export function CustomerReviewsApp({api}:{api:string}){
 const [token,setToken]=useState(()=>sessionStorage.getItem('cr_reviews_token')||'');const [authorized,setAuthorized]=useState(false);const [code,setCode]=useState('');
 const [query,setQuery]=useState('');const [market,setMarket]=useState('amazon.com');const [videos,setVideos]=useState<ReviewVideo[]>([]);const [running,setRunning]=useState(false);
 const [status,setStatus]=useState('');const [warnings,setWarnings]=useState<string[]>([]);const [error,setError]=useState('');const [failed,setFailed]=useState(0);const [image,setImage]=useState('');
 const [browserMode,setBrowserMode]=useState(true);
 const session=useRef(new SearchSession());const imageUrl=useRef('');const pendingDownloads=useRef(new Set<AbortController>());const objectUrls=useRef(new Set<string>());
 const clear=()=>{session.current.clear();for(const controller of pendingDownloads.current)controller.abort();pendingDownloads.current.clear();for(const url of objectUrls.current)URL.revokeObjectURL(url);objectUrls.current.clear();setVideos([]);setWarnings([]);setError('');setStatus('');setRunning(false);setFailed(0);};
 useEffect(()=>{
  const abort=new AbortController();if(token)fetch(api+'/api/auth/session',{headers:{Authorization:`Bearer ${token}`},signal:abort.signal}).then(r=>{if(r.ok)setAuthorized(true);else{setToken('');sessionStorage.removeItem('cr_reviews_token');}}).catch(()=>{if(!abort.signal.aborted)setError('فشل الاتصال بسيرفر البحث');});
  return()=>abort.abort();
 },[api,token]);
 useEffect(()=>()=>{session.current.clear();for(const controller of pendingDownloads.current)controller.abort();for(const url of objectUrls.current)URL.revokeObjectURL(url);if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);},[]);
 const login=async(e:React.FormEvent)=>{e.preventDefault();setError('');try{const r=await fetch(api+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const data=await r.json();if(!r.ok)throw Error(data.error||'تعذر تسجيل الدخول');sessionStorage.setItem('cr_reviews_token',data.token);setToken(data.token);setAuthorized(true);setCode('');}catch(e){setError(e instanceof TypeError?'فشل الاتصال بسيرفر البحث':e instanceof Error?e.message:'فشل الاتصال');}};
 const search=async(e?:React.FormEvent)=>{
  e?.preventDefault();if(query.trim().length<3){setError('اكتب اسم المنتج');return;}clear();const run=session.current.start();setRunning(true);setStatus('جاري البحث عن منتجات…');let done=false;
  try{
   if(browserMode){
    setStatus('جاري الاتصال بالإضافة المجانية…');
    await searchInBrowser(query.trim(),market as Marketplace,run.id,run.signal,event=>{
     if(!session.current.current(run.id)||event.id!==run.id)return;
     if('type' in event&&event.type==='video')setVideos(previous=>previous.some(v=>v.url===event.video.url)?previous:[...previous,event.video]);
     if('type' in event&&event.type==='progress')setStatus(`جاري فحص المنتج ${event.index} من ${event.total}`);
     if('type' in event&&event.type==='warn')setWarnings(previous=>previous.includes(event.reason)?previous:[...previous,event.reason]);
     if('done' in event){done=true;setStatus(`انتهى الفحص — المتاح ${event.count} فيديو عميل${event.count<40?'؛ المصدر لم يوفر 40 فيديو مطابقًا':''}`);}
    });
    return;
   }
   const response=await fetch(api+'/api/search?'+new URLSearchParams({q:query.trim(),marketplace:market,id:run.id}),{headers:{Authorization:`Bearer ${token}`},signal:run.signal});
   if(!response.ok){if(response.status===401){sessionStorage.removeItem('cr_reviews_token');setToken('');setAuthorized(false);}throw Error((await response.json()).error||'فشل الاتصال');}if(!response.body)throw Error('المتصفح لا يدعم عرض النتائج التدريجي');
   await readNdjson(response.body,run.signal,event=>{
    if(!session.current.current(run.id)||event.id!==run.id)return;
    if(event.type==='video')setVideos(previous=>previous.some(v=>v.url===event.video.url)?previous:[...previous,event.video]);
    if(event.type==='progress')setStatus(event.index?`جاري فحص المنتج ${event.index} من ${event.total}${event.cached?' — البحث محفوظ مؤقتًا':''}`:'جاري البحث عن منتجات…');
    if(event.type==='warn')setWarnings(previous=>previous.includes(event.reason)?previous:[...previous,event.reason]);
    if(event.done){done=true;setStatus(event.count?`اكتمل البحث — تم العثور على ${event.count} فيديو`:'لا توجد فيديوهات عملاء قابلة للعرض لهذا البحث');}
   });
   if(!done&&session.current.current(run.id))throw Error('انقطع الاتصال قبل اكتمال البحث؛ أعد المحاولة');
  }catch(e){if(session.current.current(run.id)){setStatus('توقف البحث');setError(e instanceof TypeError?'فشل الاتصال':e instanceof Error?e.message:'فشل الاتصال');}}
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
 const pickImage=(file?:File)=>{if(!file?.type.startsWith('image/'))return;clear();if(imageUrl.current)URL.revokeObjectURL(imageUrl.current);imageUrl.current=URL.createObjectURL(file);setImage(imageUrl.current);};
 if(!authorized)return <main dir="rtl" className="min-h-screen bg-[#f5f7f3] grid place-items-center p-5"><form onSubmit={login} className="bg-white border rounded-2xl p-8 w-full max-w-md space-y-5"><h1 className="font-bold text-2xl text-[#247c72]">Creative Radaar</h1><label className="block">كود الدخول<input className={input} type="password" value={code} onChange={e=>setCode(e.target.value)} required autoComplete="current-password"/></label>{error&&<p role="alert" className="text-red-700">{error}</p>}<button className="bg-[#247c72] text-white rounded-xl w-full p-3">دخول</button></form></main>;
 return <main dir="rtl" className="min-h-screen bg-[#f5f7f3] text-[#19251f]"><header className="bg-white border-b p-4 flex justify-between"><h1 className="text-xl font-bold text-[#247c72]">Creative Radaar</h1><button onClick={async()=>{clear();await fetch(api+'/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{});sessionStorage.removeItem('cr_reviews_token');setToken('');setAuthorized(false);}}>خروج</button></header><div className="max-w-5xl mx-auto p-5 space-y-5"><p className="text-sm text-[#5a6e62]">فيديوهات ريفيوهات العملاء — نزّل ما تحتاجه. النتائج تختفي عند تغيير المنتج أو تحديث الصفحة.</p><div className="bg-white border rounded-xl p-4 space-y-2"><label className="flex gap-2"><input type="checkbox" checked={browserMode} onChange={e=>{clear();setBrowserMode(e.target.checked);}}/>الجلب المجاني من متصفحي</label>{browserMode&&<p className="text-sm">يتطلب إضافة Chrome المجانية مرة واحدة. لا يحتاج مفتاح API. يحاول جمع حتى 50 فيديو حسب المتاح. <a className="underline text-[#247c72]" href="/creative-radaar-extension.zip" download>تنزيل الإضافة</a> · <a className="underline" href="/extension-install.html" target="_blank" rel="noreferrer">طريقة التثبيت</a></p>}</div><form onSubmit={search} className="bg-white border rounded-2xl p-6 space-y-4"><label className="block">اسم المنتج<input className={input} value={query} onChange={e=>{clear();setQuery(e.target.value);}} required/></label><label className="block">المتجر<select className={input} value={market} onChange={e=>{clear();setMarket(e.target.value);}}>{['amazon.com','amazon.eg','amazon.sa','amazon.ae'].map(m=><option key={m}>{m}</option>)}</select></label><label className="block">صورة مرجعية اختيارية<div className="border border-dashed rounded-xl p-3" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();pickImage(e.dataTransfer.files[0]);}}><input type="file" accept="image/*" onChange={e=>pickImage(e.target.files?.[0])}/>{image&&<img src={image} alt="صورة المنتج" className="h-24 mt-3 object-contain"/>}</div></label><p className="text-xs text-[#6a786f]">البحث بالاسم. الصورة للرجوع إليها فقط. الريفيوهات قد تكون إيجابية أو سلبية.</p><div className="flex gap-3"><button className="bg-[#247c72] text-white p-3 rounded-xl flex-1">{running?'بحث جديد وإلغاء الحالي':'ابحث عن فيديوهات العملاء'}</button><button type="button" onClick={()=>search()} className="border rounded-xl p-3">ابدأ من جديد</button>{running&&<button type="button" onClick={()=>{session.current.clear();setRunning(false);setStatus('تم إيقاف البحث');}} className="border rounded-xl p-3">إيقاف</button>}</div></form><p role="status" aria-live="polite">{status}</p>{failed>0&&<p className="text-sm">تعذر تشغيل {failed} فيديو وتم إخفاؤه تلقائيًا.</p>}{warnings.length>0&&<div role="status" className="bg-amber-50 text-amber-900 border rounded-xl p-4 space-y-2">{warnings.map(w=><p key={w}>{w}</p>)}</div>}{error&&<p role="alert" className="bg-red-50 text-red-800 p-4 rounded-xl">{error}</p>}<section aria-label="فيديوهات العملاء" className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{videos.map(video=><article key={video.url} className="bg-white border rounded-2xl p-3 space-y-3"><ReviewPlayer api={api} token={token} video={video} onFailed={()=>{setVideos(previous=>previous.filter(v=>v.url!==video.url));setFailed(n=>n+1);}}/><h2 className="font-semibold">{video.title||'ريفيو عميل'}</h2><div className="flex justify-between"><button className="text-[#247c72]" onClick={()=>download(video)}>تنزيل</button><a href={video.sourceUrl} target="_blank" rel="noreferrer">المصدر ↗</a><a href={`https://${market}/dp/${video.sourceAsin}`} target="_blank" rel="noreferrer">المنتج ↗</a></div></article>)}</section></div></main>;
}
