import {pipeline,RawImage,env} from '@huggingface/transformers';
import {visualLabels,canonicalScores,chooseVisualIdentity} from '../frontend/productIdentity';
env.allowLocalModels=false;
const model=await pipeline('zero-shot-image-classification','Xenova/clip-vit-base-patch32',{dtype:'q8'});
for(const path of process.argv.slice(2)){
 const image=await RawImage.read(path);
 const result=canonicalScores(await model(image,visualLabels,{hypothesis_template:'{}'}) as any);
 console.log(JSON.stringify({file:path.split(/[\\/]/).at(-1),top:result.slice(0,3),identity:chooseVisualIdentity(result as any,'9 Tier Shoe Rack with Cover')}));
}
