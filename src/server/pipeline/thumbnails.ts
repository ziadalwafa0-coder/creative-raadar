import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DOWNLOADS_DIR } from '../config.ts';
import { isSafeExternalUrl } from '../../utils/security.server.ts';

const execFileAsync = promisify(execFile);

export const POSTERS_DIR = path.join(DOWNLOADS_DIR, 'posters');
try {
  fs.mkdirSync(POSTERS_DIR, { recursive: true });
} catch {}

export interface VisualSignature {
  dHash64: string; // 16-char hex (64 bits)
  edgeVector: number[]; // 64 normalized edge/luminance values (8x8)
  colorHistogram: number[]; // 24 normalized bins (8 R + 8 G + 8 B)
  dominantRgb: [number, number, number];
}

const signatureCache = new Map<string, VisualSignature>();

/**
 * Decodes an image Buffer into a 16x16 raw RGB24 buffer (768 bytes) using ffmpeg pipe.
 */
async function decodeImageToRgb16x16(imageBuf: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vf',
        'scale=16:16:flags=area',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );

    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, 3500);

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code === 0 && out.byteLength >= 16 * 16 * 3) {
        resolve(out.subarray(0, 16 * 16 * 3));
      } else {
        resolve(null);
      }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(imageBuf);
  });
}

export async function computeImageVisualSignature(
  input: Buffer | string
): Promise<VisualSignature | null> {
  const buf =
    typeof input === 'string'
      ? Buffer.from(input.replace(/^data:[^;]+;base64,/, ''), 'base64')
      : input;
  if (!buf || buf.byteLength < 64) return null;

  const cacheKey = crypto.createHash('sha1').update(buf).digest('hex');
  const cached = signatureCache.get(cacheKey);
  if (cached) return cached;

  const rgb = await decodeImageToRgb16x16(buf);
  if (!rgb) return null;

  // Compute 9x8 luminance grid for 64-bit horizontal gradient dHash
  const lum9x8: number[][] = [];
  for (let y = 0; y < 8; y++) {
    const row: number[] = [];
    const srcY = Math.min(15, y * 2);
    for (let x = 0; x < 9; x++) {
      const srcX = Math.min(15, Math.round((x * 15) / 8));
      const idx = (srcY * 16 + srcX) * 3;
      const r = rgb[idx];
      const g = rgb[idx + 1];
      const b = rgb[idx + 2];
      row.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
    lum9x8.push(row);
  }

  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += lum9x8[y][x] < lum9x8[y][x + 1] ? '1' : '0';
    }
  }
  let dHash64 = '';
  for (let i = 0; i < 64; i += 4) {
    dHash64 += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  // Compute 8x8 spatial edge/structure vector (foreground silhouette & gradients)
  const edgeVector: number[] = [];
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sumLum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const idx = ((by * 2 + dy) * 16 + (bx * 2 + dx)) * 3;
          const l = (0.299 * rgb[idx] + 0.587 * rgb[idx + 1] + 0.114 * rgb[idx + 2]) / 255;
          // Invert near-white studio background so dark/colored foreground objects have high weight
          sumLum += 1.0 - l;
        }
      }
      edgeVector.push(sumLum / 4);
    }
  }
  const edgeNorm = Math.sqrt(edgeVector.reduce((acc, v) => acc + v * v, 0)) || 1;
  const normalizedEdge = edgeVector.map((v) => v / edgeNorm);

  // Compute 24-bin color histogram ignoring pure white studio background pixels (R>242, G>242, B>242)
  const hist = new Array<number>(24).fill(0);
  let fgCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < 16 * 16 * 3; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    if (r > 242 && g > 242 && b > 242) continue;
    fgCount++;
    sumR += r;
    sumG += g;
    sumB += b;
    hist[Math.min(7, Math.floor(r / 32))]++;
    hist[8 + Math.min(7, Math.floor(g / 32))]++;
    hist[16 + Math.min(7, Math.floor(b / 32))]++;
  }

  const denom = fgCount || 1;
  const colorHistogram = hist.map((v) => v / denom);
  const dominantRgb: [number, number, number] = [
    Math.round(sumR / denom),
    Math.round(sumG / denom),
    Math.round(sumB / denom),
  ];

  const sig: VisualSignature = {
    dHash64,
    edgeVector: normalizedEdge,
    colorHistogram,
    dominantRgb,
  };
  signatureCache.set(cacheKey, sig);
  return sig;
}

export function hammingDistanceHex64(hashA: string, hashB: string): number {
  if (!hashA || !hashB || hashA.length !== 16 || hashB.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const xor = parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16);
    dist += ((xor & 1) !== 0 ? 1 : 0) + ((xor & 2) !== 0 ? 1 : 0) + ((xor & 4) !== 0 ? 1 : 0) + ((xor & 8) !== 0 ? 1 : 0);
  }
  return dist;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

export function compareVisualSignatures(
  ref: VisualSignature,
  cand: VisualSignature
): {
  combinedSimilarity: number;
  shapeSimilarity: number;
  colorSimilarity: number;
  dHashDistance: number;
} {
  const dHashDistance = hammingDistanceHex64(ref.dHash64, cand.dHash64);
  const hashSim = Math.max(0, (64 - dHashDistance) / 64);
  const shapeSimilarity = cosineSimilarity(ref.edgeVector, cand.edgeVector);
  const colorSimilarity = cosineSimilarity(ref.colorHistogram, cand.colorHistogram);

  // Shape/silhouette is weighted higher than color so color variants of the same product score well
  const combinedSimilarity = Number(
    (shapeSimilarity * 0.55 + hashSim * 0.30 + colorSimilarity * 0.15).toFixed(4)
  );

  return {
    combinedSimilarity,
    shapeSimilarity: Number(shapeSimilarity.toFixed(4)),
    colorSimilarity: Number(colorSimilarity.toFixed(4)),
    dHashDistance,
  };
}

export interface ExtractedPosterResult {
  posterId: string;
  posterLocalPath: string;
  posterApiUrl: string;
  dHash64: string;
}

const posterMetaCache = new Map<string, ExtractedPosterResult>();
const inflightPosterExtractions = new Map<string, Promise<ExtractedPosterResult | null>>();

/**
 * Extracts a real frame from a video URL at ~1.0s (fallback 0.1s) via ffmpeg.
 * Never uses the product listing photo as a review video thumbnail.
 */
export async function extractRealVideoFramePoster(
  videoUrl: string,
  _signal?: AbortSignal
): Promise<ExtractedPosterResult | null> {
  if (!videoUrl || !isSafeExternalUrl(videoUrl).safe) return null;

  const posterId = crypto.createHash('sha256').update(videoUrl.split('?')[0]).digest('hex').slice(0, 24);
  const cached = posterMetaCache.get(posterId);
  if (cached && fs.existsSync(cached.posterLocalPath)) {
    return cached;
  }

  const existingInflight = inflightPosterExtractions.get(posterId);
  if (existingInflight) return await existingInflight;

  const work = (async (): Promise<ExtractedPosterResult | null> => {
    try {
      fs.mkdirSync(POSTERS_DIR, { recursive: true });
      const outPath = path.join(POSTERS_DIR, `${posterId}.jpg`);

      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 400) {
        // Try seeking to 1.0s first; if clip is <1s or fails, retry at 0.1s
        try {
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-ss',
              '00:00:01.00',
              '-i',
              videoUrl,
              '-frames:v',
              '1',
              '-vf',
              "scale='min(480,iw)':-2",
              '-q:v',
              '4',
              outPath,
            ],
            { timeout: 6500 }
          );
        } catch {
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-ss',
              '00:00:00.10',
              '-i',
              videoUrl,
              '-frames:v',
              '1',
              '-vf',
              "scale='min(480,iw)':-2",
              '-q:v',
              '4',
              outPath,
            ],
            { timeout: 6500 }
          );
        }
      }

      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 400) {
        return null;
      }

      const frameBuf = fs.readFileSync(outPath);
      const sig = await computeImageVisualSignature(frameBuf);
      const result: ExtractedPosterResult = {
        posterId,
        posterLocalPath: outPath,
        posterApiUrl: `/api/stream-search/poster?id=${posterId}`,
        dHash64: sig?.dHash64 || posterId.slice(0, 16),
      };
      posterMetaCache.set(posterId, result);
      return result;
    } catch (err) {
      console.warn(`[PosterExtract] Failed to extract real frame from ${videoUrl.slice(0, 80)}:`, (err as Error)?.message || err);
      return null;
    }
  })();

  inflightPosterExtractions.set(posterId, work);
  try {
    return await work;
  } finally {
    inflightPosterExtractions.delete(posterId);
  }
}

/**
 * Extracts up to 3 keyframes (at 0.5s, 2.0s, 4.0s) as base64 JPEGs for Phase C video-level verification.
 */
export async function extractVideoKeyframesBase64(
  videoUrl: string,
  timestampsSec: number[] = [0.5, 2.0, 4.0]
): Promise<string[]> {
  if (!videoUrl || !isSafeExternalUrl(videoUrl).safe) return [];
  const frames: string[] = [];
  const tmpId = crypto.randomBytes(6).toString('hex');

  await Promise.all(
    timestampsSec.map(async (sec, idx) => {
      const tmpOut = path.join(POSTERS_DIR, `kf_${tmpId}_${idx}.jpg`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(sec),
            '-i',
            videoUrl,
            '-frames:v',
            '1',
            '-vf',
            "scale='min(384,iw)':-2",
            '-q:v',
            '5',
            tmpOut,
          ],
          { timeout: 5500 }
        );
        if (fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 300) {
          frames.push(fs.readFileSync(tmpOut).toString('base64'));
        }
      } catch {
        // ignore single timestamp failure if video is shorter
      } finally {
        try {
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        } catch {}
      }
    })
  );

  return frames;
}

export function resolvePosterFilePathById(posterId: string): string | null {
  const clean = posterId.replace(/\.jpg$/i, '');
  if (!/^(?:[a-f0-9]{16,32}|kf_[a-zA-Z0-9_-]{3,40})$/i.test(clean)) return null;
  const candidate = path.join(POSTERS_DIR, `${clean}.jpg`);
  return fs.existsSync(candidate) ? candidate : null;
}
