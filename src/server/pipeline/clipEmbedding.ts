import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline, RawImage } from '@huggingface/transformers';
import { DATA_DIR } from '../config.ts';

const execFileAsync = promisify(execFile);

const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';
const CLIP_CACHE_FILE = path.join(DATA_DIR, 'clip_embeddings_cache.json');

interface CachedClipEmbedding {
  hash: string;
  vector: number[];
  createdAt: string;
}

const clipCache = new Map<string, number[]>();
let extractorPromise: Promise<any> | null = null;

function loadClipCacheFromDisk(): void {
  try {
    if (fs.existsSync(CLIP_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CLIP_CACHE_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const item of raw as CachedClipEmbedding[]) {
          if (item?.hash && Array.isArray(item.vector) && item.vector.length > 0) {
            clipCache.set(item.hash, item.vector);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[ClipEmbedding] Failed to load cache:', (err as Error)?.message);
  }
}

function saveClipCacheToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const entries: CachedClipEmbedding[] = [];
    for (const [hash, vector] of Array.from(clipCache.entries()).slice(-1000)) {
      entries.push({ hash, vector, createdAt: new Date().toISOString() });
    }
    fs.writeFileSync(CLIP_CACHE_FILE, JSON.stringify(entries), 'utf-8');
  } catch (err) {
    console.warn('[ClipEmbedding] Failed to save cache:', (err as Error)?.message);
  }
}

loadClipCacheFromDisk();

async function getClipFeatureExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = pipeline('image-feature-extraction', CLIP_MODEL_ID, {
      dtype: 'fp32',
    });
  }
  return extractorPromise;
}

/**
 * Normalizes any image buffer (PNG, JPEG, WebP) via ffmpeg into a 224x224 center-cropped
 * GRAYSCALE PNG so that colour differences are completely removed and CLIP focuses purely
 * on 3D geometry, silhouette, and structural form factor.
 */
async function preprocessColorAgnosticShapePng(imageBuffer: Buffer, hash: string): Promise<string> {
  const tmpDir = path.join(DATA_DIR, 'tmp_clip');
  fs.mkdirSync(tmpDir, { recursive: true });
  const inFile = path.join(tmpDir, `in_${hash.slice(0, 16)}.bin`);
  const outFile = path.join(tmpDir, `gray_${hash.slice(0, 16)}.png`);

  fs.writeFileSync(inFile, imageBuffer);
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inFile,
        '-vf',
        'scale=256:256:force_original_aspect_ratio=increase,crop=224:224,hue=s=0,eq=contrast=1.12',
        '-frames:v',
        '1',
        outFile,
      ],
      { timeout: 6000 }
    );
    return outFile;
  } finally {
    try {
      fs.unlinkSync(inFile);
    } catch {}
  }
}

export function l2NormalizeVector(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) return vec;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

export function cosineSimilarityClip(vecA: number[], vecB: number[]): number {
  if (!vecA.length || !vecB.length || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-12) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

/**
 * Computes a colour-agnostic 512-dim CLIP embedding for an image buffer using Transformers.js,
 * cached by SHA-256 image hash on disk.
 */
export async function computeColorAgnosticClipEmbedding(imageBuffer: Buffer): Promise<{
  hash: string;
  embedding: number[];
}> {
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  const cached = clipCache.get(hash);
  if (cached && cached.length > 0) {
    return { hash, embedding: cached };
  }

  let grayPngPath: string | null = null;
  try {
    grayPngPath = await preprocessColorAgnosticShapePng(imageBuffer, hash);
    const extractor = await getClipFeatureExtractor();
    const rawImg = await RawImage.read(grayPngPath);
    const rgbGray = rawImg.grayscale().rgb();
    const output = await extractor(rgbGray, { pooling: 'mean', normalize: true });
    const rawArr = Array.from(output.data as Float32Array);
    const normalized = l2NormalizeVector(rawArr);

    clipCache.set(hash, normalized);
    saveClipCacheToDisk();
    return { hash, embedding: normalized };
  } finally {
    if (grayPngPath) {
      try {
        fs.unlinkSync(grayPngPath);
      } catch {}
    }
  }
}

export async function computeImageBufferEmbedding(imageBuffer: Buffer): Promise<Float32Array | null> {
  try {
    const res = await computeColorAgnosticClipEmbedding(imageBuffer);
    return new Float32Array(res.embedding);
  } catch {
    return null;
  }
}

export function cosineSimilarity(
  vecA: Float32Array | number[],
  vecB: Float32Array | number[]
): number {
  return cosineSimilarityClip(Array.from(vecA), Array.from(vecB));
}

