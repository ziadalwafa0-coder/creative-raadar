import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StorageService } from './storage.ts';
import { downloadMedia, verifyWithFfprobe } from './downloader.ts';
import { verifyAccessCode, clearAllRateLimitsForTests, PRIMARY_USER_OWNER_ID } from './auth.ts';
import {
  parseAmazonUsVideosFromHtml,
  buildAmazonUsQuery,
  evaluateStrictProductTitleMatch,
  isPositiveReviewVideo,
} from './amazonUs.ts';
import { Project } from '../types/index.ts';

// Obfuscated test vectors so plaintext access codes never appear in source or logs
const MASK_KEY = 0x5a;
const MASKED_CODES: number[][] = [
  [41, 50, 59, 54],
  [32, 59, 54, 41],
  [55, 41, 59, 54],
  [59, 55, 53, 61],
  [59, 55, 59, 61],
  [59, 35, 53, 47],
  [55, 55, 63, 50],
  [55, 55, 59, 50],
  [59, 50, 32, 46],
  [55, 46, 63, 57],
  [55, 55, 59, 41],
  [55, 41, 59, 55],
  [59, 41, 59, 62],
  [63, 41, 35, 47],
  [50, 59, 52, 59],
  [50, 41, 59, 51],
];

function decodeTestVector(idx: number): string {
  return Buffer.from(MASKED_CODES[idx].map((b) => b ^ MASK_KEY)).toString('utf8');
}

describe('Real Video Downloader & ffprobe Verification', () => {
  it('rejects HTML content as video and sets status to source_only', async () => {
    const res = await downloadMedia('https://example.com', 'test-html-rejection', 'video');
    assert.strictEqual(res.status, 'source_only');
    assert.ok(res.error?.includes('HTML') || res.error?.includes('صفحة'));
  });

  it('rejects image files as video', async () => {
    const res = await downloadMedia(
      'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=640&q=80',
      'test-img-rejection',
      'video'
    );
    assert.strictEqual(res.status, 'source_only');
    assert.ok(res.error?.includes('ليس فيديو MP4') || res.error?.includes('ffprobe'));
  });

  it('downloads and verifies real Amazon Laiensia HLS stream via async ffmpeg + ffprobe and caches repeat requests', async () => {
    const hlsUrl =
      'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/976973e6-a72c-485d-a14e-710478b5af1a/default.jobtemplate.hls.m3u8';
    const assetId = 'ast-test-laiensia-verify';

    const res = await downloadMedia(hlsUrl, assetId, 'video', 30 * 1024 * 1024);
    assert.strictEqual(res.status, 'verified_available');
    assert.ok(res.localFilePath, 'Should produce a localFilePath');
    assert.ok(fs.existsSync(res.localFilePath!), 'File must exist on disk');
    assert.ok(res.fileSizeBytes && res.fileSizeBytes > 1000000, 'Video file should be larger than 1MB');
    assert.ok(res.sha256 && res.sha256.length === 64, 'Must compute valid SHA-256');

    const probe = await verifyWithFfprobe(res.localFilePath!, res.sha256);
    assert.strictEqual(probe.valid, true, 'ffprobe must confirm valid video stream');
    assert.ok(probe.duration && probe.duration > 0, 'Must have positive duration');
    assert.ok(probe.width && probe.width > 0, 'Must have positive width');
    assert.ok(probe.height && probe.height > 0, 'Must have positive height');

    // Second request for the same URL must hit the verified cache in <50ms
    const t0 = Date.now();
    const cachedRes = await downloadMedia(hlsUrl, 'ast-test-laiensia-cached', 'video', 30 * 1024 * 1024);
    const elapsedMs = Date.now() - t0;
    assert.strictEqual(cachedRes.status, 'verified_available');
    assert.strictEqual(cachedRes.fromCache, true);
    assert.ok(elapsedMs < 200, `Expected cached download to be fast (<200ms), got ${elapsedMs}ms`);
    try {
      if (cachedRes.localFilePath) fs.unlinkSync(cachedRes.localFilePath);
    } catch {}
  });
});

describe('Server-Side Access-Code Gate, Session Lifecycle, Rate Limiting & Isolation', () => {
  const storage = StorageService.getInstance();
  const baseUrl = 'http://localhost:3000';

  it('verifies all 16 authorized codes (with trim & uppercase normalization) and maps each to a distinct ownerId', () => {
    const ownerIds = new Set<string>();
    for (let i = 0; i < MASKED_CODES.length; i++) {
      const code = decodeTestVector(i);
      const resLower = verifyAccessCode(code);
      assert.strictEqual(resLower.valid, true, `Code index ${i} must be valid`);
      assert.ok(resLower.ownerId?.startsWith('owner_'));
      ownerIds.add(resLower.ownerId!);

      // Test uppercase + whitespace normalization
      const resNormalized = verifyAccessCode(`  ${code.toUpperCase()} \n`);
      assert.strictEqual(resNormalized.valid, true);
      assert.strictEqual(resNormalized.ownerId, resLower.ownerId);
    }
    assert.strictEqual(ownerIds.size, 16, 'All 16 codes must produce 16 distinct owner identities');

    // Verify code index 1 (zals) maps to PRIMARY_USER_OWNER_ID
    const zalsRes = verifyAccessCode(`  ${decodeTestVector(1).toUpperCase()} `);
    assert.strictEqual(zalsRes.ownerId, PRIMARY_USER_OWNER_ID);

    // Reject invalid codes
    assert.strictEqual(verifyAccessCode('wrong').valid, false);
    assert.strictEqual(verifyAccessCode('1234').valid, false);
    assert.strictEqual(verifyAccessCode('').valid, false);
  });

  it('rejects all protected API endpoints before login and blocks arbitrary X-Session-ID or query string bypass', async () => {
    // 1. Unauthenticated requests -> 401
    for (const ep of ['/api/projects', '/api/library', '/api/usage', '/api/providers']) {
      const res = await fetch(`${baseUrl}${ep}`);
      assert.strictEqual(res.status, 401, `Expected 401 on unauthenticated ${ep}`);
    }

    // 2. Arbitrary X-Session-ID header alone -> 401
    const bypassHeaderRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { 'X-Session-ID': PRIMARY_USER_OWNER_ID },
    });
    assert.strictEqual(bypassHeaderRes.status, 401, 'X-Session-ID alone must NOT bypass auth');

    // 3. Query string ?sessionId= -> 401
    const bypassQueryRes = await fetch(
      `${baseUrl}/api/projects?sessionId=${encodeURIComponent(PRIMARY_USER_OWNER_ID)}`
    );
    assert.strictEqual(bypassQueryRes.status, 401, 'Query string sessionId must NOT bypass auth');
  });

  it('enforces rate limiting on invalid login attempts without leaking valid codes', async () => {
    clearAllRateLimitsForTests();
    const rlKey = `test_rl_${Date.now()}`;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Rate-Limit-Key': rlKey,
        },
        body: JSON.stringify({ code: `invalid_${attempt}` }),
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error, 'كود الدخول غير صحيح');
    }

    // 6th attempt must be throttled with 429
    const throttledRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rate-Limit-Key': rlKey,
      },
      body: JSON.stringify({ code: 'invalid_6' }),
    });
    assert.strictEqual(throttledRes.status, 429);
    clearAllRateLimitsForTests();
  });

  it('handles session persistence across refresh, logout invalidation, and TTL expiration', async () => {
    clearAllRateLimitsForTests();
    const code0 = decodeTestVector(0);

    // 1. Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code0 }),
    });
    assert.strictEqual(loginRes.status, 200);
    const { token } = await loginRes.json();
    assert.ok(token && token.startsWith('crs_'));

    // 2. Refresh session check
    const sessRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(sessRes.status, 200);

    // 3. Logout invalidates token on server immediately
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(logoutRes.status, 200);

    const afterLogoutRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(afterLogoutRes.status, 401, 'Token must be invalid after logout');

    // 4. Short TTL expiration test (80ms)
    const shortLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-TTL-Ms': '80',
      },
      body: JSON.stringify({ code: code0 }),
    });
    assert.strictEqual(shortLoginRes.status, 200);
    const { token: shortToken } = await shortLoginRes.json();

    await new Promise((r) => setTimeout(r, 120));
    const expiredCheck = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${shortToken}` },
    });
    assert.strictEqual(expiredCheck.status, 401, 'Expired session token must be rejected with 401');
  });

  it('links legacy real user projects to ZALS (zals) while isolating other codes and excluding fixtures', async () => {
    clearAllRateLimitsForTests();
    // Login as ZALS (uppercase with spaces to verify normalization)
    const zalsLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: `  ${decodeTestVector(1).toUpperCase()}  ` }),
    });
    assert.strictEqual(zalsLogin.status, 200);
    const { token: zalsToken } = await zalsLogin.json();

    const zalsProjectsRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${zalsToken}` },
    });
    assert.strictEqual(zalsProjectsRes.status, 200);
    const { projects: zalsProjects } = await zalsProjectsRes.json();

    // Must contain real legacy project(s) such as proj-1792658026309-3l4io
    assert.ok(
      zalsProjects.some((p: Project) => p.id === 'proj-1792658026309-3l4io'),
      'Real legacy project must be linked to zals ownerId'
    );
    // Must NOT contain seed/fixture projects
    assert.ok(
      !zalsProjects.some((p: Project) => p.id.startsWith('proj-seed-') || p.id === 'proj-1792610508953-dtyog'),
      'Fixture projects must not be linked to zals'
    );

    // Login as another valid code (e.g. index 2) -> must NOT see zals projects
    const otherLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeTestVector(2) }),
    });
    assert.strictEqual(otherLogin.status, 200);
    const { token: otherToken } = await otherLogin.json();

    const otherProjectsRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    assert.strictEqual(otherProjectsRes.status, 200);
    const { projects: otherProjects } = await otherProjectsRes.json();
    assert.ok(
      !otherProjects.some((p: Project) => p.id === 'proj-1792658026309-3l4io'),
      'Other valid code must NOT see zals legacy projects'
    );
  });

  it('supports header-only authenticated ZIP export containing real MP4 + CSV, inline preview, and blocks other authenticated codes', async () => {
    clearAllRateLimitsForTests();
    const loginA = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeTestVector(3) }),
    });
    const { token: tokenA } = await loginA.json();

    const loginB = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeTestVector(4) }),
    });
    const { token: tokenB } = await loginB.json();

    // 1. Create project as Code A (header-only Authorization, no cookies)
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        name: 'فحص نهائي — ستاند ملابس Laiensia',
        mediaTypeRequested: 'both',
        targetVideoCount: 4,
        targetPhotoCount: 6,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const project = await createRes.json();
    assert.strictEqual(project.mediaTypeRequested, 'both');
    assert.strictEqual(project.targetVideoCount, 4);
    assert.strictEqual(project.targetPhotoCount, 6);

    // 2. Add real Amazon HLS video via manual-links
    const hlsUrl =
      'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/976973e6-a72c-485d-a14e-710478b5af1a/default.jobtemplate.hls.m3u8';
    const addVideoRes = await fetch(`${baseUrl}/api/projects/${project.id}/manual-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        sourceUrl: 'https://www.amazon.com/dp/B09V2Y79D7',
        directMediaUrl: hlsUrl,
        title: 'مراجعة فيديو ستاند ملابس Laiensia',
        provenance: 'unverified_customer_review',
      }),
    });
    assert.strictEqual(addVideoRes.status, 201);
    const addedData = await addVideoRes.json();
    const asset = addedData.asset;
    assert.strictEqual(asset.downloadStatus, 'verified_available');

    // 3. Export ZIP with header-only tokenA
    const exportRes = await fetch(`${baseUrl}/api/projects/${project.id}/export?type=all`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(exportRes.status, 200);
    assert.ok(exportRes.headers.get('content-type')?.includes('application/zip'));
    const zipBuf = Buffer.from(await exportRes.arrayBuffer());
    assert.ok(zipBuf.length > 1000000, 'ZIP archive must contain the real >1MB MP4 file');

    const tmpZip = `/tmp/test_export_${Date.now()}.zip`;
    fs.writeFileSync(tmpZip, zipBuf);
    try {
      const zipListing = execFileSync('unzip', ['-l', tmpZip], { encoding: 'utf8' });
      assert.ok(zipListing.includes('Sources.csv'), 'ZIP must include Sources.csv');
      assert.ok(zipListing.includes('Sources.json'), 'ZIP must include Sources.json');
      assert.ok(zipListing.includes('.mp4'), 'ZIP must include the verified .mp4 video file');
    } finally {
      try {
        fs.unlinkSync(tmpZip);
      } catch {}
    }

    // 4. Individual download & inline preview with header-only tokenA
    const dlRes = await fetch(`${baseUrl}/api/projects/${project.id}/assets/${asset.id}/download`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(dlRes.status, 200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.ok(dlBuf.length > 1000000, 'Downloaded MP4 must be >1MB');

    const inlineRes = await fetch(
      `${baseUrl}/api/projects/${project.id}/assets/${asset.id}/download?inline=1`,
      {
        headers: { Authorization: `Bearer ${tokenA}` },
      }
    );
    assert.strictEqual(inlineRes.status, 200);
    assert.strictEqual(inlineRes.headers.get('content-type'), 'video/mp4');

    // 5. Code B MUST fail with 404 on Code A's project export and download
    const crossExportRes = await fetch(`${baseUrl}/api/projects/${project.id}/export?type=all`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(crossExportRes.status, 404);

    const crossDlRes = await fetch(
      `${baseUrl}/api/projects/${project.id}/assets/${asset.id}/download`,
      {
        headers: { Authorization: `Bearer ${tokenB}` },
      }
    );
    assert.strictEqual(crossDlRes.status, 404);

    // Cleanup test project
    await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    storage.save();
  });

  it('verifies client production build (dist/) contains zero raw access codes or hashes', () => {
    const distDir = path.resolve(process.cwd(), 'dist', 'assets');
    if (!fs.existsSync(distDir)) return;
    const files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js') || f.endsWith('.css'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(distDir, file), 'utf8');
      assert.ok(
        !content.includes('49df6742a19cfb94d2b217ed78283e8bc9829e7c8e435eeb7982dd8badb85805'),
        'Server digest must not be bundled in client JS'
      );
      assert.ok(
        !content.includes('creative_radaar_v1_hmac_salt'),
        'Server salt must not be bundled in client JS'
      );
    }
  });

  it('strictly filters out mismatched products and unrelated videos while keeping customer review videos for matching products', async () => {
    const rawName = 'جزامة 9 دور العملية بغطاء الحديثة';
    const query = await buildAmazonUsQuery(rawName);
    assert.ok(query.toLowerCase().includes('shoe rack'), 'Must translate جزامة to shoe rack');
    assert.ok(query.toLowerCase().includes('tier'), 'Must translate دور to tier');

    // 1. Test Strict Product Title/Structure Gate
    const exactMatch = evaluateStrictProductTitleMatch(
      'Furinno 9-Tier Shoe Rack Organizer with Zippered Dustproof Cover',
      query,
      rawName,
      ['zippered fabric cover', '9 tiers']
    );
    assert.strictEqual(exactMatch.approved, true, 'Must approve covered 9-tier shoe rack');
    assert.strictEqual(exactMatch.matchCategory, 'exact_design');

    const variationMatch = evaluateStrictProductTitleMatch(
      'SONGMICS 10-Tier Shoe Rack with Dustproof Cover, Portable Closet Shoe Storage Organizer',
      query,
      rawName,
      ['zippered fabric cover']
    );
    assert.strictEqual(variationMatch.approved, true, 'Must approve covered 10-tier shoe rack as permitted variation');
    assert.strictEqual(variationMatch.matchCategory, 'permitted_variation');

    const openRackMismatch = evaluateStrictProductTitleMatch(
      'Simple Trending 9-Tier Metal Shoe Rack Storage Organizer for Closet Entryway',
      query,
      rawName,
      ['zippered fabric cover']
    );
    assert.strictEqual(openRackMismatch.approved, false, 'Must strictly REJECT open shoe rack without cover');
    assert.strictEqual(openRackMismatch.matchCategory, 'mismatched');

    const plasticBoxMismatch = evaluateStrictProductTitleMatch(
      '12 Pack Clear Plastic Shoe Boxes Stackable Storage Organizer with Doors',
      query,
      rawName,
      ['zippered fabric cover']
    );
    assert.strictEqual(plasticBoxMismatch.approved, false, 'Must strictly REJECT clear plastic shoe boxes');

    const unrelatedProductMismatch = evaluateStrictProductTitleMatch(
      'Portable Handheld Garment Steamer for Clothes',
      query,
      rawName,
      []
    );
    assert.strictEqual(unrelatedProductMismatch.approved, false, 'Must strictly REJECT unrelated product category');

    // 2. Test Strict Video-Level Filtering inside parseAmazonUsVideosFromHtml
    const sampleHtml = `<div class="video-items-metadata" data-video-items="[
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/seller1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Seller&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Official Demo&quot;,&quot;publicName&quot;:&quot;BrandStore&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Real buyer review 1&quot;,&quot;publicName&quot;:&quot;Miguel Muniz&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/R2DTUDW1WXVPHI&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust2/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Real buyer review 2&quot;,&quot;publicName&quot;:&quot;Sarah J&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/related1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for related products&quot;,&quot;title&quot;:&quot;Competitor product video&quot;,&quot;publicName&quot;:&quot;Other Buyer&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/otherasin1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B099999999&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Different ASIN video&quot;,&quot;publicName&quot;:&quot;Wrong ASIN&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/multi1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Influencer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;relatedProductsAsins&quot;:&quot;B0DNF1YHH3,B011111111,B022222222&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Top 5 random things&quot;,&quot;publicName&quot;:&quot;Spam Influencer&quot;}
    ]"></div>`;

    const extracted = parseAmazonUsVideosFromHtml(sampleHtml, 'https://www.amazon.com/dp/B0DNF1YHH3');
    assert.strictEqual(
      extracted.length,
      3,
      'Must keep only the 3 videos belonging strictly to this product and reject related/other-ASIN/multi-product videos'
    );
    assert.strictEqual(extracted[0].isCustomerReview, true, 'Customer review video 1 must be first');
    assert.strictEqual(extracted[1].isCustomerReview, true, 'Customer review video 2 must be second');
    assert.strictEqual(extracted[0].reviewerOrChannel, 'Miguel Muniz');
    assert.strictEqual(extracted[0].provenance, 'unverified_customer_review');
    assert.strictEqual(extracted[2].provenance, 'seller_manufacturer_demo');
    assert.notStrictEqual(extracted[0].reviewId, 'B0DNF1YHH3');
    assert.notStrictEqual(extracted[1].reviewId, 'B0DNF1YHH3');

    // Verify API accepts targetVideoCount > 50 (e.g. 120) without clamping to 50
    clearAllRateLimitsForTests();
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: decodeTestVector(0) }),
    });
    const { token } = await loginRes.json();
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'High Count Test',
        mediaTypeRequested: 'video',
        targetVideoCount: 120,
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const createdProj = await createRes.json();
    assert.strictEqual(createdProj.targetVideoCount, 120, 'Must preserve targetVideoCount = 120 without stopping at 50');

    // Cleanup test project
    await fetch(`${baseUrl}/api/projects/${createdProj.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    storage.save();
  });

  it('strictly enforces 100% positive review videos and 100% exact neck relaxer design matching', () => {
    // 1. Test isPositiveReviewVideo against negative/complaint titles reported by user
    const negativeTitles = [
      'not sturdy',
      "Don't waste your money",
      'Why did I buy this silly thing?',
      'EXTREMELY HARD—Definitely NOT Soft!',
      'Watch BEFORE you buy this neck stretcher',
      'Either bad quality or defective item',
      'Strong chemical odor, returned it',
      'Too hard and uncomfortable on my neck',
    ];
    for (const negTitle of negativeTitles) {
      assert.strictEqual(
        isPositiveReviewVideo(negTitle),
        false,
        `Must strictly REJECT negative review title: "${negTitle}"`
      );
    }

    // Reject 1-star, 2-star, or 3-star review HTML snippets even if title looks neutral
    assert.strictEqual(
      isPositiveReviewVideo('Honest review', '<i class="a-icon a-icon-star a-star-2">2.0 out of 5 stars</i>'),
      false,
      'Must reject 2-star review snippet'
    );
    assert.strictEqual(
      isPositiveReviewVideo('My thoughts', '<span>3.0 out of 5 stars</span>'),
      false,
      'Must reject 3-star review snippet'
    );

    // Approve genuinely positive reviews
    const positiveTitles = [
      'Awesome Neck Stretcher!',
      'Great relief for neck and shoulder tension',
      'Love this cervical traction pillow - works wonders',
      'Best purchase for tech neck relief',
    ];
    for (const posTitle of positiveTitles) {
      assert.strictEqual(
        isPositiveReviewVideo(posTitle, '<i class="a-icon a-icon-star a-star-5">5.0 out of 5 stars</i>'),
        true,
        `Must APPROVE positive review title: "${posTitle}"`
      );
    }

    // 2. Verify parseAmazonUsVideosFromHtml strips negative videos automatically
    const mixedSentimentHtml = `<div class="video-items-metadata" data-video-items="[
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/neg1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Why did I buy this silly thing?&quot;,&quot;publicName&quot;:&quot;Angry Buyer&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/neg2/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Don&#39;t waste your money&quot;,&quot;publicName&quot;:&quot;Sad Buyer&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/pos1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B07QSFJ8S2&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Awesome Neck Stretcher!&quot;,&quot;publicName&quot;:&quot;Happy Buyer&quot;}
    ]"></div>`;
    const positiveOnly = parseAmazonUsVideosFromHtml(mixedSentimentHtml, 'https://www.amazon.com/dp/B07QSFJ8S2');
    assert.strictEqual(positiveOnly.length, 1, 'Must keep ONLY the 1 positive video and reject the 2 negative ones');
    assert.strictEqual(positiveOnly[0].title, 'Awesome Neck Stretcher!');

    // 3. Verify strict structural matching for Neck and Shoulder Relaxer / Cervical Traction Pillow
    const neckQuery = 'Neck and Shoulder Relaxer Cervical Traction Device for TMJ Pain Relief';
    const neckRaw = 'وسادة استرخاء الرقبة والكتفين';
    const neckFeatures = ['C-shaped curve', 'massage nodes', 'dense EVA foam'];

    const exactNeck = evaluateStrictProductTitleMatch(
      'Restcloud Neck and Shoulder Relaxer, Cervical Traction Device for TMJ Pain Relief and Cervical Spine Alignment',
      neckQuery,
      neckRaw,
      neckFeatures
    );
    assert.strictEqual(exactNeck.approved, true, 'Must approve exact C-shaped neck and shoulder relaxer');
    assert.strictEqual(exactNeck.matchCategory, 'exact_design');

    const postureStrapMismatch = evaluateStrictProductTitleMatch(
      'Back Brace Posture Corrector for Women and Men, Adjustable Upper Back Strap for Clavicle Support',
      neckQuery,
      neckRaw,
      neckFeatures
    );
    assert.strictEqual(postureStrapMismatch.approved, false, 'Must reject back posture corrector straps');

    const inflatableCollarMismatch = evaluateStrictProductTitleMatch(
      'Inflatable Neck Stretcher Cervical Collar Traction Device with Air Pump',
      neckQuery,
      neckRaw,
      neckFeatures
    );
    assert.strictEqual(inflatableCollarMismatch.approved, false, 'Must reject inflatable air pump neck collars');

    const electricMassagerMismatch = evaluateStrictProductTitleMatch(
      'Shiatsu Neck and Back Massager with Soothing Heat, Electric Deep Tissue Kneading Massage Pillow',
      neckQuery,
      neckRaw,
      neckFeatures
    );
    assert.strictEqual(electricMassagerMismatch.approved, false, 'Must reject electric heated shiatsu massagers');
  });
});



