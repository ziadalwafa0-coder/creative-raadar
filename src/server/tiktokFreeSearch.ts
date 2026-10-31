export function parseFreeTikTokVideos(data:unknown,limit:number){
  const rows=(data as any)?.data?.videos;
  if((data as any)?.code!==0||!Array.isArray(rows))throw Error('مصدر TikTok المجاني لم يُتح نتائج البحث.');
  const videos:Array<{url:string;source:string;title:string;author:string}>=[];
  const seen=new Set<string>();
  for(const row of rows){
    const id=String(row.video_id||'');
    const author=String(row.author?.unique_id||'');
    if(!/^\d{12,24}$/.test(id)||!/^[-\w.]+$/.test(author)||row.images?.length||seen.has(id))continue;
    let media:URL;
    try{media=new URL(row.play,'https://www.tikwm.com');}catch{continue;}
    const trusted=media.hostname==='www.tikwm.com'||media.hostname==='tikwm.com'||/^(?:[^.]+\.)*tiktokcdn(?:-us|-eu)?\.com$/.test(media.hostname)||/^(?:[^.]+\.)*tiktokv\.com$/.test(media.hostname);
    if(!trusted||media.protocol!=='https:'||media.username||media.password||media.port)continue;
    seen.add(id);
    videos.push({url:media.href,source:'https://www.tiktok.com/@'+author+'/video/'+id,title:String(row.title||'فيديو TikTok').slice(0,500),author});
    if(videos.length>=limit)break;
  }
  return videos;
}
export async function searchFreeTikTok(query:string,limit:number,signal:AbortSignal,request=fetch){
  const count=Math.min(30,Math.max(1,Math.floor(limit)));
  const url=new URL('https://www.tikwm.com/api/feed/search');
  url.search=new URLSearchParams({keywords:query.slice(0,160),count:String(count),cursor:'0'}).toString();
  const response=await request(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('مصدر TikTok المجاني غير متاح حاليًا ('+response.status+').');
  return parseFreeTikTokVideos(await response.json(),count);
}
