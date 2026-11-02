import {searchTikTokProvider} from './tiktokProvider.ts';
import {searchFreeTikTok} from './tiktokFreeSearch.ts';
export async function searchPublicTikTok(query:string,limit:number,signal:AbortSignal){
  const byPost=new Map<string,Awaited<ReturnType<typeof searchFreeTikTok>>[number]>();
  const sources=[...(process.env.APIFY_API_TOKEN?.trim()?[searchTikTokProvider]:[]),searchFreeTikTok,searchNativeTikTok];
  let lastError:unknown;
  let readable=false;
  for(const source of sources){
    signal.throwIfAborted();
    try{
      const rows=await source(query,limit,signal);
      readable=true;
      for(const row of rows){byPost.set(row.source,row);if(byPost.size>=limit)break;}
      if(byPost.size>=limit)break;
    }catch(error){signal.throwIfAborted();lastError=error;}
  }
  if(!readable && lastError)throw lastError;
  return [...byPost.values()];
}
async function searchNativeTikTok(query:string,limit:number,signal:AbortSignal){
  const url=new URL('https://www.tiktok.com/api/search/general/full/');
  url.search=new URLSearchParams({keyword:query.slice(0,160),count:String(Math.min(30,limit)),offset:'0'}).toString();
  const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:{Accept:'application/json'}});
  const data=response.ok?await response.json().catch(()=>null):null;
  if(!data||data.status_code!==0||!Array.isArray(data.data))throw Error('TikTok لم يُتح نتائج البحث من السيرفر حاليًا.');
  const items:Array<{url:string;source:string;title:string;author:string;thumbnailUrl?:string}>=[];
  const seen=new Set<string>();
  for(const row of data.data){
    const item=row?.item;
    if(!item||!/^\d{12,24}$/.test(item.id)||seen.has(item.id)||!/^[-\w.]+$/.test(item.author?.uniqueId||''))continue;
    const raw=item.video?.playAddr;
    const address=typeof raw==='string'?raw:raw?.UrlList?.[0]||raw?.urlList?.[0];
    let media:URL;try{media=new URL(address);}catch{continue;}
    if(media.protocol!=='https:'||media.username||media.password||media.port||!/(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com)$/.test(media.hostname))continue;
    seen.add(item.id);
    items.push({thumbnailUrl:typeof item.video?.cover==="string"?item.video.cover:item.video?.cover?.urlList?.[0],url:media.href,source:'https://www.tiktok.com/@'+item.author.uniqueId+'/video/'+item.id,title:String(item.desc||query).slice(0,500),author:item.author.uniqueId});
    if(items.length>=limit)break;
  }
  return items;
}
