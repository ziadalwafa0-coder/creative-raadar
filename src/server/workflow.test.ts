import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeExternalUrl, sanitizeCsvField, computeSha256 } from '../utils/security.server.ts';
import {
  isQuotaExhaustedError,
  isTransientUnavailableError,
  calculateBackoffMs,
  executeWithGeminiRetry,
  QuotaExhaustedError,
  GeminiUnavailableError
} from './geminiRetry.ts';
import { isDuplicateCandidate, normalizeUrl, getExportFolderName } from '../utils/rules.ts';
import { isHtmlContent } from './downloader.ts';
import { CandidateAsset } from '../types/index.ts';

describe('1. SSRF & Security Guards', () => {
  it('blocks localhost, loopback, and private IPv4 ranges', () => {
    assert.strictEqual(isSafeExternalUrl('http://localhost:3000').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://127.0.0.1/admin').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://10.0.0.1/secrets').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://192.168.1.1').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://172.16.5.10').safe, false);
  });

  it('blocks cloud metadata endpoints', () => {
    assert.strictEqual(isSafeExternalUrl('http://169.254.169.254/latest/meta-data').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://metadata.google.internal/computeMetadata/v1/').safe, false);
  });

  it('blocks dangerous schemes and user credentials', () => {
    assert.strictEqual(isSafeExternalUrl('file:///etc/passwd').safe, false);
    assert.strictEqual(isSafeExternalUrl('ftp://example.com/file.mp4').safe, false);
    assert.strictEqual(isSafeExternalUrl('http://user:pass@example.com/video.mp4').safe, false);
  });

  it('allows safe public URLs', () => {
    assert.strictEqual(isSafeExternalUrl('https://www.amazon.com/dp/B08N5WRWNW').safe, true);
    assert.strictEqual(isSafeExternalUrl('https://www.amazon.eg/gp/customer-reviews/R123').safe, true);
    assert.strictEqual(isSafeExternalUrl('https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact/video.mp4').safe, true);
    assert.strictEqual(isSafeExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').safe, true);
  });
});

describe('2. Media vs HTML Verification (Never count HTML as video)', () => {
  it('detects HTML content-type headers', () => {
    assert.strictEqual(isHtmlContent('text/html; charset=utf-8'), true);
    assert.strictEqual(isHtmlContent('application/xhtml+xml'), true);
    assert.strictEqual(isHtmlContent('video/mp4'), false);
    assert.strictEqual(isHtmlContent('image/jpeg'), false);
  });

  it('detects HTML document snippets inside raw buffers', () => {
    const htmlBuf = Buffer.from('<!DOCTYPE html><html><head><title>Amazon Sign-in</title></head><body>Login</body></html>');
    assert.strictEqual(isHtmlContent('application/octet-stream', htmlBuf), true);

    const binaryVideoBuf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    assert.strictEqual(isHtmlContent('video/mp4', binaryVideoBuf), false);
  });
});

describe('3. Gemini Error Handling & Exponential Backoff', () => {
  it('correctly classifies 429 Quota Exhaustion errors', () => {
    assert.strictEqual(isQuotaExhaustedError(new Error('429 RESOURCE_EXHAUSTED: quota exceeded')), true);
    assert.strictEqual(isQuotaExhaustedError({ status: 429, message: 'Too Many Requests' }), true);
    assert.strictEqual(isQuotaExhaustedError(new QuotaExhaustedError()), true);
    assert.strictEqual(isQuotaExhaustedError(new Error('503 Service Unavailable')), false);
  });

  it('correctly classifies transient 503 errors and network failures', () => {
    assert.strictEqual(isTransientUnavailableError(new Error('503 UNAVAILABLE')), true);
    assert.strictEqual(isTransientUnavailableError({ status: 503, message: 'Service Unavailable' }), true);
    assert.strictEqual(isTransientUnavailableError(new Error('fetch failed: ECONNRESET')), true);
    assert.strictEqual(isTransientUnavailableError(new Error('429 RESOURCE_EXHAUSTED')), false);
  });

  it('calculates bounded exponential backoff with jitter', () => {
    const fakeRng = () => 0.5; // predictable 50% jitter
    const delay0 = calculateBackoffMs(0, 400, 2500, fakeRng);
    const delay1 = calculateBackoffMs(1, 400, 2500, fakeRng);
    const delay2 = calculateBackoffMs(2, 400, 2500, fakeRng);

    assert.ok(delay0 >= 400, 'Attempt 0 should be at least base delay');
    assert.ok(delay1 > delay0, 'Attempt 1 should be larger than attempt 0');
    assert.ok(delay2 > delay1, 'Attempt 2 should be larger than attempt 1');
    assert.ok(delay2 <= 2500, 'Delay must be bounded by maxMs');
  });

  it('aborts immediately without retrying on 429 quota exhaustion', async () => {
    let callCount = 0;
    await assert.rejects(
      async () => {
        await executeWithGeminiRetry(
          async () => {
            callCount++;
            throw new Error('429 RESOURCE_EXHAUSTED: quota limit reached');
          },
          { maxRetries: 3, baseMs: 10 }
        );
      },
      (err: any) => {
        assert.strictEqual(err.code, 'QUOTA_EXHAUSTED');
        assert.strictEqual(callCount, 1, 'Should NOT retry 429 quota errors');
        return true;
      }
    );
  });

  it('retries on 503 and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    const result = await executeWithGeminiRetry(
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('503 UNAVAILABLE');
        }
        return 'success_data';
      },
      { maxRetries: 2, baseMs: 5 }
    );

    assert.strictEqual(result, 'success_data');
    assert.strictEqual(callCount, 2, 'Should succeed on retry attempt');
  });
});

describe('4. Deduplication & Canonical URL Normalization', () => {
  it('strips tracking parameters from URLs', () => {
    const raw = 'https://www.amazon.eg/dp/B08N5WRWNW?ref=sr_1_1&utm_source=google&tag=affil-20';
    const clean = normalizeUrl(raw);
    assert.strictEqual(clean, 'https://www.amazon.eg/dp/B08N5WRWNW');
  });

  it('detects duplicates by platformAssetId, reviewId, canonical URL, and sha256', () => {
    const existing: CandidateAsset[] = [
      {
        id: 'ast-1',
        projectId: 'p1',
        title: 'Review 1',
        mediaType: 'video',
        platform: 'amazon',
        sourceUrl: 'https://www.amazon.com/gp/customer-reviews/R100',
        platformAssetId: 'AMZ-100',
        reviewId: 'R100',
        thumbnailUrl: 'https://example.com/thumb.jpg',
        provenance: 'verified_purchase_review',
        matchCategory: 'exact_design',
        matchScore: 95,
        userFacingMatchLabel: 'نفس التصميم',
        visibleDifferences: [],
        supportingObservations: [],
        unknowns: [],
        contentDescription: '',
        downloadStatus: 'verified_available',
        collectedAt: new Date().toISOString(),
        rightsStatus: 'unknown',
        selectedForExport: true,
        sha256: 'abcdef1234567890',
      },
    ];

    // 1. Same platform asset ID
    assert.strictEqual(
      isDuplicateCandidate({ platform: 'amazon', platformAssetId: 'AMZ-100' }, existing).isDuplicate,
      true
    );

    // 2. Same review ID
    assert.strictEqual(
      isDuplicateCandidate({ reviewId: 'R100' }, existing).isDuplicate,
      true
    );

    // 3. Same URL with tracking params
    assert.strictEqual(
      isDuplicateCandidate({ sourceUrl: 'https://www.amazon.com/gp/customer-reviews/R100?ref=xyz' }, existing).isDuplicate,
      true
    );

    // 4. Same sha256
    assert.strictEqual(
      isDuplicateCandidate({ sha256: 'abcdef1234567890' }, existing).isDuplicate,
      true
    );

    // 5. Distinct candidate
    assert.strictEqual(
      isDuplicateCandidate({ sourceUrl: 'https://www.amazon.com/gp/customer-reviews/R200' }, existing).isDuplicate,
      false
    );
  });
});

describe('5. CSV Formula Injection Defense & ZIP Folder Routing', () => {
  it('neutralizes dangerous formula characters in CSV fields', () => {
    assert.strictEqual(sanitizeCsvField('=SUM(A1:A10)'), '"\'=SUM(A1:A10)"');
    assert.strictEqual(sanitizeCsvField('+cmd|/c calc'), '"\'+cmd|/c calc"');
    assert.strictEqual(sanitizeCsvField('-1+1'), '"\'-1+1"');
    assert.strictEqual(sanitizeCsvField('@alert()'), '"\'@alert()"');
    assert.strictEqual(sanitizeCsvField('Safe text'), '"Safe text"');
  });

  it('routes assets to proper separated folders', () => {
    const baseAsset = (provenance: any, mediaType: 'video' | 'photo' = 'video'): CandidateAsset => ({
      id: 'ast-1',
      projectId: 'p1',
      title: 'T',
      mediaType,
      platform: 'amazon',
      sourceUrl: 'url',
      thumbnailUrl: 'thumb',
      provenance,
      matchCategory: 'exact_design',
      matchScore: 90,
      userFacingMatchLabel: 'نفس التصميم',
      visibleDifferences: [],
      supportingObservations: [],
      unknowns: [],
      contentDescription: '',
      downloadStatus: 'verified_available',
      collectedAt: '',
      rightsStatus: 'unknown',
      selectedForExport: true,
    });

    assert.strictEqual(getExportFolderName(baseAsset('verified_purchase_review')), 'Customer_Reviews');
    assert.strictEqual(getExportFolderName(baseAsset('unverified_customer_review')), 'Customer_Reviews');
    assert.strictEqual(getExportFolderName(baseAsset('vine_free_product')), 'Customer_Reviews');
    assert.strictEqual(getExportFolderName(baseAsset('affiliate_creator_demo')), 'Creator_Reviews');
    assert.strictEqual(getExportFolderName(baseAsset('seller_manufacturer_demo')), 'Seller_Demos');
    assert.strictEqual(getExportFolderName(baseAsset('verified_purchase_review', 'photo')), 'Photos');
  });
});
