import type {IConnector} from './types.ts';
import type {ProviderCapability,VisualAttribute,SearchSettings,CandidateAsset} from '../../types/index.ts';
import {safeMediaUrl,videoType} from '../../../backend/src/utils.ts';

/** Legacy registry adapter. Live collection is owned by the browser collector. */
export class AmazonConnector implements IConnector {
 id='amazon' as const;
 name='Amazon Marketplace';
 nameAr='أمازون';
 capabilities():ProviderCapability {
  return {id:this.id,name:this.name,nameAr:this.nameAr,
   description:'Legacy adapter has no independent live discovery source.',
   descriptionAr:'التكامل القديم لا يملك مصدر بحث مستقل. الجلب الفعلي من إضافة المتصفح.',
   state:'unsupported',
   supportedOperations:{discovery:false,reviewAccess:false,visualInspection:false,preview:false,download:false},
   requiredSecrets:[],configuredSecrets:[],
   notes:'A product URL alone does not verify a purchase, a customer review or media availability.',
   notesAr:'رابط المنتج وحده لا يثبت شراءً مؤكدًا أو ريفيو عميل أو وجود فيديو.'};
 }
 async healthCheck(){return false;}
 extractAsin(value:string):string|null {
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^www\.amazon\.(?:com|co\.uk|de|fr|it|es|ae|sa|eg)$/.test(u.hostname))return null;
   return u.pathname.match(/\/(?:dp|gp\/product|product-reviews|ASIN)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase()||null;
  }catch{return null;}
 }
 async searchCandidates(_profile:VisualAttribute,_settings:SearchSettings,_targetCount:number):Promise<Partial<CandidateAsset>[]> {
  throw Error('التكامل القديم لا يملك مصدر بحث فعليًا. استخدم جلب المتصفح أو مصدرًا مصرحًا به.');
 }
 async inspectSource(_url:string){return {provenance:'unresolved_source' as const};}
 async resolveAccessibleMedia(candidate:Partial<CandidateAsset>){
  const url=candidate.mediaUrl;
  const matches=typeof url==='string'&&safeMediaUrl(url)&&(candidate.mediaType==='video'?Boolean(videoType(url)):candidate.mediaType==='photo'&&/\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(url));
  if(matches)return {directMediaUrl:url,canDownload:true};
  return {canDownload:false,unsupportedReason:'لا يوجد رابط ميديا مباشر من مصدر مسموح؛ الصورة المصغرة لا تتحول إلى فيديو.'};
 }
}
