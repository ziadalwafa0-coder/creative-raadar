import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as undiciFetch } from 'undici';
import { isSafeExternalUrl } from '../utils/security.server.ts';
import type { DownloadStatus } from '../types/index.ts';
import { DOWNLOADS_DIR as CONFIG_DOWNLOADS_DIR, MAX_CACHE_BYTES } from './config.ts';
import { amazonUndiciAgent, AMAZON_CHROME_USER_AGENT } from './amazonHttp.ts';
import { resolveBestVideoDownloadUrl } from './amazonVideos.ts';

export const DOWNLOADS_DIR = CONFIG_DOWNLOADS_DIR;
const CACHE_INDEX_FILE = path.join(DOWNLOADS_DIR, 'verified_media_cache.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let cachedFfmpegAvailable: boolean | null = null;

interface CachedMediaRecord {
  urlKey: string;
  mediaType: 'video' | 'photo';
  localFilePath: string;
  sha256: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  verifiedAt: number;
  lastAccessedAt: number;
}

export interface DownloadResult {
  status: DownloadStatus;
  localFilePath?: string;
  sha256?: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  error?: string;
  isHtmlPage?: boolean;
  fromCache?: boolean;
  downloadPathUsed?: 'cache hit' | 'direct MP4' | 'ffmpeg HLS';
  durationMs?: number;
}

const urlMediaCache = new Map<string, CachedMediaRecord>();
const inflightDownloads = new Map<string, Promise<DownloadResult>>();
const shaProbeCache = new Map<
  string,
  { valid: boolean; duration?: number; width?: number; height?: number }
>();

// Priority Prewarm Queue: Concurrency 5 for direct MP4/image, semaphore 2 for ffmpeg/HLS jobs
interface PrewarmTask {
  url: string;
  mediaType: 'video' | 'photo';
  priority: 'high' | 'normal';
}

const prewarmQueue: PrewarmTask[] = [];
const prewarmQueuedKeys = new Set<string>();
let activePrewarmDirectCount = 0;
const MAX_CONCURRENT_DIRECT_PREWARMS = 5;

// Semaphore for ffmpeg/HLS jobs (max 2 concurrent)
let activeFfmpegJobs = 0;
const MAX_CONCURRENT_FFMPEG_JOBS = 2;
const ffmpegWaiters: Array<() => void> = [];

async function acquireFfmpegSlot(): Promise<void> {
  if (activeFfmpegJobs < MAX_CONCURRENT_FFMPEG_JOBS) {
    activeFfmpegJobs++;
    return;
  }
  await new Promise<void>((resolve) => {
    ffmpegWaiters.push(resolve);
  });
  activeFfmpegJobs++;
}

function releaseFfmpegSlot(): void {
  activeFfmpegJobs = Math.max(0, activeFfmpegJobs - 1);
  const next = ffmpegWaiters.shift();
  if (next) next();
}

function isLikelyHlsUrl(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url);
}

function processPrewarmQueue(): void {
  while (
    activePrewarmDirectCount < MAX_CONCURRENT_DIRECT_PREWARMS &&
    prewarmQueue.length > 0
  ) {
    // Pick high priority tasks first
    const highIdx = prewarmQueue.findIndex((t) => t.priority === 'high');
    const next = highIdx >= 0 ? prewarmQueue.splice(highIdx, 1)[0] : prewarmQueue.shift();
    if (!next) break;

    const urlKey = `${next.mediaType}:${next.url}`;
    prewarmQueuedKeys.delete(urlKey);

    activePrewarmDirectCount++;
    downloadMedia(next.url, 'prewarm', next.mediaType, 60 * 1024 * 1024, undefined, true, next.priority)
      .catch((err: unknown) => {
        console.warn('[Prewarm] Background download failed:', (err as Error)?.message || err);
      })
      .finally(() => {
        activePrewarmDirectCount = Math.max(0, activePrewarmDirectCount - 1);
        processPrewarmQueue();
      });
  }
}

/**
 * Enqueues a discovered media URL for background pre-downloading, or promotes it to the front
 * of the priority queue when priority === 'high' (e.g. user clicked or previewed the video).
 */
export function prewarmMediaInBackground(
  url?: string,
  mediaType: 'video' | 'photo' = 'video',
  priority: 'high' | 'normal' = 'normal'
): void {
  if (!url || typeof url !== 'string') return;
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) return;
  const urlKey = `${mediaType}:${trimmed}`;
  const existing = urlMediaCache.get(urlKey);
  if (existing && fs.existsSync(existing.localFilePath)) return;
  if (inflightDownloads.has(urlKey)) return;

  if (prewarmQueuedKeys.has(urlKey)) {
    if (priority === 'high') {
      const idx = prewarmQueue.findIndex((t) => `${t.mediaType}:${t.url}` === urlKey);
      if (idx >= 0) {
        const [item] = prewarmQueue.splice(idx, 1);
        item.priority = 'high';
        prewarmQueue.unshift(item);
      }
    }
    processPrewarmQueue();
    return;
  }

  prewarmQueuedKeys.add(urlKey);
  if (priority === 'high') {
    prewarmQueue.unshift({ url: trimmed, mediaType, priority: 'high' });
  } else {
    prewarmQueue.push({ url: trimmed, mediaType, priority: 'normal' });
  }
  processPrewarmQueue();
}

/**
 * Startup & periodic cache maintenance:
 * 1) Cleans leftover temp_stream_* and *.tmp files.
 * 2) Deletes files older than 7 days.
 * 3) Enforces LRU eviction when DOWNLOADS_DIR exceeds MAX_CACHE_GB.
 */
export function cleanupDownloadsCache(removeTempFiles = false): void {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      return;
    }

    const now = Date.now();
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const fileEntries: Array<{
      fullPath: string;
      name: string;
      size: number;
      lastAccess: number;
    }> = [];

    for (const name of files) {
      if (name === 'verified_media_cache.json') continue;
      const fullPath = path.join(DOWNLOADS_DIR, name);

      // 1. Clean temp_stream_* and *.tmp files on startup
      if (removeTempFiles && (name.startsWith('temp_stream_') || name.endsWith('.tmp') || name.includes('.tmp.'))) {
        try {
          fs.unlinkSync(fullPath);
        } catch (err) {
          console.warn('[CacheCleanup] Failed to remove temp file:', (err as Error)?.message);
        }
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        // 2. Delete files older than 7 days
        const ageMs = now - stat.mtimeMs;
        if (ageMs > SEVEN_DAYS_MS) {
          fs.unlinkSync(fullPath);
          for (const [k, rec] of urlMediaCache.entries()) {
            if (path.resolve(rec.localFilePath) === path.resolve(fullPath)) {
              urlMediaCache.delete(k);
            }
          }
          continue;
        }

        let lastAccess = stat.atimeMs || stat.mtimeMs;
        for (const rec of urlMediaCache.values()) {
          if (path.resolve(rec.localFilePath) === path.resolve(fullPath)) {
            lastAccess = Math.max(lastAccess, rec.lastAccessedAt || rec.verifiedAt || 0);
            break;
          }
        }

        fileEntries.push({
          fullPath,
          name,
          size: stat.size,
          lastAccess,
        });
      } catch {
        // file may have been concurrently removed
      }
    }

    // 3. LRU eviction if total size exceeds MAX_CACHE_BYTES
    let totalBytes = fileEntries.reduce((acc, f) => acc + f.size, 0);
    if (totalBytes > MAX_CACHE_BYTES) {
      fileEntries.sort((a, b) => a.lastAccess - b.lastAccess);
      for (const entry of fileEntries) {
        if (totalBytes <= MAX_CACHE_BYTES) break;
        try {
          fs.unlinkSync(entry.fullPath);
          totalBytes -= entry.size;
          for (const [k, rec] of urlMediaCache.entries()) {
            if (path.resolve(rec.localFilePath) === path.resolve(entry.fullPath)) {
              urlMediaCache.delete(k);
            }
          }
        } catch (err) {
          console.warn('[CacheCleanup] LRU unlink failed:', (err as Error)?.message);
        }
      }
    }
  } catch (err) {
    console.warn('[CacheCleanup] Error during cache maintenance:', (err as Error)?.message);
  }
}

function loadMediaCache(): void {
  try {
    if (fs.existsSync(CACHE_INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_INDEX_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (
            item &&
            item.urlKey &&
            item.localFilePath &&
            fs.existsSync(item.localFilePath) &&
            now - (item.verifiedAt || now) <= SEVEN_DAYS_MS
          ) {
            urlMediaCache.set(item.urlKey, {
              ...item,
              lastAccessedAt: item.lastAccessedAt || item.verifiedAt || now,
            });
            if (item.sha256) {
              shaProbeCache.set(item.sha256, {
                valid: true,
                duration: item.durationSeconds,
                width: item.width,
                height: item.height,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Downloader] Failed to load verified_media_cache.json:', (err as Error)?.message);
  }
}

function saveMediaCache(): void {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    const items = Array.from(urlMediaCache.values()).filter((i) =>
      fs.existsSync(i.localFilePath)
    );
    fs.writeFileSync(CACHE_INDEX_FILE, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Downloader] Failed to save verified_media_cache.json:', (err as Error)?.message);
  }
}

// Run startup cleanup and cache initialization
loadMediaCache();
cleanupDownloadsCache(true);

export function isFfmpegAvailable(): boolean {
  if (cachedFfmpegAvailable !== null) {
    return cachedFfmpegAvailable;
  }
  try {
    const res = spawnSync('ffmpeg', ['-version'], { timeout: 2000 });
    cachedFfmpegAvailable = res.status === 0;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

export function verifyWithFfprobe(
  filePath: string,
  knownSha256?: string
): Promise<{ valid: boolean; duration?: number; width?: number; height?: number }> {
  if (knownSha256 && shaProbeCache.has(knownSha256)) {
    return Promise.resolve(shaProbeCache.get(knownSha256)!);
  }

  return new Promise((resolve) => {
    try {
      const probe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height,duration',
        '-of',
        'json',
        filePath,
      ]);
      let stdout = '';
      probe.stdout.on('data', (d) => (stdout += d));
      probe.on('close', (code) => {
        if (code !== 0) return resolve({ valid: false });
        try {
          const parsed = JSON.parse(stdout);
          const videoStream = parsed.streams?.find((s: any) => s.codec_type === 'video');
          if (!videoStream) return resolve({ valid: false });
          const res = {
            valid: true,
            duration: Math.round(Number(videoStream.duration || 0)),
            width: Number(videoStream.width || 0),
            height: Number(videoStream.height || 0),
          };
          if (knownSha256) {
            shaProbeCache.set(knownSha256, res);
          }
          resolve(res);
        } catch {
          resolve({ valid: false });
        }
      });
      probe.on('error', () => resolve({ valid: false }));
    } catch {
      resolve({ valid: false });
    }
  });
}

export async function resolveDirectMp4Candidate(
  url: string,
  signal?: AbortSignal
): Promise<string | null> {
  const resolved = await resolveBestVideoDownloadUrl(url, signal);
  if (/\.mp4(?:[?#]|$)/i.test(resolved)) {
    return resolved;
  }
  return null;
}

export function isHtmlContent(contentType?: string | null, bufferChunk?: Buffer): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
      return true;
    }
  }

  if (bufferChunk && bufferChunk.length > 0) {
    const snippet = bufferChunk.slice(0, 512).toString('utf-8').trim().toLowerCase();
    if (
      snippet.startsWith('<!doctype html') ||
      snippet.startsWith('<html') ||
      snippet.startsWith('<?xml') ||
      snippet.includes('<head>') ||
      snippet.includes('<body>')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Streams an HTTP response body directly to a temporary file on disk using stream.pipeline,
 * enforcing maxBytes while streaming and computing SHA-256 without buffering the file in memory.
 */
async function streamResponseToTempFile(
  webBody: ReadableStream<Uint8Array>,
  tempFilePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ bytesWritten: number; sha256: string; headBytes: Buffer }> {
  const hash = crypto.createHash('sha256');
  const headChunks: Buffer[] = [];
  let headBytesCollected = 0;
  let bytesWritten = 0;

  const byteCapAndHashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        callback(new Error(`BYTE_CAP_EXCEEDED:${bytesWritten}`));
        return;
      }
      hash.update(chunk);
      if (headBytesCollected < 512) {
        const slice = chunk.subarray(0, 512 - headBytesCollected);
        headChunks.push(Buffer.from(slice));
        headBytesCollected += slice.length;
      }
      callback(null, chunk);
    },
  });

  const writeStream = fs.createWriteStream(tempFilePath);
  await pipeline(
    Readable.fromWeb(webBody as any),
    byteCapAndHashTransform,
    writeStream,
    signal ? { signal } : undefined
  );

  return {
    bytesWritten,
    sha256: hash.digest('hex'),
    headBytes: Buffer.concat(headChunks),
  };
}

/**
 * Downloads an HLS (.m3u8) stream via ffmpeg using the 2-slot semaphore, -reconnect flags,
 * realistic -user_agent, and -c copy (never re-encoding), writing to a temp file and renaming atomically.
 */
async function downloadHlsWithFfmpeg(
  hlsUrl: string,
  finalFilePath: string,
  maxBytes: number,
  timeoutMs = 35_000,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string }> {
  await acquireFfmpegSlot();
  const tempFilePath = `${finalFilePath}.tmp.${crypto.randomBytes(4).toString('hex')}.mp4`;

  try {
    return await new Promise<{ success: boolean; error?: string }>((resolve) => {
      try {
        const proc = spawn(
          'ffmpeg',
          [
            '-y',
            '-v',
            'error',
            '-reconnect',
            '1',
            '-reconnect_streamed',
            '1',
            '-user_agent',
            AMAZON_CHROME_USER_AGENT,
            '-timeout',
            '10000000',
            '-i',
            hlsUrl,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-c',
            'copy',
            '-bsf:a',
            'aac_adtstoasc',
            '-movflags',
            '+faststart',
            '-fs',
            String(maxBytes),
            tempFilePath,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );

        const cleanupTemp = () => {
          try {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          } catch {}
        };

        const onAbort = () => {
          try {
            proc.kill('SIGKILL');
          } catch {}
          cleanupTemp();
          resolve({ success: false, error: 'تم إلغاء عملية التنزيل.' });
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
          timeoutTimer = null;
          try {
            proc.kill('SIGKILL');
          } catch {}
          cleanupTemp();
          resolve({ success: false, error: 'تجاوزت مهلة معالجة وتنزيل بث HLS.' });
        }, timeoutMs);

        proc.on('close', (code) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (code === 0 && fs.existsSync(tempFilePath)) {
            try {
              fs.renameSync(tempFilePath, finalFilePath);
              resolve({ success: true });
            } catch (renameErr) {
              cleanupTemp();
              resolve({
                success: false,
                error: `تعذر نقل ملف الفيديو المكتمل: ${(renameErr as Error).message}`,
              });
            }
          } else {
            cleanupTemp();
            resolve({
              success: false,
              error: `تعذر معالجة بث HLS بواسطة ffmpeg (رمز الخروج ${code}).`,
            });
          }
        });

        proc.on('error', (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          cleanupTemp();
          resolve({
            success: false,
            error: `خطأ أثناء تشغيل ffmpeg: ${err.message}`,
          });
        });
      } catch (e) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
        resolve({
          success: false,
          error: `تعذر تشغيل ffmpeg: ${(e as Error).message}`,
        });
      }
    });
  } finally {
    releaseFfmpegSlot();
  }
}

/**
 * Safely downloads media file with verified cache reuse, priority promotion, in-flight deduplication,
 * streaming-to-disk byte cap enforcement, atomic rename, and HLS ffmpeg semaphore handling.
 */
export async function downloadMedia(
  url: string,
  assetId: string,
  mediaType: 'video' | 'photo' = 'video',
  maxBytes = 60 * 1024 * 1024,
  signal?: AbortSignal,
  reuseCachedPath = false,
  priority: 'high' | 'normal' = 'normal'
): Promise<DownloadResult> {
  const tStart = Date.now();
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  // 1. SSRF Guard
  const safetyCheck = isSafeExternalUrl(url);
  if (!safetyCheck.safe) {
    return {
      status: 'download_failed',
      error: `فشل التحميل بسبب قيود الأمان: ${safetyCheck.reason}`,
    };
  }

  const trimmedUrl = url.trim();
  const urlKey = `${mediaType}:${trimmedUrl}`;
  const urlHash8 = crypto.createHash('sha256').update(urlKey).digest('hex').slice(0, 8);

  // If priority === 'high' and item was waiting in prewarmQueue, remove it from queue since we are running it now
  if (priority === 'high' && prewarmQueuedKeys.has(urlKey)) {
    prewarmQueuedKeys.delete(urlKey);
    const qIdx = prewarmQueue.findIndex((t) => `${t.mediaType}:${t.url}` === urlKey);
    if (qIdx >= 0) prewarmQueue.splice(qIdx, 1);
  }

  const resolveFromCachedRecord = (cached: CachedMediaRecord): DownloadResult | null => {
    if (!fs.existsSync(cached.localFilePath)) return null;
    try {
      cached.lastAccessedAt = Date.now();
      const durationMs = Date.now() - tStart;
      if (reuseCachedPath) {
        console.log(
          `[Downloader] path="cache hit" durationMs=${durationMs} sizeBytes=${cached.fileSizeBytes} url=${trimmedUrl.slice(0, 90)}`
        );
        return {
          status: 'verified_available',
          localFilePath: cached.localFilePath,
          sha256: cached.sha256,
          fileSizeBytes: cached.fileSizeBytes,
          durationSeconds: cached.durationSeconds,
          width: cached.width,
          height: cached.height,
          fromCache: true,
          downloadPathUsed: 'cache hit',
          durationMs,
        };
      }
      const ext = path.extname(cached.localFilePath) || (mediaType === 'video' ? '.mp4' : '.jpg');
      const targetFilePath = path.join(DOWNLOADS_DIR, `${assetId}_${urlHash8}_verified${ext}`);
      if (path.resolve(cached.localFilePath) !== path.resolve(targetFilePath)) {
        fs.copyFileSync(cached.localFilePath, targetFilePath);
      }
      console.log(
        `[Downloader] path="cache hit" durationMs=${durationMs} sizeBytes=${cached.fileSizeBytes} url=${trimmedUrl.slice(0, 90)}`
      );
      return {
        status: 'verified_available',
        localFilePath: targetFilePath,
        sha256: cached.sha256,
        fileSizeBytes: cached.fileSizeBytes,
        durationSeconds: cached.durationSeconds,
        width: cached.width,
        height: cached.height,
        fromCache: true,
        downloadPathUsed: 'cache hit',
        durationMs,
      };
    } catch {
      return null;
    }
  };

  // 2. Check Verified Media Cache
  const cached = urlMediaCache.get(urlKey);
  if (cached) {
    const hit = resolveFromCachedRecord(cached);
    if (hit) return hit;
  }

  // 2A. Join existing in-flight download for the same URL
  const existingInflight = inflightDownloads.get(urlKey);
  if (existingInflight) {
    try {
      const inflightRes = await existingInflight;
      const freshCached = urlMediaCache.get(urlKey);
      if (freshCached) {
        const hit = resolveFromCachedRecord(freshCached);
        if (hit) return hit;
      }
      return inflightRes;
    } catch {
      // fall through to fresh download
    }
  }

  const executePromise = executeDownloadMediaInternal(
    trimmedUrl,
    assetId,
    mediaType,
    maxBytes,
    urlKey,
    urlHash8,
    tStart,
    signal
  );
  inflightDownloads.set(urlKey, executePromise);
  try {
    return await executePromise;
  } finally {
    if (inflightDownloads.get(urlKey) === executePromise) {
      inflightDownloads.delete(urlKey);
    }
  }
}

async function computeFileSha256Stream(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function executeDownloadMediaInternal(
  url: string,
  assetId: string,
  mediaType: 'video' | 'photo',
  maxBytes: number,
  urlKey: string,
  urlHash8: string,
  tStart: number,
  signal?: AbortSignal
): Promise<DownloadResult> {
  // Resolve best download URL if this is an Amazon VSE HLS URL that hasn't been resolved yet
  let effectiveUrl = url;
  if (mediaType === 'video' && isLikelyHlsUrl(url) && url.includes('vse-vms-transcoding-artifact')) {
    try {
      effectiveUrl = await resolveBestVideoDownloadUrl(url, signal);
    } catch {
      effectiveUrl = url;
    }
  }

  const isHls = isLikelyHlsUrl(effectiveUrl);

  // 3. HLS (.m3u8) stream download via ffmpeg semaphore
  if (isHls) {
    if (mediaType !== 'video') {
      return {
        status: 'source_only',
        error: 'الرابط لبث فيديو HLS وليس ملف صورة.',
      };
    }
    if (!isFfmpegAvailable()) {
      return {
        status: 'source_only',
        error: 'بث الفيديو بصيغة HLS ويتطلب ffmpeg على الخادم لتحويله (متاح للمشاهدة على المصدر فقط).',
      };
    }

    const targetFileName = `${assetId}_${urlHash8}_verified.mp4`;
    const targetFilePath = path.join(DOWNLOADS_DIR, targetFileName);

    try {
      const ffmpegRes = await downloadHlsWithFfmpeg(
        effectiveUrl,
        targetFilePath,
        maxBytes,
        35_000,
        signal
      );

      if (ffmpegRes.success && fs.existsSync(targetFilePath)) {
        const stats = fs.statSync(targetFilePath);
        if (stats.size > 1024) {
          const sha = await computeFileSha256Stream(targetFilePath);
          const probe = await verifyWithFfprobe(targetFilePath, sha);
          if (probe.valid) {
            const now = Date.now();
            const durationMs = now - tStart;
            const record: CachedMediaRecord = {
              urlKey,
              mediaType: 'video',
              localFilePath: targetFilePath,
              sha256: sha,
              fileSizeBytes: stats.size,
              durationSeconds: probe.duration,
              width: probe.width,
              height: probe.height,
              verifiedAt: now,
              lastAccessedAt: now,
            };
            urlMediaCache.set(urlKey, record);
            saveMediaCache();
            cleanupDownloadsCache(false);

            console.log(
              `[Downloader] path="ffmpeg HLS" durationMs=${durationMs} sizeBytes=${stats.size} url=${effectiveUrl.slice(0, 90)}`
            );

            return {
              status: 'verified_available',
              localFilePath: targetFilePath,
              sha256: sha,
              fileSizeBytes: stats.size,
              durationSeconds: probe.duration,
              width: probe.width,
              height: probe.height,
              downloadPathUsed: 'ffmpeg HLS',
              durationMs,
            };
          } else {
            try {
              fs.unlinkSync(targetFilePath);
            } catch {}
            return {
              status: 'source_only',
              error: 'الملف الناتج لم يجتز فحص ffprobe لصلاحية البث المرئي.',
            };
          }
        }
      }

      return {
        status: 'source_only',
        error:
          ffmpegRes.error ||
          'تعذر سحب مقاطع بث HLS مباشرة؛ الفيديو متاح للمشاهدة عبر الرابط الأصلي.',
      };
    } catch (err) {
      return {
        status: 'source_only',
        error: `تعذر معالجة بث HLS: ${(err as Error).message}`,
      };
    }
  }

  // 4. Direct MP4 / Image HTTP(S) stream straight to disk using stream.pipeline
  let currentUrl = effectiveUrl;
  let redirectCount = 0;
  const maxRedirects = 3;

  while (redirectCount <= maxRedirects) {
    const urlCheck = isSafeExternalUrl(currentUrl);
    if (!urlCheck.safe) {
      return {
        status: 'download_failed',
        error: `تحويل الرابط إلى وجهة غير آمنة (${urlCheck.reason})`,
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);
    const onExtAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        return { status: 'download_failed', error: 'تم إلغاء التنزيل' };
      }
      signal.addEventListener('abort', onExtAbort, { once: true });
    }

    const tempFilePath = path.join(
      DOWNLOADS_DIR,
      `temp_stream_${assetId}_${urlHash8}_${crypto.randomBytes(4).toString('hex')}.tmp`
    );

    try {
      const response = await undiciFetch(currentUrl, {
        signal: controller.signal,
        dispatcher: amazonUndiciAgent,
        headers: {
          'User-Agent': AMAZON_CHROME_USER_AGENT,
          Accept:
            mediaType === 'video'
              ? 'video/*,application/octet-stream,*/*'
              : 'image/*,*/*',
        },
        redirect: 'manual',
      });

      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        const location = response.headers.get('location');
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExtAbort);
        if (!location) {
          return { status: 'download_failed', error: 'فشل التحويل: مسار التوجيه غير موجود' };
        }
        currentUrl = new URL(location, currentUrl).href;
        redirectCount++;
        continue;
      }

      if (!response.ok) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExtAbort);
        return {
          status: 'source_only',
          error: `استجاب الخادم برمز خطأ (${response.status})؛ الرابط متاح للمشاهدة على المصدر.`,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      if (isHtmlContent(contentType)) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExtAbort);
        return {
          status: 'source_only',
          isHtmlPage: true,
          error:
            'الرابط يؤدي إلى صفحة ويب وليس إلى ملف ميديا مباشر (متاح للمشاهدة على المصدر الأصلي).',
        };
      }

      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > maxBytes) {
        controller.abort();
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExtAbort);
        return { status: 'source_only', error: 'حجم الملف يتجاوز 60 ميجابايت.' };
      }

      if (!response.body) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExtAbort);
        return { status: 'source_only', error: 'ملف فارغ' };
      }

      // Stream directly to disk with byte cap enforcement (never buffering whole file in memory)
      const { bytesWritten, sha256, headBytes } = await streamResponseToTempFile(
        response.body as any,
        tempFilePath,
        maxBytes,
        controller.signal
      );

      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onExtAbort);

      if (isHtmlContent(contentType, headBytes)) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
        return {
          status: 'source_only',
          isHtmlPage: true,
          error: 'الرابط لصفحة ويب HTML وليس ملف ميديا مباشر (متاح للمشاهدة على المصدر).',
        };
      }

      const isMp4 = headBytes.length > 16 && headBytes.toString('ascii', 4, 8) === 'ftyp';
      const isJpeg = headBytes[0] === 0xff && headBytes[1] === 0xd8 && headBytes[2] === 0xff;
      const isPng = headBytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isWebp =
        headBytes.toString('ascii', 0, 4) === 'RIFF' &&
        headBytes.toString('ascii', 8, 12) === 'WEBP';

      if (mediaType === 'video' && (!isMp4 || contentType.startsWith('image/'))) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
        return { status: 'source_only', error: 'المصدر ليس فيديو MP4 صالحاً. لم يتم حفظه كفيديو.' };
      }
      if (mediaType === 'photo' && !isJpeg && !isPng && !isWebp) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
        return { status: 'source_only', error: 'المصدر ليس ملف صورة صالحاً.' };
      }

      const ext = mediaType === 'video' ? '.mp4' : isPng ? '.png' : isWebp ? '.webp' : '.jpg';
      const localFileName = `${assetId}_${urlHash8}_verified${ext}`;
      const localFilePath = path.join(DOWNLOADS_DIR, localFileName);

      // Rename atomically when complete
      fs.renameSync(tempFilePath, localFilePath);

      let durationSeconds: number | undefined;
      let width: number | undefined;
      let height: number | undefined;

      if (mediaType === 'video') {
        const probe = await verifyWithFfprobe(localFilePath, sha256);
        if (!probe.valid) {
          try {
            fs.unlinkSync(localFilePath);
          } catch {}
          return {
            status: 'source_only',
            error: 'الملف لا يحتوي على بث فيديو صالح وفق فحص ffprobe.',
          };
        }
        durationSeconds = probe.duration;
        width = probe.width;
        height = probe.height;
      }

      const now = Date.now();
      const durationMs = now - tStart;
      const record: CachedMediaRecord = {
        urlKey,
        mediaType,
        localFilePath,
        sha256,
        fileSizeBytes: bytesWritten,
        durationSeconds,
        width,
        height,
        verifiedAt: now,
        lastAccessedAt: now,
      };
      urlMediaCache.set(urlKey, record);
      saveMediaCache();
      cleanupDownloadsCache(false);

      console.log(
        `[Downloader] path="direct MP4" durationMs=${durationMs} sizeBytes=${bytesWritten} url=${currentUrl.slice(0, 90)}`
      );

      return {
        status: 'verified_available',
        localFilePath,
        sha256,
        fileSizeBytes: bytesWritten,
        durationSeconds,
        width,
        height,
        downloadPathUsed: 'direct MP4',
        durationMs,
      };
    } catch (fetchErr: unknown) {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onExtAbort);
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch {}
      const msg = (fetchErr as Error).message || String(fetchErr);
      if (msg.startsWith('BYTE_CAP_EXCEEDED:')) {
        return {
          status: 'source_only',
          error: 'حجم الملف يتجاوز الحد الأقصى المسموح به (60MB).',
        };
      }
      return {
        status: 'source_only',
        error: `تعذر سحب الملف مباشرة (${msg})؛ يمكنك مشاهدته عبر الرابط الأصلي.`,
      };
    }
  }

  return {
    status: 'download_failed',
    error: 'تم تجاوز عدد عمليات التحويل المسموح بها.',
  };
}
