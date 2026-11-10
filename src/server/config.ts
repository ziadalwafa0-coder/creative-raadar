import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({path:['.env.local','.env'],quiet:true});

const DEFAULT_ACCESS_CODE_DIGESTS = [
  '49df6742a19cfb94d2b217ed78283e8bc9829e7c8e435eeb7982dd8badb85805',
  'bbe306ae6d1322716e124c1c2a5640d5246caa9cbc02f74e6f450ed3b6f6e8b8',
  'bc0baad48f83aec2a74046276c928c5198008c91b38350b54f9c9d68239f00fa',
  'd3a12bcfe2f7faa8be79cea700fd46375cfa2da812513264391c7f9241ce920f',
  'cab24a5dc82354231865b1961832669046dbfaa72dc2643f6426eb75fcc318d6',
  'b665b722afed8371d94c4008e6254141cf6030899628617429ac9e90ebb88c86',
  'da1aa887ac4dfb42528182785af4b9f5f6b5663f2bc23969e220c33e67f19e9b',
  'ea1fa0ba0472ed5034d7a7fae264b2f203ac6e503b2caf4d41db6d88798f33e5',
  '2d2764995156f667ce84f42b03d2ef4ac688b0a2e194bd3b1bfd6688fd14d1ec',
  'be81f1652528608e182a0ad7555548832836764ba2a3e923e49b8f6b8180e20e',
  '01912c999c0bdc5fecb15825a3bd4fccffabd2a72dc53b20c6cba8131618e446',
  '204654da50f797b4068f1a8b738b2fe06835fd406543be03becaab0755eb148f',
  'dee9a0c01511257cbe97c1dc59de54bbf0265c15f4007bafe8deb433e51c33fc',
  'e2451d28c3efdf159c13acb252623a85ddd57a55a2909891cbd6014b70657791',
  '5f5842008f0ddc77946ad28c5a19e65d002ecfb839d3fd9ac70184a4cb4a50d2',
  '3c1a0deb1cf91f309272882be66c4a006249eefdaacbc83ec0a31f31b5670223',
];

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';

const DEFAULT_RUNTIME_DATA_DIR = path.join(os.tmpdir(), 'creative-radaar-data');

function resolveWritableDir(preferredPath: string, fallbackSubdir: string): string {
  const candidate = path.resolve(process.cwd(), preferredPath);
  try {
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, `.probe_${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return candidate;
  } catch {
    const fallback = path.join(DEFAULT_RUNTIME_DATA_DIR, fallbackSubdir);
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }
}

export const DATA_DIR = resolveWritableDir(
  process.env.DATA_DIR || DEFAULT_RUNTIME_DATA_DIR,
  'root'
);
export const DOWNLOADS_DIR = resolveWritableDir(
  process.env.DOWNLOADS_DIR || path.join(DATA_DIR, 'downloads'),
  'downloads'
);

export const POSTERS_DIR=resolveWritableDir(path.join(DATA_DIR,'posters'),'posters');

function resolveGeminiApiKey(): string {
  const fromEnv = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (fromEnv && fromEnv !== 'MY_GEMINI_API_KEY') {
    return fromEnv;
  }
  return fromEnv;
}

export const GEMINI_API_KEY = resolveGeminiApiKey();

const DEFAULT_PEPPER = 'creative_radaar_v1_hmac_salt_9f8e7d6c5b4a3210';
export const CREATIVE_RADAAR_PEPPER = (
  process.env.CREATIVE_RADAAR_PEPPER || DEFAULT_PEPPER
).trim();

export const ACCESS_CODE_DIGESTS: readonly string[] = process.env.ACCESS_CODE_DIGESTS
  ? process.env.ACCESS_CODE_DIGESTS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{64}$/.test(s))
  : DEFAULT_ACCESS_CODE_DIGESTS;

export const SCRAPER_PROXY_URL = (process.env.SCRAPER_PROXY_URL || '').trim() || undefined;
export const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || '').trim() || undefined;

const parsedMaxCacheGb = Number(process.env.MAX_CACHE_GB);
export const MAX_CACHE_GB =
  Number.isFinite(parsedMaxCacheGb) && parsedMaxCacheGb > 0 ? parsedMaxCacheGb : 1;
export const MAX_CACHE_BYTES = Math.floor(MAX_CACHE_GB * 1024 * 1024 * 1024);

export const GEMINI_MODELS: readonly string[] = process.env.GEMINI_MODELS
  ? process.env.GEMINI_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
  : ['gemini-2.5-flash', 'gemini-flash-latest'];

export function assertProductionConfig(): void {
  if (IS_PROD && !process.env.CREATIVE_RADAAR_PEPPER?.trim()) {
    if (process.env.STRICT_PRODUCTION_PEPPER === 'true') {
      throw new Error(
        'FATAL: CREATIVE_RADAAR_PEPPER environment variable must be set when running in strict production.'
      );
    }
    console.warn(
      '[Config] Warning: CREATIVE_RADAAR_PEPPER is not set in environment; using default built-in HMAC pepper so Cloud Run deployment starts cleanly.'
    );
  }
}
