import {parseAmazonQuery} from '../backend/src/queryAi';
export async function thumbnailJpegBase64(file:Blob):Promise<string|undefined>{
 let image:ImageBitmap|undefined;
 try{image=await createImageBitmap(file);const scale=Math.min(1,320/Math.max(image.width,image.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');if(!ctx)return;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const base64=canvas.toDataURL('image/jpeg',0.8).split(',')[1];return base64?.length<=180000?base64:undefined;}catch{return;}finally{image?.close();}
}
export async function aiAmazonQueries(api:string,token:string,name:string,image:Blob|undefined,market:string,signal:AbortSignal,request:typeof fetch=fetch):Promise<string[]|null>{
 try{signal.throwIfAborted();const thumbnail=image?await thumbnailJpegBase64(image):undefined;signal.throwIfAborted();const response=await request(api+'/api/amazon-query',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,market,thumbnailJpegBase64:thumbnail}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});signal.throwIfAborted();if(!response.ok)return null;const data=await response.json();signal.throwIfAborted();return parseAmazonQuery(JSON.stringify(data)).queries;}catch{signal.throwIfAborted();return null;}
}
