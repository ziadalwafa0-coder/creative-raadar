import {tikTokFrame} from './tiktokFrame.ts';
import {evaluateStrictProductTitleMatch,extractAsinFromUrl,resolveProductIdentityFromUrl} from './queryBuilder.ts';
import {parseReferenceImage} from './productProfile.ts';
import {fetchProductImageAsBase64} from './amazonHttp.ts';
import {verifyAmazonProductsBatchVisually} from './gemini.ts';

type Clip={title:string;thumbnailUrl?:string;url?:string};
export async function filterTikTokProducts<T extends Clip>(pool:T[],body:Record<string,unknown>,limit:number,signal:AbortSignal){
  const name=String(body.productName||'').slice(0,200);
  if(!body.matchImage && !body.selectedProductUrl){
    return pool.filter(item=>evaluateStrictProductTitleMatch(item.title.replace(/#/g,' '),name).approved).slice(0,limit);
  }
  let reference=parseReferenceImage(body.matchImage);
  if(!reference && typeof body.selectedProductUrl==='string'){
    const asin=extractAsinFromUrl(body.selectedProductUrl);
    if(asin){
      const listing=await resolveProductIdentityFromUrl('https://www.amazon.com/dp/'+asin,signal);
      reference=await fetchProductImageAsBase64(listing?.imageUrl,signal);
    }
  }
  if(!reference)return [];
  const matched:T[]=[];
  for(let i=0;i<pool.length&&matched.length<limit;i+=5){
    signal.throwIfAborted();
    const batch=pool.slice(i,i+5);
    const pictures=await Promise.all(batch.map(async(item,index)=>{
      const asin='CLIP'+index;
      let pic=null;
      try{
        const url=new URL(item.thumbnailUrl||'');
        if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
          /(^|\.)(tiktokcdn(?:-us|-eu)?\.com|tiktokv\.com)$/.test(url.hostname))pic=await fetchProductImageAsBase64(url.href,signal);
      }catch{signal.throwIfAborted();}
      if(!pic)pic=await tikTokFrame(item.url,signal);
      if(pic)item.thumbnailUrl='data:'+pic.mimeType+';base64,'+pic.base64;
      return pic?{asin,title:String(item.title).slice(0,500),imageBase64:pic.base64,imageMimeType:pic.mimeType}:null;
    }));
    const valid=pictures.filter(p=>p!==null);
    if(!valid.length)continue;
    const decisions=await verifyAmazonProductsBatchVisually(reference.base64,reference.mimeType,name,undefined,valid,undefined,signal);
    if(!decisions)break;
    batch.forEach((item,index)=>{if(decisions.get('CLIP'+index)?.approved&&matched.length<limit)matched.push(item);});
  }
  return matched;
}
