let worker: Worker | undefined;
export type IdentityCandidate = { asin: string; title: string; url: string; image: string };
export type VisualScore = { id: string; similarity: number; structure: number; accepted: boolean };

export function analyzeCommercialName(image: Blob, signal: AbortSignal, progress: (text: string) => void, nameHint = '') {
  return run<{query: string; confidence: 'suggested'; uncertain: boolean; scores: import('./visualIdentity.ts').CategoryScore[]}>({image, nameHint}, signal, progress);
}
export function compareCandidateImages(image: Blob, candidates: IdentityCandidate[], signal: AbortSignal, progress: (text: string) => void) {
  return run<VisualScore[]>({image, candidates}, signal, progress);
}
function run<T>(payload: object, signal: AbortSignal, progress: (text: string) => void): Promise<T> {
  signal.throwIfAborted();
  worker ??= new Worker(new URL('./productVision.worker.ts', import.meta.url), {type: 'module'});
  const active = worker, id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const stop = () => { active.terminate(); if (worker === active) worker = undefined; };
    const cleanup = () => { clearTimeout(timer); active.removeEventListener('message', receive); active.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); stop(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    const fail = () => { cleanup(); stop(); reject(new Error('تعذر تشغيل تحليل الصورة على هذا الجهاز؛ يمكنك كتابة اسم البحث التجاري يدويًا.')); };
    const receive = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      if (event.data.progress) { progress(event.data.progress); return; }
      cleanup();
      if (event.data.error) { stop(); reject(new Error(event.data.error)); }
      else resolve(event.data.result);
    };
    const timer = setTimeout(() => { cleanup(); stop(); reject(new Error('انتهت مهلة تحميل نموذج الصورة. جرّب اتصالًا أسرع أو اكتب اسم البحث يدويًا.')); }, 300_000);
    active.addEventListener('message', receive); active.addEventListener('error', fail); signal.addEventListener('abort', abort, {once: true});
    active.postMessage({id, ...payload});
  });
}
