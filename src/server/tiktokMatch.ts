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
  let visuallyChecked=0,secondLookMatches=0;
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
    visuallyChecked+=valid.length;
    const unclear=batch.map((item,index)=>({item,index})).filter(({index})=>!decisions.get('CLIP'+index)?.approved);
    const extra=await Promise.all(unclear.map(async({item,index})=>{
      const frame=await tikTokFrame(item.url,signal,4);
      return frame?{asin:'CLIP'+index,title:item.title,imageBase64:frame.base64,imageMimeType:frame.mimeType}:null;
    }));
    const frames=extra.filter(f=>f!==null);
    const second=frames.length?await verifyAmazonProductsBatchVisually(reference.base64,reference.mimeType,name,undefined,frames,undefined,signal):null;
    batch.forEach((item,index)=>{
      const id='CLIP'+index;
      if(matched.length>=limit)return;
      if(decisions.get(id)?.approved)matched.push(item);
      else if(second?.get(id)?.approved){
        secondLookMatches++;
        item.thumbnailUrl='data:image/jpeg;base64,'+frames.find(f=>f.asin===id)!.imageBase64;
        matched.push(item);
      }
    });
  }
  console.info('[TikTok match counts]',{visuallyChecked,matched:matched.length,secondLookMatches});
  return matched;
}
