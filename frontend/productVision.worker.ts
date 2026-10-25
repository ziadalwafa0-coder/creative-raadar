import {pipeline,RawImage,env} from '@huggingface/transformers';
env.allowLocalModels=false;
// Runs in a worker: no product photo or name is sent to an inference service.
let classifier:Promise<any>|undefined;
let queue=Promise.resolve();
self.onmessage=(event:MessageEvent)=>{
 const {id,image,labels}=event.data;
 queue=queue.then(async()=>{
  try{
   classifier??=pipeline('zero-shot-image-classification','Xenova/clip-vit-base-patch32',{
    dtype:'q8',device:'wasm',progress_callback:(p:any)=>{
     self.postMessage({id,progress:p.status==='progress'?`تنزيل نموذج فهم الصورة: ${Math.round(p.progress||0)}٪`:'تجهيز نموذج فهم الصورة على جهازك…'});
    },
   }).catch(error=>{classifier=undefined;throw error;});
   const model=await classifier;
   const picture=await RawImage.fromBlob(image);
   const scores=await model(picture,labels,{hypothesis_template:'{}'});
   self.postMessage({id,scores});
  }catch{self.postMessage({id,error:'تعذر تحليل الصورة على هذا الجهاز أو تنزيل النموذج. أعد المحاولة، أو اختر البحث بالاسم فقط بوضوح.'});}
 });
};
