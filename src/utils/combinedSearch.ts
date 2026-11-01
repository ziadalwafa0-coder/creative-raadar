type Fetcher = (input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;

/** Merge two server streams into the single active UI search. */
export function combinedSearch(init:RequestInit,request:Fetcher):Response {
  const parent=JSON.parse(String(init.body));
  const quotas=parent.sourceVideoCounts;
  const explicit=quotas && [quotas.amazon,quotas.tiktok].every(n=>Number.isInteger(n)&&n>=1&&n<=500);
  const target=explicit?quotas.amazon+quotas.tiktok:Math.min(500,Math.max(1,Math.floor(Number(parent.targetVideoCount)||10)));
  const controller=new AbortController();
  const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
  const stream=new ReadableStream<Uint8Array>({
    start(writer){
      const seen=new Set<string>();let found=0,photos=0;
      const warnings:string[]=[];
      const send=(event:any)=>{
        if(!signal.aborted)writer.enqueue(new TextEncoder().encode(JSON.stringify({...event,searchId:parent.searchId})+'\n'));
      };
      const read=async(source:'amazon'|'tiktok',count:number)=>{
        const selectedName=parent.productUrl && parent.productName?.match(/[a-z]{3}/i)
          ? parent.productName.split(/[,|]/)[0].split(/\s+/).slice(0,12).join(' ') : '';
        const query=source==='tiktok'?selectedName||parent.verifiedExpansion?.query||parent.productName:parent.productName;
        const response=await request('/api/stream-search',{...init,signal,body:JSON.stringify({...parent,
          searchId:crypto.randomUUID(),sourcePlatform:source,productName:query,
          productUrl:source==='amazon'?parent.productUrl:undefined,
          referenceImage:source==='amazon'?parent.referenceImage:undefined,
          verifiedExpansion:source==='amazon'?parent.verifiedExpansion:undefined,
          mediaType:source==='tiktok'?'video':parent.mediaType,targetVideoCount:count,
          targetPhotoCount:source==='amazon'?parent.targetPhotoCount:0})});
        if(!response.ok||!response.body)throw Error(source+': تعذّر بدء البحث');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        let sourceVideos=0;
        const process=(line:string)=>{
          if(!line.trim())return;
          const event=JSON.parse(line);
          if(event.type==='result'&&event.asset){
            const asset=event.asset;
            const key=asset.mediaType+':'+(asset.mediaType==='video'?((source==='tiktok'&&asset.sourceUrl)||asset.mediaUrl):asset.mediaUrl);
            if(asset.mediaType==='video'&&sourceVideos>=count)return;
            if(!asset.mediaUrl||seen.has(key)||(asset.mediaType==='video'?found>=target:photos>=Number(parent.targetPhotoCount||0)))return;
            seen.add(key);
            if(asset.mediaType==='video'){found++;sourceVideos++;}else photos++;
            send({...event,asset:{...asset,searchId:parent.searchId}});
          }else if(event.type==='warning'||event.type==='progress')send(event);
          else if(event.type==='failed'){
            warnings.push(source+': '+event.error);
            send({type:'warning',message:source+': '+event.error});
          }else if(event.type==='completed'&&event.reasonIfPartial)warnings.push(source+': '+event.reasonIfPartial);
        };
        try{
          while(true){
            const part=await reader.read();buffer+=decoder.decode(part.value,{stream:!part.done});
            const lines=buffer.split('\n');buffer=lines.pop()||'';lines.forEach(process);
            if(part.done){process(buffer);break;}
          }
        }finally{await reader.cancel().catch(()=>{});}
      };
      void(async()=>{
        const amazonShare=explicit?quotas.amazon:Math.ceil(target/2);
        const collect=async(source:'amazon'|'tiktok',count:number)=>{
          signal.throwIfAborted();
          try{await read(source,count);}catch(error){
            signal.throwIfAborted();
            const message=source+': '+(error instanceof Error?error.message:'تعذّر الجلب');
            warnings.push(message);send({type:'warning',message});
          }
        };
        if(parent.amazonDiscoveryBlocked){
          const message='تعذر تأكيد منتج أمازون. لاستكمال حصته أضف رابط المنتج في البحث. بدأ بحث تيك توك بالاسم.';
          warnings.push(message);send({type:'warning',message});
        }else await collect('amazon',amazonShare);
        const amazonFilledShare=found===amazonShare;
        if(found<target)await collect('tiktok',explicit?quotas.tiktok:target-found);
        // Amazon starts at the first result again. Ask for the full quota and deduplicate the replay.
        if(!explicit&&found<target&&amazonFilledShare)await collect('amazon',target);
        send({type:'completed',requestedCount:target,foundCount:found+photos,downloadableCount:found+photos,
          reasonIfPartial:found<target?warnings.join(' · ')||'النتائج المتاحة أقل من العدد المطلوب.':undefined});
      })().catch(error=>{if(!signal.aborted)send({type:'failed',error:error.message});}).finally(()=>{try{writer.close();}catch{}});
    },
    cancel(){controller.abort();}
  });
  return new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}});
}
