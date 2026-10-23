import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeExternalUrl, sanitizeCsvField, computeSha256 } from './security.ts';
import {
  canTransitionJobState,
  getExportFolderName,
  isDuplicateCandidate,
  normalizeUrl,
  matchesStrictness
} from './rules.ts';
import { CandidateAsset } from '../types/index.ts';

test('SSRF URL validation allows public domains and blocks private/loopback destinations', () => {
  // Safe URLs
  assert.equal(isSafeExternalUrl('https://www.amazon.com/dp/B08N5WRWNW').safe, true);
  assert.equal(isSafeExternalUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg').safe, true);

  // Unsafe URLs
  assert.equal(isSafeExternalUrl('http://localhost:3000/secret').safe, false);
  assert.equal(isSafeExternalUrl('http://127.0.0.1:8080').safe, false);
  assert.equal(isSafeExternalUrl('http://10.0.0.1/admin').safe, false);
  assert.equal(isSafeExternalUrl('http://192.168.1.100').safe, false);
  assert.equal(isSafeExternalUrl('http://169.254.169.254/latest/meta-data/').safe, false);
  assert.equal(isSafeExternalUrl('ftp://example.com/file').safe, false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd').safe, false);
  assert.equal(isSafeExternalUrl('http://user:pass@example.com').safe, false);
});

test('CSV formula injection sanitization protects against formula execution', () => {
  // Starts with =
  assert.equal(sanitizeCsvField('=SUM(1+1)'), "\"\'=SUM(1+1)\"");
  // Starts with -
  assert.equal(sanitizeCsvField('-10+5'), "\"'-10+5\"");
  // Starts with +
  assert.equal(sanitizeCsvField('+cmd|calc'), "\"'+\cmd|calc\"");
  // Starts with @
  assert.equal(sanitizeCsvField('@SUM(A1:A10)'), "\"\'@SUM(A1:A10)\"");
  // Normal string
  assert.equal(sanitizeCsvField('Wireless Headphones'), '"Wireless Headphones"');
  // Quotes in text are doubled
  assert.equal(sanitizeCsvField('Product "Pro" 10'), '"Product ""Pro"" 10"');
});

test('SHA-256 computation produces valid 64-char hex hash', () => {
  const hash = computeSha256('test product media string');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.equal(hash, computeSha256('test product media string'));
});

test('Job state machine transitions enforce sequential order and cancellation', () => {
  assert.equal(canTransitionJobState('idle', 'queued'), true);
  assert.equal(canTransitionJobState('queued', 'analyzing'), true);
  assert.equal(canTransitionJobState('analyzing', 'searching'), true);
  assert.equal(canTransitionJobState('searching', 'inspecting'), true);
  assert.equal(canTransitionJobState('inspecting', 'downloading'), true);
  assert.equal(canTransitionJobState('downloading', 'verifying'), true);
  assert.equal(canTransitionJobState('verifying', 'completed'), true);

  // Cancellation and failure allowed from almost any active state
  assert.equal(canTransitionJobState('searching', 'cancelled'), true);
  assert.equal(canTransitionJobState('analyzing', 'failed'), true);

  // Invalid backward or jumping transitions
  assert.equal(canTransitionJobState('idle', 'verifying'), false);
  assert.equal(canTransitionJobState('queued', 'completed'), false);
});

test('Export folder router categorizes assets into correct folders', () => {
  const mockPhoto: Partial<CandidateAsset> = {
    mediaType: 'photo',
    provenance: 'verified_purchase_review'
  };
  assert.equal(getExportFolderName(mockPhoto as CandidateAsset), 'Photos');

  const mockReviewVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'verified_purchase_review'
  };
  assert.equal(getExportFolderName(mockReviewVideo as CandidateAsset), 'Customer_Reviews');

  const mockVineVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'vine_free_product'
  };
  assert.equal(getExportFolderName(mockVineVideo as CandidateAsset), 'Customer_Reviews');

  const mockCreatorVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'affiliate_creator_demo'
  };
  assert.equal(getExportFolderName(mockCreatorVideo as CandidateAsset), 'Creator_Reviews');

  const mockSellerVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'seller_manufacturer_demo'
  };
  assert.equal(getExportFolderName(mockSellerVideo as CandidateAsset), 'Seller_Demos');
});

test('Deduplication correctly detects matching platform IDs, canonical URLs, and checksums', () => {
  const existing: CandidateAsset[] = [
    {
      id: 'ast-1',
      projectId: 'proj-1',
      title: 'Headphones review',
      mediaType: 'video',
      platform: 'amazon',
      platformAssetId: 'AMZ-V-99881',
      sourceUrl: 'https://www.amazon.com/dp/B08N5WRWNW?ref=dp_vse_ibvc0',
      thumbnailUrl: 'https://example.com/thumb1.jpg',
      provenance: 'verified_purchase_review',
      matchCategory: 'exact_design',
      matchScore: 95,
      userFacingMatchLabel: 'نفس التصميم',
      visibleDifferences: [],
      supportingObservations: ['Exact headband and cup shape'],
      unknowns: [],
      contentDescription: 'Unboxing review',
      downloadStatus: 'verified_available',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      collectedAt: new Date().toISOString(),
      rightsStatus: 'unknown',
      selectedForExport: true
    }
  ];

  // 1. Same platform ID
  const dup1 = isDuplicateCandidate({ platform: 'amazon', platformAssetId: 'AMZ-V-99881' }, existing);
  assert.equal(dup1.isDuplicate, true);

  // 2. Same URL with different tracking query params
  const dup2 = isDuplicateCandidate(
    { sourceUrl: 'https://www.amazon.com/dp/B08N5WRWNW?utm_source=twitter&ref=other' },
    existing
  );
  assert.equal(dup2.isDuplicate, true);

  // 3. Same SHA-256 hash
  const dup3 = isDuplicateCandidate(
    { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    existing
  );
  assert.equal(dup3.isDuplicate, true);

  // 4. Distinct new candidate
  const distinct = isDuplicateCandidate(
    {
      platform: 'youtube',
      platformAssetId: 'YT-VIDEO-1234',
      sourceUrl: 'https://www.youtube.com/watch?v=unique123',
      sha256: '1111111111111111111111111111111111111111111111111111111111111111'
    },
    existing
  );
  assert.equal(distinct.isDuplicate, false);
});

test('Matching strictness filters properly', () => {
  assert.equal(matchesStrictness('exact_design', 'exact'), true);
  assert.equal(matchesStrictness('permitted_variation', 'exact'), false);

  assert.equal(matchesStrictness('exact_design', 'color_allowed'), true);
  assert.equal(matchesStrictness('permitted_variation', 'color_allowed'), true);
  assert.equal(matchesStrictness('similar_differences', 'color_allowed'), false);

  assert.equal(matchesStrictness('similar_differences', 'similar_disclosed'), true);
  assert.equal(matchesStrictness('mismatched', 'similar_disclosed'), false);
});
