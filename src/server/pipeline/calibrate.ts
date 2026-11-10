import fs from 'node:fs';
import path from 'node:path';

export interface CalibrationConfig {
  version: number;
  calibratedAt: string;
  clipModelId: string;
  stage1LocalMinShapeSimilarity: number;
  stage1LocalDirectRejectSimilarity: number;
  stage1MustNotBeOverrideClipSimilarity: number;
  stage2MustNotBeRejectConfidence: number;
  stage2AcceptMinConfidence: number;
  strictColorMinHistogramSimilarity: number;
  videoDedupeMaxHammingDistance: number;
  maxGeminiCallsPerDay: number;
  maxStage2BatchSize: number;
  snowballMinVerifiedListings: number;
  maxConsecutiveZeroYieldPages: number;
  calibrationMetrics?: {
    positiveCount: number;
    negativeCount: number;
    precision: number;
    recall: number;
    f1Score: number;
    positiveMeanClipSim: number;
    negativeMeanClipSim: number;
  };
  notes?: string;
}

const CALIBRATION_PATH = path.resolve(process.cwd(), 'config', 'calibration.json');

const DEFAULT_CALIBRATION: CalibrationConfig = {
  version: 3,
  calibratedAt: new Date().toISOString(),
  clipModelId: 'Xenova/clip-vit-base-patch32',
  stage1LocalMinShapeSimilarity: 0.58,
  stage1LocalDirectRejectSimilarity: 0.42,
  stage1MustNotBeOverrideClipSimilarity: 0.94,
  stage2MustNotBeRejectConfidence: 0.58,
  stage2AcceptMinConfidence: 0.60,
  strictColorMinHistogramSimilarity: 0.62,
  videoDedupeMaxHammingDistance: 8,
  maxGeminiCallsPerDay: Number(process.env.MAX_GEMINI_CALLS_PER_DAY) || 1500,
  maxStage2BatchSize: 4,
  snowballMinVerifiedListings: 1,
  maxConsecutiveZeroYieldPages: 2,
};

let cachedCalibration: CalibrationConfig | null = null;

export function invalidateCalibrationCache(): void {
  cachedCalibration = null;
}

export function getCalibrationConfig(): CalibrationConfig {
  if (cachedCalibration) return cachedCalibration;
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf-8'));
      const loaded: CalibrationConfig = {
        ...DEFAULT_CALIBRATION,
        ...raw,
        maxGeminiCallsPerDay:
          Number(process.env.MAX_GEMINI_CALLS_PER_DAY) ||
          raw.maxGeminiCallsPerDay ||
          DEFAULT_CALIBRATION.maxGeminiCallsPerDay,
      };
      cachedCalibration = loaded;
      return loaded;
    }
  } catch (err) {
    console.warn('[Calibration] Failed to load config/calibration.json:', (err as Error)?.message || err);
  }
  cachedCalibration = DEFAULT_CALIBRATION;
  return DEFAULT_CALIBRATION;
}
