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

export interface VisualAttribute {
  category: string;
  suggestedNameAr: string;
  suggestedNameEn: string;
  brandOrModelText: string[];
  distinctiveGeometry: string;
  components: string[];
  materials: string[];
  colors: string[];
  visibleAccessories: string[];
  mechanism: string;
  mustMatchAttributes: string[];
  allowedDifferences: string[];
  unknownAttributes: string[];
  confidence: 'high' | 'medium' | 'low';
  multilingualQueries: {
    ar: string[];
    en: string[];
    de?: string[];
    fr?: string[];
  };
}

export interface SearchSettings {
  strictness: MatchStrictness;
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

export interface CandidateAsset {
  id: string;
  projectId: string;
  title: string;
  mediaType: 'video' | 'photo';
  platform: SourcePlatform;
  sourceUrl: string;
  productListingUrl?: string;
  reviewerOrChannel?: string;
  platformAssetId?: string;
  reviewId?: string;
  thumbnailUrl: string;
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
  dimensions?: { width: number; height: number };
  hasAudio?: boolean;
  fileSizeBytes?: number;
  sha256?: string;
  localFilePath?: string;
  downloadStatus: DownloadStatus;
  downloadError?: string;
  collectedAt: string;
  rightsStatus: 'unknown' | 'public_reference' | 'licensed';
  selectedForExport: boolean;
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
