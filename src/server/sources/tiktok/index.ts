import {
  ALL_TIKTOK_SERP_ENGINES,
  buildTikTokSearchVariants,
  checkYtDlpVersion,
  discoverTikTokVideoUrls,
  discoverTikTokVideoUrlsWithDiagnostics,
  fetchTikTokVideoDetail,
  isTikTokVideoPageUrl,
  tryYtDlpDirectPlayAddr,
  type SearchEngineRouteReport,
  type TikTokSerpEngineName,
} from '../../tiktokVideos.ts';
import { AMAZON_CHROME_USER_AGENT, fetchProductImageAsBase64 } from '../../amazonHttp.ts';
import type { IdentityCardV2 } from '../../pipeline/identity.ts';
import { buildDiscriminatorsForIdentityCard } from '../../pipeline/identity.ts';
import { evaluateProductTypeGate } from '../../pipeline/verify.ts';
import {
  computeColorAgnosticClipEmbedding,
  cosineSimilarityClip,
} from '../../pipeline/clipEmbedding.ts';
import { expandSnowballQueriesFromVerified } from '../../pipeline/queryIntelligence.ts';
import { getRuntimeSettings } from '../../settings.ts';
import type { TikTokProviderProbeItem, VerdictTier } from '../../../types/index.ts';
import type {
  TikTokProvider,
  TikTokProviderFunnelReport,
  TikTokSearchOptions,
  TikTokVideoCandidate,
} from './types.ts';

interface CircuitState {
  failures: number;
  openedUntil: number;
  lastError?: string;
}

const circuitBreakers = new Map<string, CircuitState>();
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

function isCircuitOpen(providerName: string): boolean {
  const st = circuitBreakers.get(providerName);
  if (!st) return false;
  if (st.openedUntil > Date.now()) return true;
  return false;
}

function recordProviderSuccess(providerName: string): void {
  circuitBreakers.set(providerName, { failures: 0, openedUntil: 0 });
}

function recordProviderFailure(providerName: string, err: unknown): void {
  const prev = circuitBreakers.get(providerName) || { failures: 0, openedUntil: 0 };
  const failures = prev.failures + 1;
  const openedUntil =
    failures >= CIRCUIT_FAILURE_THRESHOLD ? Date.now() + CIRCUIT_COOLDOWN_MS : 0;
  const lastError = (err as Error)?.message || String(err);
  circuitBreakers.set(providerName, { failures, openedUntil, lastError });
  console.warn(
    `[TikTokAdapter:${providerName}] Error (#${failures}${openedUntil ? ' - CIRCUIT OPENED' : ''}): ${lastError}`
  );
}

export function getTikTokProviderStatus(): Array<{
  name: string;
  configured: boolean;
  circuitOpen: boolean;
  lastError?: string;
}> {
  return ALL_PROVIDERS.map((p) => {
    const st = circuitBreakers.get(p.name);
    return {
      name: p.name,
      configured: p.isConfigured(),
      circuitOpen: isCircuitOpen(p.name),
      lastError: st?.lastError,
    };
  });
}

export async function fetchOembedFallback(
  url: string,
  signal?: AbortSignal,
  providerName: TikTokVideoCandidate['providerName'] = 'url-import',
  downloadFailureReason = 'download_failed:rehydration_blocked_oembed_only'
): Promise<TikTokVideoCandidate | null> {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const timeoutSig = AbortSignal.timeout(6000);
    const combined = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await fetch(oembedUrl, {
      headers: { 'User-Agent': AMAZON_CHROME_USER_AGENT },
      signal: combined,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, any>;
    const vidMatch = url.match(/\/video\/(\d{15,22})/);
    const videoId = vidMatch ? vidMatch[1] : String(data.embed_product_id || Date.now());
    const author = String(data.author_unique_id || data.author_name || 'tiktok_creator');
    return {
      videoId,
      canonicalUrl: url,
      title: String(data.title || `فيديو تيك توك (@${author})`),
      playAddr: url,
      thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
      embedHtml: typeof data.html === 'string' ? data.html : undefined,
      hasDirectMp4: false,
      downloadFailureReason,
      authorHandle: author.startsWith('@') ? author : `@${author}`,
      authorNickname: String(data.author_name || author),
      playCount: 0,
      diggCount: 0,
      commentCount: 0,
      cookieHeader: '',
      providerName,
    };
  } catch (err) {
    console.warn('[TikTokOembed] Fallback failed:', (err as Error)?.message || err);
    return null;
  }
}

/**
 * Hydrates a discovered TikTok video URL by separating DISCOVERY from DOWNLOAD.
 */
export async function hydrateTikTokCandidateWithFallbacks(
  url: string,
  providerName: TikTokVideoCandidate['providerName'],
  signal?: AbortSignal
): Promise<TikTokVideoCandidate | null> {
  const [detail, oembed] = await Promise.all([
    fetchTikTokVideoDetail(url, signal).catch(() => null),
    fetchOembedFallback(url, signal, providerName).catch(() => null),
  ]);

  if (detail && detail.playAddr && detail.playAddr !== url) {
    return {
      ...detail,
      thumbnailUrl: detail.thumbnailUrl || oembed?.thumbnailUrl,
      embedHtml: oembed?.embedHtml,
      title:
        detail.title && !detail.title.startsWith('فيديو تيك توك')
          ? detail.title
          : oembed?.title || detail.title,
      hasDirectMp4: true,
      providerName,
    };
  }

  if (oembed) {
    const ytdlp = await tryYtDlpDirectPlayAddr(url);
    if (ytdlp.playAddr) {
      return {
        ...oembed,
        playAddr: ytdlp.playAddr,
        hasDirectMp4: true,
        downloadFailureReason: undefined,
        providerName,
      };
    }
    return {
      ...oembed,
      hasDirectMp4: false,
      downloadFailureReason: `download_failed:${ytdlp.error || 'rehydration_blocked_oembed_only'}`,
      providerName,
    };
  }

  return null;
}

/**
 * PHASE 4.1 — Pre-ranks hydrated TikTok candidates by:
 * (1) embedding similarity of the oEmbed thumbnail to the reference image,
 * (2) caption/discriminator keyword overlap,
 * (3) strict rejection of captions hitting mustNotBe / sameCategoryLookalikes / Type Gate.
 * Returns only the top M candidates to send to frame verification.
 */
export async function preRankTikTokCandidates(params: {
  candidates: TikTokVideoCandidate[];
  identity: IdentityCardV2;
  referenceImageBase64?: string;
  topM?: number;
  signal?: AbortSignal;
}): Promise<{
  passed: TikTokVideoCandidate[];
  droppedCount: number;
}> {
  const { candidates, identity, referenceImageBase64, topM = 20, signal } = params;
  if (candidates.length === 0) return { passed: [], droppedCount: 0 };

  const { discriminators } = buildDiscriminatorsForIdentityCard(identity);
  const discTokens = new Set(
    [
      identity.nameEn,
      ...discriminators.map((d) => `${d.name} ${d.expectedValue}`),
      ...identity.mustMatch,
    ]
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );

  let refClipEmb: number[] | null = null;
  if (referenceImageBase64) {
    try {
      const clean = referenceImageBase64.replace(/^data:[^;]+;base64,/, '');
      const r = await computeColorAgnosticClipEmbedding(Buffer.from(clean, 'base64'));
      refClipEmb = r.embedding;
    } catch {}
  }

  const scored: TikTokVideoCandidate[] = [];
  let droppedCount = 0;

  await Promise.all(
    candidates.map(async (cand) => {
      // 1. Check Type Gate & Look-Alike Gate on caption
      const gate = evaluateProductTypeGate(cand.title, identity);
      if (!gate.passesTypeGate) {
        droppedCount++;
        return;
      }

      // 2. Compute caption/discriminator token overlap
      const capTokens = String(cand.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3);
      let hits = 0;
      for (const t of capTokens) {
        if (discTokens.has(t)) hits++;
      }
      const discOverlap = Number(Math.min(1, hits / Math.max(3, Math.min(8, discTokens.size))).toFixed(3));

      // 3. Compute oEmbed thumbnail CLIP similarity if reference embedding is available
      let clipSim = 0.55;
      if (refClipEmb && cand.thumbnailUrl) {
        try {
          const fetched = await fetchProductImageAsBase64(cand.thumbnailUrl, signal);
          if (fetched?.base64) {
            const emb = await computeColorAgnosticClipEmbedding(Buffer.from(fetched.base64, 'base64'));
            clipSim = Number(cosineSimilarityClip(refClipEmb, emb.embedding).toFixed(4));
          }
        } catch {}
      }

      if (clipSim < 0.30) {
        droppedCount++;
        return;
      }

      const preRankScore = Number((clipSim * 0.7 + discOverlap * 0.3).toFixed(4));
      scored.push({
        ...cand,
        preRankClipSim: clipSim,
        preRankDiscriminatorOverlap: discOverlap,
        preRankScore,
      });
    })
  );

  scored.sort((a, b) => (b.preRankScore || 0) - (a.preRankScore || 0));
  return {
    passed: scored.slice(0, topM),
    droppedCount: droppedCount + Math.max(0, scored.length - topM),
  };
}

/**
 * PHASE 4.2 — Expands TikTok candidates ONLY from VERIFIED (V2/V3) items:
 * (a) same creator/shop account's other videos,
 * (b) hashtags found in verified captions,
 * (c) similar-caption search.
 * Capped at expansion depth 1 and NEVER expands from unverified (V0/V1) or rejected items!
 */
export async function expandTikTokCandidatesFromVerified(params: {
  identity: IdentityCardV2;
  verifiedItems: Array<{
    id: string;
    title: string;
    reviewerOrChannel?: string;
    evidenceLevel?: 'V3' | 'V2' | 'V1' | 'V0';
    verdictTier?: VerdictTier;
    approved?: boolean;
  }>;
  alreadySeenVideoIds: Set<string>;
  alreadyRunQueries: Set<string>;
  referenceImageBase64?: string;
  maxNewCandidates?: number;
  signal?: AbortSignal;
}): Promise<{
  expandedCandidates: TikTokVideoCandidate[];
  expansionQueriesRun: string[];
}> {
  const snowball = expandSnowballQueriesFromVerified({
    identity: params.identity,
    verifiedItems: params.verifiedItems,
    alreadyRunQueries: params.alreadyRunQueries,
  });

  if (snowball.newTikTokQueries.length === 0) {
    return { expandedCandidates: [], expansionQueriesRun: [] };
  }

  const queriesToRun = snowball.newTikTokQueries.slice(0, 3);
  for (const q of queriesToRun) {
    params.alreadyRunQueries.add(q.toLowerCase());
  }

  let urls: string[] = [];
  try {
    urls = await discoverTikTokVideoUrls(queriesToRun, params.signal);
  } catch {
    return { expandedCandidates: [], expansionQueriesRun: queriesToRun };
  }

  const freshUrls = urls.filter((u) => {
    const m = u.match(/\/video\/(\d{15,22})/);
    const vid = m ? m[1] : u;
    return !params.alreadySeenVideoIds.has(vid);
  });

  const hydrated: TikTokVideoCandidate[] = [];
  for (const u of freshUrls.slice(0, params.maxNewCandidates || 8)) {
    if (params.signal?.aborted) break;
    const item = await hydrateTikTokCandidateWithFallbacks(u, 'serp-hydration', params.signal);
    if (item && !params.alreadySeenVideoIds.has(item.videoId)) {
      params.alreadySeenVideoIds.add(item.videoId);
      hydrated.push(item);
    }
  }

  const preRanked = await preRankTikTokCandidates({
    candidates: hydrated,
    identity: params.identity,
    referenceImageBase64: params.referenceImageBase64,
    topM: params.maxNewCandidates || 6,
    signal: params.signal,
  });

  return {
    expandedCandidates: preRanked.passed,
    expansionQueriesRun: queriesToRun,
  };
}

/**
 * 1. URL-Import Provider: Hydrates user-pasted TikTok video URLs via rehydration + yt-dlp + oEmbed survival.
 */
export class UrlImportTikTokProvider implements TikTokProvider {
  public readonly name = 'url-import' as const;

  isConfigured(): boolean {
    const settings = getRuntimeSettings();
    return settings.tiktokProviders?.enabled?.['url-import'] ?? true;
  }

  async *search(
    _identity: IdentityCardV2,
    opts: TikTokSearchOptions,
    signal?: AbortSignal
  ): AsyncIterable<TikTokVideoCandidate> {
    const urls = (opts.directUrls || []).filter((u) => isTikTokVideoPageUrl(u));
    let oembedOk = 0;
    const yielded: TikTokVideoCandidate[] = [];

    for (const rawUrl of urls) {
      if (signal?.aborted) break;
      try {
        const hydrated = await hydrateTikTokCandidateWithFallbacks(rawUrl, 'url-import', signal);
        if (hydrated) {
          oembedOk++;
          recordProviderSuccess(this.name);
          yielded.push(hydrated);
          yield hydrated;
        }
      } catch (err) {
        recordProviderFailure(this.name, err);
      }
    }

    if (urls.length > 0) {
      opts.onFunnelReport?.({
        provider: 'url-import',
        query: 'direct_urls',
        serpResults: urls.length,
        tiktokUrlsParsed: urls.length,
        oembedOk,
        preRankedPassed: yielded.length,
        sentToFrameVerification: yielded.length,
        acceptedCount: 0,
      });
    }
  }
}

/**
 * 2. SERP + Hydration Provider: Discovers TikTok video links across multi-engine SERP routes,
 * hydrates via oEmbed + rehydration, pre-ranks by oEmbed thumbnail CLIP similarity + discriminator overlap,
 * and yields top M candidates for frame verification.
 */
export class SerpHydrationTikTokProvider implements TikTokProvider {
  public readonly name = 'serp-hydration' as const;

  isConfigured(): boolean {
    const settings = getRuntimeSettings();
    return settings.tiktokProviders?.enabled?.['serp-hydration'] ?? true;
  }

  async *search(
    identity: IdentityCardV2,
    opts: TikTokSearchOptions,
    signal?: AbortSignal
  ): AsyncIterable<TikTokVideoCandidate> {
    const queries = opts.customQueries?.length
      ? opts.customQueries
      : buildTikTokSearchVariants(
          identity.nameEn,
          [
            ...identity.queries.tiktokEn,
            ...identity.queries.amazonEn,
            ...identity.queries.tradeNamesEn,
            ...(identity.queries.tiktokAr || []),
            ...identity.hashtags.slice(0, 3).map((h) => `#${h}`),
          ],
          identity.nameAr
        );

    let discoveredUrls: string[] = [];
    let totalRawSerpResults = 0;
    try {
      const diag = await discoverTikTokVideoUrlsWithDiagnostics(queries, signal, false, 3);
      discoveredUrls = diag.urls;
      for (const rep of Object.values(diag.engineReports)) {
        totalRawSerpResults += rep.rawResultsCount || 0;
      }
      recordProviderSuccess(this.name);
    } catch (err) {
      recordProviderFailure(this.name, err);
      return;
    }

    const maxToInspect = Math.min(opts.maxCandidates || 35, discoveredUrls.length);
    const batchSize = 5;
    const hydratedAll: TikTokVideoCandidate[] = [];

    for (let i = 0; i < maxToInspect; i += batchSize) {
      if (signal?.aborted) break;
      const slice = discoveredUrls.slice(i, i + batchSize);
      const hydrated = await Promise.all(
        slice.map(async (u) => {
          if (signal?.aborted) return null;
          try {
            return await hydrateTikTokCandidateWithFallbacks(u, 'serp-hydration', signal);
          } catch (err) {
            recordProviderFailure(this.name, err);
            return null;
          }
        })
      );

      for (const item of hydrated) {
        if (item) {
          hydratedAll.push(item);
        }
      }
    }

    const topM = opts.topMForVerification || opts.maxCandidates || 20;
    const preRanked = await preRankTikTokCandidates({
      candidates: hydratedAll,
      identity,
      referenceImageBase64: opts.referenceImageBase64,
      topM,
      signal,
    });

    opts.onFunnelReport?.({
      provider: 'serp-hydration',
      query: queries.slice(0, 3).join(' | '),
      serpResults: Math.max(totalRawSerpResults, discoveredUrls.length),
      tiktokUrlsParsed: discoveredUrls.length,
      oembedOk: hydratedAll.length,
      preRankedPassed: preRanked.passed.length,
      sentToFrameVerification: preRanked.passed.length,
      acceptedCount: 0,
    });

    for (const item of preRanked.passed) {
      if (signal?.aborted) break;
      yield item;
    }
  }
}

/**
 * 3. Playwright Headless Browser Provider (behind feature flag in settings or TIKTOK_PROVIDERS).
 */
export class PlaywrightTikTokProvider implements TikTokProvider {
  public readonly name = 'playwright' as const;

  isConfigured(): boolean {
    const settings = getRuntimeSettings();
    if (settings.tiktokProviders?.enabled?.playwright) return true;
    const enabledList = (process.env.TIKTOK_PROVIDERS || 'url-import,serp-hydration')
      .split(',')
      .map((s) => s.trim().toLowerCase());
    return enabledList.includes('playwright');
  }

  async *search(
    identity: IdentityCardV2,
    opts: TikTokSearchOptions,
    signal?: AbortSignal
  ): AsyncIterable<TikTokVideoCandidate> {
    if (!this.isConfigured() || isCircuitOpen(this.name)) return;
    try {
      const q = identity.queries.tiktokEn[0] || identity.nameEn;
      const urls = await discoverTikTokVideoUrls([q], signal);
      for (const u of urls.slice(0, Math.min(8, opts.maxCandidates || 8))) {
        if (signal?.aborted) break;
        const hydrated = await hydrateTikTokCandidateWithFallbacks(u, 'playwright', signal);
        if (hydrated) {
          recordProviderSuccess(this.name);
          yield hydrated;
        }
      }
    } catch (err) {
      recordProviderFailure(this.name, err);
    }
  }
}

/**
 * 4. Optional Apify TikTok Provider (enabled when APIFY_TOKEN is set).
 */
export class ApifyTikTokProvider implements TikTokProvider {
  public readonly name = 'apify' as const;

  isConfigured(): boolean {
    return Boolean(process.env.APIFY_TOKEN && process.env.APIFY_TOKEN.trim().length > 10);
  }

  async *search(
    identity: IdentityCardV2,
    opts: TikTokSearchOptions,
    signal?: AbortSignal
  ): AsyncIterable<TikTokVideoCandidate> {
    const token = (process.env.APIFY_TOKEN || '').trim();
    if (!token || isCircuitOpen(this.name)) return;

    const actorId = process.env.APIFY_TIKTOK_ACTOR || 'clockworks~free-tiktok-scraper';
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

    try {
      const timeoutSig = AbortSignal.timeout(15000);
      const combined = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchQueries: identity.queries.tiktokEn.slice(0, 2),
          resultsPerPage: Math.min(20, opts.maxCandidates || 15),
        }),
        signal: combined,
      });
      if (!res.ok) {
        throw new Error(`Apify HTTP ${res.status}`);
      }
      const items = (await res.json()) as Array<Record<string, any>>;
      recordProviderSuccess(this.name);
      for (const item of items) {
        const videoId = String(item.id || '').trim();
        const webVideoUrl = String(item.webVideoUrl || '').trim();
        const mediaUrl = String(item.videoMeta?.downloadAddr || webVideoUrl).trim();
        if (!videoId || !mediaUrl) continue;
        yield {
          videoId,
          canonicalUrl: webVideoUrl || mediaUrl,
          title: String(item.text || ''),
          playAddr: mediaUrl,
          thumbnailUrl: String(item.videoMeta?.coverUrl || item.covers?.default || '') || undefined,
          hasDirectMp4: Boolean(item.videoMeta?.downloadAddr),
          authorHandle: `@${String(item.authorMeta?.name || 'tiktok')}`,
          authorNickname: String(item.authorMeta?.nickName || ''),
          durationSeconds: Number(item.videoMeta?.duration) || undefined,
          playCount: Number(item.playCount) || 0,
          diggCount: Number(item.diggCount) || 0,
          commentCount: Number(item.commentCount) || 0,
          cookieHeader: '',
          providerName: 'apify',
        };
      }
    } catch (err) {
      recordProviderFailure(this.name, err);
    }
  }
}

const ALL_PROVIDERS: TikTokProvider[] = [
  new UrlImportTikTokProvider(),
  new SerpHydrationTikTokProvider(),
  new PlaywrightTikTokProvider(),
  new ApifyTikTokProvider(),
];

export interface TikTokSpikeDiagnostics {
  queriesUsed: string[];
  ytDlpStatus?: { installed: boolean; version?: string; error?: string };
  searchEngineRoutes: Record<TikTokSerpEngineName, SearchEngineRouteReport>;
  providerProbes: TikTokProviderProbeItem[];
  providers: Array<{
    provider: 'serp-hydration' | 'url-import' | 'playwright' | 'apify';
    configured: boolean;
    candidatesReturned: number;
    sampleCandidates: Array<{
      videoId: string;
      authorHandle: string;
      title: string;
      hasPlayAddr: boolean;
      hasThumbnail: boolean;
      hasEmbedHtml: boolean;
      canonicalUrl: string;
    }>;
    failureOrSkipReason?: string;
  }>;
}

/**
 * Phase 3.2 & 3.3 Live Probe ("اختبار تيك توك"):
 * Runs a live probe across all SERP engines (Naver, DuckDuckGo Lite, DuckDuckGo HTML, Bing RSS, Yahoo, Brave, SearXNG, Google CSE)
 * and all 4 providers (serp-hydration, url-import, playwright, apify), testing oEmbed & hydration on discovered URLs.
 * Returns structured `TikTokProviderProbeItem[]` for UI display and trace storage.
 */
export async function runTikTokProviderSpike(
  identity: IdentityCardV2,
  directUrls: string[] = [],
  signal?: AbortSignal
): Promise<TikTokSpikeDiagnostics> {
  const ytDlpStatus = await checkYtDlpVersion();
  const queries = buildTikTokSearchVariants(
    identity.nameEn,
    [
      ...identity.queries.tiktokEn,
      ...identity.queries.amazonEn,
      ...identity.queries.tradeNamesEn,
      ...identity.hashtags.slice(0, 2).map((h) => `#${h}`),
    ],
    identity.nameAr
  );

  const { urls: discoveredUrls, engineReports } = await discoverTikTokVideoUrlsWithDiagnostics(
    queries.slice(0, 3),
    signal,
    true,
    2
  );

  const providerProbes: TikTokProviderProbeItem[] = [];

  // Sample oEmbed check on up to 6 discovered URLs to measure oEmbed ok/fail
  const sampleUrlsForOembed = discoveredUrls.slice(0, 6);
  let totalOembedOk = 0;
  let totalOembedFail = 0;
  const oembedResults = await Promise.all(
    sampleUrlsForOembed.map(async (u) => {
      const oem = await fetchOembedFallback(u, signal, 'serp-hydration');
      return { url: u, ok: Boolean(oem && oem.thumbnailUrl), oem };
    })
  );
  for (const r of oembedResults) {
    if (r.ok) totalOembedOk++;
    else totalOembedFail++;
  }

  for (const eng of ALL_TIKTOK_SERP_ENGINES) {
    const rep = engineReports[eng];
    // Test oEmbed on up to 2 sample URLs from this specific engine
    let engOembedOk = 0;
    let engOembedFail = 0;
    for (const su of rep.sampleUrls.slice(0, 2)) {
      const cached = oembedResults.find((x) => x.url === su);
      if (cached) {
        if (cached.ok) engOembedOk++;
        else engOembedFail++;
      } else {
        const oem = await fetchOembedFallback(su, signal, 'serp-hydration');
        if (oem && oem.thumbnailUrl) engOembedOk++;
        else engOembedFail++;
      }
    }
    providerProbes.push({
      provider: 'serp-hydration',
      engine: eng,
      httpStatus: rep.httpStatus,
      latencyMs: rep.latencyMs,
      rawResultsCount: rep.rawResultsCount,
      tiktokUrlsParsed: rep.urlsFound,
      oembedOkCount: engOembedOk,
      oembedFailCount: engOembedFail,
      circuitOpen: rep.circuitOpen,
      firstError: rep.error,
      sampleUrls: rep.sampleUrls,
    });
  }

  const providersReport: TikTokSpikeDiagnostics['providers'] = [];

  // 1) serp-hydration
  const serpProvider = new SerpHydrationTikTokProvider();
  const serpCandidates: TikTokVideoCandidate[] = [];
  let serpReason: string | undefined;
  try {
    for await (const c of serpProvider.search(identity, { maxCandidates: 12 }, signal)) {
      serpCandidates.push(c);
    }
    if (serpCandidates.length === 0) {
      serpReason =
        discoveredUrls.length === 0
          ? 'Search engine routes returned 0 TikTok video URLs'
          : `Discovered ${discoveredUrls.length} URLs, but hydration/oEmbed returned 0 items`;
    }
  } catch (err) {
    serpReason = (err as Error)?.message || String(err);
  }
  providersReport.push({
    provider: 'serp-hydration',
    configured: serpProvider.isConfigured(),
    candidatesReturned: serpCandidates.length,
    sampleCandidates: serpCandidates.slice(0, 5).map((c) => ({
      videoId: c.videoId,
      authorHandle: c.authorHandle,
      title: c.title.slice(0, 90),
      hasPlayAddr: Boolean(c.hasDirectMp4),
      hasThumbnail: Boolean(c.thumbnailUrl),
      hasEmbedHtml: Boolean(c.embedHtml),
      canonicalUrl: c.canonicalUrl,
    })),
    failureOrSkipReason: serpReason,
  });

  // 2) url-import
  const urlProvider = new UrlImportTikTokProvider();
  const urlCandidates: TikTokVideoCandidate[] = [];
  const sampleDirectUrls = directUrls.length > 0 ? directUrls : discoveredUrls.slice(0, 2);
  let urlReason: string | undefined;
  const tUrl0 = Date.now();
  if (sampleDirectUrls.length === 0) {
    urlReason = 'No direct TikTok URLs supplied in opts.directUrls';
  } else {
    try {
      for await (const c of urlProvider.search(
        identity,
        { directUrls: sampleDirectUrls, maxCandidates: 5 },
        signal
      )) {
        urlCandidates.push(c);
      }
    } catch (err) {
      urlReason = (err as Error)?.message || String(err);
    }
  }
  providerProbes.push({
    provider: 'url-import',
    httpStatus: urlCandidates.length > 0 ? 200 : 0,
    latencyMs: Date.now() - tUrl0,
    rawResultsCount: sampleDirectUrls.length,
    tiktokUrlsParsed: sampleDirectUrls.length,
    oembedOkCount: urlCandidates.filter((c) => Boolean(c.thumbnailUrl)).length,
    oembedFailCount: Math.max(0, sampleDirectUrls.length - urlCandidates.length),
    circuitOpen: isCircuitOpen('url-import'),
    firstError: urlReason,
    sampleUrls: sampleDirectUrls.slice(0, 3),
  });
  providersReport.push({
    provider: 'url-import',
    configured: urlProvider.isConfigured(),
    candidatesReturned: urlCandidates.length,
    sampleCandidates: urlCandidates.slice(0, 3).map((c) => ({
      videoId: c.videoId,
      authorHandle: c.authorHandle,
      title: c.title.slice(0, 90),
      hasPlayAddr: Boolean(c.hasDirectMp4),
      hasThumbnail: Boolean(c.thumbnailUrl),
      hasEmbedHtml: Boolean(c.embedHtml),
      canonicalUrl: c.canonicalUrl,
    })),
    failureOrSkipReason:
      directUrls.length === 0
        ? `Tested with ${sampleDirectUrls.length} discovered direct URL(s) (0 user-pasted URLs provided)`
        : urlReason,
  });

  // 3) playwright
  const pwProvider = new PlaywrightTikTokProvider();
  const pwReason = pwProvider.isConfigured()
    ? 'Enabled'
    : 'Disabled by default in settings (TikTok blocks headless browser search without residential proxy / CAPTCHA solver)';
  providerProbes.push({
    provider: 'playwright',
    httpStatus: 0,
    latencyMs: 0,
    rawResultsCount: 0,
    tiktokUrlsParsed: 0,
    oembedOkCount: 0,
    oembedFailCount: 0,
    circuitOpen: isCircuitOpen('playwright'),
    firstError: pwReason,
    sampleUrls: [],
  });
  providersReport.push({
    provider: 'playwright',
    configured: pwProvider.isConfigured(),
    candidatesReturned: 0,
    sampleCandidates: [],
    failureOrSkipReason: pwReason,
  });

  // 4) apify
  const apifyProvider = new ApifyTikTokProvider();
  const apifyReason = apifyProvider.isConfigured()
    ? 'Enabled'
    : 'Skipped: APIFY_TOKEN environment variable is not configured in this environment';
  providerProbes.push({
    provider: 'apify',
    httpStatus: 0,
    latencyMs: 0,
    rawResultsCount: 0,
    tiktokUrlsParsed: 0,
    oembedOkCount: 0,
    oembedFailCount: 0,
    circuitOpen: isCircuitOpen('apify'),
    firstError: apifyReason,
    sampleUrls: [],
  });
  providersReport.push({
    provider: 'apify',
    configured: apifyProvider.isConfigured(),
    candidatesReturned: 0,
    sampleCandidates: [],
    failureOrSkipReason: apifyReason,
  });

  return {
    queriesUsed: queries,
    ytDlpStatus,
    searchEngineRoutes: engineReports,
    providerProbes,
    providers: providersReport,
  };
}

/**
 * Unified TikTok Adapter orchestrating enabled providers according to runtime settings & circuit breaker.
 */
export async function* searchTikTokProviders(
  identity: IdentityCardV2,
  opts: TikTokSearchOptions,
  signal?: AbortSignal
): AsyncIterable<TikTokVideoCandidate> {
  const settings = getRuntimeSettings();
  const orderList = Array.isArray(settings.tiktokProviders?.order)
    ? settings.tiktokProviders.order
    : (['serp-hydration', 'url-import', 'playwright', 'apify'] as const);
  const sortedFromSettings = orderList.filter(
    (name) => settings.tiktokProviders?.enabled?.[name] ?? true
  );

  const configuredOrder =
    sortedFromSettings.length > 0
      ? sortedFromSettings
      : (process.env.TIKTOK_PROVIDERS || 'url-import,serp-hydration,playwright,apify')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

  const seenVideoIds = new Set<string>();

  for (const name of configuredOrder) {
    if (signal?.aborted) break;
    const provider = ALL_PROVIDERS.find((p) => p.name === name);
    if (!provider || !provider.isConfigured()) continue;
    if (isCircuitOpen(provider.name)) {
      console.warn(`[TikTokAdapter] Skipping provider "${provider.name}" (circuit open)`);
      continue;
    }

    try {
      for await (const candidate of provider.search(identity, opts, signal)) {
        if (signal?.aborted) break;
        if (seenVideoIds.has(candidate.videoId)) continue;
        seenVideoIds.add(candidate.videoId);
        yield candidate;
      }
    } catch (err) {
      recordProviderFailure(provider.name, err);
    }
  }
}
