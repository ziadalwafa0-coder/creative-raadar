import {RawImage,env,AutoProcessor,CLIPVisionModelWithProjection} from '@huggingface/transformers';
import {compareEvidence,imageShape,type ImageEvidence} from './imageMatch';
env.allowLocalModels=false;
// Runs in a worker: no product photo or name is sent to an inference service.
let vision:Promise<any>|undefined;
async function evidence(image:Blob):Promise<ImageEvidence>{
 const {processor,model}=await vision!;
 const picture=(await RawImage.fromBlob(image)).rgb();
 const inputs=await processor(picture);const {image_embeds}=await model(inputs);
 const shape=await picture.resize(9,8,{resample:2});
 return {embedding:Array.from(image_embeds.data),...imageShape(shape.data,shape.channels)};
}
let queue=Promise.resolve();
self.onmessage=(event:MessageEvent)=>{
 const {id,image,labels,candidates}=event.data;
 queue=queue.then(async()=>{
  try{
   if(candidates){
    vision??=Promise.all([
     AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32'),
     CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32',{dtype:'q8',device:'wasm',progress_callback:(p:any)=>self.postMessage({id,progress:p.status==='progress'?`تنزيل نموذج مقارنة الصور: ${Math.round(p.progress||0)}٪`:'تجهيز مقارنة صور المنتجات…'})}),
    ]).then(([processor,model])=>({processor,model})).catch(error=>{vision=undefined;throw error;});
    const reference=await evidence(image);const comparisons=[];
    for(let i=0;i<candidates.length;i++){
     self.postMessage({id,progress:`مقارنة صورة المنتج بصورة نتيجة أمازون ${i+1} من ${candidates.length}…`});
     try{comparisons.push(compareEvidence(reference,await evidence(candidates[i].image),candidates[i].id));}
     catch{comparisons.push({id:candidates[i].id,cosine:0,structure:0,accepted:false});}
    }
    self.postMessage({id,scores:comparisons});return;
   }
   throw Error('Image comparison payload required');
  }catch{self.postMessage({id,error:'تعذر تحليل الصورة على هذا الجهاز أو تنزيل النموذج. أعد المحاولة، أو اختر البحث بالاسم فقط بوضوح.'});}
 });
};
