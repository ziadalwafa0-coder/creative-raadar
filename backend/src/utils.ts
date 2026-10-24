import type {ReviewVideo} from './types.ts';
export function parseRatingsCount(value:unknown):number {
 if(typeof value==='number')return Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
 const text=String(value||'').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٬/g,',').replace(/٫/g,'.');
 const match=text.match(/([\d][\d,\s.]*)(?:\s*)([kKmM]|ألف|الف|مليون)?/);
 if(!match)return 0;
 const n=Number(match[1].replace(/[,\s]/g,''));const suffix=match[2]?.toLowerCase();
 return Number.isFinite(n)?Math.max(0,Math.round(n*(suffix==='k'||suffix==='ألف'||suffix==='الف'?1000:suffix==='m'||suffix==='مليون'?1000000:1))):0;
}
const mediaHosts=new Set(['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com']);
export function safeMediaUrl(value:string):boolean {
 // Exact host membership also rejects every IP literal; keep this shared parser browser-compatible.
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&mediaHosts.has(u.hostname);}catch{return false;}
}
export function dedupeVideos(videos:ReviewVideo[]) {const seen=new Set<string>();return videos.filter(v=>{if(seen.has(v.url))return false;seen.add(v.url);return true;});}
export const decodeHtml=(v:string)=>v.replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function videoType(url:string):'mp4'|'hls'|undefined {return /\.m3u8(?:[?#]|$)/i.test(url)?'hls':/\.mp4(?:[?#]|$)/i.test(url)?'mp4':undefined;}
export function normalizeQuery(query:string){return query.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();}
export function isAmazonErrorPage(title:string,body:string):boolean {
 // Observed on Railway: Amazon returns its 500/503 image page with HTTP 200
 // and an empty innerText. The title remains the authoritative failure signal.
 return /^Sorry!\s*Something went wrong!?$/i.test(title.trim()) || /automated access/i.test(body);
}
export function signalSleep(ms:number,signal?:AbortSignal) {
 return new Promise<void>((resolve,reject)=>{signal?.throwIfAborted();const stop=()=>{clearTimeout(timer);reject(signal?.reason||Error('aborted'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});
}
