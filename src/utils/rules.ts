import type {
  MatchCategory,
  ProvenanceClassification,
  CandidateAsset,
  JobState,
  MediaType
} from '../types/index.ts';

/**
 * Maps match category to authentic Egyptian Arabic and English labels.
 */
export function getMatchCategoryLabel(
  category: MatchCategory,
  lang: 'ar' | 'en' = 'ar'
): { label: string; color: string } {
  if (lang === 'ar') {
    switch (category) {
      case 'exact_design':
        return { label: 'نفس التصميم', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'permitted_variation':
        return { label: 'لون أو مقاس مختلف', color: 'bg-teal-50 text-teal-700 border-teal-200' };
      case 'similar_differences':
        return { label: 'اختلاف يحتاج مراجعة', color: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'mismatched':
        return { label: 'غير مطابق', color: 'bg-rose-50 text-rose-700 border-rose-200' };
      case 'insufficient_evidence':
      default:
        return { label: 'لم يتم التحقق بصريًا', color: 'bg-slate-100 text-slate-700 border-slate-200' };
    }
  }

  switch (category) {
    case 'exact_design':
      return { label: 'Exact Design', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'permitted_variation':
      return { label: 'Permitted Variation', color: 'bg-teal-50 text-teal-700 border-teal-200' };
    case 'similar_differences':
      return { label: 'Differences Require Review', color: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'mismatched':
      return { label: 'Mismatched', color: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'insufficient_evidence':
    default:
      return { label: 'Unverified Visually', color: 'bg-slate-100 text-slate-700 border-slate-200' };
  }
}

/**
 * Maps provenance classification to labels.
 */
export function getProvenanceLabel(
  provenance: ProvenanceClassification,
  lang: 'ar' | 'en' = 'ar'
): { label: string; badge: string } {
  if (lang === 'ar') {
    switch (provenance) {
      case 'verified_purchase_review':
        return { label: 'تقييم مشتري مؤكد', badge: 'bg-teal-100 text-teal-800 border-teal-300' };
      case 'unverified_customer_review':
        return { label: 'تقييم عميل (غير موسوم)', badge: 'bg-blue-50 text-blue-700 border-blue-200' };
      case 'vine_free_product':
        return { label: 'تقييم منتج مجاني (Vine)', badge: 'bg-purple-50 text-purple-700 border-purple-200' };
      case 'affiliate_creator_demo':
        return { label: 'عرض صانع محتوى / مسوق', badge: 'bg-orange-50 text-orange-700 border-orange-200' };
      case 'seller_manufacturer_demo':
        return { label: 'عرض البائع / المصنّع', badge: 'bg-slate-100 text-slate-700 border-slate-300' };
      case 'unresolved_source':
      default:
        return { label: 'مصدر غير محدد', badge: 'bg-gray-100 text-gray-600 border-gray-200' };
    }
  }

  switch (provenance) {
    case 'verified_purchase_review':
      return { label: 'Verified Purchase Review', badge: 'bg-teal-100 text-teal-800 border-teal-300' };
    case 'unverified_customer_review':
      return { label: 'Customer Review (No Badge)', badge: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'vine_free_product':
      return { label: 'Vine / Free Product', badge: 'bg-purple-50 text-purple-700 border-purple-200' };
    case 'affiliate_creator_demo':
      return { label: 'Creator / Affiliate Demo', badge: 'bg-orange-50 text-orange-700 border-orange-200' };
    case 'seller_manufacturer_demo':
      return { label: 'Seller / Manufacturer Demo', badge: 'bg-slate-100 text-slate-700 border-slate-300' };
    case 'unresolved_source':
    default:
      return { label: 'Unresolved Source', badge: 'bg-gray-100 text-gray-600 border-gray-200' };
  }
}

/**
 * Validates if a job state transition is permitted.
 */
export function canTransitionJobState(current: JobState, next: JobState): boolean {
  if (current === next) return true;
  if (next === 'cancelled' || next === 'failed') return true;

  const validTransitions: Record<JobState, JobState[]> = {
    idle: ['queued', 'analyzing'],
    queued: ['analyzing', 'cancelled'],
    analyzing: ['searching', 'needs_configuration', 'failed', 'cancelled'],
    searching: ['inspecting', 'downloading', 'completed_partial', 'completed', 'needs_configuration', 'failed', 'cancelled'],
    inspecting: ['downloading', 'verifying', 'completed_partial', 'completed', 'failed', 'cancelled'],
    downloading: ['verifying', 'completed_partial', 'completed', 'failed', 'cancelled'],
    verifying: ['packaging', 'completed_partial', 'completed', 'failed', 'cancelled'],
    packaging: ['completed', 'failed'],
    completed: ['queued', 'searching'], // re-run
    completed_partial: ['queued', 'searching'],
    needs_configuration: ['queued', 'searching'],
    failed: ['queued', 'searching'],
    cancelled: ['queued', 'searching']
  };

  return validTransitions[current]?.includes(next) ?? false;
}

/**
 * Determines which folder an asset should be placed in inside the export ZIP archive.
 */
export function getExportFolderName(asset: CandidateAsset): string {
  if (asset.mediaType === 'photo') {
    return 'Photos';
  }

  switch (asset.provenance) {
    case 'verified_purchase_review':
    case 'unverified_customer_review':
    case 'vine_free_product':
      return 'Customer_Reviews';
    case 'affiliate_creator_demo':
      return 'Creator_Reviews';
    case 'seller_manufacturer_demo':
      return 'Seller_Demos';
    default:
      return 'Customer_Reviews';
  }
}

/**
 * Deduplicates candidates against existing assets based on:
 * 1. Platform asset ID / Review ID (exact match)
 * 2. Source URL canonical matching
 * 3. SHA-256 hash (if files are downloaded)
 */
export function isDuplicateCandidate(
  candidate: Partial<CandidateAsset>,
  existingAssets: CandidateAsset[]
): { isDuplicate: boolean; reason?: string } {
  for (const existing of existingAssets) {
    // 1. Platform asset ID check
    if (
      candidate.platform &&
      candidate.platform === existing.platform &&
      candidate.platformAssetId &&
      existing.platformAssetId &&
      candidate.platformAssetId === existing.platformAssetId
    ) {
      return { isDuplicate: true, reason: `Matching platform ID: ${candidate.platformAssetId}` };
    }

    // 2. Review ID check
    if (
      candidate.reviewId &&
      existing.reviewId &&
      candidate.reviewId === existing.reviewId
    ) {
      return { isDuplicate: true, reason: `Matching review ID: ${candidate.reviewId}` };
    }

    // 3. Direct Media URL check (if both have mediaUrl)
    if (candidate.mediaUrl && existing.mediaUrl) {
      const cleanNewMedia = normalizeUrl(candidate.mediaUrl);
      const cleanOldMedia = normalizeUrl(existing.mediaUrl);
      if (cleanNewMedia === cleanOldMedia) {
        return { isDuplicate: true, reason: `Matching media URL: ${cleanNewMedia}` };
      }
    } else if (candidate.sourceUrl && existing.sourceUrl) {
      // 4. Normalized source URL check (only when at least one candidate lacks a distinct mediaUrl)
      const cleanNew = normalizeUrl(candidate.sourceUrl);
      const cleanOld = normalizeUrl(existing.sourceUrl);
      if (cleanNew === cleanOld) {
        return { isDuplicate: true, reason: `Matching canonical URL: ${cleanNew}` };
      }
    }

    // 5. SHA-256 check
    if (candidate.sha256 && existing.sha256 && candidate.sha256 === existing.sha256) {
      return { isDuplicate: true, reason: `Identical SHA-256 checksum: ${candidate.sha256.slice(0, 10)}...` };
    }
  }

  return { isDuplicate: false };
}

/**
 * Normalizes URL by removing transient tracking query params (utm_*, ref, tag, etc.).
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'ref_', 'tag', 'keywords', 'qid', 'sr'];
    for (const p of trackingParams) {
      url.searchParams.delete(p);
    }
    // Remove trailing slash
    return url.origin + url.pathname.replace(/\/$/, '') + (url.search ? url.search : '');
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Determines whether a candidate meets the requested strictness filter.
 */
export function matchesStrictness(
  candidateCategory: MatchCategory,
  configuredStrictness: 'exact' | 'color_allowed' | 'similar_disclosed'
): boolean {
  if (configuredStrictness === 'exact') {
    return candidateCategory === 'exact_design';
  }
  if (configuredStrictness === 'color_allowed') {
    return candidateCategory === 'exact_design' || candidateCategory === 'permitted_variation';
  }
  // similar_disclosed allows exact, variation, and similar_differences
  return (
    candidateCategory === 'exact_design' ||
    candidateCategory === 'permitted_variation' ||
    candidateCategory === 'similar_differences'
  );
}

/**
 * Checks whether an asset matches the media type filter.
 */
export function matchesMediaType(assetType: 'video' | 'photo', requested: MediaType): boolean {
  if (requested === 'both') return true;
  return assetType === requested;
}
