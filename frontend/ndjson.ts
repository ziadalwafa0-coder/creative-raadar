export async function readNdjson(body:ReadableStream<Uint8Array>,signal:AbortSignal,onEvent:(event:any)=>void){
 const reader=body.getReader();const decoder=new TextDecoder();let buffer='';
 const abort=()=>{void reader.cancel();};signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>1024*1024)throw Error('استجابة المصدر أكبر من المتوقع');
   let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(line){signal.throwIfAborted();onEvent(JSON.parse(line));}}
  }
  buffer+=decoder.decode();if(buffer.trim()){signal.throwIfAborted();onEvent(JSON.parse(buffer));}
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
export class SearchSession {
 id='';controller:AbortController|undefined;
 start(){this.controller?.abort();this.controller=new AbortController();this.id=crypto.randomUUID();return {id:this.id,signal:this.controller.signal};}
 current(id:string){return this.id===id&&!this.controller?.signal.aborted;}
 clear(){this.controller?.abort();this.id='';}
}
