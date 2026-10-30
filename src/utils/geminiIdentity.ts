import type { VisualAttribute } from '../types/index.ts';

export async function prepareIdentityImage(image: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  try {
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('تعذر تجهيز الصورة للتحليل.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally { bitmap.close(); }
}

export async function analyzeImageWithGemini(referenceImage: string, productName: string, signal: AbortSignal,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Promise<{query: string; profile: VisualAttribute}> {
  const response = await request('/api/product-identity/analyze', {
    method:'POST', headers:{'Content-Type':'application/json'}, signal,
    body: JSON.stringify({referenceImage, productName}),
  });
  const body = await response.json();
  if (!response.ok || typeof body.query !== 'string' || !body.profile) throw new Error(body.error || 'تعذر تحليل الصورة الآن.');
  return body;
}
