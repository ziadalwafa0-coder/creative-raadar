import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import {
  DATA_DIR,
  DOWNLOADS_DIR,
  GEMINI_API_KEY,
  IS_PROD,
  assertProductionConfig,
} from './src/server/config.ts';
import { StorageService } from './src/server/storage.ts';
import { ProviderRegistry } from './src/server/connectors/ProviderRegistry.ts';
import { analyzeProductImage, isGeminiConfigured } from './src/server/gemini.ts';
import { streamExportArchive } from './src/server/exporter.ts';
import { isFfmpegAvailable } from './src/server/downloader.ts';
import type { Project, SearchSettings } from './src/types/index.ts';
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
} from './src/server/streamSearch.ts';

dotenv.config();
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
const PORT = Number(process.env.PORT) || 3000;

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
  res.json({ gemini, ffmpeg, amazonReachable });
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

app.get('/api/debug/amazon', requireAuth, (req: Request, res: Response) => {
  handleDebugAmazon(req, res).catch((err) => {
    console.error('[DebugAmazon Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error)?.message || 'Debug Amazon failed' });
    }
  });
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
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Creative Radaar server running on http://0.0.0.0:${PORT}`);
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
