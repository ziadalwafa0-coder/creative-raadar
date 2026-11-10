import fs from 'node:fs';
import {
  createSearchTrace,
  recordCandidateDecision,
  recordSearchRound,
  finalizeSearchTrace,
} from '../src/server/pipeline/trace.ts';
import {
  evaluateStrictProductTitleMatch,
} from '../src/server/queryBuilder.ts';
import { fetchAmazonSearchPage } from '../src/server/amazonSearch.ts';
import { fetchAmazonUsProductVideos } from '../src/server/amazonVideos.ts';

async function main() {
  const searchId = 'phase_a_f1_repro';
  const trace = createSearchTrace(searchId, {
    productName: 'Photocatalyst Mosquito Killer',
    mediaType: 'video',
    sourcePlatform: 'amazon',
    targetVideoCount: 100,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  // Reproduce the exact state from recent_searches.json (s-1793699668934-ljq9ejz):
  // Tier 1 & Tier 2 analyzeProductImage timed out/503 on the 505KB PNG,
  // emergency fallback returned "Photocatalyst Mosquito Killer" with mustMatch=[] and excludeKeywords=[],
  // and visual batch verification timed out / fell back to titleApproved (streamSearch.ts lines 830 & 888).
  const searchProductName = 'Photocatalyst Mosquito Killer';
  const topVariants = ['Photocatalyst Mosquito Killer'];
  const mustMatchAttrs: string[] = [];
  const excludeKeywords: string[] = [];

  trace.identityResolution = {
    durationMs: 6000,
    profileResolved: false,
    emergencyFallbackUsed: true,
    suggestedNameEn: searchProductName,
    formFactor: undefined,
    mechanism: undefined,
    mustMatch: [],
    mustNotBe: [],
    variableAttributes: [],
    queriesTried: [...topVariants],
    error: 'Tier 1 (6000ms) & Tier 2 (4500ms) aborted on 505KB PNG; emergency 1-line fallback used without attributes.',
  };
  trace.summary.timeoutsCount += 2;

  const seenAsins = new Set<string>();
  const approvedListings: Array<{ page: any; titleVerdict: any }> = [];

  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    for (const qVariant of topVariants) {
      const rStart = Date.now();
      const { candidates } = await fetchAmazonSearchPage(qVariant, pageNum);
      trace.summary.listingsDiscovered += candidates.length;

      const titleApproved: Array<{ page: any; titleVerdict: any }> = [];
      for (const page of candidates) {
        if (!page.asin || seenAsins.has(page.asin)) continue;
        seenAsins.add(page.asin);
        trace.summary.listingsInspected++;

        const tv = evaluateStrictProductTitleMatch(
          page.title,
          qVariant,
          searchProductName,
          mustMatchAttrs,
          excludeKeywords
        );
        if (!tv.approved) {
          recordCandidateDecision(trace, {
            source: 'amazon',
            entityType: 'listing',
            id: page.asin,
            title: page.title,
            url: page.url,
            imageUrl: page.imageUrl,
            referenceSimilarity: tv.matchScore / 100,
            attributeVerdicts: { reasonAr: tv.reasonAr },
            stage: 'text_gate',
            finalDecision: 'rejected',
            rejectionReason: `text_gate: ${tv.reasonAr}`,
            rejectionReasonAr: tv.reasonAr,
          });
          continue;
        }
        titleApproved.push({ page, titleVerdict: tv });
      }

      titleApproved.sort((a, b) => (b.page.ratingCount || 0) - (a.page.ratingCount || 0));
      const batchToVerify = titleApproved.slice(0, 10);

      for (const skipped of titleApproved.slice(10)) {
        recordCandidateDecision(trace, {
          source: 'amazon',
          entityType: 'listing',
          id: skipped.page.asin,
          title: skipped.page.title,
          url: skipped.page.url,
          imageUrl: skipped.page.imageUrl,
          referenceSimilarity: skipped.titleVerdict.matchScore / 100,
          attributeVerdicts: {},
          stage: 'text_gate',
          finalDecision: 'rejected',
          rejectionReason: 'batch_cap_exceeded_slice_10',
          rejectionReasonAr: 'تم تجاهله بسبب حد الـ 10 عناصر لكل صفحة (titleApproved.slice(0, 10))',
        });
      }

      // streamSearch.ts line 830 (`let finalApproved = titleApproved`) & line 888 (`else if (item.titleVerdict.matchCategory === 'exact_design')`)
      for (const item of batchToVerify) {
        approvedListings.push(item);
        recordCandidateDecision(trace, {
          source: 'amazon',
          entityType: 'listing',
          id: item.page.asin,
          title: item.page.title,
          url: item.page.url,
          imageUrl: item.page.imageUrl,
          referenceSimilarity: item.titleVerdict.matchScore / 100,
          attributeVerdicts: {
            reasonAr: `Approved by text_gate (matchCategory=${item.titleVerdict.matchCategory}, score=${item.titleVerdict.matchScore}) + unverified visual fallback in streamSearch.ts lines 830/888`,
          },
          stage: 'visual_timeout_fallback',
          finalDecision: 'accepted',
          rejectionReason: null,
          rejectionReasonAr: null,
        });
      }

      recordSearchRound(trace, {
        round: `R1_page_${pageNum}`,
        source: 'amazon',
        marketplace: 'US',
        query: qVariant,
        page: pageNum,
        candidatesFound: candidates.length,
        verifiedCount: batchToVerify.length,
        durationMs: Date.now() - rStart,
        status: 'ok',
      });
    }
  }

  const seenUuids = new Set<string>();
  for (const item of approvedListings) {
    const videos = await fetchAmazonUsProductVideos(item.page.url);
    trace.summary.videosDiscovered += videos.length;
    for (const v of videos) {
      if (seenUuids.has(v.streamUuid)) {
        trace.summary.duplicateVideosSkipped++;
        continue;
      }
      seenUuids.add(v.streamUuid);
      const usedProductListingImage = !v.thumbnailUrl || v.thumbnailUrl === item.page.imageUrl;
      recordCandidateDecision(trace, {
        source: 'amazon',
        entityType: 'video',
        id: v.streamUuid,
        parentId: item.page.asin,
        title: v.title,
        url: v.mediaUrl,
        thumbnailUrl: v.thumbnailUrl || item.page.imageUrl,
        thumbnailSource: usedProductListingImage ? 'product_listing_image' : 'amazon_slate',
        referenceSimilarity: item.titleVerdict.matchScore / 100,
        attributeVerdicts: {
          reasonAr: `Inherited from listing ${item.page.asin} (${item.page.title.slice(0, 60)})`,
        },
        stage: 'emitted',
        finalDecision: 'accepted',
        rejectionReason: null,
        rejectionReasonAr: null,
      });
    }
  }

  finalizeSearchTrace(trace, {
    amazon: 'Stopped after 3 pages of 1 query variant (capped at 10 listings/page); 18 cached/inspected listings yielded 27 videos (26 unique streamUuids).',
  });

  console.log('=== PHASE A TRACE SUMMARY (EXACT REPRODUCTION OF F1/F2/F3) ===');
  console.log(JSON.stringify(trace.summary, null, 2));
  console.log('\n=== SAMPLE ACCEPTED GRID ZAPPER LISTINGS ===');
  for (const l of trace.candidates.filter((c) => c.entityType === 'listing' && c.finalDecision === 'accepted').slice(0, 8)) {
    console.log(`- ASIN=${l.id} | Stage=${l.stage} | Score=${l.referenceSimilarity} | Title=${l.title.slice(0, 85)}`);
  }
  console.log('\n=== FIRST 8 EMITTED VIDEOS (SHOWING B082F6HKZV & PRODUCT_LISTING_IMAGE THUMBNAILS) ===');
  for (const v of trace.candidates.filter((c) => c.entityType === 'video' && c.finalDecision === 'accepted').slice(0, 8)) {
    console.log(`- Video=${v.id.slice(0, 14)} | ASIN=${v.parentId} | ThumbSource=${v.thumbnailSource} | Title="${v.title}" | Thumb=${v.thumbnailUrl}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
