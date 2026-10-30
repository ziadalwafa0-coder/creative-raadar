import { RawImage, env, AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection } from '@huggingface/transformers';
import { commercialProducts, cosine, imageShape, compareEvidence, selectCommercialName, type ImageEvidence } from './visualIdentity.ts';
env.allowLocalModels = false;
env.backends.onnx.wasm!.numThreads = 1;
const modelId = 'Xenova/clip-vit-base-patch32';
let vision: Promise<any> | undefined;
let texts: Promise<number[][]> | undefined;
let queue = Promise.resolve();

async function evidence(blob: Blob): Promise<ImageEvidence> {
  const { processor, model } = await vision!;
  const image = (await RawImage.fromBlob(blob)).rgb();
  const { image_embeds } = await model(await processor(image));
  const shape = await image.resize(9, 8, {resample: 2});
  return { embedding: Array.from(image_embeds.data), ...imageShape(shape.data, shape.channels) };
}

self.onmessage = event => {
  const { id, image, candidates, nameHint } = event.data;
  let lastProgress = '';
  const progress = (p: any) => {
    const text = p.status === 'progress' ? `تنزيل نموذج تحليل الصورة لأول مرة: ${Math.round(p.progress || 0)}٪` : 'تجهيز تحليل الصورة على جهازك…';
    if (text !== lastProgress) { lastProgress = text; self.postMessage({id, progress: text}); }
  };
  queue = queue.then(async () => {
    try {
      vision ??= Promise.all([
        AutoProcessor.from_pretrained(modelId),
        CLIPVisionModelWithProjection.from_pretrained(modelId, {dtype: 'q8', device: 'wasm', progress_callback: progress}),
      ]).then(([processor, model]) => ({processor, model}));
      const reference = await evidence(image);
      if (candidates) {
        const scores = [];
        for (const candidate of candidates) {
          self.postMessage({id, progress: `مقارنة صورة المنتج بصورة نتيجة أمازون ${scores.length + 1} من ${candidates.length}…`});
          try {
            const picture = await (await fetch(candidate.image)).blob();
            scores.push(compareEvidence(reference, await evidence(picture), candidate.asin));
          } catch { scores.push({id: candidate.asin, similarity: 0, structure: 0, accepted: false}); }
        }
        self.postMessage({id, result: scores});
      } else {
        texts ??= Promise.all([
          AutoTokenizer.from_pretrained(modelId),
          CLIPTextModelWithProjection.from_pretrained(modelId, {dtype: 'q8', device: 'wasm', progress_callback: progress}),
        ]).then(async ([tokenizer, model]) => {
          const inputs = await tokenizer(commercialProducts.map(x => `a photo of ${x[1]}`), {padding: true, truncation: true});
          const {text_embeds} = await model(inputs);
          const embeddings = text_embeds.tolist();
          await model.dispose();
          return embeddings;
        });
        const labels = await texts;
        self.postMessage({id, result: selectCommercialName(labels.map((embedding, index) => ({index, score: cosine(reference.embedding, embedding)})), nameHint)});
      }
    } catch (error) {
      self.postMessage({id, error: error instanceof Error ? error.message : 'تعذر تحليل الصورة على هذا الجهاز.'});
    }
  });
};
