import type { IdentityCardV2, MatchMode } from '../../pipeline/identity.ts';

export interface TikTokProviderFunnelReport {
  provider: string;
  query?: string;
  serpResults: number;
  tiktokUrlsParsed: number;
  oembedOk: number;
  preRankedPassed: number;
  sentToFrameVerification: number;
  acceptedCount: number;
}

export interface TikTokVideoCandidate {
  videoId: string;
  canonicalUrl: string;
  title: string;
  playAddr: string;
  thumbnailUrl?: string;
  embedHtml?: string;
  hasDirectMp4?: boolean;
  downloadFailureReason?: string;
  authorHandle: string;
  authorNickname?: string;
  durationSeconds?: number;
  playCount: number;
  diggCount: number;
  commentCount: number;
  cookieHeader: string;
  providerName: 'url-import' | 'serp-hydration' | 'playwright' | 'apify';
  discoveryEngine?: string;
  discoveryQuery?: string;
  preRankScore?: number;
  preRankClipSim?: number;
  preRankDiscriminatorOverlap?: number;
}

export interface TikTokSearchOptions {
  directUrls?: string[];
  customQueries?: string[];
  maxCandidates?: number;
  topMForVerification?: number;
  matchMode?: MatchMode;
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  onFunnelReport?: (report: TikTokProviderFunnelReport) => void;
}

export interface TikTokProvider {
  readonly name: 'url-import' | 'serp-hydration' | 'playwright' | 'apify';
  isConfigured(): boolean;
  search(
    identity: IdentityCardV2,
    opts: TikTokSearchOptions,
    signal?: AbortSignal
  ): AsyncIterable<TikTokVideoCandidate>;
}
