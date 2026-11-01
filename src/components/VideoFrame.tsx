import React,{useEffect,useRef,useState} from 'react';
import {Film} from 'lucide-react';
import {useApp} from '../context/AppContext.tsx';
import type {CandidateAsset} from '../types/index.ts';

// Fetch a frame only for visible cards without a usable poster.
export function VideoFrame({asset}:{asset:CandidateAsset}){
  const {sessionId}=useApp();
  const host=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const element=host.current;
    if(!element)return;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}
    });
    observer.observe(element);
    return ()=>observer.disconnect();
  },[]);
  const query=new URLSearchParams({url:asset.downloadUrl||asset.mediaUrl||'',type:'video',inline:'1'});
  if(sessionId)query.set('token',sessionId);
  return <div ref={host} className="w-full h-full flex items-center justify-center text-slate-300">
    {visible&&!failed?<video muted playsInline preload="auto" aria-label={asset.title} className="w-full h-full object-contain"
      src={'/api/stream-search/download?'+query+'#t=0.2'} onError={()=>setFailed(true)} />:<Film className="w-6 h-6"/>}
  </div>;
}
