import {browserRequest,readAmazonDocument,readBrowserProducts,type BrowserProduct} from './browserCollector';
import {productFamilies,matchesIdentity,type ProductFamily} from './productIdentity';
import {compareProductImages} from './productVision';
import {safeMediaUrl} from '../backend/src/utils';
import type {Marketplace} from '../backend/src/types';
import type {ImageComparison} from './imageMatch';
export type MatchedProduct=BrowserProduct&{visualEvidence:ImageComparison};
export type IdentityProposal={query:string;family:ProductFamily;conflict:boolean;uncertain:boolean;alternatives:string[];products:MatchedProduct[];inspected?:number;compared?:number};
export async function identifyProduct(image:Blob,englishHint:string,market:Marketplace,signal:AbortSignal,progress:(text:string)=>void,onIdentity?:(proposal:IdentityProposal)=>void,services?:Partial<{request:typeof browserRequest;loadImage:typeof loadAmazonImage;compare:typeof compareProductImages}>):Promise<IdentityProposal>{
 // Never replace the supplied product name with an unrelated guessed image category.
 const family=productFamilies.find(f=>f[2].test(englishHint))?.[0]||'custom';
 const identity={query:englishHint,family,conflict:false,uncertain:true,alternatives:[],products:[]};
 onIdentity?.(identity);return findIdentityCandidates(image,identity,market,signal,progress,{request:browserRequest,loadImage:loadAmazonImage,compare:compareProductImages,...services});
}
export async function loadAmazonImage(url:string,signal:AbortSignal):Promise<Blob>{
 if(!safeMediaUrl(url))throw Error('مصدر صورة غير مسموح');
 const response=await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
 if(!response.ok||!/^image\/(jpeg|png|webp|avif)(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('تعذر قراءة صورة المنتج');
 const reader=response.body?.getReader();if(!reader)throw Error('صورة غير قابلة للقراءة');
 const chunks:Uint8Array<ArrayBuffer>[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw Error('صورة كبيرة');chunks.push(value as Uint8Array<ArrayBuffer>);}}
 finally{await reader.cancel().catch(()=>{});}
 signal.throwIfAborted();return new Blob(chunks,{type:response.headers.get('content-type')!});
}
export function selectImageMatches(products:BrowserProduct[],scores:ImageComparison[]):MatchedProduct[]{
 const evidence=new Map(scores.filter(s=>s.accepted&&Number.isFinite(s.cosine)&&s.cosine>=0.92&&Number.isFinite(s.structure)&&s.structure>=0.875).map(s=>[s.id,s]));
 return products.filter(p=>p.imageUrl&&evidence.has(p.asin)).map(p=>({...p,visualEvidence:evidence.get(p.asin)!})).sort((a,b)=>b.visualEvidence.cosine-a.visualEvidence.cosine);
}
export async function findIdentityCandidates(image:Blob,identity:Omit<IdentityProposal,'products'>,market:Marketplace,signal:AbortSignal,progress:(text:string)=>void,services={request:browserRequest,loadImage:loadAmazonImage,compare:compareProductImages}):Promise<IdentityProposal>{
 const seen=new Set<string>();let inspected=0,compared=0;
 for(let page=1;page<=2;page++){
  progress(`البحث عن نفس المنتج ثم فحص صور النتائج — صفحة ${page}…`);
  const result=await services.request('search',{query:identity.query,market,page:String(page)},signal);signal.throwIfAborted();
  const hits=readBrowserProducts(readAmazonDocument(result.html),market).filter(p=>!seen.has(p.asin));
  if(!hits.length)break;for(const p of hits)seen.add(p.asin);
  const products=hits.filter(p=>p.imageUrl&&matchesIdentity(p.title,identity.query,identity.family));
  const candidates:{id:string;image:Blob}[]=[];
  // Unreadable pictures are rejected, never approved by title as a fallback.
  for(let i=0;i<products.length;i+=3){
   const batch=await Promise.all(products.slice(i,i+3).map(async p=>{try{return{id:p.asin,image:await services.loadImage(p.imageUrl!,signal)};}catch{signal.throwIfAborted();return null;}}));
   candidates.push(...batch.filter((p):p is {id:string;image:Blob}=>p!==null));
  }
  inspected+=products.length;if(!candidates.length)continue;
  const scores=await services.compare(image,candidates,signal,progress);signal.throwIfAborted();compared+=candidates.length;
  const matches=selectImageMatches(products,scores);
  if(matches.length)return {...identity,products:matches.slice(0,3),inspected,compared};
 }
 if(inspected&&!compared)throw Error('وجدنا منتجات مناسبة للاسم لكن تعذر قراءة صورها؛ لم يكتمل فحص المطابقة.');
 return {...identity,products:[],inspected,compared};
}
