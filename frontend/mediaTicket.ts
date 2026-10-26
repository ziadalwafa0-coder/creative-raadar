import {timedRequest} from './request';
export class SessionExpired extends Error{constructor(){super('انتهت جلسة الدخول. سجّل بكودك مرة أخرى لاستكمال التشغيل والتنزيل.');}}
export async function mediaTicket(api:string,token:string,url:string,signal:AbortSignal,request:typeof fetch=fetch):Promise<string>{
 const response=await timedRequest(api+'/api/media-ticket',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({url}),signal},20000,request);
 if(response.status===401)throw new SessionExpired();
 if(!response.ok)throw Error('تعذر تجهيز رابط الفيديو');
 const data=await response.json();signal.throwIfAborted();
 if(typeof data.path!=='string'||!data.path.startsWith('/api/media?'))throw Error('رابط تشغيل غير صالح');
 return data.path;
}
