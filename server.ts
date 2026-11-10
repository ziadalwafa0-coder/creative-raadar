import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import {
  DATA_DIR,
  DOWNLOADS_DIR,
  POSTERS_DIR,
  GEMINI_API_KEY,
  IS_PROD,
  assertProductionConfig,
} from './src/server/config.ts';
import { StorageService } from './src/server/storage.ts';
import { ProviderRegistry } from './src/server/connectors/ProviderRegistry.ts';
import {
  analyzeProductImage,
  isGeminiConfigured,
  generateCreativeHookAnalysis,
} from './src/server/gemini.ts';
import { streamExportArchive } from './src/server/exporter.ts';
import { isFfmpegAvailable, downloadMedia } from './src/server/downloader.ts';
import type { Project, SearchSettings, CandidateAsset } from './src/types/index.ts';
import {
  verifyAccessCode,
  getRateLimitKey,
  checkLoginRateLimit,
  recordFailedLoginAttempt,
  resetLoginAttempts,
  issueAuthSession,
  verifyAuthSession,
  revokeAuthSession,
  extractAuthToken,
} from './src/server/auth.ts';
import {
  JobWorker,
  handleStreamSearch,
  handleStreamDownload,
  handlePrepareExportZip,
  handleStreamExportZip,
  handleDebugAmazon,
  handleDebugSearchTrace,
  handleStreamPoster,
  handleVerificationFeedback,
  handleOwnerFeedbackLabel,
} from './src/server/streamSearch.ts';
import {
  updateCachedIdentityCard,
  upsertManualIdentityCard,
  IdentityResolutionFailedError,
  type IdentityCardV2,
} from './src/server/pipeline/identity.ts';
import {
  getDailyGeminiBudgetStatus,
  setSimulatedGeminiBudgetExhausted,
} from './src/server/pipeline/verify.ts';
import {
  getRuntimeSettings,
  updateRuntimeSettings,
} from './src/server/settings.ts';
import { runTikTokProviderSpike } from './src/server/sources/tiktok/index.ts';
import { checkYtDlpVersion } from './src/server/tiktokVideos.ts';
import {
  fetchAmazonHtml,
  isAmazonDeadListing,
  hasAmazonProductMarker,
} from './src/server/amazonHttp.ts';
import {
  markAsinAsDead,
  isAsinMarkedDead,
} from './src/server/amazonVideos.ts';
import { fetch as undiciFetch } from 'undici';

dotenv.config({path:['.env.local','.env'],quiet:true});
assertProductionConfig();

function isDataDirWritable(): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    const probeFile = path.join(DATA_DIR, `.write_probe_${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

export function runStartupChecks(): { gemini: boolean; ffmpeg: boolean; dataDirWritable: boolean } {
  assertProductionConfig();
  const gemini = Boolean(GEMINI_API_KEY && GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  const ffmpeg = isFfmpegAvailable();
  const dataDirWritable = isDataDirWritable();
  console.log(`[Startup] Gemini API key: ${gemini ? 'present' : 'missing'}`);
  console.log(`[Startup] ffmpeg binary: ${ffmpeg ? 'present' : 'missing'}`);
  console.log(`[Startup] Data directory (${DATA_DIR}): ${dataDirWritable ? 'writable' : 'not writable'}`);
  return { gemini, ffmpeg, dataDirWritable };
}

const app = express();

function resolveListenPort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const cliPort = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(cliPort) && cliPort > 0) return cliPort;
  }
  if (process.env.DEFAULT_APP_PORT) {
    const defaultAppPort = Number(process.env.DEFAULT_APP_PORT);
    if (Number.isFinite(defaultAppPort) && defaultAppPort > 0) return defaultAppPort;
  }
  if (process.env.NGINX_PORT && process.env.PORT === process.env.NGINX_PORT) {
    return 3000;
  }
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return 3000;
}

const PORT = resolveListenPort();

app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Global API rate limiter (protects all /api/* routes against abuse)
const globalRateBuckets = new Map<string, { count: number; resetAt: number }>();
const GLOBAL_RATE_WINDOW_MS = 60_000;
const GLOBAL_RATE_MAX_REQUESTS = 300;

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const key = getRateLimitKey(req);
  const now = Date.now();
  let bucket = globalRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + GLOBAL_RATE_WINDOW_MS };
    globalRateBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > GLOBAL_RATE_MAX_REQUESTS) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة بعد قليل.' });
  }
  next();
});

const uploadJsonParser = express.json({ limit: '25mb' });
app.use('/api/stream-search', uploadJsonParser);
app.use('/api/projects', uploadJsonParser);
app.use('/api/gemini', uploadJsonParser);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ephemeral short-lived tickets for SSE / media preview (bound to authenticated ownerId + projectId)
const ephemeralTickets = new Map<string, { ownerId: string; projectId: string; expiresAt: number }>();

function issueProjectTicket(ownerId: string, projectId: string, ttlMs = 10 * 60 * 1000): string {
  const now = Date.now();
  for (const [k, v] of ephemeralTickets.entries()) {
    if (v.expiresAt <= now) ephemeralTickets.delete(k);
  }
  const ticket = crypto.randomBytes(18).toString('hex');
  ephemeralTickets.set(ticket, { ownerId, projectId, expiresAt: now + ttlMs });
  return ticket;
}

function verifyProjectTicket(ticket: string | undefined, projectId: string): string | null {
  if (!ticket || typeof ticket !== 'string') return null;
  const entry = ephemeralTickets.get(ticket);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ephemeralTickets.delete(ticket);
    return null;
  }
  if (entry.projectId !== projectId) return null;
  return entry.ownerId;
}

const storage = StorageService.getInstance();
const worker = JobWorker.getInstance();
const providerRegistry = ProviderRegistry.getInstance();

// -------------------------------------------------------------
// Public Health Endpoint
// -------------------------------------------------------------
app.get('/api/health', async (_req: Request, res: Response) => {
  const gemini = isGeminiConfigured();
  const ffmpeg = isFfmpegAvailable();
  let amazonReachable = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch('https://www.amazon.com/robots.txt', {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    amazonReachable = resp.status >= 200 && resp.status < 500;
  } catch {
    amazonReachable = false;
  }
  res.json({ gemini, ffmpeg, amazonReachable, release: 'import-20261110', commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || null });
});

// -------------------------------------------------------------
// Public Authentication Endpoints (Rate-limited, Server-Side Code Verification)
// -------------------------------------------------------------

app.post('/api/auth/login', (req: Request, res: Response) => {
  const rlKey = getRateLimitKey(req);
  const rlCheck = checkLoginRateLimit(rlKey);
  if (!rlCheck.allowed) {
    res.setHeader('Retry-After', String(rlCheck.retryAfterSeconds || 60));
    return res.status(429).json({
      error: 'تم تجاوز عدد محاولات الدخول المسموح بها. يرجى الانتظار دقيقة ثم المحاولة مرة أخرى.',
    });
  }

  const rawCode = req.body?.code;
  const verification = verifyAccessCode(rawCode);

  if (!verification.valid || !verification.ownerId) {
    recordFailedLoginAttempt(rlKey);
    return res.status(401).json({
      error: 'كود الدخول غير صحيح',
    });
  }

  resetLoginAttempts(rlKey);

  const ttlMs = 12 * 60 * 60 * 1000;
  const { token, expiresAt } = issueAuthSession(verification.ownerId, ttlMs);
  const maxAgeSec = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  const isHttps = IS_PROD || req.secure || req.headers['x-forwarded-proto'] === 'https';
  const sameSiteAndSecure = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';

  res.setHeader(
    'Set-Cookie',
    `cr_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; ${sameSiteAndSecure}; Max-Age=${maxAgeSec}`
  );

  return res.json({
    authenticated: true,
    token,
    expiresAt,
  });
});

app.get('/api/auth/session', (req: Request, res: Response) => {
  const token = extractAuthToken(req);
  const session = verifyAuthSession(token);
  if (!session.valid || !session.ownerId) {
    return res.status(401).json({
      authenticated: false,
      error: 'يرجى تسجيل الدخول أولاً',
    });
  }
  return res.json({
    authenticated: true,
    expiresAt: session.expiresAt,
  });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = extractAuthToken(req);
  if (token) {
    revokeAuthSession(token);
  }
  const isHttps = IS_PROD || req.secure || req.headers['x-forwarded-proto'] === 'https';
  const sameSiteAndSecure = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader(
    'Set-Cookie',
    `cr_auth_token=; Path=/; HttpOnly; ${sameSiteAndSecure}; Max-Age=0`
  );
  return res.json({ authenticated: false });
});

// -------------------------------------------------------------
// Strict Authentication Guard for all /api/* routes
// Never accepts arbitrary X-Session-ID or ?sessionId= query parameters
// -------------------------------------------------------------
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractAuthToken(req);
  const session = verifyAuthSession(token);
  if (session.valid && session.ownerId) {
    (req as any).sessionId = session.ownerId;
    return next();
  }

  // Allow short-lived signed project ticket ONLY on specific project stream/download routes
  const ticket = req.query.ticket as string | undefined;
  const projectId = req.params.id;
  if (ticket && projectId) {
    const ticketOwnerId = verifyProjectTicket(ticket, projectId);
    if (ticketOwnerId) {
      (req as any).sessionId = ticketOwnerId;
      return next();
    }
  }

  return res.status(401).json({
    error: 'يرجى تسجيل الدخول أولاً',
  });
}

// -------------------------------------------------------------
// Protected REST API Routes
// -------------------------------------------------------------

app.get('/api/providers', requireAuth, (req: Request, res: Response) => {
  res.json({
    providers: providerRegistry.getAllCapabilities(),
    geminiConfigured: isGeminiConfigured(),
  });
});

app.get('/api/usage', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  res.json(storage.getUsage(sid));
});

app.get('/api/library', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  res.json({ assets: storage.getLibrary(sid) });
});

app.post('/api/library', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const rawAsset = req.body?.asset as CandidateAsset | undefined;
  if (!rawAsset || !rawAsset.id || !rawAsset.title) {
    return res.status(400).json({ error: 'بيانات الفيديو غير مكتملة للحفظ في Swipe File' });
  }
  const enrichedAsset: CandidateAsset = {
    ...rawAsset,
    swipeVerdict: req.body?.verdict || rawAsset.swipeVerdict || 'winner',
    editorNotes:
      typeof req.body?.editorNotes === 'string' ? req.body.editorNotes : rawAsset.editorNotes,
  };
  const saved = storage.upsertSwipeItem(sid, enrichedAsset);

  // Trigger background archival of the creative file so it remains cached on disk permanently
  const mediaUrl = saved.downloadUrl || saved.mediaUrl;
  if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    downloadMedia(mediaUrl, saved.id, saved.mediaType || 'video').catch(() => {});
  }

  return res.status(201).json({ asset: saved, assets: storage.getLibrary(sid) });
});

app.patch('/api/library/:id', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const assetId = req.params.id;
  const updated = storage.updateSwipeItem(sid, assetId, {
    swipeVerdict: req.body?.swipeVerdict,
    editorNotes: req.body?.editorNotes,
    creativeAnalysis: req.body?.creativeAnalysis,
  });
  if (!updated) {
    return res.status(404).json({ error: 'العنصر غير موجود في مكتبة Swipe File' });
  }
  return res.json({ asset: updated, assets: storage.getLibrary(sid) });
});

app.delete('/api/library/:id', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const ok = storage.removeSwipeItem(sid, req.params.id);
  return res.json({ success: ok, assets: storage.getLibrary(sid) });
});

app.post('/api/gemini/creative-brief', requireAuth, async (req: Request, res: Response) => {
  const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim() : '';
  const assetTitle =
    typeof req.body?.assetTitle === 'string'
      ? req.body.assetTitle.trim()
      : typeof req.body?.videoTitle === 'string'
      ? req.body.videoTitle.trim()
      : '';
  const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim() : 'amazon';
  const reviewerOrChannel =
    typeof req.body?.reviewerOrChannel === 'string' ? req.body.reviewerOrChannel.trim() : undefined;
  const sampleTitles = Array.isArray(req.body?.sampleTitles)
    ? req.body.sampleTitles.map(String)
    : undefined;

  if (!productName && !assetTitle) {
    return res.status(400).json({ error: 'يرجى تحديد اسم المنتج أو عنوان الفيديو لتوليد التحليل الإعلاني' });
  }

  try {
    const analysis = await generateCreativeHookAnalysis({
      productName,
      assetTitle,
      platform,
      reviewerOrChannel,
      sampleTitles,
    });

    if (typeof req.body?.assetId === 'string' && req.body.assetId.trim()) {
      const sid = (req as any).sessionId;
      storage.updateSwipeItem(sid, req.body.assetId.trim(), { creativeAnalysis: analysis });
    }

    return res.json({ analysis });
  } catch (err: unknown) {
    return res.status(500).json({
      error: (err as Error)?.message || 'تعذر توليد تحليل الـ Hooks والملخص الإعلاني',
    });
  }
});

// -------------------------------------------------------------
// Ephemeral Streaming Search & On-Demand Download (Zero Disk Persistence)
// Works seamlessly in all environments including Vercel Serverless
// -------------------------------------------------------------
app.post('/api/stream-search', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  handleStreamSearch(req, res, sid).catch((err) => {
    console.error('[StreamSearch Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal streaming search error' });
    }
  });
});

app.get('/api/stream-search/download', requireAuth, (req: Request, res: Response) => {
  handleStreamDownload(req, res).catch((err) => {
    console.error('[StreamDownload Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal download error' });
    }
  });
});

app.post('/api/stream-search/prepare-zip', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  handlePrepareExportZip(req, res, sid);
});

app.get('/api/stream-search/export-zip', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  handleStreamExportZip(req, res, sid).catch((err) => {
    console.error('[StreamExportZip Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal ZIP export error' });
    }
  });
});

app.post('/api/stream-search/export-zip', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  handleStreamExportZip(req, res, sid).catch((err) => {
    console.error('[StreamExportZip Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal ZIP export error' });
    }
  });
});

app.get('/api/stream-search/poster', (req: Request, res: Response) => {
  handleStreamPoster(req, res);
});

app.get('/api/posters/:filename', (req: Request, res: Response) => {
  const filename = path.basename(String(req.params.filename || '').trim());
  if (!filename || !/^[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return res.status(404).json({ error: 'Keyframe image not found' });
  }
  const filePath = path.join(POSTERS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Keyframe image not found' });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(path.resolve(filePath));
});

app.get('/api/debug/search', (req: Request, res: Response) => {
  handleDebugSearchTrace(req, res);
});

app.post('/api/feedback', requireAuth, (req: Request, res: Response) => {
  handleVerificationFeedback(req, res).catch((err) => {
    console.error('[VerificationFeedback Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error)?.message || 'Feedback failed' });
    }
  });
});

app.post('/api/feedback/owner-label', requireAuth, (req: Request, res: Response) => {
  handleOwnerFeedbackLabel(req, res).catch((err) => {
    console.error('[OwnerFeedbackLabel Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error)?.message || 'Owner feedback failed' });
    }
  });
});

app.get('/api/debug/amazon', requireAuth, (req: Request, res: Response) => {
  handleDebugAmazon(req, res).catch((err) => {
    console.error('[DebugAmazon Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error)?.message || 'Debug Amazon failed' });
    }
  });
});

app.get('/api/gemini/budget', requireAuth, (_req: Request, res: Response) => {
  res.json(getDailyGeminiBudgetStatus());
});

app.post('/api/gemini/budget-simulate', requireAuth, (req: Request, res: Response) => {
  const exhausted = Boolean(req.body?.exhausted);
  setSimulatedGeminiBudgetExhausted(exhausted);
  res.json(getDailyGeminiBudgetStatus());
});

app.post('/api/gemini/identify-image', requireAuth, async (req: Request, res: Response) => {
  const rawImage = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  const productHint = typeof req.body?.productName === 'string' ? req.body.productName.trim() : undefined;
  const productUrl = typeof req.body?.productUrl === 'string' ? req.body.productUrl.trim() : undefined;
  const simulateFailure = Boolean(req.body?.simulateFailure);

  if (!rawImage) {
    return res.status(400).json({ error: 'يرجى إرفاق صورة المنتج أولاً' });
  }
  if (!isGeminiConfigured() || simulateFailure) {
    const failErr = new IdentityResolutionFailedError(
      simulateFailure ? 'Simulated identity failure' : 'GEMINI_API_KEY not configured',
      3
    );
    return res.status(422).json({
      code: failErr.code,
      requiresManualIdentity: true,
      error: !isGeminiConfigured() ? 'تحليل الصور غير مُعدّ محليًا. أضف GEMINI_API_KEY إلى .env.local أو أدخل هوية المنتج يدويًا.' : failErr.arabicMessage,
    });
  }

  try {
    let mime = 'image/jpeg';
    const m = rawImage.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i);
    if (m) mime = m[1];
    const base64Clean = rawImage.replace(/^data:[^;]+;base64,/, '');
    const profile = await analyzeProductImage(base64Clean, mime, undefined, productUrl, productHint);
    if (
      !profile.identityCardV2 ||
      !profile.identityCardV2.mustMatch?.length ||
      !profile.identityCardV2.mustNotBe?.length
    ) {
      const failErr = new IdentityResolutionFailedError('Empty mustMatch or mustNotBe', 3);
      return res.status(422).json({
        code: failErr.code,
        requiresManualIdentity: true,
        error: !isGeminiConfigured() ? 'تحليل الصور غير مُعدّ محليًا. أضف GEMINI_API_KEY إلى .env.local أو أدخل هوية المنتج يدويًا.' : failErr.arabicMessage,
      });
    }
    return res.json({
      profile,
      identityCard: profile.identityCardV2,
      commercialNameEn: profile.suggestedNameEn,
      commercialNameAr: profile.suggestedNameAr,
      amazonQueries: [
        profile.suggestedNameEn,
        ...(profile.multilingualQueries?.en || []),
      ].filter(Boolean),
    });
  } catch (err: unknown) {
    console.error('[GeminiIdentifyImage Error]', err);
    const arabicMessage =
      err instanceof IdentityResolutionFailedError
        ? err.arabicMessage
        : 'تعذر استخراج بطاقة الهوية البصرية للمنتج (mustMatch / mustNotBe) بعد 3 محاولات. يرجى تعبئة نموذج الهوية اليدوي للمتابعة.';
    return res.status(422).json({
      code: 'IDENTITY_RESOLUTION_FAILED',
      requiresManualIdentity: true,
      error: arabicMessage,
    });
  }
});

app.post('/api/gemini/identity-manual', requireAuth, (req: Request, res: Response) => {
  const nameEn = typeof req.body?.nameEn === 'string' ? req.body.nameEn.trim() : '';
  const nameAr = typeof req.body?.nameAr === 'string' ? req.body.nameAr.trim() : nameEn;
  const mustMatch = Array.isArray(req.body?.mustMatch)
    ? req.body.mustMatch.map((x: unknown) => String(x || '').trim()).filter(Boolean)
    : [];
  const mustNotBe = Array.isArray(req.body?.mustNotBe)
    ? req.body.mustNotBe.map((x: unknown) => String(x || '').trim()).filter(Boolean)
    : [];

  if (!nameEn || mustMatch.length === 0 || mustNotBe.length === 0) {
    return res.status(400).json({
      error: 'يرجى إدخال الاسم الإنجليزي للمنتج وسمة إلزامية واحدة على الأقل (mustMatch) ومستبعد واحد على الأقل (mustNotBe).',
    });
  }

  const card = upsertManualIdentityCard({
    imageHash: typeof req.body?.imageHash === 'string' ? req.body.imageHash.trim() : undefined,
    nameEn,
    nameAr,
    formFactorShape: typeof req.body?.formFactorShape === 'string' ? req.body.formFactorShape.trim() : undefined,
    mechanismHowItWorks:
      typeof req.body?.mechanismHowItWorks === 'string' ? req.body.mechanismHowItWorks.trim() : undefined,
    mustMatch,
    mustNotBe,
    discriminators: Array.isArray(req.body?.discriminators) ? req.body.discriminators : undefined,
  });

  return res.json({
    identityCard: card,
    commercialNameEn: card.nameEn,
    commercialNameAr: card.nameAr,
    amazonQueries: card.queries.amazonEn,
  });
});

app.patch('/api/gemini/identity', requireAuth, (req: Request, res: Response) => {
  const imageHash = typeof req.body?.imageHash === 'string' ? req.body.imageHash.trim() : '';
  if (!imageHash) {
    return res.status(400).json({ error: 'imageHash is required' });
  }
  const attributeStrengths =
    req.body?.attributeStrengths && typeof req.body.attributeStrengths === 'object'
      ? req.body.attributeStrengths
      : undefined;
  if (attributeStrengths) {
    const currentSettings = getRuntimeSettings();
    updateRuntimeSettings({
      attributeStrengthOverrides: {
        ...currentSettings.attributeStrengthOverrides,
        ...attributeStrengths,
      },
    });
  }
  const updated = updateCachedIdentityCard(imageHash, {
    nameEn: typeof req.body?.nameEn === 'string' ? req.body.nameEn.trim() : undefined,
    nameAr: typeof req.body?.nameAr === 'string' ? req.body.nameAr.trim() : undefined,
    mustMatch: Array.isArray(req.body?.mustMatch) ? req.body.mustMatch.map(String) : undefined,
    mustNotBe: Array.isArray(req.body?.mustNotBe) ? req.body.mustNotBe.map(String) : undefined,
    attributeStrengths,
    discriminators: Array.isArray(req.body?.discriminators) ? req.body.discriminators : undefined,
  });
  if (!updated) {
    return res.status(404).json({ error: 'Identity card not found in cache' });
  }
  return res.json({ identityCard: updated });
});

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(getRuntimeSettings());
});

app.put('/api/settings', requireAuth, (req: Request, res: Response) => {
  const updated = updateRuntimeSettings(req.body || {});
  res.json(updated);
});

app.post('/api/debug/tiktok-probe', async (req: Request, res: Response) => {
  try {
    const rawCard = req.body?.identityCard as Partial<IdentityCardV2> | undefined;
    const productName =
      typeof req.body?.productName === 'string' && req.body.productName.trim()
        ? req.body.productName.trim()
        : rawCard?.nameEn || 'Shiatsu Neck and Back Massager Pillow with Heat';
    const directUrls = Array.isArray(req.body?.directUrls)
      ? req.body.directUrls.map(String).filter(Boolean)
      : [];

    const synthCard: IdentityCardV2 = {
      imageHash: rawCard?.imageHash || 'probe',
      nameEn: rawCard?.nameEn || productName,
      nameAr: rawCard?.nameAr || productName,
      category: rawCard?.category || 'General',
      primaryColor: rawCard?.primaryColor || 'Standard',
      formFactor: rawCard?.formFactor || {
        shape: productName,
        approximateSize: 'Standard',
        orientationPlacement: 'Standard',
      },
      mechanism: rawCard?.mechanism || {
        howItWorks: productName,
        powerSource: 'Standard',
        keyComponents: [productName],
      },
      mustMatch: rawCard?.mustMatch || [],
      variableAttributes: rawCard?.variableAttributes || [],
      mustNotBe: rawCard?.mustNotBe || [],
      queries: rawCard?.queries || {
        amazonEn: [productName],
        amazonAr: [productName],
        tiktokEn: [productName],
        tiktokAr: [productName],
        tradeNamesEn: [],
      },
      hashtags: rawCard?.hashtags || [],
      confidence: 0.9,
      ambiguity: [],
      createdAt: new Date().toISOString(),
    };

    const report = await runTikTokProviderSpike(synthCard, directUrls);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'TikTok live probe failed' });
  }
});

interface LinkValidationCacheEntry {
  valid: boolean;
  reason?: string;
  expiresAt: number;
}
const linkValidationCache = new Map<string, LinkValidationCacheEntry>();
const REPORTED_DEAD_LINKS_FILE = path.join(DATA_DIR, 'reported_dead_links.json');

app.post('/api/links/validate', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const asin = typeof req.body?.asin === 'string' ? req.body.asin.trim().toUpperCase() : undefined;
  const type = req.body?.type === 'video' ? 'video' : 'product';

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  // 1. Check if ASIN is marked dead in negative cache
  if (asin) {
    const deadCheck = isAsinMarkedDead(asin);
    if (deadCheck.isDead) {
      return res.json({ valid: false, reason: deadCheck.reason || 'صفحة المنتج غير متاحة (Dead listing)' });
    }
  }

  // 2. Check 24h link cache
  const cached = linkValidationCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ valid: cached.valid, reason: cached.reason, fromCache: true });
  }

  try {
    if (type === 'video') {
      const resp = await undiciFetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      const valid = resp.status >= 200 && resp.status < 400;
      linkValidationCache.set(url, {
        valid,
        reason: valid ? undefined : `HTTP ${resp.status}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      return res.json({ valid, reason: valid ? undefined : `HTTP ${resp.status}` });
    }

    const isAmz = url.includes('amazon.');
    if (isAmz) {
      try {
        const html = await fetchAmazonHtml(url, {
          minHtmlChars: 500,
          timeoutMs: 8000,
        });
        const deadCheck = isAmazonDeadListing(200, html, url);
        if (deadCheck.isDead) {
          if (asin) markAsinAsDead(asin, deadCheck.reason || 'Dead listing 404');
          linkValidationCache.set(url, {
            valid: false,
            reason: deadCheck.reason || 'صفحة المنتج غير متاحة',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          return res.json({ valid: false, reason: deadCheck.reason || 'صفحة المنتج غير متاحة' });
        }
        linkValidationCache.set(url, {
          valid: true,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
        return res.json({ valid: true });
      } catch (err: any) {
        if (err.name === 'AmazonDeadListingError') {
          if (asin) markAsinAsDead(asin, err.reason || 'Dead listing 404');
          linkValidationCache.set(url, {
            valid: false,
            reason: err.reason || 'صفحة المنتج غير متاحة',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          return res.json({ valid: false, reason: err.reason || 'صفحة المنتج غير متاحة' });
        }
        return res.json({ valid: true, unverified: true });
      }
    }

    const resp = await undiciFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const valid = resp.status >= 200 && resp.status < 400;
    linkValidationCache.set(url, {
      valid,
      reason: valid ? undefined : `HTTP ${resp.status}`,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return res.json({ valid, reason: valid ? undefined : `HTTP ${resp.status}` });
  } catch (err) {
    return res.json({ valid: false, reason: (err as Error)?.message || 'Validation error' });
  }
});

app.post('/api/links/report-dead', (req: Request, res: Response) => {
  const asin = typeof req.body?.asin === 'string' ? req.body.asin.trim().toUpperCase() : undefined;
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const searchId = typeof req.body?.searchId === 'string' ? req.body.searchId.trim() : undefined;
  const assetId = typeof req.body?.assetId === 'string' ? req.body.assetId.trim() : undefined;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : 'User reported broken link';

  if (asin) {
    markAsinAsDead(asin, reason);
  }
  if (url) {
    linkValidationCache.set(url, {
      valid: false,
      reason,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }

  try {
    let reports: any[] = [];
    if (fs.existsSync(REPORTED_DEAD_LINKS_FILE)) {
      reports = JSON.parse(fs.readFileSync(REPORTED_DEAD_LINKS_FILE, 'utf-8'));
    }
    reports.push({
      asin,
      url,
      searchId,
      assetId,
      reason,
      reportedAt: new Date().toISOString(),
    });
    fs.writeFileSync(REPORTED_DEAD_LINKS_FILE, JSON.stringify(reports.slice(-500), null, 2), 'utf-8');
  } catch (err) {
    console.warn('[ReportDeadLink] Error saving report:', (err as Error)?.message);
  }

  return res.json({ success: true, pruned: true, asin, url });
});

app.get('/api/projects', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  res.json({ projects: storage.getProjects(sid) });
});

app.post('/api/projects', requireAuth, (req: Request, res: Response) => {
  if (process.env.VERCEL) {
    return res.status(503).json({
      code: 'CLOUD_PROJECT_STORAGE_REQUIRED',
      error: 'تم إصلاح تسجيل الدخول. حفظ المشاريع وتشغيل البحث على السحابة يحتاجان استكمال إعداد التخزين الدائم أولًا.',
    });
  }

  const {
    name,
    referenceImages,
    imagePath,
    productUrl,
    mediaTypeRequested,
    targetVideoCount,
    targetPhotoCount,
    userNotes,
    productListingUrl,
    settings,
  } = req.body;

  const defaultSettings: SearchSettings = {
    strictness: 'color_allowed',
    contentSources: 'customer_only',
    sourcePriority: ['amazon', 'youtube'],
    preferredMarketplaces: ['US', 'EG', 'UAE', 'SA'],
    preferredLanguages: ['ar', 'en'],
    excludeWorkspaceProjects: true,
    minDurationSeconds: 15,
    preserveAudio: true,
    maxSearchDepth: 5,
    maxProcessingTimeSeconds: 120,
    estimatedBudgetUsd: 0.15,
  };

  const sid = (req as any).sessionId;
  const validMediaType =
    mediaTypeRequested === 'photo' || mediaTypeRequested === 'both' ? mediaTypeRequested : 'video';
  const clampedVideoCount = Math.min(500, Math.max(1, Number(targetVideoCount) || 10));
  const clampedPhotoCount = Math.min(500, Math.max(1, Number(targetPhotoCount) || 10));
  const effectiveVideoTarget = validMediaType === 'photo' ? 0 : clampedVideoCount;
  const effectivePhotoTarget = validMediaType === 'video' ? 0 : clampedPhotoCount;
  const totalTarget = effectiveVideoTarget + effectivePhotoTarget;

  const resolvedImages =
    Array.isArray(referenceImages) && referenceImages.length > 0
      ? referenceImages
      : imagePath
      ? [{ id: `img-${Date.now()}`, url: imagePath, isPrimary: true, label: 'صورة المنتج' }]
      : [];

  const newProject: Project = {
    id: `proj-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    sessionId: sid,
    name: name || 'مشروع بحث جديد',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    referenceImages: resolvedImages,
    mediaTypeRequested: validMediaType,
    targetVideoCount: effectiveVideoTarget,
    targetPhotoCount: effectivePhotoTarget,
    userNotes,
    productListingUrl: productListingUrl || productUrl || undefined,
    settings: { ...defaultSettings, ...(settings || {}) },
    jobState: 'idle',
    counters: {
      candidatesDiscovered: 0,
      sourcesInspected: 0,
      visuallyMatchedAssets: 0,
      downloadedAssets: 0,
      verifiedAssets: 0,
      rejectedDuplicates: 0,
      targetCount: totalTarget,
    },
    logs: [
      {
        timestamp: new Date().toISOString(),
        stage: 'idle',
        message: 'تم إنشاء المشروع بنجاح وهو جاهز للبدء.',
        level: 'info',
      },
    ],
    candidates: [],
  };

  storage.upsertProject(newProject);
  res.status(201).json(newProject);
});

app.get('/api/projects/:id', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود أو لا تملك صلاحية الوصول إليه' });
  }
  res.json(project);
});

app.patch('/api/projects/:id', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود أو لا تملك صلاحية الوصول إليه' });
  }

  if (req.body.productProfile) {
    project.productProfile = req.body.productProfile;
  }
  if (req.body.name) {
    project.name = req.body.name;
  }
  if (req.body.settings) {
    project.settings = { ...project.settings, ...req.body.settings };
  }
  if (req.body.candidates) {
    project.candidates = req.body.candidates;
  }
  if (req.body.targetVideoCount !== undefined) {
    project.targetVideoCount = Math.min(500, Math.max(1, Number(req.body.targetVideoCount) || 10));
  }
  if (req.body.targetPhotoCount !== undefined) {
    project.targetPhotoCount = Math.min(500, Math.max(1, Number(req.body.targetPhotoCount) || 10));
  }

  storage.upsertProject(project);
  res.json(project);
});

app.delete('/api/projects/:id', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const ok = storage.deleteProject(req.params.id, sid);
  if (!ok) {
    return res.status(404).json({ error: 'المشروع غير موجود أو لا تملك صلاحية حذفه' });
  }
  res.json({ success: true });
});

app.post('/api/projects/:id/analyze', requireAuth, async (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  const refImg = project.referenceImages[0];
  if (!refImg?.base64Data) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  try {
    const profile = await analyzeProductImage(
      refImg.base64Data,
      refImg.mimeType,
      project.userNotes,
      project.productListingUrl
    );
    project.productProfile = profile;
    project.logs.push({
      timestamp: new Date().toISOString(),
      stage: 'analyzing',
      message: `تم تحليل المنتج: "${profile.suggestedNameAr}"`,
      level: 'success',
    });
    storage.upsertProject(project);
    res.json({ productProfile: profile });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/search', requireAuth, async (req: Request, res: Response) => {
  if (process.env.VERCEL) {
    return res.status(503).json({
      code: 'CLOUD_PROJECT_STORAGE_REQUIRED',
      error: 'تم إصلاح تسجيل الدخول. حفظ المشاريع وتشغيل البحث على السحابة يحتاجان استكمال إعداد التخزين الدائم أولًا.',
    });
  }

  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  if (req.body?.targetVideoCount !== undefined) {
    project.targetVideoCount = Math.min(500, Math.max(1, Number(req.body.targetVideoCount) || 10));
    storage.upsertProject(project);
  }
  if (req.body?.targetPhotoCount !== undefined) {
    project.targetPhotoCount = Math.min(500, Math.max(1, Number(req.body.targetPhotoCount) || 10));
    storage.upsertProject(project);
  }

  worker.runProjectSearch(project.id).catch((err) => {
    console.error(`[Worker Job Error for ${project.id}]`, err);
  });

  res.json({ message: 'Search job queued', projectId: project.id });
});

app.post('/api/projects/:id/cancel', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }
  worker.cancelJob(req.params.id);
  res.json({ message: 'Cancellation signal sent' });
});

app.post('/api/projects/:id/ticket', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }
  const ticket = issueProjectTicket(sid, project.id);
  res.json({ ticket, expiresInSeconds: 600 });
});

app.get('/api/events/:id', requireAuth, (req: Request, res: Response) => {
  const projectId = req.params.id;
  const sid = (req as any).sessionId;
  const initialProject = storage.getProject(projectId, sid);
  if (!initialProject) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  worker.registerSseClient(projectId, res);
  res.write(`data: ${JSON.stringify({ project: initialProject })}\n\n`);
});

app.post('/api/projects/:id/manual-links', requireAuth, async (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  const { sourceUrl, directMediaUrl, title, reviewerOrChannel, provenance, mediaType } = req.body;
  if (!sourceUrl) {
    return res.status(400).json({ error: 'يرجى إدخال رابط المصدر' });
  }

  try {
    const asset = await worker.addManualLink(req.params.id, {
      sourceUrl,
      directMediaUrl,
      title,
      reviewerOrChannel,
      provenance,
      mediaType,
    });
    res.status(201).json({ success: true, asset });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/projects/:id/assets/:assetId/retry', requireAuth, async (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) return res.status(404).json({ error: 'المشروع غير موجود' });

  const asset = project.candidates.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'العنصر غير موجود' });

  const targetUrl = asset.mediaUrl;
  if (!targetUrl) return res.status(400).json({ error: 'أضف رابط ملف الميديا المباشر أولاً' });
  const { downloadMedia } = await import('./src/server/downloader.ts');
  const result = await downloadMedia(targetUrl, asset.id, asset.mediaType);

  asset.downloadStatus = result.status;
  asset.localFilePath = result.localFilePath;
  asset.sha256 = result.sha256 || asset.sha256;
  asset.fileSizeBytes = result.fileSizeBytes || asset.fileSizeBytes;
  asset.downloadError = result.error;
  if (result.durationSeconds) asset.durationSeconds = result.durationSeconds;
  if (result.width && result.height) asset.dimensions = { width: result.width, height: result.height };

  const verifiedCount = project.candidates.filter((c) => c.downloadStatus === 'verified_available').length;
  project.counters.downloadedAssets = verifiedCount;
  project.counters.verifiedAssets = verifiedCount;

  storage.upsertProject(project);
  worker.broadcast(project.id, { project, assetUpdated: asset });
  res.json({ success: true, asset });
});

app.get('/api/projects/:id/assets/:assetId/download', requireAuth, async (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) return res.status(404).json({ error: 'المشروع غير موجود' });

  const asset = project.candidates.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'العنصر غير موجود' });

  // If file is not yet downloaded on disk but mediaUrl is available, download & verify on the fly!
  if ((!asset.localFilePath || !fs.existsSync(asset.localFilePath)) && asset.mediaUrl) {
    try {
      const { downloadMedia } = await import('./src/server/downloader.ts');
      const result = await downloadMedia(asset.mediaUrl, asset.id, asset.mediaType);
      if (result.status === 'verified_available' && result.localFilePath) {
        asset.downloadStatus = 'verified_available';
        asset.localFilePath = result.localFilePath;
        asset.sha256 = result.sha256 || asset.sha256;
        asset.fileSizeBytes = result.fileSizeBytes || asset.fileSizeBytes;
        if (result.durationSeconds) asset.durationSeconds = result.durationSeconds;
        if (result.width && result.height) asset.dimensions = { width: result.width, height: result.height };
        const verifiedCount = project.candidates.filter((c) => c.downloadStatus === 'verified_available').length;
        project.counters.downloadedAssets = verifiedCount;
        project.counters.verifiedAssets = verifiedCount;
        storage.upsertProject(project);
      }
    } catch {}
  }

  if (asset.localFilePath && fs.existsSync(asset.localFilePath)) {
    const ext = path.extname(asset.localFilePath).slice(1).toLowerCase() || (asset.mediaType === 'video' ? 'mp4' : 'jpg');
    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    if (req.query.inline === '1') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${asset.id}_verified.${ext}"`);
      return res.sendFile(path.resolve(asset.localFilePath));
    }

    res.download(asset.localFilePath, `${asset.id}_verified.${ext}`);
  } else {
    res.status(404).json({ error: 'ملف الميديا غير متوفر للتحميل المباشر' });
  }
});

app.get('/api/projects/:id/export', requireAuth, async (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  const exportType = req.query.type as string;
  let assetsToExport = project.candidates;

  if (exportType === 'selected') {
    assetsToExport = project.candidates.filter((a) => a.selectedForExport);
  } else if (exportType === 'verified') {
    assetsToExport = project.candidates.filter((a) => a.downloadStatus === 'verified_available');
  }

  await streamExportArchive(project, assetsToExport, res);
});

// Catch-all for unknown /api/* routes (also protected)
app.all('/api/*', requireAuth, (_req: Request, res: Response) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

async function startServer() {
  runStartupChecks();
  const distPath = path.resolve(process.cwd(), 'dist');
  const hasBuiltDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isDevContainer = Boolean(
    process.env.CONTROL_PLANE_PORT ||
    process.env.DEFAULT_APP_PORT ||
    process.argv.includes('--port')
  );
  const isProd =
    process.env.NODE_ENV === 'production' || (!isDevContainer && hasBuiltDist);

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Creative Radaar server running on http://0.0.0.0:${PORT} (mode=${isProd ? 'production' : 'development'})`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && PORT !== 3000) {
      console.warn(`[Server] Port ${PORT} is in use, falling back to port 3000...`);
      app.listen(3000, '0.0.0.0', () => {
        console.log(`Creative Radaar server running on http://0.0.0.0:3000 (fallback)`);
      });
    } else {
      console.error('[Server] Fatal listen error:', err);
    }
  });
}

export default app;

const isTestRunner =
  process.env.NODE_ENV === 'test' ||
  process.env.NODE_TEST_CONTEXT !== undefined ||
  process.argv.some((arg) => arg === '--test' || arg.endsWith('.test.ts'));

if (!process.env.VERCEL && !isTestRunner) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
  });
}
