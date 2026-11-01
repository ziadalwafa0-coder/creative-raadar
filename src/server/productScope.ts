import {extractAsinFromUrl} from './queryBuilder.ts';

export function selectedAmazonListing(input:{productUrl?:unknown;productName?:unknown;hasReferenceImage?:unknown;referenceImage?:unknown;verifiedExpansion?:unknown}){
  const explicit=typeof input.productUrl==='string'?input.productUrl.trim():'';
  const named=typeof input.productName==='string'?input.productName.trim():'';
  const asin=extractAsinFromUrl(explicit||named);
  if(explicit&&!asin)throw Error('رابط المنتج المحدد لا يحتوي على رقم منتج أمازون صالح. اختَر صفحة المنتج الصحيحة.');
  if((input.hasReferenceImage||input.referenceImage||input.verifiedExpansion)&&!asin)
    throw Error('اختَر صفحة المنتج المطابقة للصورة أولًا، ثم ابدأ جمع المراجعات.');
  return asin?'https://www.amazon.com/dp/'+asin:undefined;
}
