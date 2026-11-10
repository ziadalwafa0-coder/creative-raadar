import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';
import type { IdentityCardV2 } from './identity.ts';
import type { QueryScoreboardRow, VerdictTier } from '../../types/index.ts';
import {
  computeColorAgnosticClipEmbedding,
  cosineSimilarityClip,
} from './clipEmbedding.ts';
import { fetchProductImageAsBase64 } from '../amazonHttp.ts';

const LEARNED_QUERIES_FILE = path.join(DATA_DIR, 'learned_queries.json');

export interface LearnedProductQueryEntry {
  imageHash: string;
  productNameEn: string;
  positiveNgrams: string[];
  negativeTerms: string[];
  bestAmazonQueries: string[];
  bestTikTokQueries: string[];
  autocompleteSuggestions: string[];
  updatedAt: string;
}

const learnedQueriesStore = new Map<string, LearnedProductQueryEntry>();

function loadLearnedQueriesFromDisk(): void {
  try {
    if (fs.existsSync(LEARNED_QUERIES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LEARNED_QUERIES_FILE, 'utf-8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === 'object' && (v as any).productNameEn) {
            learnedQueriesStore.set(k, v as LearnedProductQueryEntry);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[QueryIntelligence] Failed to load learned_queries.json:', (err as Error)?.message);
  }
}

function saveLearnedQueriesToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const obj: Record<string, LearnedProductQueryEntry> = {};
    for (const [k, v] of learnedQueriesStore.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(LEARNED_QUERIES_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[QueryIntelligence] Failed to save learned_queries.json:', (err as Error)?.message);
  }
}

loadLearnedQueriesFromDisk();

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'your',
  'home',
  'use',
  'new',
  'best',
  'high',
  'quality',
  'pack',
  'set',
  'pcs',
  'piece',
  'pieces',
  'amazon',
  'tiktok',
  'video',
  'review',
  'unboxing',
]);

/**
 * Phase 4.1(d): Live Amazon Marketplace Autocomplete / Suggestion API fetcher.
 * Uses Amazon's public completion API (HTTP 200 JSON) for US and UK.
 */
export async function fetchAmazonMarketplaceSuggestions(
  prefix: string,
  marketplace: 'US' | 'UK' = 'US',
  signal?: AbortSignal
): Promise<string[]> {
  const cleanPrefix = String(prefix || '')
    .replace(/[^\w\s\u0600-\u06FF-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanPrefix || cleanPrefix.length < 3) return [];

  const endpoint =
    marketplace === 'UK'
      ? `https://completion.amazon.co.uk/api/2017/suggestions?mid=A1F83G8C2ARO7P&alias=aps&prefix=${encodeURIComponent(cleanPrefix)}`
      : `https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=aps&prefix=${encodeURIComponent(cleanPrefix)}`;

  try {
    const res = await fetch(endpoint, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(4500)])
        : AbortSignal.timeout(4500),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { suggestions?: Array<{ value?: string }> };
    if (!Array.isArray(data?.suggestions)) return [];
    const out: string[] = [];
    for (const s of data.suggestions) {
      const val = String(s?.value || '').trim();
      if (val && val.length >= 3 && !out.includes(val)) {
        out.push(val);
      }
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Tokenizes a title into 1-grams and 2-grams for TF-IDF ranking.
 */
function extractNgrams(text: string): string[] {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s.-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  const ngrams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return Array.from(new Set(ngrams));
}

/**
 * Phase 4.1(c) & 4.3: Ranks n-grams from VERIFIED listing titles by TF-IDF against REJECTED titles
 * (positive terms) and the reverse for negative terms.
 */
export function rankNgramsTfIdf(
  verifiedTitles: string[],
  rejectedTitles: string[],
  mustNotBe: string[] = []
): {
  positiveNgrams: Array<{ term: string; score: number }>;
  negativeTerms: Array<{ term: string; score: number }>;
} {
  const posCounts = new Map<string, number>();
  const negCounts = new Map<string, number>();

  for (const title of verifiedTitles) {
    for (const ng of extractNgrams(title)) {
      posCounts.set(ng, (posCounts.get(ng) || 0) + 1);
    }
  }

  for (const title of rejectedTitles) {
    for (const ng of extractNgrams(title)) {
      negCounts.set(ng, (negCounts.get(ng) || 0) + 1);
    }
  }

  const posTotal = Math.max(1, verifiedTitles.length);
  const negTotal = Math.max(1, rejectedTitles.length);

  const positiveNgrams: Array<{ term: string; score: number }> = [];
  for (const [term, count] of posCounts.entries()) {
    const tfPos = count / posTotal;
    const dfNeg = negCounts.get(term) || 0;
    const idf = Math.log((negTotal + 1) / (dfNeg + 0.5)) + 1;
    const score = Number((tfPos * idf).toFixed(4));
    if (score > 0.15) {
      positiveNgrams.push({ term, score });
    }
  }
  positiveNgrams.sort((a, b) => b.score - a.score);

  const negativeTerms: Array<{ term: string; score: number }> = [];
  for (const rawMustNot of mustNotBe) {
    const clean = rawMustNot.toLowerCase().trim();
    if (clean.length >= 3) {
      negativeTerms.push({ term: clean, score: 2.0 });
    }
  }
  for (const [term, count] of negCounts.entries()) {
    if (posCounts.has(term)) continue; // never penalize terms that appear in verified titles
    const tfNeg = count / negTotal;
    const idf = Math.log((posTotal + 1) / 0.5) + 1;
    const score = Number((tfNeg * idf).toFixed(4));
    if (count >= 2 || score >= 0.5) {
      negativeTerms.push({ term, score });
    }
  }
  negativeTerms.sort((a, b) => b.score - a.score);

  return {
    positiveNgrams: positiveNgrams.slice(0, 12),
    negativeTerms: negativeTerms.slice(0, 12),
  };
}

import { buildDiscriminatorsForIdentityCard } from './identity.ts';
import { evaluateProductTypeGate } from './verify.ts';

/**
 * PHASE 3.1, 3.2 — Generates precise, discriminator-driven queries per platform:
 * (a) discriminator terms from the Identity Card,
 * (b) anchor-listing title n-grams,
 * (c) EN + AR variants,
 * (d) hashtags,
 * (e) creator-style wording for TikTok,
 * plus negative terms from mustNotBe/sameCategoryLookalikes and rejected-title clusters.
 */
export async function buildIntelligentQueryPlan(params: {
  identity: IdentityCardV2;
  verifiedTitles?: string[];
  rejectedTitles?: string[];
  signal?: AbortSignal;
}): Promise<{
  amazonEnQueries: string[];
  amazonArQueries: string[];
  tiktokEnQueries: string[];
  tiktokArQueries: string[];
  autocompleteSuggestions: string[];
  positiveNgrams: string[];
  negativeTerms: string[];
  discriminatorQueriesEn: string[];
}> {
  const { identity, verifiedTitles = [], rejectedTitles = [], signal } = params;
  const cachedLearned = learnedQueriesStore.get(identity.imageHash);
  const { discriminators, sameCategoryLookalikes } = buildDiscriminatorsForIdentityCard(identity);

  const fullIdentityText = [
    identity.nameEn,
    identity.formFactor.shape,
    identity.mechanism.howItWorks,
    identity.mechanism.powerSource,
    ...identity.mechanism.keyComponents,
    ...identity.mustMatch,
  ].join(' ');

  const voltageMatch = fullIdentityText.match(/\b(\d{1,2}(?:\.\d)?\s*V(?:olt)?)\b/i);
  const hasBrushless = /\bbrushless\b/i.test(fullIdentityText);
  const hasTwoBatteries = /\b(2\s*batter|two\s*batter|dual\s*batter)\b/i.test(fullIdentityText);
  const hasToolKit = /\b(kit|case|box|bit|socket|accessor)\b/i.test(fullIdentityText);
  const isFrontConsolePad =
    /\barmrest\b/i.test(fullIdentityText) &&
    /\b(pad|cushion|quilted|center\s*console)\b/i.test(fullIdentityText);

  const seedPrefix = identity.nameEn.split(/\s+/).slice(0, 4).join(' ');
  const [usSuggestions, ukSuggestions] = await Promise.all([
    fetchAmazonMarketplaceSuggestions(seedPrefix, 'US', signal),
    fetchAmazonMarketplaceSuggestions(identity.nameEn, 'US', signal),
  ]);
  const autocompleteSuggestions = Array.from(
    new Set([...usSuggestions, ...ukSuggestions, ...(cachedLearned?.autocompleteSuggestions || [])])
  ).slice(0, 8);

  const allMustNotBe = Array.from(new Set([...(identity.mustNotBe || []), ...sameCategoryLookalikes]));
  const { positiveNgrams, negativeTerms } = rankNgramsTfIdf(
    verifiedTitles,
    rejectedTitles,
    allMustNotBe
  );

  // Filter out any autocomplete suggestion that hits a negative term / mustNotBe / Type Gate
  const safeSuggestions = autocompleteSuggestions.filter((sug) => {
    const gate = evaluateProductTypeGate(sug, identity);
    if (!gate.passesTypeGate) return false;
    const lower = sug.toLowerCase();
    return !allMustNotBe.some((m) => lower.includes(m.toLowerCase()));
  });

  // (a) Discriminator-specific queries from Identity Card v3
  const discriminatorQueriesEn: string[] = [];
  if (isFrontConsolePad) {
    discriminatorQueriesEn.push(
      'quilted car center console armrest pad with cup holder',
      'car armrest cushion pad with 2 cup holders phone slot side pocket',
      'diamond stitched leather car armrest booster pad cup holder',
      'center console cover pad with dual cup holder tissue slot'
    );
  } else {
    for (const d of discriminators.filter((x) => x.strength === 'hard').slice(0, 3)) {
      const shortDisc = d.name
        .replace(/\([^)]*\)/g, '')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
        .slice(0, 4)
        .join(' ');
      if (shortDisc.length >= 4) {
        discriminatorQueriesEn.push(`${identity.nameEn} ${shortDisc}`.trim());
      }
    }
  }

  // Feature-diversified Amazon seller-title style queries
  const featureQueries: string[] = [];
  if (voltageMatch) {
    featureQueries.push(`${voltageMatch[1].replace(/\s+/g, '')} ${identity.nameEn}`);
  }
  if (hasBrushless) {
    featureQueries.push(`Brushless ${identity.nameEn}`);
  }
  if (hasTwoBatteries) {
    featureQueries.push(`${identity.nameEn} with 2 Batteries and Charger`);
  }
  if (hasToolKit && !/\bkit\b/i.test(identity.nameEn)) {
    featureQueries.push(`${identity.nameEn} Tool Kit with Case`);
  }

  // (b) Mine anchor terms from verified titles
  const anchorQueries: string[] = [];
  for (const vt of verifiedTitles.slice(0, 4)) {
    const cleanWords = vt
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
      .slice(0, 7)
      .join(' ');
    if (cleanWords.length >= 6) {
      anchorQueries.push(cleanWords);
    }
  }

  const amazonEnQueries = Array.from(
    new Set([
      identity.nameEn,
      ...discriminatorQueriesEn,
      ...anchorQueries,
      ...(cachedLearned?.bestAmazonQueries || []),
      ...identity.queries.amazonEn,
      ...featureQueries,
      ...safeSuggestions.slice(0, 4),
      ...identity.queries.tradeNamesEn,
    ])
  )
    .map((q) => q.trim())
    .filter((q) => q.length >= 3 && evaluateProductTypeGate(q, identity).passesTypeGate)
    .slice(0, 12);

  const amazonArQueries = Array.from(
    new Set([
      identity.nameAr,
      ...identity.queries.amazonAr,
      ...(isFrontConsolePad
        ? ['وسادة مسند ذراع السيارة مع حامل أكواب وجيوب جانبية', 'غطاء مسند الكونسول الوسطي مبطن مع حامل أكواب']
        : []),
    ])
  )
    .map((q) => q.trim())
    .filter((q) => q.length >= 3)
    .slice(0, 6);

  // (d) & (e) TikTok creator style queries + discriminator phrases + hashtags
  const shortCoreEn = identity.nameEn.split(/\s+/).slice(0, 5).join(' ');
  const tiktokCreatorQueries = isFrontConsolePad
    ? [
        'car center console armrest pad with cup holder',
        'quilted car armrest cushion cup holder pocket',
        'car armrest booster pad with cup holder review',
        'center console armrest organizer pad cup holder',
        '#cararmrestpad cup holder',
        '#centerconsoleorganizer armrest pad',
      ]
    : [
        `${shortCoreEn} review`,
        `${shortCoreEn} unboxing`,
        ...discriminatorQueriesEn.slice(0, 2),
      ];

  const tiktokEnQueries = Array.from(
    new Set([
      ...tiktokCreatorQueries,
      ...identity.queries.tiktokEn,
      identity.nameEn,
      ...(cachedLearned?.bestTikTokQueries || []),
      ...anchorQueries.slice(0, 2),
      ...safeSuggestions.slice(0, 2),
      ...identity.hashtags.slice(0, 3).map((h) => `#${h.replace(/^#+/, '')}`),
    ])
  )
    .map((q) => q.trim())
    .filter((q) => q.length >= 3 && evaluateProductTypeGate(q, identity).passesTypeGate)
    .slice(0, 10);

  const tiktokArQueries = Array.from(
    new Set([
      ...identity.queries.tiktokAr,
      identity.nameAr,
      `تجربة ${identity.nameAr}`,
      `مراجعة ${identity.nameAr}`,
    ])
  )
    .map((q) => q.trim())
    .filter((q) => q.length >= 3)
    .slice(0, 6);

  const posTermsList = positiveNgrams.map((p) => p.term);
  const negTermsList = negativeTerms.map((n) => n.term);

  learnedQueriesStore.set(identity.imageHash, {
    imageHash: identity.imageHash,
    productNameEn: identity.nameEn,
    positiveNgrams: posTermsList,
    negativeTerms: negTermsList,
    bestAmazonQueries: amazonEnQueries.slice(0, 6),
    bestTikTokQueries: tiktokEnQueries.slice(0, 6),
    autocompleteSuggestions: safeSuggestions,
    updatedAt: new Date().toISOString(),
  });
  saveLearnedQueriesToDisk();

  return {
    amazonEnQueries,
    amazonArQueries,
    tiktokEnQueries,
    tiktokArQueries,
    autocompleteSuggestions: safeSuggestions,
    positiveNgrams: posTermsList,
    negativeTerms: negTermsList,
    discriminatorQueriesEn,
  };
}

/**
 * PHASE 3.3 & 4.2 — Snowball query & candidate expansion ONLY from VERIFIED (V2/V3) items.
 * Never expands from unverified (V0/V1) or rejected items!
 */
export function expandSnowballQueriesFromVerified(params: {
  identity: IdentityCardV2;
  verifiedItems: Array<{
    id: string;
    title: string;
    reviewerOrChannel?: string;
    evidenceLevel?: 'V3' | 'V2' | 'V1' | 'V0';
    verdictTier?: VerdictTier;
    approved?: boolean;
  }>;
  rejectedTitles?: string[];
  alreadyRunQueries: Set<string>;
}): {
  newTikTokQueries: string[];
  newAmazonQueries: string[];
  verifiedCreatorHandles: string[];
  verifiedHashtags: string[];
} {
  // STRICT RULE: Filter to ONLY verified items with evidenceLevel V2 or V3 and approved !== false
  const strictlyVerified = params.verifiedItems.filter(
    (item) =>
      item.approved !== false &&
      (item.evidenceLevel === 'V3' || item.evidenceLevel === 'V2') &&
      (item.verdictTier === 'exact' ||
        item.verdictTier === 'same_design_variant' ||
        item.verdictTier === 'same_type_close_design')
  );

  if (strictlyVerified.length === 0) {
    return {
      newTikTokQueries: [],
      newAmazonQueries: [],
      verifiedCreatorHandles: [],
      verifiedHashtags: [],
    };
  }

  const verifiedCreatorHandles: string[] = [];
  const verifiedHashtags: string[] = [];
  const newTikTokQueries: string[] = [];
  const newAmazonQueries: string[] = [];

  for (const item of strictlyVerified) {
    // 1. Creator handle expansion
    const handle = String(item.reviewerOrChannel || '')
      .replace(/^@+/, '')
      .trim();
    if (
      handle &&
      handle.length >= 3 &&
      !/^(tiktok|amazon|user\d+|creator)$/i.test(handle) &&
      !verifiedCreatorHandles.includes(handle)
    ) {
      verifiedCreatorHandles.push(handle);
    }

    // 2. Hashtags in verified caption
    const tagMatches = String(item.title || '').match(/#([a-zA-Z0-9_\u0600-\u06FF]{3,30})/g) || [];
    for (const rawTag of tagMatches) {
      const cleanTag = rawTag.replace(/^#+/, '').toLowerCase();
      if (
        !['fyp', 'foryou', 'foryoupage', 'viral', 'tiktok', 'tiktokmademebuyit', 'fy'].includes(
          cleanTag
        ) &&
        !verifiedHashtags.includes(cleanTag)
      ) {
        verifiedHashtags.push(cleanTag);
      }
    }
  }

  const { positiveNgrams } = rankNgramsTfIdf(
    strictlyVerified.map((x) => x.title),
    params.rejectedTitles || [],
    params.identity.mustNotBe
  );

  const coreNoun = params.identity.nameEn.split(/\s+/).slice(0, 3).join(' ');
  for (const ng of positiveNgrams.slice(0, 4)) {
    if (ng.term.includes(' ')) {
      const candidateQ = `${coreNoun} ${ng.term}`.trim();
      if (
        !params.alreadyRunQueries.has(candidateQ.toLowerCase()) &&
        evaluateProductTypeGate(candidateQ, params.identity).passesTypeGate
      ) {
        newTikTokQueries.push(candidateQ);
        newAmazonQueries.push(candidateQ);
      }
    }
  }

  for (const tag of verifiedHashtags.slice(0, 3)) {
    const tagQ = `#${tag} ${coreNoun}`;
    if (!params.alreadyRunQueries.has(tagQ.toLowerCase())) {
      newTikTokQueries.push(tagQ);
    }
  }

  for (const handle of verifiedCreatorHandles.slice(0, 3)) {
    const handleQ = `@${handle} ${coreNoun}`;
    if (!params.alreadyRunQueries.has(handleQ.toLowerCase())) {
      newTikTokQueries.push(handleQ);
    }
  }

  return {
    newTikTokQueries: newTikTokQueries.slice(0, 5),
    newAmazonQueries: newAmazonQueries.slice(0, 4),
    verifiedCreatorHandles: verifiedCreatorHandles.slice(0, 5),
    verifiedHashtags: verifiedHashtags.slice(0, 6),
  };
}

/**
 * PHASE 3.3 & 3.4 — Query Probing & Scoreboard:
 * Computes local CLIP similarity + discriminator/type-gate pass rate on the first page of a query,
 * producing `probeAcceptedRate`, `probePassed`, `parsedCount`, and `acceptedCount`.
 */
export async function scoreQueryByEvidence(params: {
  query: string;
  marketplace: string;
  source: 'amazon' | 'tiktok';
  identity?: IdentityCardV2 | null;
  parsedCount?: number;
  negativeTermsApplied?: string[];
  topCandidates: Array<{
    id: string;
    title: string;
    imageUrl?: string;
    verdictTier?: VerdictTier;
    clipSimilarity?: number;
  }>;
  referenceImageBuffer?: Buffer;
  acceptedCount?: number;
  videosFound?: number;
  probeThreshold?: number;
  signal?: AbortSignal;
}): Promise<QueryScoreboardRow> {
  const {
    query,
    marketplace,
    source,
    identity,
    parsedCount,
    negativeTermsApplied = [],
    topCandidates,
    referenceImageBuffer,
    acceptedCount = 0,
    probeThreshold = 0.2,
    signal,
  } = params;

  const tierDistribution: Partial<Record<VerdictTier, number>> = {};
  let simSum = 0;
  let simCount = 0;
  let probePassItems = 0;

  let refEmb: number[] | null = null;
  if (referenceImageBuffer) {
    try {
      const r = await computeColorAgnosticClipEmbedding(referenceImageBuffer);
      refEmb = r.embedding;
    } catch {}
  }

  const sample = topCandidates.slice(0, 8);
  for (const c of sample) {
    let itemSim = typeof c.clipSimilarity === 'number' ? c.clipSimilarity : 0;
    if (itemSim <= 0 && refEmb && c.imageUrl && !c.imageUrl.endsWith('.svg')) {
      try {
        const fetched = await fetchProductImageAsBase64(c.imageUrl, signal);
        if (fetched?.base64) {
          const buf = Buffer.from(fetched.base64, 'base64');
          const emb = await computeColorAgnosticClipEmbedding(buf);
          itemSim = cosineSimilarityClip(refEmb, emb.embedding);
        }
      } catch {}
    }

    if (itemSim > 0) {
      simSum += itemSim;
      simCount++;
    }

    const passesType = identity ? evaluateProductTypeGate(c.title, identity).passesTypeGate : true;
    const isTierOk =
      c.verdictTier === 'exact' ||
      c.verdictTier === 'same_design_variant' ||
      c.verdictTier === 'same_type_close_design';

    if (isTierOk || (passesType && itemSim >= 0.48)) {
      probePassItems++;
    }

    if (c.verdictTier) {
      tierDistribution[c.verdictTier] = (tierDistribution[c.verdictTier] || 0) + 1;
    }
  }

  const avgSim = simCount > 0 ? simSum / simCount : 0;
  const probeAcceptedRate =
    sample.length > 0
      ? Number((probePassItems / sample.length).toFixed(3))
      : topCandidates.length > 0
      ? Number((acceptedCount / topCandidates.length).toFixed(3))
      : 0;
  const probePassed = sample.length === 0 ? false : probeAcceptedRate >= probeThreshold || acceptedCount > 0;
  const resultRate = topCandidates.length > 0 ? acceptedCount / topCandidates.length : 0;
  const precisionProxy = Number(
    (simCount > 0 ? avgSim * 0.5 + probeAcceptedRate * 0.3 + resultRate * 0.2 : probeAcceptedRate).toFixed(3)
  );

  return {
    query,
    marketplace,
    source,
    round: 'R1_query_intelligence',
    resultsCount: topCandidates.length,
    parsedCount: parsedCount ?? topCandidates.length,
    inspectedCount: topCandidates.length,
    probeAcceptedRate,
    probePassed,
    acceptedCount,
    exactOrVariantCount:
      (tierDistribution.exact || 0) + (tierDistribution.same_design_variant || 0),
    similarCount:
      (tierDistribution.same_type_close_design || 0) +
      (tierDistribution.same_type_other_design || 0),
    otherTypeCount: (tierDistribution.other_type || 0) + (tierDistribution.unrelated || 0),
    avgClipSimilarity: Number(avgSim.toFixed(3)),
    precisionProxy,
    negativeTermsApplied,
    status: topCandidates.length > 0 ? (probePassed ? 'ok' : 'dropped_by_probe') : 'empty',
  };
}
