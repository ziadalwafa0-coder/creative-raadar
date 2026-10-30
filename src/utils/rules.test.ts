import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeExternalUrl, sanitizeCsvField, computeSha256 } from './security.server.ts';
import {
  canTransitionJobState,
  getExportFolderName,
  isDuplicateCandidate,
  normalizeUrl,
  matchesStrictness
} from './rules.ts';
import { evaluateStrictProductTitleMatch } from '../server/queryBuilder.ts';
import {
  extractRatingCountFromCardHtml,
  sortCandidatesByRatingCountDesc,
} from '../server/amazonSearch.ts';
import {
  parseAmazonUsVideosFromHtml,
  selectHighestQualityVariantFromM3u8,
} from '../server/amazonVideos.ts';
import { detectAmazonBlock } from '../server/amazonHttp.ts';
import { AmazonConnector } from '../server/connectors/AmazonConnector.ts';
import { CandidateAsset } from '../types/index.ts';

test('SSRF URL validation allows public domains and blocks private/loopback destinations', () => {
  assert.equal(isSafeExternalUrl('https://www.amazon.com/dp/B08N5WRWNW').safe, true);
  assert.equal(isSafeExternalUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg').safe, true);

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
  assert.equal(sanitizeCsvField('=SUM(1+1)'), "\"'=SUM(1+1)\"");
  assert.equal(sanitizeCsvField('-10+5'), "\"'-10+5\"");
  assert.equal(sanitizeCsvField('+cmd|calc'), "\"'+cmd|calc\"");
  assert.equal(sanitizeCsvField('@SUM(A1:A10)'), "\"'@SUM(A1:A10)\"");
  assert.equal(sanitizeCsvField('Wireless Headphones'), '"Wireless Headphones"');
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

  assert.equal(canTransitionJobState('searching', 'cancelled'), true);
  assert.equal(canTransitionJobState('analyzing', 'failed'), true);

  assert.equal(canTransitionJobState('idle', 'verifying'), false);
  assert.equal(canTransitionJobState('queued', 'completed'), false);
});

test('Export folder router categorizes assets into correct folders', () => {
  const mockPhoto: Partial<CandidateAsset> = {
    mediaType: 'photo',
    provenance: 'verified_purchase_review',
  };
  assert.equal(getExportFolderName(mockPhoto as CandidateAsset), 'Photos');

  const mockReviewVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'verified_purchase_review',
  };
  assert.equal(getExportFolderName(mockReviewVideo as CandidateAsset), 'Customer_Reviews');

  const mockVineVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'vine_free_product',
  };
  assert.equal(getExportFolderName(mockVineVideo as CandidateAsset), 'Customer_Reviews');

  const mockCreatorVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'affiliate_creator_demo',
  };
  assert.equal(getExportFolderName(mockCreatorVideo as CandidateAsset), 'Creator_Reviews');

  const mockSellerVideo: Partial<CandidateAsset> = {
    mediaType: 'video',
    provenance: 'seller_manufacturer_demo',
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
      selectedForExport: true,
    },
  ];

  const dup1 = isDuplicateCandidate({ platform: 'amazon', platformAssetId: 'AMZ-V-99881' }, existing);
  assert.equal(dup1.isDuplicate, true);

  const dup2 = isDuplicateCandidate(
    { sourceUrl: 'https://www.amazon.com/dp/B08N5WRWNW?utm_source=twitter&ref=other' },
    existing
  );
  assert.equal(dup2.isDuplicate, true);

  const dup3 = isDuplicateCandidate(
    { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    existing
  );
  assert.equal(dup3.isDuplicate, true);

  const distinct = isDuplicateCandidate(
    {
      platform: 'amazon',
      platformAssetId: 'AMZ-VIDEO-1234',
      sourceUrl: 'https://www.amazon.com/dp/B099999999',
      sha256: '1111111111111111111111111111111111111111111111111111111111111111',
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

test('Phase 2 Amazon modules: rating count sorting, customer video extraction without sentiment filtering, block detection, and m3u8 variant selection', () => {
  // 1. Rating count extraction & primary sort key
  const count = extractRatingCountFromCardHtml('<span aria-label="14,520 ratings">14,520</span>');
  assert.equal(count, 14520);

  const sorted = sortCandidatesByRatingCountDesc([
    { asin: 'B001', ratingCount: 120, matchScore: 98 },
    { asin: 'B002', ratingCount: 8400, matchScore: 75 },
    { asin: 'B003', ratingCount: 1500, matchScore: 90 },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.asin),
    ['B002', 'B003', 'B001']
  );

  // 2. Customer reviews keep both positive and negative reviews and reject seller/other-ASIN videos
  const html = `<div data-video-items="[
    {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid-pos-1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Great emergency flashlight!&quot;,&quot;publicName&quot;:&quot;Happy Buyer&quot;},
    {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid-neg-2/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Battery died after two days&quot;,&quot;publicName&quot;:&quot;Critical Buyer&quot;},
    {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid-seller-3/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Seller&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Official Promo&quot;}
  ]"></div>`;
  const videos = parseAmazonUsVideosFromHtml(html, 'https://www.amazon.com/dp/B07QSFJ8S2');
  assert.equal(videos.length, 2, 'Must keep both positive and negative customer review videos and exclude Seller video');

  // 3. Master m3u8 variant selection picks highest bandwidth
  const masterM3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
variant_360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
variant_720p.m3u8`;
  const bestVariant = selectHighestQualityVariantFromM3u8(
    masterM3u8,
    'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid1/default.jobtemplate.hls.m3u8'
  );
  assert.equal(
    bestVariant,
    'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid1/variant_720p.m3u8'
  );

  // 4. Block detection
  assert.equal(detectAmazonBlock(503, '<html>Service Unavailable</html>').blocked, true);
  assert.equal(detectAmazonBlock(200, '<html>validateCaptcha</html>').blocked, true);
  assert.equal(detectAmazonBlock(200, '<html>short</html>', 5000).blocked, true);

  // 5. Title matching approves matching products and rejects replacement parts
  assert.equal(
    evaluateStrictProductTitleMatch(
      'Rechargeable LED Emergency Flashlight Power Outage Light',
      'rechargeable emergency flashlight'
    ).approved,
    true
  );
  assert.equal(
    evaluateStrictProductTitleMatch(
      '125 Pcs Air Fryer Disposable Paper Liners',
      'air fryer'
    ).approved,
    false
  );
});

test('Phase 4 AmazonConnector does not return fake Unsplash thumbnails, fake durations, or fake verified purchase labels', async () => {
  const conn = new AmazonConnector();
  const inspected = await conn.inspectSource('https://www.amazon.com/dp/B07QSFJ8S2');
  assert.equal(inspected.thumbnailUrl, undefined);
  assert.equal(inspected.durationSeconds, undefined);
  assert.equal(inspected.verifiedPurchaseEvidence, undefined);
  assert.equal(inspected.provenance, 'unverified_customer_review');
});


