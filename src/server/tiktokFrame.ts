import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export async function tikTokFrame(raw:string|undefined,signal:AbortSignal,seconds=1){
  let url:URL;try{url=new URL(raw||'');}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.port||
    !/(^|\.)(tiktokcdn(?:-us|-eu)?\.com|tiktokv\.com)$/.test(url.hostname))return null;
  let directory:string|undefined;
  try{
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(18000)]);
    const res=await fetch(url,{signal:bounded,redirect:'error'});
    if(!res.ok||!res.body)return null;
    const reader=res.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{
      while(true){
        const part=await reader.read();if(part.done)break;
        size+=part.value.length;if(size>18*1024*1024)return null;
        chunks.push(part.value);
      }
    }finally{await reader.cancel().catch(()=>{});}
    directory=await mkdtemp(path.join(tmpdir(),'radaar-frame-'));
    const file=path.join(directory,'clip.mp4');
    await writeFile(file,Buffer.concat(chunks));
    const jpg=await new Promise<Buffer>((resolve,reject)=>{
      const output:Buffer[]=[];
      const child=spawn('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',file,'-ss',String(seconds),'-frames:v','1','-vf','scale=480:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{windowsHide:true,signal:bounded});
      child.stdout.on('data',chunk=>output.push(chunk));
      child.stderr.resume();child.on('error',reject);
      child.on('close',code=>code===0?resolve(Buffer.concat(output)):reject(Error('Frame unavailable')));
    });
    return jpg.length>100?{base64:jpg.toString('base64'),mimeType:'image/jpeg'}:null;
  }catch{return null;}
  finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
