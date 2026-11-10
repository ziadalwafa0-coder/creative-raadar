import fs from 'node:fs';
import path from 'node:path';
import { getCalibrationConfig, invalidateCalibrationCache } from './pipeline/calibrate.ts';

export type StrictnessPreset = 'strict' | 'balanced' | 'lenient';
export type AttributeStrength = 'hard' | 'soft' | 'ignore' | 'HARD' | 'SOFT' | 'IGNORE';
export type AmazonSortVariant = 'relevance' | 'review-rank' | 'popularity-rank';

export interface RuntimeTuningSettings {
  version: number;
  updatedAt: string;
  strictnessPreset: StrictnessPreset;
  matchMode: 'same_design' | 'strict_color';
  includeSimilar: boolean;
  minimumEffort?: {
    minQueries: number;
    minPagesPerMarketplace: number;
    minListingsInspected: number;
  };
  autoRelaxation?: {
    enabled: boolean;
    countSimilarTowardTarget: boolean;
  };
  thresholds: {
    stage1ClipMin: number;
    stage1TikTokClipMin: number;
    stage2ConfidenceMin: number;
    stage2MustNotBeConfidence: number;
    videoDedupeHamming: number;
    stage1LocalDirectRejectSimilarity?: number;
    stage2AcceptMinConfidence?: number;
  };
  searchDepth: {
    maxPagesPerQuery: number;
    pagesPerQuery?: number;
    maxQueries: number;
    maxListingsToInspect: number;
    consecutiveZeroYieldPagesStop: number;
    consecutiveZeroYieldStopK?: number;
    sortVariants: AmazonSortVariant[];
    enableAnchorSnowball: boolean;
    enableRealKeyframeCheck: boolean;
  };
  marketplaces: Record<'US' | 'UK' | 'DE' | 'CA' | 'AE' | 'SA' | 'EG', boolean>;
  sourceCaps: {
    amazonMax: number;
    tiktokMax: number;
    amazonMaxVideos?: number;
    tiktokMaxVideos?: number;
  };
  geminiDailyBudget: number;
  tiktokProviders: {
    order: Array<'serp-hydration' | 'url-import' | 'playwright' | 'apify'>;
    enabled: Record<'serp-hydration' | 'url-import' | 'playwright' | 'apify', boolean>;
    serpHydration?: boolean;
    urlImport?: boolean;
    playwright?: boolean;
    apify?: boolean;
  };
  attributeStrengthOverrides: Record<string, AttributeStrength>;
}

const SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'settings.json');

export function getDefaultRuntimeSettings(): RuntimeTuningSettings {
  const cal = getCalibrationConfig();
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    strictnessPreset: 'balanced',
    matchMode: 'same_design',
    includeSimilar: true,
    minimumEffort: {
      minQueries: 3,
      minPagesPerMarketplace: 1,
      minListingsInspected: 10,
    },
    autoRelaxation: {
      enabled: true,
      countSimilarTowardTarget: true,
    },
    thresholds: {
      stage1ClipMin: cal.stage1LocalDirectRejectSimilarity || 0.42,
      stage1TikTokClipMin: 0.34,
      stage2ConfidenceMin: cal.stage2AcceptMinConfidence || 0.60,
      stage2MustNotBeConfidence: cal.stage2MustNotBeRejectConfidence || 0.58,
      videoDedupeHamming: cal.videoDedupeMaxHammingDistance || 8,
      stage1LocalDirectRejectSimilarity: cal.stage1LocalDirectRejectSimilarity || 0.42,
      stage2AcceptMinConfidence: cal.stage2AcceptMinConfidence || 0.60,
    },
    searchDepth: {
      maxPagesPerQuery: 4,
      pagesPerQuery: 4,
      maxQueries: 8,
      maxListingsToInspect: 200,
      consecutiveZeroYieldPagesStop: cal.maxConsecutiveZeroYieldPages || 2,
      consecutiveZeroYieldStopK: cal.maxConsecutiveZeroYieldPages || 2,
      sortVariants: ['relevance', 'review-rank', 'popularity-rank'],
      enableAnchorSnowball: true,
      enableRealKeyframeCheck: true,
    },
    marketplaces: {
      US: true,
      UK: true,
      DE: false,
      CA: false,
      AE: false,
      SA: false,
      EG: false,
    },
    sourceCaps: {
      amazonMax: 500,
      tiktokMax: 500,
      amazonMaxVideos: 500,
      tiktokMaxVideos: 500,
    },
    geminiDailyBudget: cal.maxGeminiCallsPerDay || 1500,
    tiktokProviders: {
      order: ['serp-hydration', 'url-import', 'playwright', 'apify'],
      enabled: {
        'serp-hydration': true,
        'url-import': true,
        playwright: false,
        apify: false,
      },
      serpHydration: true,
      urlImport: true,
      playwright: false,
      apify: false,
    },
    attributeStrengthOverrides: {},
  };
}

export function applyPresetThresholds(
  preset: StrictnessPreset,
  base: RuntimeTuningSettings
): RuntimeTuningSettings {
  if (preset === 'strict') {
    return {
      ...base,
      strictnessPreset: 'strict',
      includeSimilar: false,
      thresholds: {
        ...base.thresholds,
        stage1ClipMin: 0.52,
        stage1TikTokClipMin: 0.42,
        stage2ConfidenceMin: 0.72,
        stage2MustNotBeConfidence: 0.50,
      },
    };
  }
  if (preset === 'lenient') {
    return {
      ...base,
      strictnessPreset: 'lenient',
      includeSimilar: true,
      thresholds: {
        ...base.thresholds,
        stage1ClipMin: 0.35,
        stage1TikTokClipMin: 0.28,
        stage2ConfidenceMin: 0.50,
        stage2MustNotBeConfidence: 0.68,
      },
    };
  }
  return {
    ...base,
    strictnessPreset: 'balanced',
    thresholds: {
      ...base.thresholds,
      stage1ClipMin: 0.42,
      stage1TikTokClipMin: 0.34,
      stage2ConfidenceMin: 0.60,
      stage2MustNotBeConfidence: 0.58,
    },
  };
}

export function getRuntimeSettings(): RuntimeTuningSettings {
  const defaults = getDefaultRuntimeSettings();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return {
        ...defaults,
        ...raw,
        minimumEffort: { ...defaults.minimumEffort!, ...(raw.minimumEffort || {}) },
        autoRelaxation: { ...defaults.autoRelaxation!, ...(raw.autoRelaxation || {}) },
        thresholds: { ...defaults.thresholds, ...(raw.thresholds || {}) },
        searchDepth: { ...defaults.searchDepth, ...(raw.searchDepth || {}) },
        marketplaces: { ...defaults.marketplaces, ...(raw.marketplaces || {}) },
        sourceCaps: { ...defaults.sourceCaps, ...(raw.sourceCaps || {}) },
        tiktokProviders: {
          order: Array.isArray(raw.tiktokProviders?.order)
            ? raw.tiktokProviders.order
            : defaults.tiktokProviders.order,
          enabled: {
            ...defaults.tiktokProviders.enabled,
            ...(raw.tiktokProviders?.enabled || {}),
          },
          serpHydration: raw.tiktokProviders?.serpHydration ?? defaults.tiktokProviders.serpHydration,
          urlImport: raw.tiktokProviders?.urlImport ?? defaults.tiktokProviders.urlImport,
          playwright: raw.tiktokProviders?.playwright ?? defaults.tiktokProviders.playwright,
          apify: raw.tiktokProviders?.apify ?? defaults.tiktokProviders.apify,
        },
        attributeStrengthOverrides: {
          ...defaults.attributeStrengthOverrides,
          ...(raw.attributeStrengthOverrides || {}),
        },
      };
    }
  } catch (err) {
    console.warn('[Settings] Failed to read config/settings.json:', (err as Error)?.message);
  }
  return defaults;
}

export function updateRuntimeSettings(
  patch: Partial<RuntimeTuningSettings> & { applyPreset?: StrictnessPreset }
): RuntimeTuningSettings {
  let current = getRuntimeSettings();
  if (patch.applyPreset) {
    current = applyPresetThresholds(patch.applyPreset, current);
  }
  const merged: RuntimeTuningSettings = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    minimumEffort: {
      ...current.minimumEffort!,
      ...(patch.minimumEffort || {}),
    },
    autoRelaxation: {
      ...current.autoRelaxation!,
      ...(patch.autoRelaxation || {}),
    },
    thresholds: {
      ...current.thresholds,
      ...(patch.thresholds || {}),
    },
    searchDepth: {
      ...current.searchDepth,
      ...(patch.searchDepth || {}),
    },
    marketplaces: {
      ...current.marketplaces,
      ...(patch.marketplaces || {}),
    },
    sourceCaps: {
      ...current.sourceCaps,
      ...(patch.sourceCaps || {}),
    },
    tiktokProviders: {
      order: Array.isArray(patch.tiktokProviders?.order)
        ? patch.tiktokProviders!.order
        : current.tiktokProviders.order,
      enabled: {
        ...current.tiktokProviders.enabled,
        ...(patch.tiktokProviders?.enabled || {}),
      },
      serpHydration: patch.tiktokProviders?.serpHydration ?? current.tiktokProviders.serpHydration,
      urlImport: patch.tiktokProviders?.urlImport ?? current.tiktokProviders.urlImport,
      playwright: patch.tiktokProviders?.playwright ?? current.tiktokProviders.playwright,
      apify: patch.tiktokProviders?.apify ?? current.tiktokProviders.apify,
    },
    attributeStrengthOverrides: {
      ...current.attributeStrengthOverrides,
      ...(patch.attributeStrengthOverrides || {}),
    },
  };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    invalidateCalibrationCache();
  } catch (err) {
    console.warn('[Settings] Failed to write config/settings.json:', (err as Error)?.message);
  }
  return merged;
}
