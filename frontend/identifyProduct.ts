import {browserRequest,readAmazonDocument,readBrowserProducts,type BrowserProduct} from './browserCollector';
import {chooseVisualIdentity,visualLabels,canonicalScores,productFamilies,matchesIdentity,type VisualScore,type ProductFamily} from './productIdentity';
import {scoreProductImage} from './productVision';
import type {Marketplace,ProductHit} from '../backend/src/types';
export type IdentityProposal={query:string;family:ProductFamily;conflict:boolean;uncertain:boolean;alternatives:string[];products:BrowserProduct[]};
export async function identifyProduct(image:Blob,englishHint:string,market:Marketplace,signal:AbortSignal,progress:(text:string)=>void,onIdentity?:(proposal:IdentityProposal)=>void):Promise<IdentityProposal>{
 const labels=[...new Set([...visualLabels,englishHint])];
 const scores=canonicalScores(await scoreProductImage(image,labels,signal,progress));signal.throwIfAborted();
 const identity=chooseVisualIdentity(scores,englishHint);
 if(identity.family==='other')throw Error('الصورة لا تطابق نوعًا معروفًا بدرجة كافية. اكتب نوع المنتج بالتحديد أو جرّب صورة واضحة بخلفية بسيطة.');
 if(identity.conflict)identity.alternatives=[englishHint,...identity.alternatives].slice(0,4);
 onIdentity?.({...identity,products:[]});
 return findIdentityCandidates(image,identity,market,signal,progress);
}
export async function findIdentityCandidates(image:Blob,identity:Omit<IdentityProposal,'products'>,market:Marketplace,signal:AbortSignal,progress:(text:string)=>void):Promise<IdentityProposal>{
 progress('جاري مقارنة الصورة بأسماء منتجات موجودة على أمازون…');
 const result=await browserRequest('search',{query:identity.query,market,page:'1'},signal);signal.throwIfAborted();
 const products=readBrowserProducts(readAmazonDocument(result.html),market).filter(p=>matchesIdentity(p.title,identity.query,identity.family));
 if(!products.length)throw Error('لم نجد منتجات توافق النوع والمواصفات على أمازون. عدّل الاسم أو جرّب متجرًا آخر؛ لم يتم جمع ريفيوهات لمنتج بديل.');
 const ranked=await scoreProductImage(image,products.map(p=>p.title),signal,progress);signal.throwIfAborted();
 return {...identity,products:rankProducts(products,ranked).slice(0,3)};
}
export function rankProducts(products:ProductHit[],scores:VisualScore[]){
 // Only actual titles and ASINs returned by the current Amazon search can become suggestions.
 const weights=new Map(scores.map(s=>[s.label,Number.isFinite(s.score)?s.score:0]));
 return [...products].sort((a,b)=>(weights.get(b.title)||0)-(weights.get(a.title)||0));
}
