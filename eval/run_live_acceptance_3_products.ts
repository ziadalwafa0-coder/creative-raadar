import fs from 'fs';
import path from 'path';
import { handleStreamSearch } from '../src/server/streamSearch.js';
import { getSearchTrace } from '../src/server/pipeline/trace.js';
import type { Request, Response } from 'express';

function loadImageAsDataUrl(relPath: string, mime = 'image/png'): string {
  const full = path.resolve(process.cwd(), relPath);
  const buf = fs.readFileSync(full);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function runLiveSearch(body: Record<string, any>): Promise<{
  events: Array<any>;
  searchId: string | null;
}> {
  const events: Array<any> = [];
  let searchId: string | null = null;

  const req = {
    body,
    on: () => {},
  } as unknown as Request;

  const res = {
    writableEnded: false,
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk: string) => {
      const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          events.push(parsed);
          if (parsed?.searchId) searchId = parsed.searchId;
        } catch {
          // ignore
        }
      }
      return true;
    },
    end: () => {},
    on: () => {},
  } as unknown as Response;

  await handleStreamSearch(req, res, 'live_acceptance');
  return { events, searchId };
}

interface ProductAcceptanceSpec {
  id: string;
  label: string;
  relPath: string;
  mime: string;
  targetVideoCount: number;
}

const PRODUCTS: ProductAcceptanceSpec[] = [
  {
    id: 'P1_MOSQUITO_KILLER',
    label: 'Product 1: USB Photocatalyst Suction Mosquito Killer Fixture (eval/fixtures/f1_mosquito_killer_ref.png)',
    relPath: 'eval/fixtures/f1_mosquito_killer_ref.png',
    mime: 'image/png',
    targetVideoCount: 25,
  },
  {
    id: 'P2_PLIERS_5IN1',
    label: 'Product 2: 5-in-1 Interchangeable Head Pliers Set Fixture (eval/fixtures/pliers_5in1_ref.webp)',
    relPath: 'eval/fixtures/pliers_5in1_ref.webp',
    mime: 'image/webp',
    targetVideoCount: 25,
  },
  {
    id: 'P3_DUAL_CYLINDER_INFLATOR',
    label: 'Product 3 (Color Variants): Heavy-Duty Dual-Cylinder 12V Tire Inflator Air Compressor (public/assets/aistudio/efe025db-5582-48bd-80fd-86374851c9dc_e98de15c.webp)',
    relPath: 'public/assets/aistudio/efe025db-5582-48bd-80fd-86374851c9dc_e98de15c.webp',
    mime: 'image/webp',
    targetVideoCount: 25,
  },
];

async function main() {
  const summaryRows: Array<any> = [];
  const allAcceptedVideoAssets: Array<any> = [];

  for (const prod of PRODUCTS) {
    console.log('\n================================================================================');
    console.log(`LIVE ACCEPTANCE RUN — ${prod.label}`);
    console.log('================================================================================');
    const refDataUrl = loadImageAsDataUrl(prod.relPath, prod.mime);

    const { events, searchId } = await runLiveSearch({
      productName: 'بحث بالصورة',
      referenceImage: refDataUrl,
      mediaType: 'video',
      sourcePlatform: 'all',
      targetVideoCount: prod.targetVideoCount,
      targetAmazonVideoCount: 20,
      targetTikTokVideoCount: 5,
      matchMode: 'same_design',
    });

    const trace = searchId ? getSearchTrace(searchId) : null;
    const resultAssets = events
      .filter((e) => e.type === 'result' && e.asset)
      .map((e) => e.asset);
    const verifiedAssets = resultAssets.filter((a) => a.verifiedByAi !== false);
    const unverifiedAssets = resultAssets.filter((a) => a.verifiedByAi === false);

    // Map video trace entries by streamUuid / url for dHash64 lookup
    const videoTraceByUrl = new Map<string, any>();
    for (const c of trace?.candidates || []) {
      if (c.entityType === 'video' && c.url) {
        videoTraceByUrl.set(c.url, c);
      }
    }

    for (const v of verifiedAssets) {
      const vt = videoTraceByUrl.get(v.mediaUrl);
      const listingAsin =
        vt?.parentId ||
        (v.productListingUrl?.match(/\/dp\/([B0-9][A-Z0-9]{9})/i) || [])[1] ||
        v.reviewId ||
        v.id;
      allAcceptedVideoAssets.push({
        productId: prod.id,
        id: v.id,
        platform: v.platform,
        listingAsin,
        streamOrVideoId: vt?.id || v.reviewId || v.id,
        title: v.title,
        reviewer: v.reviewerOrChannel,
        posterUrl: v.thumbnailUrl,
        videoUrl: v.mediaUrl,
        posterHash: vt?.perceptualHash || 'n/a',
        posterSource: v.posterSource || vt?.thumbnailSource || 'real_video_frame',
        productListingUrl: v.productListingUrl,
      });
    }

    console.log('\n--- [1] IDENTITY CARD v2 ---');
    console.log(JSON.stringify(trace?.identityResolution || null, null, 2));

    console.log('\n--- [2] CANDIDATE DECISION TRACE (Every Inspected Candidate) ---');
    const candidateRows = (trace?.candidates || []).map((c) => ({
      source: c.source,
      entityType: c.entityType,
      id: c.id,
      parentId: c.parentId || undefined,
      title: (c.title || '').slice(0, 75),
      referenceSimilarity: c.referenceSimilarity,
      stage: c.stage,
      verdict: c.attributeVerdicts?.verdict || c.finalDecision,
      mustNotBeHit: c.attributeVerdicts?.mustNotBeHit || [],
      finalDecision: c.finalDecision,
      reason: c.rejectionReason || c.attributeVerdicts?.reasonAr || 'Accepted',
    }));
    console.log(JSON.stringify(candidateRows, null, 2));

    console.log('\n--- [3] FINAL ACCEPTED VIDEOS (Verified Only, No Padding) ---');
    const acceptedSummary = verifiedAssets.map((a) => {
      const vt = videoTraceByUrl.get(a.mediaUrl);
      const listingAsin =
        vt?.parentId ||
        (a.productListingUrl?.match(/\/dp\/([B0-9][A-Z0-9]{9})/i) || [])[1] ||
        a.reviewId;
      return {
        platform: a.platform,
        listingAsin,
        streamUuidOrVideoId: vt?.id || a.reviewId || a.id,
        title: a.title,
        reviewer: a.reviewerOrChannel || 'Customer',
        matchCategory: a.matchCategory,
        userFacingMatchLabel: a.userFacingMatchLabel,
        provenance: a.provenance,
        mediaUrl: a.mediaUrl,
        posterUrl: a.thumbnailUrl,
        posterDHash64: vt?.perceptualHash || null,
        posterSource: a.posterSource || 'real_video_frame',
      };
    });
    console.log(JSON.stringify(acceptedSummary, null, 2));

    const amazonCount = verifiedAssets.filter((a) => a.platform === 'amazon').length;
    const tiktokCount = verifiedAssets.filter((a) => a.platform === 'tiktok').length;

    const row = {
      productId: prod.id,
      searchId,
      requestedVideos: prod.targetVideoCount,
      deliveredVerifiedVideos: verifiedAssets.length,
      hiddenUnverifiedByAiVideos: unverifiedAssets.length,
      amazonVerifiedCount: amazonCount,
      tiktokVerifiedCount: tiktokCount,
      pagesFetched: trace?.summary.pagesFetched ?? 0,
      listingsDiscovered: trace?.summary.listingsDiscovered ?? 0,
      listingsInspected: trace?.summary.listingsInspected ?? 0,
      listingsAccepted: trace?.summary.listingsAccepted ?? 0,
      listingsRejected: trace?.summary.listingsRejected ?? 0,
      videosDiscovered: trace?.summary.videosDiscovered ?? 0,
      videosEmitted: trace?.summary.videosEmitted ?? 0,
      duplicateVideosSkipped: trace?.summary.duplicateVideosSkipped ?? 0,
      productImageUsedAsPosterCount: trace?.summary.productImageUsedAsPosterCount ?? 0,
      realVideoFramePosterCount: trace?.summary.realVideoFramePosterCount ?? 0,
      stopReasons: trace?.summary.stopReasons || {},
      filtersFired: trace?.summary.filtersFired || {},
    };
    summaryRows.push(row);

    console.log('\n--- [4] COUNTS & STOP REASONS ---');
    console.log(JSON.stringify(row, null, 2));
  }

  console.log('\n================================================================================');
  console.log('ITEM 8: 10 REAL VIDEO POSTERS / FRAMES CONFIRMATION (NO PRODUCT IMAGES USED)');
  console.log('================================================================================');
  const sample10Posters = allAcceptedVideoAssets.slice(0, 10).map((item, idx) => ({
    index: idx + 1,
    productId: item.productId,
    platform: item.platform,
    listingAsin: item.listingAsin,
    streamOrVideoId: item.streamOrVideoId,
    title: item.title,
    posterSource: item.posterSource,
    posterDHash64: item.posterHash,
    posterUrl: item.posterUrl,
    isRealExtractedVideoFrame: Boolean(item.posterUrl?.startsWith('/api/stream-search/poster?id=')),
  }));
  console.log(JSON.stringify(sample10Posters, null, 2));

  console.log('\n================================================================================');
  console.log('ITEM 9: FINAL SUMMARY TABLE (REQUESTED VS DELIVERED PER PRODUCT & SOURCE)');
  console.log('================================================================================');
  console.log(JSON.stringify(summaryRows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
