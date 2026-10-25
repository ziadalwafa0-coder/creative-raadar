import {AutoProcessor,CLIPVisionModelWithProjection,RawImage,env} from '@huggingface/transformers';
import {compareEvidence,imageShape,type ImageEvidence} from '../frontend/imageMatch';
env.allowLocalModels=false;
const processor=await AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32');
const model=await CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32',{dtype:'q8'});
const all:ImageEvidence[]=[];
for(const path of process.argv.slice(2)){
 const picture=(await RawImage.read(path)).rgb();const {image_embeds}=await model(await processor(picture));
 const small=await picture.resize(9,8,{resample:2});
 all.push({embedding:Array.from(image_embeds.data) as number[],...imageShape(small.data,small.channels)});
}
for(let a=0;a<all.length;a++)for(let b=a;b<all.length;b++)console.log(JSON.stringify({a,b,...compareEvidence(all[a],all[b],String(b))}));
