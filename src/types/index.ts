export type MediaType = 'video' | 'photo' | 'both';

export type MatchStrictness = 'exact' | 'color_allowed' | 'similar_disclosed';

export type ContentSourcePreference = 'customer_only' | 'customer_and_creator' | 'all_including_seller';

export type SourcePlatform = 'amazon' | 'youtube' | 'tiktok' | 'aliexpress' | 'walmart' | 'direct_web';

export type ProvenanceClassification =
  | 'verified_purchase_review'
  | 'unverified_customer_review'
  | 'vine_free_product'
  | 'affiliate_creator_demo'
  | 'seller_manufacturer_demo'
  | 'unresolved_source';

export type MatchCategory =
  | 'exact_design'
  | 'permitted_variation'
  | 'same_category_similar'
  | 'similar_differences'
  | 'mismatched'
  | 'insufficient_evidence';

export type JobState =
  | 'idle'
  | 'queued'
  | 'analyzing'
  | 'searching'
  | 'inspecting'
  | 'downloading'
  | 'verifying'
  | 'packaging'
  | 'completed'
  | 'completed_partial'
  | 'needs_configuration'
  | 'failed'
  | 'cancelled';

export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'verified_available'
  | 'source_only'
  | 'download_failed'
  | 'unsupported_provider';

export type MatchMode = 'same_design' | 'strict_color';

export type AttributeStrength = 'hard' | 'soft' | 'ignore' | 'HARD' | 'SOFT' | 'IGNORE';

export type VerdictTier =
  | 'exact'
  | 'same_design_variant'
  | 'same_type_close_design'
  | 'same_type_other_design'
  | 'other_type'
  | 'unrelated'
  | 'unverified';

export type EvidenceLevel = 'V3' | 'V2' | 'V1' | 'V0';

export type LinkState = 'alive' | 'blocked' | 'dead';

export interface DiscriminatorSpec {
  id: string;
  name: string;
  nameAr?: string;
  expectedValue: string;
  strength: 'hard' | 'soft' | 'ignore';
  evidencePhrase: string;
}

export interface BoundingBox2D {
  frameIndex: number;
  ymin: number; // 0..1000
  xmin: number; // 0..1000
  ymax: number; // 0..1000
  xmax: number; // 0..1000
  label?: string;
}

export interface BlindDiscriminatorObservation {
  discriminatorId: string;
  discriminatorName: string;
  strength: 'hard' | 'soft' | 'ignore';
  observedStatus: 'present_match' | 'present_conflict' | 'not_visible';
  observedValue: string;
  frameIndices: number[];
}

export type StopReasonCode =
  | 'target_reached'
  | 'exhausted_candidates'
  | 'insufficient_search'
  | 'amazon_blocked'
  | 'tiktok_unreachable'
  | 'gemini_budget'
  | 'timeout'
  | 'user_cancelled'
  | `provider_failed:${string}`;

export interface QueryScoreboardRow {
  query: string;
  source: 'amazon' | 'tiktok';
  marketplace: string;
  round: string;
  resultsCount: number;
  parsedCount?: number;
  probeAcceptedRate?: number | null;
  inspectedCount: number;
  acceptedCount: number;
  exactOrVariantCount: number;
  similarCount: number;
  otherTypeCount: number;
  avgClipSimilarity: number;
  precisionProxy: number | null;
  negativeTermsApplied?:string[];probePassed?:boolean;probeSampleSize?:number;
  status: string;
}

export interface IdentityAttributeSpec {
  name: string;
  strength: AttributeStrength;
}

export interface IdentityCardV2Client {
  imageHash: string;
  nameEn: string;
  nameAr: string;
  category: string;
  primaryColor: string;
  placement?: string;
  constructionType?: string;
  formFactor: {
    shape: string;
    approximateSize: string;
    orientationPlacement: string;
  };
  mechanism: {
    howItWorks: string;
    powerSource: string;
    keyComponents: string[];
  };
  discriminators?: DiscriminatorSpec[];
  sameCategoryLookalikes?: string[];
  mustMatch: string[];
  attributeStrengths?: Record<string, AttributeStrength>;
  variableAttributes: string[];
  mustNotBe: string[];
  queries: {
    amazonEn: string[];
    amazonAr: string[];
    tiktokEn: string[];
    tiktokAr: string[];
    tradeNamesEn: string[];
  };
  hashtags: string[];
  confidence: number;
  ambiguity: string[];
}

export interface RejectedCandidateItem {
  extractedFrameUrls?:string[];
  id: string;
  source: 'amazon' | 'tiktok';
  marketplace?: string;
  provider?: string;
  entityType: 'listing' | 'video';
  title: string;
  url: string;
  imageUrl?: string;
  reasonCode?: string;
  reasonLabelAr?: string;
  failedAttribute?: string;
  reasonAr: string;
  verdict: string;
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  linkState?: LinkState;
  stage?: string;
  mustNotBeHit?: string[];
  referenceSimilarity?: number;
  cropClipSimilarity?: number;
  acceptedByUser?: boolean;
}

export interface ReasonHistogramEntry {
  reasonCode: string;
  labelAr: string;
  count: number;
  isErrorNotRejection?: boolean;
  examples: Array<{
    id: string;
    title: string;
    url: string;
    imageUrl?: string;
    reasonAr: string;
    source: string;
  }>;
}

export interface FunnelStageSummary {
  stageId:
    | 'found'
    | 'deduped'
    | 'text_prefilter'
    | 'local_visual'
    | 'gemini_attribute_check'
    | 'accepted';
  labelAr: string;
  inCount: number;
  outCount: number;
  droppedCount: number;
  unverifiedCount?: number;
  reasons: ReasonHistogramEntry[];
}

export interface SourceFunnelBreakdown {
  scopeKey: string; // e.g. 'amazon', 'tiktok', 'amazon:US', 'tiktok:serp-hydration'
  labelAr: string;
  source: 'amazon' | 'tiktok' | 'all';
  marketplace?: string;
  provider?: string;
  stages: FunnelStageSummary[];
}

export interface QueryPlanRow {
  round: string;
  source: string;
  marketplace: string;
  sortVariant: string;
  query: string;
  pagesFetched: number;
  listingsReturned: number;
  listingsNew: number;
  listingsAccepted: number;
  videosFound: number;
  durationMs: number;
  status: string;
  error?: string;
}

export interface RejectionOverrideWarning {
  reasonCode: string;
  labelAr: string;
  totalRejected: number;
  overriddenCount: number;
  overrideRatio: number;
  warningAr: string;
  suggestionAr: string;
}

export interface TikTokProviderProbeItem {
  provider: string;
  engine?: string;
  configured?: boolean;
  circuitOpen: boolean;
  httpStatus: number;
  latencyMs: number;
  rawResultsCount: number;
  tiktokUrlsParsed: number;
  oembedOkCount: number;
  oembedFailCount: number;
  firstError?: string;
  sampleUrls?: string[];
}

export interface SearchBreakdownSummary {
  identityCard?:IdentityCardV2Client;
  searchId?: string;
  requestedVideos: number;
  emittedVideos: number;
  matchedCount?: number;
  similarCount?: number;
  relaxationPassesRun?: number;
  unverifiedVideosCount?: number;
  unverifiedListingsCount?: number;
  verificationErrorsCount?: number;
  budgetExhaustedCount?: number;
  rejectedTotal?: number;
  rejected_by_text_prefilter?: number;
  rejected_by_local_visual?: number;
  rejected_by_gemini?: number;
  rejected_by_hard_attribute?: number;
  verification_error?: number;
  duplicates?: number;
  minimumEffortMet?: boolean;
  amazonRequested?: number;
  amazonMaxCap?: number;
  amazonEmitted?: number;
  tiktokRequested?: number;
  tiktokMaxCap?: number;
  tiktokEmitted?: number;
  tiktokDownloadFailedButKeptCount?: number;
  pagesFetched: number;
  marketplacesSearched: string[];
  marketplaceProbes?: Array<{
    marketplace: string;
    enabled: boolean;
    httpStatus: number;
    exposesVideos: boolean;
    reason: string;
  }>;
  listingsDiscovered: number;
  listingsDeduped?: number;
  listingsInspected: number;
  listingsAccepted: number;
  listingsRejected: number;
  tierCounts?: Record<VerdictTier, number>;
  evidenceLevelHistogram?: Record<EvidenceLevel, number>;
  linkStateHistogram?: Record<LinkState, number>;
  perAttributeRejectionHistogram?: Record<string, number>;
  tiktokProviderFunnels?: Array<{
    provider: string;
    query?: string;
    serpResults: number;
    tiktokUrlsParsed: number;
    oembedOk: number;
    preRankedPassed: number;
    sentToFrameVerification: number;
    acceptedCount: number;
  }>;
  ownerPrecisionStats?: {
    totalLabelled: number;
    sameProductCount: number;
    differentProductCount: number;
    precisionPercent: number;
    precisionByTier?: Record<string, { same: number; total: number; pct: number }>;
    precisionByEvidenceLevel?: Record<string, { same: number; total: number; pct: number }>;
    thresholdSuggestionAr?: string;
  };
  videosDiscovered: number;
  duplicateVideosSkipped: number;
  realVideoFramePosterCount: number;
  keyframesExtractedCount?: number;
  keyframesFailedCount?: number;
  stopReasonCode?: StopReasonCode;
  stopReasonLabelAr?: string;
  topLimitingFactorAr?: string;
  stopReasonsAr: Record<string, string>;
  filtersFired: Record<string, number>;
  reasonHistograms?: ReasonHistogramEntry[];
  funnels?: SourceFunnelBreakdown[];
  queryPlan?: QueryPlanRow[];
  queryScoreboard?: QueryScoreboardRow[];
  rejectionAuditSample?: RejectedCandidateItem[];
  overrideWarnings?: RejectionOverrideWarning[];
  providerProbes?: TikTokProviderProbeItem[];
  settingsUsed?: Record<string, any>;
  geminiUsage?: {
    callsUsedInSearch: number;
    dailyCallsUsed: number;
    dailyMaxCalls: number;
    exhausted: boolean;
  };
  diagnosticReportMarkdown?: string;
}

export interface VisualAttribute {
  category: string;
  suggestedNameAr: string;
  suggestedNameEn: string;
  shape?: string;
  dimensions?: string;
  material?: string;
  color?: string;
  headDesign?: string;
  handleType?: string;
  brandOrModelText?: string[];
  distinctiveGeometry: string;
  components?: string[];
  materials?: string[];
  colors?: string[];
  visibleAccessories?: string[];
  mechanism: string;
  mustMatchAttributes: string[];
  excludeKeywords?: string[];
  allowedDifferences: string[];
  unknownAttributes?: string[];
  confidence: 'high' | 'medium' | 'low' | number;
  multilingualQueries: {
    ar: string[];
    en: string[];
    de?: string[];
    fr?: string[];
  };
  identityCardV2?: IdentityCardV2Client;
}

export interface SearchSettings {
  strictness: MatchStrictness;
  matchMode?: MatchMode;
  includeSimilar?: boolean;
  contentSources: ContentSourcePreference;
  sourcePriority: SourcePlatform[];
  preferredMarketplaces: string[];
  preferredLanguages: string[];
  excludeWorkspaceProjects: boolean;
  minDurationSeconds: number;
  preserveAudio: boolean;
  maxSearchDepth: number;
  maxProcessingTimeSeconds: number;
  estimatedBudgetUsd: number;
}

export type SwipeVerdict = 'winner' | 'testing' | 'reference' | 'loser';

export interface WinnerSignal {
  tier: 'top_winner' | 'strong' | 'standard';
  labelAr: string;
  score: number;
}

export interface CreativeHookAnalysis {
  hooksAr: string[];
  hooksEn: string[];
  marketingAngleAr: string;
  marketingAngleEn: string;
  offerCtaAr: string;
  scriptBriefAr: string;
  whyItWorksAr: string;
  generatedAt: string;
}

export type OwnerFeedbackLabel = 'same_product' | 'different_product';

export interface CandidateAsset {
  id: string;
  projectId: string;
  searchId?: string;
  imageHash?: string;
  title: string;
  mediaType: 'video' | 'photo';
  platform: SourcePlatform;
  sourceUrl: string;
  productListingUrl?: string;
  reviewerOrChannel?: string;
  platformAssetId?: string;
  reviewId?: string;
  thumbnailUrl: string;
  posterSource?: 'real_video_frame' | 'amazon_slate' | 'tiktok_cover' | 'product_listing_image';
  verifiedByAi?: boolean;
  verificationStage?: string;
  mediaUrl?: string;
  downloadUrl?: string;
  provenance: ProvenanceClassification;
  verifiedPurchaseEvidence?: string;
  incentiveDisclosure?: string;
  matchCategory: MatchCategory;
  matchScore: number; // 0 - 100 internal ranking
  userFacingMatchLabel: string;
  visibleDifferences: string[];
  supportingObservations: string[];
  unknowns: string[];
  contentDescription: string;
  sentiment?: 'positive' | 'mixed' | 'negative' | 'neutral';
  durationSeconds?: number;
  ratingCount?: number;
  winnerSignal?: WinnerSignal;
  swipeVerdict?: SwipeVerdict;
  editorNotes?: string;
  creativeAnalysis?: CreativeHookAnalysis;
  savedAt?: string;
  dimensions?: { width: number; height: number };
  hasAudio?: boolean;
  fileSizeBytes?: number;
  sha256?: string;
  localFilePath?: string;
  downloadStatus: DownloadStatus;
  downloadError?: string;
  downloadFailureReason?: string;
  embedHtml?: string;
  verdictTier?: VerdictTier;
  evidenceLevel?: EvidenceLevel;
  evidenceSummaryAr?: string;
  visibleFramesCount?: number;
  keyframesExtractedCount?: number;
  extractedFrameUrls?: string[];
  referenceClipSimilarity?: number;
  cropClipSimilarity?: number;
  boundingBoxes?: BoundingBox2D[];
  blindObservations?: BlindDiscriminatorObservation[];
  linkState?: LinkState;
  linkStateReasonAr?: string;
  ownerFeedback?: OwnerFeedbackLabel;
  demotedByFeedback?: boolean;
  collectedAt: string;
  rightsStatus: 'unknown' | 'public_reference' | 'licensed';
  selectedForExport: boolean;
  marketplace?: string;
  asin?: string;
  isDead?: boolean;
  provenanceData?: {
    source: 'live' | 'fixture' | 'manual';
    marketplace: string;
    asin: string;
    fetchedAt: string;
    httpStatus: number;
    finalUrl: string;
    responseSnippetHash: string;
  };
}

export interface JobProgressCounters {
  candidatesDiscovered: number;
  sourcesInspected: number;
  visuallyMatchedAssets: number;
  downloadedAssets: number;
  verifiedAssets: number;
  rejectedDuplicates: number;
  targetCount: number;
}

export interface Project {
  id: string;
  sessionId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  referenceImages: {
    id: string;
    url: string;
    base64Data?: string;
    mimeType: string;
    fileName: string;
  }[];
  mediaTypeRequested: MediaType;
  targetVideoCount: number;
  targetPhotoCount: number;
  userNotes?: string;
  productListingUrl?: string;
  settings: SearchSettings;
  productProfile?: VisualAttribute;
  identityCard?: IdentityCardV2Client;
  rejectedCandidates?: RejectedCandidateItem[];
  breakdownSummary?: SearchBreakdownSummary;
  jobState: JobState;
  jobError?: string;
  counters: JobProgressCounters;
  logs: {
    timestamp: string;
    stage: string;
    message: string;
    level: 'info' | 'warn' | 'error' | 'success';
  }[];
  candidates: CandidateAsset[];
  isDemoFixture?: boolean;
}

export interface ProviderCapability {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  state: 'ready' | 'missing_config' | 'unsupported' | 'rate_limited';
  supportedOperations: {
    discovery: boolean;
    reviewAccess: boolean;
    visualInspection: boolean;
    preview: boolean;
    download: boolean;
  };
  requiredSecrets: string[];
  configuredSecrets: string[];
  notes: string;
  notesAr: string;
}

export interface WorkspaceUsage {
  monthlySearchesUsed: number;
  monthlySearchesLimit: number;
  verifiedDownloadsUsed: number;
  verifiedDownloadsLimit: number;
  storageUsedBytes: number;
  storageLimitBytes: number;
  activeProjects: number;
}
