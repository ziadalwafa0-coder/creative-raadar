import {searchFreeTikTok} from '../server/tiktokFreeSearch.ts';

// The public feed allows cross-origin reads. Use the user's connection only
// after the authenticated server stream ends short, without sending credentials.
export async function recoverTikTokStream(response:Response, options:RequestInit):Promise<Response>{
  if(!response.ok)return response;
  const {searchId,productName,targetVideoCount,matchImage,selectedProductUrl,discoveryAlias,previousPosts=[]}=JSON.parse(String(options.body));
  const target=Math.max(1,Math.min(500,Number(targetVideoCount)||10));
  const signal=options.signal||new AbortController().signal;
  const original=await response.text();
  const events=original.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const seen=new Set(events.filter(e=>e.type==='result'&&e.asset).map(e=>e.asset.sourceUrl));
  const reply=(body:string)=>new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
  if(seen.size>=target)return reply(original);
  const recovered=[];
  const attempted=new Set([...seen,...previousPosts]);
  const shortName=String(productName).split(/\s+(?:with|for)\s+|[,|]/i)[0].trim();
  const queries=[productName];
  if(matchImage||selectedProductUrl){
    for(const alias of [discoveryAlias,shortName]){
      if(typeof alias==='string' && alias.trim().split(/\s+/).length>=2 && !queries.some(q=>q.toLowerCase()===alias.trim().toLowerCase()))queries.push(alias.trim());
    }
  }
  for(const query of queries.slice(0,3)){
    if(seen.size>=target)break;
    try{
    const items=await searchFreeTikTok(query,Math.min(500,target+6+previousPosts.length),signal,(url,init)=>fetch(url,{
      ...init,credentials:'omit',referrerPolicy:'no-referrer'
    }));
    for(let offset=0;offset<items.length && seen.size<target;offset+=10){
      const batch=items.slice(offset,offset+10).filter(item=>!attempted.has(item.source));
      if(!batch.length)continue;
      const check=await fetch('/api/tiktok/matches',{method:'POST',headers:options.headers,signal,
        body:JSON.stringify({productName,matchImage,selectedProductUrl,items:batch.map(({source,title,thumbnailUrl,url})=>({source,title,thumbnailUrl,url}))})});
      if(!check.ok)break;
      const verified=await check.json();
      batch.forEach(item=>attempted.add(item.source));
      const accepted=new Set(verified.sources);
      for(const item of batch){
      if(!accepted.has(item.source))continue;
      if(seen.has(item.source)||seen.size>=target)continue;
      seen.add(item.source);
      recovered.push({type:'result',searchId,asset:{
        id:'tt-'+searchId+'-'+item.source.split('/').pop(),searchId,platform:'tiktok',mediaType:'video',
        thumbnailUrl:verified.posters?.[item.source]||item.thumbnailUrl,mediaUrl:item.url,downloadUrl:item.url,productListingUrl:item.source,sourceUrl:item.source,
        reviewerOrChannel:item.author,title:item.title,provenance:'unresolved_source',
        matchCategory:'permitted_variation',matchScore:0,userFacingMatchLabel:matchImage||selectedProductUrl?'تطابق بصري مع صورة المنتج':'مطابقة وصف الفيديو',
        sentiment:'neutral',collectedAt:new Date().toISOString()
      }});
    }
    }
    }catch{signal.throwIfAborted();}
  }
    if(!recovered.length)return reply(original);
    const merged=events.filter(e=>e.type!=='completed'&&e.type!=='failed');
    merged.push(...recovered,{type:'completed',searchId,requestedCount:target,foundCount:seen.size,
      downloadableCount:seen.size,reasonIfPartial:seen.size<target?'نتائج تيك توك المتاحة أقل من العدد المطلوب.':undefined});
    return reply(merged.map(e=>JSON.stringify(e)).join('\n')+'\n');
}
