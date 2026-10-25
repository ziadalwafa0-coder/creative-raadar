import {useEffect,useRef,useState} from 'react';
import type Hls from 'hls.js';
import type {ReviewVideo} from '../backend/src/types';
import {mediaTicket,SessionExpired} from './mediaTicket';
export function ReviewPlayer({video,api,token,onFailed,onAuthExpired}:{video:ReviewVideo;api:string;token:string;onFailed:()=>void;onAuthExpired:()=>void}){
 const element=useRef<HTMLVideoElement>(null);const hls=useRef<Hls|null>(null);const request=useRef<AbortController|null>(null);const failed=useRef(false);
 const disposed=useRef(false);
 const [ready,setReady]=useState(false);const [busy,setBusy]=useState(false);const [near,setNear]=useState(false);
 const fail=()=>{if(!disposed.current&&!failed.current){failed.current=true;onFailed();}};
 useEffect(()=>{
  disposed.current=false;
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setNear(true);observer.disconnect();}},{rootMargin:'200px'});
  if(element.current)observer.observe(element.current);
  return()=>{disposed.current=true;observer.disconnect();request.current?.abort();hls.current?.destroy();if(element.current){element.current.removeAttribute('src');element.current.load();}};
 },[]);
 const play=async()=>{
  if(busy||ready)return;setBusy(true);const abort=new AbortController();request.current=abort;
  try{
   const path=await mediaTicket(api,token,video.url,abort.signal);abort.signal.throwIfAborted();
   const node=element.current;if(!node)return;
   if(video.type==='hls'&&!node.canPlayType('application/vnd.apple.mpegurl')){
    const {default:Hls}=await import('hls.js');abort.signal.throwIfAborted();
    if(!Hls.isSupported())throw Error('HLS unavailable');
    const player=new Hls({enableWorker:true,autoStartLoad:true,maxBufferLength:20});hls.current=player;
    player.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal)fail();});player.on(Hls.Events.MANIFEST_PARSED,()=>{void node.play().catch(()=>{});});
    player.loadSource(api+path);player.attachMedia(node);
   }else{node.src=api+path;void node.play().catch(()=>{});}
   setReady(true);
  }catch(error){if(!abort.signal.aborted){if(error instanceof SessionExpired)onAuthExpired();else fail();}}finally{if(!abort.signal.aborted)setBusy(false);}
 };
 return <div className="relative rounded-xl overflow-hidden bg-[#edf2ef]"><video ref={element} controls={ready} preload="none" playsInline poster={near?video.poster:undefined} onError={fail} className="w-full h-56 object-contain"/>{!ready&&<button type="button" onClick={play} disabled={busy} className="absolute inset-0 grid place-items-center bg-black/10"><span className="bg-white rounded-full px-5 py-3">{busy?'جاري تجهيز الفيديو…':'▶ تشغيل'}</span></button>}</div>;
}
