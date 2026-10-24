import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {Agent,fetch as mediaFetch} from 'undici';
import {safeMediaUrl} from './utils.ts';
export function publicAddress(address:string):boolean {
 if(isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127));}
 if(isIP(address)===6)return /^2[0-9a-f]{3}:/i.test(address); // Accept global unicast only; reject local/mapped addresses.
 return false;
}
export async function openMedia(url:string,headers:Record<string,string>,signal:AbortSignal){
 if(!safeMediaUrl(url))throw Error('MEDIA_DENIED');
 const hostname=new URL(url).hostname;const records=await dns.lookup(hostname,{all:true});
 if(!records.length||records.some(r=>!publicAddress(r.address)))throw Error('MEDIA_DENIED');
 const record=records[0];
 const dispatcher=new Agent({connect:{lookup:((_host:unknown,options:any,callback:any)=>{callback(null,options?.all?[record]:record.address,record.family);}) as any}});
 try{
  const response=await mediaFetch(url,{headers,signal,redirect:'manual',dispatcher});
  return {response,close:()=>dispatcher.close()};
 }catch(error){await dispatcher.close();throw error;}
}
export function rewriteManifest(text:string,base:string,proxy:(url:string)=>string){
 const rewrite=(value:string)=>{const url=new URL(value,base).href;if(!safeMediaUrl(url))throw Error('MEDIA_DENIED');return proxy(url);};
 return text.split(/\r?\n/).map(line=>!line.trim()?line:line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_all,url)=>`URI="${rewrite(url)}"`):rewrite(line.trim())).join('\n');
}
