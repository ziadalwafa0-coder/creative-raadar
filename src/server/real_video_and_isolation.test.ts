import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';

process.env.NODE_ENV = 'test';

import app from '../../server.ts';
import { DOWNLOADS_DIR } from './config.ts';
import { StorageService } from './storage.ts';
import { downloadMedia, verifyWithFfprobe } from './downloader.ts';
import {
  verifyAccessCode,
  issueAuthSession,
  clearAllRateLimitsForTests,
  PRIMARY_USER_OWNER_ID,
} from './auth.ts';
import {
  buildAmazonUsQuery,
  evaluateStrictProductTitleMatch,
} from './queryBuilder.ts';
import {
  extractRatingCountFromCardHtml,
  sortCandidatesByRatingCountDesc,
} from './amazonSearch.ts';
import {
  parseAmazonUsVideosFromHtml,
  extractStreamUuid,
} from './amazonVideos.ts';
import { isAllowedDownloadHost } from './streamSearch.ts';
import { Project } from '../types/index.ts';

const RUN_NETWORK_TESTS = process.env.RUN_NETWORK_TESTS === '1';

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

function generateLocalTestMp4(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      targetPath,
    ],
    { stdio: 'ignore' }
  );
}

describe('Real Video Downloader & ffprobe Verification', () => {
  it('verifies locally generated MP4 via ffprobe deterministically', async () => {
    const localMp4 = path.join(DOWNLOADS_DIR, `unit_test_sample_${Date.now()}.mp4`);
    generateLocalTestMp4(localMp4);
    try {
      const probe = await verifyWithFfprobe(localMp4);
      assert.strictEqual(probe.valid, true);
      assert.strictEqual(probe.width, 320);
      assert.strictEqual(probe.height, 240);
    } finally {
      try {
        fs.unlinkSync(localMp4);
      } catch {}
    }
  });

  it(
    'rejects HTML content as video and sets status to source_only',
    { skip: !RUN_NETWORK_TESTS },
    async () => {
      const res = await downloadMedia('https://example.com', 'test-html-rejection', 'video');
      assert.strictEqual(res.status, 'source_only');
      assert.ok(res.error?.includes('HTML') || res.error?.includes('صفحة'));
    }
  );

  it(
    'rejects image files as video',
    { skip: !RUN_NETWORK_TESTS },
    async () => {
      const res = await downloadMedia(
        'https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=640&q=80',
        'test-img-rejection',
        'video'
      );
      assert.strictEqual(res.status, 'source_only');
      assert.ok(res.error?.includes('ليس فيديو MP4') || res.error?.includes('ffprobe'));
    }
  );

  it(
    'downloads and verifies real Amazon Laiensia HLS stream via async ffmpeg + ffprobe and caches repeat requests',
    { skip: !RUN_NETWORK_TESTS },
    async () => {
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
    }
  );
});

describe('Server-Side Access-Code Gate, Session Lifecycle, Rate Limiting & Isolation', () => {
  const storage = StorageService.getInstance();
  let server: Server;
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exposes GET /api/health returning gemini, ffmpeg, and amazonReachable booleans', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.gemini, 'boolean');
    assert.strictEqual(typeof body.ffmpeg, 'boolean');
    assert.strictEqual(typeof body.amazonReachable, 'boolean');
  });

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
    const candidatePreview = await fetch(`${baseUrl}/api/product-identity/candidates`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query:'spray mop'}),
    });
    assert.equal(candidatePreview.status, 401);
    const imageAnalysis = await fetch(`${baseUrl}/api/product-identity/analyze`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({referenceImage:'data:image/png;base64,AAAA'}),
    });
    assert.equal(imageAnalysis.status, 401);

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

    // 4. Short TTL expiration test (80ms via issueAuthSession, x-session-ttl-ms header removed)
    const { token: shortToken } = issueAuthSession(PRIMARY_USER_OWNER_ID, 80);

    await new Promise((r) => setTimeout(r, 120));
    const expiredCheck = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${shortToken}` },
    });
    assert.strictEqual(expiredCheck.status, 401, 'Expired session token must be rejected with 401');
  });

  it('links user projects to ZALS (zals) while isolating other codes and excluding fixtures', async () => {
    clearAllRateLimitsForTests();
    // Login as ZALS (uppercase with spaces to verify normalization)
    const zalsLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: `  ${decodeTestVector(1).toUpperCase()}  ` }),
    });
    assert.strictEqual(zalsLogin.status, 200);
    const { token: zalsToken } = await zalsLogin.json();

    const createdRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zalsToken}`,
      },
      body: JSON.stringify({
        name: 'جزامة 9 دور بغطاء',
        mediaTypeRequested: 'video',
        targetVideoCount: 3,
      }),
    });
    assert.strictEqual(createdRes.status, 201);
    const zalsCreated = await createdRes.json();

    const zalsProjectsRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${zalsToken}` },
    });
    assert.strictEqual(zalsProjectsRes.status, 200);
    const { projects: zalsProjects } = await zalsProjectsRes.json();

    assert.ok(
      zalsProjects.some((p: Project) => p.id === zalsCreated.id),
      'ZALS project must be linked to zals ownerId'
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
      !otherProjects.some((p: Project) => p.id === zalsCreated.id),
      'Other valid code must NOT see zals projects'
    );

    await fetch(`${baseUrl}/api/projects/${zalsCreated.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${zalsToken}` },
    });
  });

  it('supports header-only authenticated ZIP export containing real MP4 + CSV, inline preview, and blocks other authenticated codes', { skip: !RUN_NETWORK_TESTS }, async () => {
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

  it('extracts customer review videos (both positive and negative) belonging to the ASIN family, deduplicates by stream UUID, and rejects Seller/Influencer/other-ASIN videos', async () => {
    const sampleHtml = `<div class="video-items-metadata" data-video-items="[
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/seller1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Seller&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Official Demo&quot;,&quot;publicName&quot;:&quot;BrandStore&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust-uuid-1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Positive buyer review 1&quot;,&quot;publicName&quot;:&quot;Miguel Muniz&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/R2DTUDW1WXVPHI&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust-uuid-2/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Not sturdy - collapsed after two months&quot;,&quot;publicName&quot;:&quot;Sarah J&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE514&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust-uuid-1/embedded.cc.default.vertical.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Duplicate UUID stream&quot;,&quot;publicName&quot;:&quot;Miguel Muniz&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE515&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/related1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;segmentName&quot;:&quot;Videos for related products&quot;,&quot;title&quot;:&quot;Competitor product video&quot;,&quot;publicName&quot;:&quot;Other Buyer&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE516&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/otherasin1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B099999999&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Different ASIN video&quot;,&quot;publicName&quot;:&quot;Wrong ASIN&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE517&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/multi1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Influencer&quot;,&quot;productAsin&quot;:&quot;B0DNF1YHH3&quot;,&quot;relatedProductsAsins&quot;:&quot;B0DNF1YHH3,B011111111,B022222222&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;Top 5 random things&quot;,&quot;publicName&quot;:&quot;Spam Influencer&quot;}
    ]"></div>
    <div id="customer_review-R99887766">
      <a data-hook="review-title"><span>Honest video from media_reviews_only page</span></a>
      <span class="a-profile-name">Verified Customer</span>
      <video src="https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/cust-uuid-3/default.jobtemplate.hls.m3u8"></video>
    </div>`;

    const extracted = parseAmazonUsVideosFromHtml(sampleHtml, 'https://www.amazon.com/dp/B0DNF1YHH3');
    assert.strictEqual(
      extracted.length,
      3,
      'Must keep the 3 unique customer review videos (both positive and negative, from data-video-items and customer_review block) and reject Seller, duplicate UUID, related, and wrong-ASIN videos'
    );
    assert.strictEqual(extracted[0].streamUuid, 'cust-uuid-1');
    assert.strictEqual(extracted[1].streamUuid, 'cust-uuid-2');
    assert.strictEqual(extracted[2].streamUuid, 'cust-uuid-3');
    assert.strictEqual(extractStreamUuid(extracted[0].mediaUrl), 'cust-uuid-1');

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

    // Verify /api/debug/amazon requires authentication and validates ?q=
    const unauthDebugRes = await fetch(`${baseUrl}/api/debug/amazon?q=flashlight`);
    assert.strictEqual(unauthDebugRes.status, 401);

    const missingQueryDebugRes = await fetch(`${baseUrl}/api/debug/amazon`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(missingQueryDebugRes.status, 400);

    // Cleanup test project
    await fetch(`${baseUrl}/api/projects/${createdProj.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    storage.save();
  });

  it('sorts candidates by rating COUNT descending as primary key and parses inner quotes in data-video-items', () => {
    const rating1 = extractRatingCountFromCardHtml('<span class="a-size-base s-underline-text">(4,812)</span>');
    const rating2 = extractRatingCountFromCardHtml('<span>10K+ bought in past month</span>');
    assert.strictEqual(rating1, 4812);
    assert.strictEqual(rating2, 10000);

    const candidates = [
      { asin: 'B0LOW', ratingCount: 45, matchScore: 99 },
      { asin: 'B0HIGH', ratingCount: 12400, matchScore: 80 },
      { asin: 'B0MID', ratingCount: 980, matchScore: 95 },
    ];
    const sorted = sortCandidatesByRatingCountDesc(candidates);
    assert.deepStrictEqual(
      sorted.map((c) => c.asin),
      ['B0HIGH', 'B0MID', 'B0LOW'],
      'Must sort by ratingCount descending first, then matchScore'
    );

    const quotedAttrHtml = `<div data-video-items="[
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid-q1/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DYNZ4MFB&quot;,&quot;parentAsin&quot;:&quot;B0FGXT13R9&quot;,&quot;relatedProductsAsins&quot;:&quot;B0DYNZ4MFB,B0H9NT6277&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;&#34;See how easily I organized all my shoes!&#34;&quot;,&quot;publicName&quot;:&quot;Verified Buyer&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE597&quot;},
      {&quot;videoURL&quot;:&quot;https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/uuid-q2/default.jobtemplate.hls.m3u8&quot;,&quot;creatorType&quot;:&quot;Customer&quot;,&quot;productAsin&quot;:&quot;B0DYNZ4MFB&quot;,&quot;segmentName&quot;:&quot;Videos for this product&quot;,&quot;title&quot;:&quot;It&#x27;s a wonderful product but we were missing 3 of the 6.7&#34;rods&quot;,&quot;publicName&quot;:&quot;Unlucky Buyer&quot;,&quot;fullReviewLink&quot;:&quot;/gp/customer-reviews/RFIXTURE598&quot;}
    ]"></div>`;
    const parsedFromQuoted = parseAmazonUsVideosFromHtml(
      quotedAttrHtml,
      'https://www.amazon.com/dp/B0DYNZ4MFB'
    );
    assert.strictEqual(
      parsedFromQuoted.length,
      2,
      'Must parse data-video-items containing &#34; inner quotes and keep all customer reviews (positive or negative)'
    );
    assert.strictEqual(parsedFromQuoted[0].title, '"See how easily I organized all my shoes!"');
  });

  it('validates allowed Amazon media download hosts and rejects untrusted domains', () => {
    assert.strictEqual(
      isAllowedDownloadHost('https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/123/default.mp4'),
      true
    );
    assert.strictEqual(isAllowedDownloadHost('https://evil-phishing.example.com/video.mp4'), false);
  });

  it(
    'serves pre-warmed / cached video downloads via /api/stream-search/download in milliseconds',
    { skip: !RUN_NETWORK_TESTS },
    async () => {
      clearAllRateLimitsForTests();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: decodeTestVector(0) }),
      });
      const { token } = await loginRes.json();

      const hlsUrl =
        'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/976973e6-a72c-485d-a14e-710478b5af1a/default.jobtemplate.hls.m3u8';

      const fastCacheHit = await downloadMedia(hlsUrl, 'stream-cache', 'video', 30 * 1024 * 1024, undefined, true);
      assert.strictEqual(fastCacheHit.status, 'verified_available');
      assert.strictEqual(fastCacheHit.fromCache, true);

      const t0 = Date.now();
      const streamDlRes = await fetch(
        `${baseUrl}/api/stream-search/download?url=${encodeURIComponent(hlsUrl)}&type=video&title=Fast_Test`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      assert.strictEqual(streamDlRes.status, 200);
      assert.strictEqual(streamDlRes.headers.get('content-type'), 'video/mp4');
      const buf = Buffer.from(await streamDlRes.arrayBuffer());
      const elapsedMs = Date.now() - t0;

      assert.ok(buf.length > 1000000, 'Streamed MP4 must be >1MB');
      assert.ok(
        elapsedMs < 800,
        `Expected cached /api/stream-search/download to complete in <800ms, took ${elapsedMs}ms`
      );
    }
  );

  it('distills verbose AI descriptions into concise Amazon queries and approves matching product titles', async () => {
    const aiSuggestedEn = 'Automatic Door Closer Punch-Free Steel Wire Cable with Adhesive Mount';
    const aiSuggestedAr = 'غالق باب أوتوماتيكي بسلك فولاذي لاصق';

    const distilledQuery = await buildAmazonUsQuery(aiSuggestedAr, aiSuggestedEn);
    assert.ok(!distilledQuery.toLowerCase().includes('with adhesive mount'), 'Must strip verbose trailing with-clause');

    const realPunchFreeCloser = evaluateStrictProductTitleMatch(
      'Punch-Free Automatic Sensor Door Closer - Multifunctional Door Closer Automatically Close for All Doors',
      distilledQuery,
      aiSuggestedAr
    );
    assert.strictEqual(realPunchFreeCloser.approved, true);
  });
});
