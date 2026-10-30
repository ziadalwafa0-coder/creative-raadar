import fs from 'node:fs';
import path from 'node:path';
import type { Project, CandidateAsset, WorkspaceUsage } from '../types/index.ts';
import { PRIMARY_USER_OWNER_ID } from './auth.ts';
import { DATA_DIR, DOWNLOADS_DIR, MAX_CACHE_BYTES } from './config.ts';

const DB_FILE = path.join(DATA_DIR, 'reviewscout_db.json');

export interface DatabaseSchema {
  projects: Record<string, Project>;
  library: Record<string, CandidateAsset>;
  usage: WorkspaceUsage;
  migratedToOwnerAuth?: boolean;
}

const defaultUsage: WorkspaceUsage = {
  monthlySearchesUsed: 0,
  monthlySearchesLimit: 100,
  verifiedDownloadsUsed: 0,
  verifiedDownloadsLimit: 250,
  storageUsedBytes: 0,
  storageLimitBytes: MAX_CACHE_BYTES,
  activeProjects: 0,
};

function isTestOrFixtureProject(project: Project): boolean {
  if (project.id.startsWith('proj-seed-') || project.isDemoFixture) return true;
  if (project.id === 'proj-1792610508953-dtyog') return true; // early sample headphones fixture
  const sid = project.sessionId || '';
  if (
    sid.startsWith('sess_header_only_') ||
    sid.startsWith('sess_counts_') ||
    sid.startsWith('sess_user_') ||
    sid.startsWith('sess_test_') ||
    sid.startsWith('sess_intruder_') ||
    sid === 'legacy_isolated_fixture'
  ) {
    return true;
  }
  return false;
}

function isNonTerminalState(state: Project['jobState']): boolean {
  return (
    state === 'queued' ||
    state === 'analyzing' ||
    state === 'searching' ||
    state === 'inspecting' ||
    state === 'downloading' ||
    state === 'verifying'
  );
}

function sanitizeProject(project: Project): Project {
  const knownFixture =
    /(?:EXAMPLE|EGYVERIFIED|AUDIOVERIFIED|REVIEWVERIFIED|MANUAL_TEST|VINEEXAMPLE|SELLEROFFICIALDEMO)/i;
  const candidates = (project.candidates || []).filter(
    (a) => !a.id.startsWith('ast-seed-') && !knownFixture.test(a.sourceUrl || '')
  );

  for (const asset of candidates) {
    if (asset.localFilePath && !fs.existsSync(asset.localFilePath)) {
      const migratedPath = path.join(DOWNLOADS_DIR, path.basename(asset.localFilePath));
      if (fs.existsSync(migratedPath)) {
        asset.localFilePath = migratedPath;
      }
    }

    if (asset.downloadStatus === 'verified_available') {
      let valid = false;
      try {
        if (asset.localFilePath && fs.existsSync(asset.localFilePath)) {
          const stat = fs.statSync(asset.localFilePath);
          if (stat.size > 16) {
            const fd = fs.openSync(asset.localFilePath, 'r');
            const header = Buffer.alloc(12);
            fs.readSync(fd, header, 0, 12, 0);
            fs.closeSync(fd);
            valid =
              asset.mediaType === 'video'
                ? header.toString('ascii', 4, 8) === 'ftyp'
                : stat.size > 16;
          }
        }
      } catch {}
      if (!valid) {
        asset.localFilePath = undefined;
        const hasValidRemoteMedia =
          asset.mediaUrl &&
          (asset.mediaUrl.startsWith('https://') || asset.mediaUrl.startsWith('http://')) &&
          !asset.mediaUrl.includes('youtube.com') &&
          !asset.mediaUrl.includes('youtu.be');
        if (!hasValidRemoteMedia) {
          asset.downloadStatus = 'source_only';
          asset.downloadError = 'الملف القديم لم يجتز التحقق؛ أضف رابط فيديو صالحاً.';
        }
      }
    }
  }

  let jobState = project.jobState;
  const logs = [...(project.logs || [])];
  if (isNonTerminalState(jobState)) {
    jobState = 'completed_partial';
    const has429 = logs.some((l) => l.message.includes('429') || l.message.includes('حصة'));
    logs.push({
      timestamp: new Date().toISOString(),
      stage: 'completed_partial',
      message: has429
        ? 'حصة البحث غير متاحة مؤقتاً — يمكنك إعادة المحاولة يدوياً أو إضافة روابط مباشرة من التفاصيل.'
        : 'تم إنهاء حالة البحث المعلقة تلقائياً.',
      level: 'warn',
    });
  }

  const ready = candidates.filter((a) => a.downloadStatus === 'verified_available').length;
  if (jobState === 'idle' && ready > 0) {
    jobState = 'completed';
  }
  return {
    ...project,
    jobState,
    logs,
    candidates,
    counters: {
      ...project.counters,
      candidatesDiscovered: candidates.length,
      sourcesInspected: candidates.length,
      downloadedAssets: ready,
      verifiedAssets: ready,
      visuallyMatchedAssets: candidates.filter(
        (a) => a.matchCategory === 'exact_design' && a.supportingObservations?.length
      ).length,
    },
  };
}

export class StorageService {
  private static instance: StorageService;
  private db: DatabaseSchema;

  private constructor() {
    this.ensureDir();
    this.db = this.load();
  }

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  private ensureDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
  }

  private load(): DatabaseSchema {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        const rawProjects: Record<string, Project> = parsed.projects || {};
        let needsSave = false;

        const sanitizedProjects: Record<string, Project> = {};

        for (const [id, rawProj] of Object.entries(rawProjects)) {
          const p = sanitizeProject(rawProj as Project);
          if (p.jobState !== (rawProj as Project).jobState) {
            needsSave = true;
          }

          if (isTestOrFixtureProject(p)) {
            if (p.sessionId !== 'legacy_isolated_fixture' && !p.id.startsWith('proj-seed-')) {
              p.sessionId = 'legacy_isolated_fixture';
              needsSave = true;
            }
          } else if (!p.sessionId || !p.sessionId.startsWith('owner_')) {
            p.sessionId = PRIMARY_USER_OWNER_ID;
            needsSave = true;
          }

          sanitizedProjects[id] = p;
        }

        const loadedDb: DatabaseSchema = {
          projects: sanitizedProjects,
          library: parsed.library || {},
          usage: parsed.usage || defaultUsage,
          migratedToOwnerAuth: true,
        };

        if (needsSave || !parsed.migratedToOwnerAuth) {
          try {
            fs.writeFileSync(DB_FILE, JSON.stringify(loadedDb, null, 2), 'utf-8');
          } catch {}
        }

        return loadedDb;
      }
    } catch (err) {
      console.warn('[Storage] Error loading DB, using defaults:', err);
    }

    return {
      projects: {},
      library: {},
      usage: defaultUsage,
      migratedToOwnerAuth: true,
    };
  }

  public save(): void {
    try {
      this.ensureDir();
      fs.writeFileSync(DB_FILE, JSON.stringify(this.db, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Storage] Error saving DB:', err);
    }
  }

  public getProjects(ownerId?: string): Project[] {
    if (!ownerId) return [];
    const all = Object.values(this.db.projects).filter(
      (p) => !p.id.startsWith('proj-seed-') && !p.isDemoFixture && p.sessionId !== 'legacy_isolated_fixture'
    );

    return all
      .filter((p) => p.sessionId === ownerId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getProject(id: string, ownerId?: string): Project | undefined {
    const project = this.db.projects[id];
    if (!project) return undefined;
    if (project.id.startsWith('proj-seed-') || project.isDemoFixture || project.sessionId === 'legacy_isolated_fixture') {
      return undefined;
    }

    if (ownerId && project.sessionId !== ownerId) {
      return undefined;
    }

    return project;
  }

  public upsertProject(project: Project): void {
    this.db.projects[project.id] = {
      ...project,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  public deleteProject(id: string, ownerId?: string): boolean {
    const project = this.db.projects[id];
    if (!project) return false;

    if (!ownerId || project.sessionId !== ownerId) {
      return false;
    }

    for (const asset of project.candidates || []) {
      if (asset.localFilePath && fs.existsSync(asset.localFilePath)) {
        try {
          fs.unlinkSync(asset.localFilePath);
        } catch {}
      }
    }

    delete this.db.projects[id];
    this.save();
    return true;
  }

  public getLibrary(ownerId?: string): CandidateAsset[] {
    if (!ownerId) return [];
    const allAssets: CandidateAsset[] = [];
    for (const proj of this.getProjects(ownerId)) {
      for (const asset of proj.candidates) {
        if (asset.downloadStatus === 'verified_available') {
          allAssets.push(asset);
        }
      }
    }
    return allAssets;
  }

  public getUsage(ownerId?: string): WorkspaceUsage {
    const userProjects = this.getProjects(ownerId);
    const assets = this.getLibrary(ownerId);
    return {
      ...this.db.usage,
      activeProjects: userProjects.length,
      verifiedDownloadsUsed: assets.length,
      storageUsedBytes: assets.reduce((n, a) => n + (a.fileSizeBytes || 0), 0),
    };
  }

  public incrementSearches(): void {
    this.db.usage.monthlySearchesUsed += 1;
    this.save();
  }

  public incrementDownloads(count = 1): void {
    this.db.usage.verifiedDownloadsUsed += count;
    this.save();
  }
}
