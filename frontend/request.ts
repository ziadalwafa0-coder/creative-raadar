/** Bound API waits, including response-body reads, without retrying source requests. */
export async function timedRequest(url:string,init:RequestInit={},timeoutMs=20000,request:typeof fetch=fetch):Promise<Response>{
 const timeout=AbortSignal.timeout(timeoutMs);
 const signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout;
 try{return await request(url,{...init,signal});}
 catch(error){
  init.signal?.throwIfAborted();
  if(timeout.aborted)throw Error('السيرفر لم يرد في الوقت المحدد. حاول لاحقًا.');
  throw error;
 }
}
