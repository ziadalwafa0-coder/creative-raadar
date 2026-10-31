import type {ReviewVideo} from './types.ts';
import {markets,type Marketplace} from './types.ts';
import {decodeHtml,dedupeVideos,safeMediaUrl,videoType} from './utils.ts';

/** Read only structured carousel records with explicit customer provenance. */
export function parseCustomerVideoBlocks(blocks:string[],asin:string,market:Marketplace):ReviewVideo[] {
 const found:ReviewVideo[]=[];
 for(const block of blocks){
  let items:unknown;try{items=JSON.parse(block);}catch{try{items=JSON.parse(decodeHtml(block));}catch{continue;}}
  if(!Array.isArray(items))continue;
  for(const item of items){
   if(!item||typeof item!=='object')continue;
   const creator=String(item.creatorType||'').toLowerCase();const reviewLink=String(item.fullReviewLink||'');
   if(creator==='influencer'||creator==='seller'||creator==='brand'||creator==='manufacturer')continue;
   if(creator!=='customer'&&!reviewLink.includes('customer-reviews')&&!String(item.aciContentId||'').startsWith('amzn1.productreview.'))continue;
   if(/related|other|from the brand/i.test(String(item.segmentName||'')))continue;
   const productAsin=String(item.productAsin||'').toUpperCase();
   if(productAsin&&productAsin!==asin)continue;
   const related=String(item.relatedProductsAsins||'').toUpperCase().split(',').map(v=>v.trim()).filter(Boolean);
   if(!productAsin&&related.length&&!related.includes(asin))continue;
   const url=String(item.videoURL||'');const type=videoType(url);if(!type||!safeMediaUrl(url))continue;
   const poster=String(item.videoImageUrlUnchanged||item.hiResVideoImageUrl||item.videoImageUrl||'');
   let sourceUrl=`https://${markets[market].host}/dp/${asin}`;
   try{const link=new URL(reviewLink,sourceUrl);if(link.protocol==='https:'&&link.hostname===markets[market].host&&link.pathname.includes('customer-reviews'))sourceUrl=link.href;}catch{}
   found.push({url,type,poster:safeMediaUrl(poster)?poster:undefined,title:decodeHtml(String(item.title||'ريفيو عميل')),sourceAsin:asin,sourceUrl,customerReview:true});
  }
 }
 return dedupeVideos(found);
}
