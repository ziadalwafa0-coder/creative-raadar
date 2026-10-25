import {markets,type Marketplace} from '../backend/src/types';
export function productReference(raw:string,market:Marketplace):{asin:string;market:Marketplace}|undefined{
 const value=raw.trim();if(/^[A-Z0-9]{10}$/i.test(value))return{asin:value.toUpperCase(),market};
 if(!/^https?:\/\//i.test(value))return;
 let url:URL;try{url=new URL(value);}catch{throw Error('رابط المنتج غير صالح');}
 const host=url.hostname.replace(/^www\./,'');
 if(url.protocol!=='https:'||url.username||url.password||url.port||!(host in markets))throw Error('استخدم رابط منتج مباشر من متاجر أمازون المدعومة، بدون روابط مختصرة.');
 const asin=url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
 if(!asin)throw Error('الرابط يجب أن يكون لصفحة منتج أمازون نفسه، وليس نتائج البحث.');
 return{asin:asin.toUpperCase(),market:host as Marketplace};
}
