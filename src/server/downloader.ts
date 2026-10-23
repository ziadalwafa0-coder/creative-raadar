import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { isSafeExternalUrl } from '../utils/security.ts';
import { DownloadStatus } from '../types/index.ts';

const DOWNLOADS_DIR = path.join(path.resolve(process.env.CREATIVE_RADAAR_DATA_DIR || path.join(process.cwd(), '.data')), 'downloads');
const CACHE_INDEX_FILE = path.join(DOWNLOADS_DIR, 'verified_media_cache.json');

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
}

const urlMediaCache = new Map<string, CachedMediaRecord>();
const shaProbeCache = new Map<
  string,
  { valid: boolean; duration?: number; width?: number; height?: number }
>();

function loadMediaCache(): void {
  try {
    if (fs.existsSync(CACHE_INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_INDEX_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.urlKey && item.localFilePath && fs.existsSync(item.localFilePath)) {
            urlMediaCache.set(item.urlKey, item);
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
  } catch {
    // ignore cache load errors
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
  } catch {
    // ignore cache write errors
  }
}

loadMediaCache();

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

/**
 * Validates that an MP4 or media file contains valid video/audio streams using ffprobe.
 * Uses SHA-256 memoization so the same binary is never re-probed repeatedly.
 */
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

function downloadHlsWithFfmpeg(
  url: string,
  targetFilePath: string,
  maxBytes: number,
  timeoutMs = 30000,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string }> {
  return new Promise(async (resolve) => {
    // 1. Ultra-fast direct MP4 stream download for Amazon VSE videos (bypasses ffmpeg 15s transcoding)
    if (url.includes('vse-vms-transcoding-artifact')) {
      const directMp4Candidates = [
        url.replace(/\/embedded\.cc\.default\.vertical\.jobtemplate\.hls\.m3u8.*$/i, '/default.vertical.jobtemplate.mp4.480.mp4'),
        url.replace(/\/default\.jobtemplate\.hls\.m3u8.*$/i, '/default.jobtemplate.mp4.480.mp4'),
        url.replace(/\.hls\.m3u8.*$/i, '.mp4.480.mp4'),
      ];
      for (const mp4Url of directMp4Candidates) {
        if (mp4Url === url) continue;
        try {
          const timeoutSig = AbortSignal.timeout(12000);
          const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
          const res = await fetch(mp4Url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: combinedSig });
          if (res.ok && res.body) {
            const fileStream = fs.createWriteStream(targetFilePath);
            // @ts-ignore
            const reader = res.body.getReader();
            let bytesWritten = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done || bytesWritten >= maxBytes) break;
              if (value) {
                fileStream.write(value);
                bytesWritten += value.length;
              }
            }
            fileStream.end();
            if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 100000) {
              return resolve({ success: true });
            }
          }
        } catch {
          // fallback to ffmpeg if direct mp4 is missing or aborted
        }
      }
    }

    try {
      const proc = spawn('ffmpeg', [
        '-y',
        '-timeout',
        '12000000',
        '-i',
        url,
        '-c',
        'copy',
        '-bsf:a',
        'aac_adtstoasc',
        '-fs',
        String(maxBytes),
        targetFilePath,
      ]);

      const onAbort = () => {
        try {
          proc.kill('SIGKILL');
        } catch {}
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
        resolve({ success: false, error: 'تجاوزت مهلة معالجة وتنزيل بث HLS.' });
      }, timeoutMs);

      proc.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (code === 0 && fs.existsSync(targetFilePath)) {
          resolve({ success: true });
        } else {
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
        resolve({
          success: false,
          error: `خطأ أثناء تشغيل ffmpeg: ${err.message}`,
        });
      });
    } catch (e) {
      resolve({
        success: false,
        error: `تعذر تشغيل ffmpeg: ${(e as Error).message}`,
      });
    }
  });
}

/**
 * Checks whether content-type or buffer is HTML rather than real video or image binary.
 */
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
}

/**
 * Safely downloads media file with verified cache reuse, timeout, size limit, SSRF guard, redirect validation, and HLS handling.
 */
export async function downloadMedia(
  url: string,
  assetId: string,
  mediaType: 'video' | 'photo' = 'video',
  maxBytes = 60 * 1024 * 1024, // 60 MB limit
  signal?: AbortSignal
): Promise<DownloadResult> {
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

  // 2. Check Verified Media Cache by URL + mediaType
  const urlKey = `${mediaType}:${url.trim()}`;
  const cached = urlMediaCache.get(urlKey);
  if (cached && fs.existsSync(cached.localFilePath)) {
    try {
      const ext = path.extname(cached.localFilePath) || (mediaType === 'video' ? '.mp4' : '.jpg');
      const targetFilePath = path.join(DOWNLOADS_DIR, `${assetId}_verified${ext}`);
      if (path.resolve(cached.localFilePath) !== path.resolve(targetFilePath)) {
        fs.copyFileSync(cached.localFilePath, targetFilePath);
      }
      return {
        status: 'verified_available',
        localFilePath: targetFilePath,
        sha256: cached.sha256,
        fileSizeBytes: cached.fileSizeBytes,
        durationSeconds: cached.durationSeconds,
        width: cached.width,
        height: cached.height,
        fromCache: true,
      };
    } catch {
      // Fallback to fresh download if copy fails
    }
  }

  const isHls = new URL(url).pathname.endsWith('.m3u8');

  // 3. HLS stream download via async ffmpeg + ffprobe verification
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

    const targetFileName = `${assetId}_verified.mp4`;
    const targetFilePath = path.join(DOWNLOADS_DIR, targetFileName);

    try {
      const ffmpegRes = await downloadHlsWithFfmpeg(url, targetFilePath, maxBytes, 30000, signal);

      if (ffmpegRes.success && fs.existsSync(targetFilePath)) {
        const stats = fs.statSync(targetFilePath);
        if (stats.size > 1024) {
          const fileBuf = await fs.promises.readFile(targetFilePath);
          const sha = crypto.createHash('sha256').update(fileBuf).digest('hex');
          const probe = await verifyWithFfprobe(targetFilePath, sha);
          if (probe.valid) {
            const record: CachedMediaRecord = {
              urlKey,
              mediaType: 'video',
              localFilePath: targetFilePath,
              sha256: sha,
              fileSizeBytes: stats.size,
              durationSeconds: probe.duration,
              width: probe.width,
              height: probe.height,
              verifiedAt: Date.now(),
            };
            urlMediaCache.set(urlKey, record);
            saveMediaCache();

            return {
              status: 'verified_available',
              localFilePath: targetFilePath,
              sha256: sha,
              fileSizeBytes: stats.size,
              durationSeconds: probe.duration,
              width: probe.width,
              height: probe.height,
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

  // 4. Direct HTTP(S) stream download with redirect checking
  let currentUrl = url;
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
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const onExtAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        return { status: 'download_failed', error: 'تم إلغاء التنزيل' };
      }
      signal.addEventListener('abort', onExtAbort, { once: true });
    }

    try {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

      const chunks: Buffer[] = [];
      let received = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('ملف فارغ');
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        received += item.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new Error('حجم الملف يتجاوز 60 ميجابايت');
        }
        chunks.push(Buffer.from(item.value));
      }
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onExtAbort);

      const buffer = Buffer.concat(chunks);

      if (buffer.length > maxBytes) {
        return {
          status: 'source_only',
          error: `حجم الملف (${Math.round(buffer.length / 1024 / 1024)}MB) يتجاوز الحد الأقصى المسموح به (60MB).`,
        };
      }

      if (isHtmlContent(contentType, buffer)) {
        return {
          status: 'source_only',
          isHtmlPage: true,
          error: 'الرابط لصفحة ويب HTML وليس ملف ميديا مباشر (متاح للمشاهدة على المصدر).',
        };
      }

      const isMp4 = buffer.length > 16 && buffer.toString('ascii', 4, 8) === 'ftyp';
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const isPng = buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isWebp =
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP';

      if (mediaType === 'video' && (!isMp4 || contentType.startsWith('image/'))) {
        return { status: 'source_only', error: 'المصدر ليس فيديو MP4 صالحاً. لم يتم حفظه كفيديو.' };
      }
      if (mediaType === 'photo' && !isJpeg && !isPng && !isWebp) {
        return { status: 'source_only', error: 'المصدر ليس ملف صورة صالحاً.' };
      }

      const ext = mediaType === 'video' ? '.mp4' : isPng ? '.png' : isWebp ? '.webp' : '.jpg';
      const localFileName = `${assetId}_verified${ext}`;
      const localFilePath = path.join(DOWNLOADS_DIR, localFileName);

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      await fs.promises.writeFile(localFilePath, buffer);

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

      const record: CachedMediaRecord = {
        urlKey,
        mediaType,
        localFilePath,
        sha256,
        fileSizeBytes: buffer.length,
        durationSeconds,
        width,
        height,
        verifiedAt: Date.now(),
      };
      urlMediaCache.set(urlKey, record);
      saveMediaCache();

      return {
        status: 'verified_available',
        localFilePath,
        sha256,
        fileSizeBytes: buffer.length,
        durationSeconds,
        width,
        height,
      };
    } catch (fetchErr: unknown) {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onExtAbort);
      const msg = (fetchErr as Error).message || String(fetchErr);
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
