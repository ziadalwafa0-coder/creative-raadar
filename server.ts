import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { StorageService } from './src/server/storage.ts';
import { JobWorker } from './src/server/worker.ts';
import { ProviderRegistry } from './src/server/connectors/ProviderRegistry.ts';
import { analyzeProductImage, isGeminiConfigured } from './src/server/gemini.ts';
import { streamExportArchive } from './src/server/exporter.ts';
import { Project, SearchSettings } from './src/types/index.ts';
import { prepareSearchIdentity, productInputFingerprint } from './src/utils/productIdentity.ts';
import {
  verifyAccessCode,
  getRateLimitKey,
  checkSharedLoginLimit,
  recordSharedLoginFailure,
  resetSharedLoginFailures,
  issueAuthSession,
  verifyAuthSession,
  revokeAuthSession,
  extractAuthToken,
} from './src/server/auth.ts';

dotenv.config({quiet:true});

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/auth', (_req,res,next) => {
  res.setHeader('Cache-Control','private, no-store');
  next();
});

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
// Public Authentication Endpoints (Rate-limited, Server-Side Code Verification)
// -------------------------------------------------------------

app.post('/api/auth/login', async (req: Request, res: Response, next: NextFunction) => {
 try {
  const rlKey = getRateLimitKey(req);
  const rlCheck = await checkSharedLoginLimit(rlKey);
  if (!rlCheck.allowed) {
    res.setHeader('Retry-After', String(rlCheck.retryAfterSeconds || 60));
    return res.status(429).json({
      error: 'تم تجاوز عدد محاولات الدخول المسموح بها. يرجى الانتظار دقيقة ثم المحاولة مرة أخرى.',
    });
  }

  const rawCode = req.body?.code;
  const verification = verifyAccessCode(rawCode);

  if (!verification.valid || !verification.ownerId) {
    await recordSharedLoginFailure(rlKey);
    return res.status(401).json({
      error: 'كود الدخول غير صحيح',
    });
  }

  await resetSharedLoginFailures(rlKey);

  // Support optional bounded TTL header for automated expiration tests (capped at 12h)
  const customTtlHeader = Number(req.headers['x-session-ttl-ms']);
  const ttlMs =
    Number.isFinite(customTtlHeader) && customTtlHeader > 50 && customTtlHeader <= 12 * 3600 * 1000
      ? customTtlHeader
      : 12 * 60 * 60 * 1000;

  const { token, expiresAt } = await issueAuthSession(verification.ownerId, ttlMs);
  const maxAgeSec = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));

  res.setHeader(
    'Set-Cookie',
    `cr_auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${process.env.VERCEL ? '; Secure' : ''}`
  );

  return res.json({
    authenticated: true,
    token,
    expiresAt,
  });
 } catch(error) { next(error); }
});

app.get('/api/auth/session', async (req: Request, res: Response, next: NextFunction) => {
 try {
  const token = extractAuthToken(req);
  const session = await verifyAuthSession(token);
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
 } catch(error) {next(error);}
});

app.post('/api/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
 try {
  const token = extractAuthToken(req);
  if (token) {
    await revokeAuthSession(token);
  }
  res.setHeader(
    'Set-Cookie',
    `cr_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`
  );
  return res.json({ authenticated: false });
 } catch(error) {next(error);}
});

// -------------------------------------------------------------
// Strict Authentication Guard for all /api/* routes
// Never accepts arbitrary X-Session-ID or ?sessionId= query parameters
// -------------------------------------------------------------
async function requireAuth(req: Request, res: Response, next: NextFunction) {
 try {
  const token = extractAuthToken(req);
  const session = await verifyAuthSession(token);
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
 } catch(error) {next(error);}
}

app.get('/api/health', (_req, res) => res.json({ok:true, api:true, projectStorageReady:!process.env.VERCEL}));

// Until a durable cloud project store and job runner are configured, refuse cloud
// mutations instead of pretending scratch-space files are persistent projects.
app.use('/api/projects', (req,res,next) => {
  if (process.env.VERCEL && req.method !== 'GET') return requireAuth(req,res,() => res.status(503).json({
    code:'CLOUD_PROJECT_STORAGE_REQUIRED',
    error:'تم إصلاح تسجيل الدخول. حفظ المشاريع وتشغيل البحث على السحابة يحتاجان استكمال إعداد التخزين الدائم أولاً.',
  }));
  next();
});

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

app.get('/api/projects', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  res.json({ projects: storage.getProjects(sid) });
});

app.post('/api/projects', requireAuth, (req: Request, res: Response) => {
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

  prepareSearchIdentity(newProject);
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

  if (worker.isRunning(project.id)) return res.status(409).json({error: 'أوقف البحث وانتظر انتهاءه قبل تعديل المنتج'});
  prepareSearchIdentity(project);
  if (req.body.name) {
    project.name = req.body.name;
  }
  if (Array.isArray(req.body.referenceImages)) project.referenceImages = req.body.referenceImages;
  if (typeof req.body.productListingUrl === 'string') project.productListingUrl = req.body.productListingUrl;
  if (typeof req.body.userNotes === 'string') project.userNotes = req.body.userNotes;
  const previousFingerprint = project.searchInputFingerprint;
  prepareSearchIdentity(project);
  if (req.body.productProfile && previousFingerprint === project.searchInputFingerprint) project.productProfile = req.body.productProfile;
  if (req.body.settings) {
    project.settings = { ...project.settings, ...req.body.settings };
  }
  if (req.body.candidates) {
    // Only update existing assets; a client cannot inject another project's results.
    const changes = new Map((Array.isArray(req.body.candidates) ? req.body.candidates : []).map((c: any) => [c.id, c]));
    project.candidates = project.candidates.map(c => changes.has(c.id) ? {...c, selectedForExport: Boolean((changes.get(c.id) as any).selectedForExport)} : c);
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

  if (worker.isRunning(project.id)) return res.status(409).json({error: 'البحث قيد التشغيل'});
  const fingerprint = prepareSearchIdentity(project);
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
    if (productInputFingerprint(project) !== fingerprint || worker.isRunning(project.id)) return res.status(409).json({error: 'تغيّر المنتج أثناء التحليل؛ أعد المحاولة'});
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
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) {
    return res.status(404).json({ error: 'المشروع غير موجود' });
  }

  if (worker.isRunning(project.id)) return res.status(409).json({error: 'الطلب السابق لم ينته بعد؛ انتظر ثم أعد المحاولة'});
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

app.get('/api/projects/:id/assets/:assetId/download', requireAuth, (req: Request, res: Response) => {
  const sid = (req as any).sessionId;
  const project = storage.getProject(req.params.id, sid);
  if (!project) return res.status(404).json({ error: 'المشروع غير موجود' });

  const asset = project.candidates.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'العنصر غير موجود' });

  if (asset.downloadStatus === 'verified_available' && asset.localFilePath && fs.existsSync(asset.localFilePath)) {
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
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
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

app.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
  // Do not expose provider errors, tokens, or submitted access codes.
  console.error('[API] Request failed', error instanceof Error ? error.name : 'UnknownError');
  res.status(503).json({code:'SERVICE_UNAVAILABLE',error:'خدمة تسجيل الدخول أو التخزين غير متاحة مؤقتاً. حاول مرة أخرى.'});
});

export default app;
if (!process.env.VERCEL) startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
