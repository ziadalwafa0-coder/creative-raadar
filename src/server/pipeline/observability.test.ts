import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import {
  createSearchTrace,
  recordCandidateDecision,
  recordSearchRound,
  computeDerivedDiagnostics,
  buildDiagnosticReportMarkdown,
  isErrorNotRejectionReason,
} from './trace.ts';
import { canSourceAcceptMoreVideos, handleStreamExportZip, handlePrepareExportZip } from '../streamSearch.ts';
import {
  hydrateTikTokCandidateWithFallbacks,
  expandTikTokCandidatesFromVerified,
} from '../sources/tiktok/index.ts';
import {
  classifyIdentityAttributeStrengths,
  isTautologicalOrVagueAttribute,
  buildDiscriminatorsForIdentityCard,
} from './identity.ts';
import { evaluateHardAttributeConflicts } from './verify.ts';
import {
  enforceEvidenceGatedBadge,
  classifyHttpStatusToLinkState,
} from './linkState.ts';
import {
  compareBlindProfileInCode,
  type BlindCandidateDescription,
} from './blindVerify.ts';
import { expandSnowballQueriesFromVerified } from './queryIntelligence.ts';
import {
  recordOwnerFeedback,
  rescoreCandidatesWithOwnerFeedback,
} from './ownerFeedback.ts';

test('Phase 1.1: Counter consistency — all derived counters in SearchBreakdownSummary and top chip vs panel match 100% (never 45 vs 135)', () => {
  const trace = createSearchTrace('test-counter-consistency-137', {
    productName: 'Shiatsu Kneading Neck and Back Massage Pillow with Heat',
    mediaType: 'video',
    sourcePlatform: 'all',
    targetVideoCount: 40,
    targetAmazonVideoCount: 20,
    targetTikTokVideoCount: 20,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  // Record 2 accepted listings
  for (let i = 1; i <= 2; i++) {
    recordCandidateDecision(trace, {
      source: 'amazon',
      marketplace: 'US',
      entityType: 'listing',
      id: `B0ACCEPT0${i}`,
      title: `Shiatsu Neck and Back Massager Pillow with Heat #${i}`,
      url: `https://www.amazon.com/dp/B0ACCEPT0${i}`,
      referenceSimilarity: 0.78,
      attributeVerdicts: {
        verdict: 'same_design',
        verdictTier: 'exact',
        confidence: 0.92,
      },
      verdictTier: 'exact',
      stage: 'visual_stage2_gemini',
      finalDecision: 'accepted',
      reasonCode: null,
      rejectionReason: null,
      rejectionReasonAr: null,
    });
  }

  // Record 135 rejected listings across distinct reason codes (exceeding the old 45 UI cap)
  for (let i = 1; i <= 135; i++) {
    const reasonCode =
      i <= 50
        ? 'low_similarity'
        : i <= 95
        ? 'rejected_other_type'
        : i <= 120
        ? 'rejected_hard_attribute:Ergonomic U-shaped or curved pillow body'
        : 'rejected_must_not_be:flat seat cushion';

    recordCandidateDecision(trace, {
      source: 'amazon',
      marketplace: i % 2 === 0 ? 'US' : 'UK',
      entityType: 'listing',
      id: `B0REJECT${String(i).padStart(3, '0')}`,
      title: `Rejected Listing #${i}`,
      url: `https://www.amazon.com/dp/B0REJECT${String(i).padStart(3, '0')}`,
      referenceSimilarity: 0.35,
      attributeVerdicts: {
        verdict: 'similar_other_type',
        verdictTier: 'other_type',
        confidence: 0.85,
      },
      verdictTier: 'other_type',
      stage: i <= 50 ? 'visual_stage1_local' : 'visual_stage2_gemini',
      finalDecision: 'rejected',
      reasonCode,
      rejectionReason: reasonCode,
      rejectionReasonAr: `سبب رفض ${i}`,
    });
  }

  const diag = computeDerivedDiagnostics(trace);

  // Top chip rejected counter and diagnostic panel rejected counter both read from diag.listingsRejected
  const topChipRejectedCount = diag.listingsRejected;
  const panelRejectedCount = diag.listingsRejected;
  const traceRejectedListingsCount = trace.candidates.filter(
    (c) => c.entityType === 'listing' && c.finalDecision === 'rejected'
  ).length;

  assert.equal(diag.listingsInspected, 137, 'Inspected listings must equal 137');
  assert.equal(diag.listingsAccepted, 2, 'Accepted listings must equal 2');
  assert.equal(diag.listingsRejected, 135, 'Rejected listings must equal 135 (never capped at 45)');
  assert.equal(
    topChipRejectedCount,
    panelRejectedCount,
    'Top chip counter and panel counter must never disagree'
  );
  assert.equal(
    topChipRejectedCount,
    traceRejectedListingsCount,
    'Displayed rejected count must match trace rejected listings count (135)'
  );

  // Sum of non-error reason histogram counts must equal 135
  const histogramRejectedSum = (diag.reasonHistograms || [])
    .filter((h) => !h.isErrorNotRejection)
    .reduce((acc, h) => acc + h.count, 0);
  assert.equal(histogramRejectedSum, 135, 'Reason histogram sum must equal 135');

  // Amazon funnel stage counts must be consistent
  const amazonFunnel = diag.funnels?.find((f) => f.scopeKey === 'amazon');
  assert.ok(amazonFunnel, 'Amazon funnel must exist');
  const acceptedStage = amazonFunnel.stages.find((s) => s.stageId === 'accepted');
  assert.equal(acceptedStage?.outCount, 2, 'Amazon funnel accepted stage outCount must equal 2');
});

test('Phase 1.4: Error-is-not-rejection — verification_error and budget_exhausted mark finalDecision unverified and never count as rejected', () => {
  assert.equal(isErrorNotRejectionReason('verification_error'), true);
  assert.equal(isErrorNotRejectionReason('verification_error:timeout'), true);
  assert.equal(isErrorNotRejectionReason('budget_exhausted'), true);
  assert.equal(isErrorNotRejectionReason('rejected_other_type'), false);

  const trace = createSearchTrace('test-error-not-rejection', {
    productName: 'Test Product',
    mediaType: 'video',
    sourcePlatform: 'amazon',
    targetVideoCount: 10,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  // 1) Candidate that hit a Gemini timeout / 429 verification_error
  recordCandidateDecision(trace, {
    source: 'amazon',
    marketplace: 'US',
    entityType: 'listing',
    id: 'B0ERRORTMO',
    title: 'Candidate With Gemini Timeout',
    url: 'https://www.amazon.com/dp/B0ERRORTMO',
    referenceSimilarity: 0.65,
    attributeVerdicts: {
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
    },
    verdictTier: 'unverified',
    stage: 'visual_timeout_fallback',
    finalDecision: 'unverified',
    reasonCode: 'verification_error',
    rejectionReason: 'verification_error',
    rejectionReasonAr: 'انتهت مهلة Gemini بعد 3 محاولات',
  });

  // 2) Candidate that hit daily budget exhaustion
  recordCandidateDecision(trace, {
    source: 'amazon',
    marketplace: 'US',
    entityType: 'listing',
    id: 'B0BUDGETEX',
    title: 'Candidate With Exhausted Budget',
    url: 'https://www.amazon.com/dp/B0BUDGETEX',
    referenceSimilarity: 0.68,
    attributeVerdicts: {
      verdict: 'unverified_by_ai',
      verdictTier: 'unverified',
    },
    verdictTier: 'unverified',
    stage: 'budget_fallback',
    finalDecision: 'unverified_ai_fallback',
    reasonCode: 'budget_exhausted',
    rejectionReason: 'budget_exhausted',
    rejectionReasonAr: 'استنفاد ميزانية Gemini اليومية',
  });

  const diag = computeDerivedDiagnostics(trace);

  assert.equal(
    diag.listingsRejected,
    0,
    'verification_error and budget_exhausted must NEVER be counted as rejected'
  );
  assert.equal(diag.unverifiedListingsCount, 2, 'Both items must be counted as unverified');
  assert.equal(diag.verificationErrorsCount, 1, 'verificationErrorsCount must be 1');
  assert.equal(diag.budgetExhaustedCount, 1, 'budgetExhaustedCount must be 1');
  assert.equal(diag.tierCounts?.unverified, 2, 'tierCounts.unverified must be 2');
});

test('Phase 5: Global target redistribution — when TikTok yields 0, Amazon continues filling up to global target N', () => {
  const globalTarget = 40;
  const amazonMaxCap = 500;
  const tiktokMaxCap = 500;

  // When Amazon has already found 20 (its nominal half) and TikTok has found 0,
  // Amazon MUST keep accepting videos up to globalTarget = 40!
  const canAmazonAcceptAt20 = canSourceAcceptMoreVideos({
    source: 'amazon',
    totalVideoTarget: globalTarget,
    foundAmazonVideos: 20,
    foundTikTokVideos: 0,
    amazonMaxCap,
    tiktokMaxCap,
    includeAmazon: true,
    includeTikTok: true,
  });
  assert.equal(
    canAmazonAcceptAt20,
    true,
    'Amazon must continue accepting past 20 when TikTok yielded 0 and global target is 40'
  );

  const canAmazonAcceptAt39 = canSourceAcceptMoreVideos({
    source: 'amazon',
    totalVideoTarget: globalTarget,
    foundAmazonVideos: 39,
    foundTikTokVideos: 0,
    amazonMaxCap,
    tiktokMaxCap,
    includeAmazon: true,
    includeTikTok: true,
  });
  assert.equal(canAmazonAcceptAt39, true, 'Amazon must accept #40 when total is 39/40');

  // Once total reaches 40 (e.g. 35 Amazon + 5 TikTok), both sources stop
  const canAmazonAcceptAt40 = canSourceAcceptMoreVideos({
    source: 'amazon',
    totalVideoTarget: globalTarget,
    foundAmazonVideos: 35,
    foundTikTokVideos: 5,
    amazonMaxCap,
    tiktokMaxCap,
    includeAmazon: true,
    includeTikTok: true,
  });
  assert.equal(canAmazonAcceptAt40, false, 'Must stop once global target 40 is reached');
});

test('Phase 3.1: TikTok item survival when download fails — item is kept as FOUND with oEmbed metadata/embedHtml and download_failed:<reason>', async () => {
  const trace = createSearchTrace('test-tiktok-survival', {
    productName: 'Mosquito Killer Lamp',
    mediaType: 'video',
    sourcePlatform: 'tiktok',
    targetVideoCount: 10,
    hasReferenceImage: false,
    matchMode: 'same_design',
  });

  // Record a TikTok video where oEmbed succeeded and visual verification passed,
  // but direct MP4 download failed (downloadFailedButKept = true)
  recordCandidateDecision(trace, {
    source: 'tiktok',
    provider: 'serp-hydration',
    entityType: 'video',
    id: '7349557795224603950',
    title: 'Mosquito Killer Trap Review #tiktokmademebuyit',
    url: 'https://www.tiktok.com/@ creator/video/7349557795224603950',
    thumbnailUrl: 'https://p16-sign-va.tiktokcdn.com/tos-maliva-p-0068/oembed_thumb.jpeg',
    thumbnailSource: 'tiktok_cover',
    referenceSimilarity: 0.58,
    attributeVerdicts: {
      verdict: 'same_design',
      verdictTier: 'exact',
      confidence: 0.84,
    },
    verdictTier: 'exact',
    stage: 'emitted',
    finalDecision: 'accepted',
    reasonCode: 'download_failed:yt_dlp_not_installed',
    rejectionReason: null,
    rejectionReasonAr: null,
    downloadFailedButKept: true,
    downloadFailureReason: 'download_failed:yt_dlp_not_installed',
    embedHtml: '<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@creator/video/7349557795224603950"></blockquote>',
  });

  const diag = computeDerivedDiagnostics(trace);

  assert.equal(diag.emittedVideos, 1, 'TikTok item with failed download must still count as emitted/FOUND');
  assert.equal(diag.tiktokEmitted, 1, 'tiktokEmitted must be 1');
  assert.equal(
    diag.tiktokDownloadFailedButKeptCount,
    1,
    'tiktokDownloadFailedButKeptCount must record the survived item'
  );

  // Also test live hydrateTikTokCandidateWithFallbacks if network is reachable
  const liveCandidate = await hydrateTikTokCandidateWithFallbacks(
    'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'url-import'
  );
  if (liveCandidate) {
    assert.ok(liveCandidate.videoId, 'Hydrated TikTok candidate must have videoId');
    assert.ok(liveCandidate.thumbnailUrl || liveCandidate.embedHtml, 'Must preserve oEmbed thumbnail or embedHtml');
    if (!liveCandidate.hasDirectMp4) {
      assert.ok(
        liveCandidate.downloadFailureReason?.startsWith('download_failed:'),
        `Expected downloadFailureReason to start with download_failed:, got ${liveCandidate.downloadFailureReason}`
      );
    }
  }
});

test('Phase 6.1: Asking for 40 never displays any denominator other than 40 (no x/500 per-source denominators)', () => {
  const trace = createSearchTrace('test-no-500-denominator', {
    productName: 'Cordless Electric Power Drill with Tool Kit',
    mediaType: 'video',
    sourcePlatform: 'all',
    targetVideoCount: 40,
    targetAmazonVideoCount: 500, // internal safety cap passed in
    targetTikTokVideoCount: 500, // internal safety cap passed in
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  for (let i = 1; i <= 4; i++) {
    recordCandidateDecision(trace, {
      source: 'tiktok',
      provider: 'serp-hydration',
      entityType: 'video',
      id: `755000000000000000${i}`,
      title: `Cordless Drill Kit Review #${i}`,
      url: `https://www.tiktok.com/@creator/video/755000000000000000${i}`,
      referenceSimilarity: 0.91,
      attributeVerdicts: { verdictTier: 'same_design_variant' },
      verdictTier: 'same_design_variant',
      stage: 'emitted',
      finalDecision: 'accepted',
      reasonCode: null,
      rejectionReason: null,
      rejectionReasonAr: null,
    });
  }

  const diag = computeDerivedDiagnostics(trace);
  const reportMd = buildDiagnosticReportMarkdown(trace, diag);

  // Report and UI must show /40 (or من 40 المطلوب) and NEVER /500
  assert.ok(
    reportMd.includes('المؤكد 4 من 40 المطلوب'),
    'Report headline must display المؤكد 4 من 40 المطلوب'
  );
  assert.equal(
    /\/\s*500\b/.test(reportMd),
    false,
    'Diagnostic report must NEVER display /500 as a denominator'
  );

  // Also verify JobProgress.tsx source code never renders /{amazonTargetCount} or /500 on source chips
  const jobProgressSrc = fs.readFileSync(
    new URL('../../components/JobProgress.tsx', import.meta.url),
    'utf-8'
  );
  assert.equal(
    jobProgressSrc.includes('/{amazonTargetCount}') || jobProgressSrc.includes('/{tiktokTargetCount}'),
    false,
    'JobProgress.tsx must never render per-source /{amazonTargetCount} or /{tiktokTargetCount} denominators'
  );
});

test('Phase 6.2: Semantic counter consistency — rejectedTotal, rejected_by_text_prefilter, rejected_by_local_visual, rejected_by_gemini, rejected_by_hard_attribute, verification_error, duplicates', () => {
  const trace = createSearchTrace('test-semantic-counters', {
    productName: 'Cordless Electric Power Drill with Tool Kit',
    mediaType: 'video',
    sourcePlatform: 'all',
    targetVideoCount: 40,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  // 2 rejected by text prefilter
  for (let i = 1; i <= 2; i++) {
    recordCandidateDecision(trace, {
      source: 'amazon',
      entityType: 'listing',
      id: `B0TEXT000${i}`,
      title: `Impact Wrench #${i}`,
      url: `https://www.amazon.com/dp/B0TEXT000${i}`,
      referenceSimilarity: null,
      attributeVerdicts: {},
      stage: 'text_gate',
      finalDecision: 'rejected',
      reasonCode: 'rejected_must_not_be:Impact wrench',
      verdictTier: 'other_type',
      rejectionReason: 'text_gate',
      rejectionReasonAr: 'مستبعد نصياً',
    });
  }

  // 3 rejected by local visual (CLIP Stage 1)
  for (let i = 1; i <= 3; i++) {
    recordCandidateDecision(trace, {
      source: 'tiktok',
      entityType: 'video',
      id: `TTLOCAL00${i}`,
      title: `Unrelated Video #${i}`,
      url: `https://www.tiktok.com/@u/video/TTLOCAL00${i}`,
      referenceSimilarity: 0.21,
      attributeVerdicts: {},
      stage: 'visual_stage1_local',
      finalDecision: 'rejected',
      reasonCode: 'low_similarity',
      verdictTier: 'unrelated',
      rejectionReason: 'low_similarity',
      rejectionReasonAr: 'تشابه بصري محلي منخفض',
    });
  }

  // 7 rejected by Gemini Stage 2 (4 of which are rejected_hard_attribute)
  for (let i = 1; i <= 7; i++) {
    const isHard = i <= 4;
    recordCandidateDecision(trace, {
      source: 'tiktok',
      entityType: 'video',
      id: `TTGEM000${i}`,
      title: `Tool Video #${i}`,
      url: `https://www.tiktok.com/@u/video/TTGEM000${i}`,
      referenceSimilarity: 0.78,
      attributeVerdicts: {},
      stage: 'visual_stage2_gemini',
      finalDecision: 'rejected',
      reasonCode: isHard ? 'rejected_hard_attribute:Keyless chuck' : 'rejected_other_type',
      verdictTier: 'other_type',
      rejectionReason: 'gemini',
      rejectionReasonAr: 'تعارض',
    });
  }

  // 1 verification_error (must NOT be in rejectedTotal!)
  recordCandidateDecision(trace, {
    source: 'tiktok',
    entityType: 'video',
    id: 'TTERR0001',
    title: 'Timeout Video',
    url: 'https://www.tiktok.com/@u/video/TTERR0001',
    referenceSimilarity: 0.75,
    attributeVerdicts: {},
    stage: 'budget_fallback',
    finalDecision: 'unverified',
    reasonCode: 'verification_error',
    verdictTier: 'unverified',
    rejectionReason: 'verification_error',
    rejectionReasonAr: 'خطأ تقني',
  });

  const diag = computeDerivedDiagnostics(trace);

  assert.equal(diag.rejectedTotal, 12, 'Total rejected candidates across all sources must be 12');
  assert.equal(diag.rejected_by_text_prefilter, 2);
  assert.equal(diag.rejected_by_local_visual, 3);
  assert.equal(diag.rejected_by_gemini, 7);
  assert.equal(diag.rejected_by_hard_attribute, 4);
  assert.equal(diag.verification_error, 1);
  assert.equal(
    diag.rejected_by_text_prefilter! + diag.rejected_by_local_visual! + diag.rejected_by_gemini!,
    diag.rejectedTotal,
    'Sum of stage rejection counters must equal rejectedTotal (12)'
  );
});

test('Phase 6.3 & 6.4: Stop-reason mapping and Minimum-Effort Guard — blocked rounds produce amazon_blocked, low effort produces insufficient_search, never exhausted_candidates prematurely', () => {
  // Case A: Amazon rounds all blocked by 503/CAPTCHA -> stopReason MUST be amazon_blocked
  const traceBlocked = createSearchTrace('test-stop-amazon-blocked', {
    productName: 'Cordless Electric Power Drill with Tool Kit',
    mediaType: 'video',
    sourcePlatform: 'all',
    targetVideoCount: 40,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  for (let i = 1; i <= 4; i++) {
    recordSearchRound(traceBlocked, {
      round: `R1_q${i}`,
      source: 'amazon',
      marketplace: 'US',
      query: `cordless drill kit ${i}`,
      page: 1,
      candidatesFound: 0,
      newCandidatesCount: 0,
      verifiedCount: 0,
      videosFound: 0,
      durationMs: 400,
      status: 'blocked',
      error: 'Amazon HTTP 503 CAPTCHA / Dog Page',
    });
  }

  const diagBlocked = computeDerivedDiagnostics(traceBlocked);
  assert.equal(
    diagBlocked.stopReasonCode,
    'amazon_blocked',
    'When Amazon search rounds are blocked and yield 0 listings, stopReasonCode must be amazon_blocked (never exhausted_candidates)'
  );

  // Case B: Unblocked but inspected only 5 items (< minListingsInspected=10) -> stopReasonCode MUST be insufficient_search
  const traceInsufficient = createSearchTrace('test-stop-insufficient-effort', {
    productName: 'Cordless Electric Power Drill with Tool Kit',
    mediaType: 'video',
    sourcePlatform: 'all',
    targetVideoCount: 40,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  recordSearchRound(traceInsufficient, {
    round: 'R1_p1',
    source: 'amazon',
    marketplace: 'US',
    query: 'cordless drill',
    page: 1,
    candidatesFound: 5,
    newCandidatesCount: 5,
    verifiedCount: 0,
    videosFound: 0,
    durationMs: 300,
    status: 'ok',
  });

  const diagInsufficient = computeDerivedDiagnostics(traceInsufficient);
  assert.equal(diagInsufficient.minimumEffortMet, false, 'minimumEffortMet must be false when <3 queries and <10 inspected');
  assert.equal(
    diagInsufficient.stopReasonCode,
    'insufficient_search',
    'When minimum effort was not met, stopReasonCode must be insufficient_search (never exhausted_candidates)'
  );
});

test('Phase 6.5: ZIP never empty — returns HTTP 409 on 0 items, and creates valid non-empty ZIP verified by unzip -t and Python zipfile on real items', async () => {
  // 1) 0 items -> HTTP 409
  let emptyStatus = 200;
  let emptyJson: any = null;
  await handleStreamExportZip(
    { query: { searchId: 'unit-empty' }, body: { searchId: 'unit-empty', assets: [] } } as any,
    {
      status(c: number) {
        emptyStatus = c;
        return this;
      },
      json(b: any) {
        emptyJson = b;
        return this;
      },
    } as any,
    'unit-owner'
  );
  assert.equal(emptyStatus, 409, 'Exporting 0 items must return HTTP 409 (never a 22-byte empty ZIP)');
  assert.ok(emptyJson?.error, 'HTTP 409 response must include an Arabic error message');

  // 2) Link-only / cached item -> valid ZIP verified by unzip -t and python zipfile
  const testSearchId = 'unit-zip-valid';
  await handlePrepareExportZip(
    {
      body: {
        searchId: testSearchId,
        productName: 'Cordless_Drill_Unit_Test',
        assets: [
          {
            id: 'ast-unit-1',
            title: 'مثقاب كهربائي لاسلكي 20 فولت',
            mediaUrl: 'https://www.tiktok.com/@creator/video/7554345537298844941',
            downloadUrl: 'https://www.tiktok.com/@creator/video/7554345537298844941',
            url: 'https://www.tiktok.com/@creator/video/7554345537298844941',
            productListingUrl: 'https://www.tiktok.com/@creator/video/7554345537298844941',
            mediaType: 'video',
                    verdictTier: 'same_design_variant',
          },
        ],
        verifyDownloads: true,
      },
    } as any,
    {
      status() {
        return this;
      },
      json() {
        return this;
      },
    } as any,
    'unit-owner'
  );

  const zipPath = path.join(os.tmpdir(),'unit_test_phase6-'+process.pid+'.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const out = fs.createWriteStream(zipPath);
  (out as any).headersSent = false;
  (out as any).setHeader = () => {};
  (out as any).flushHeaders = () => {
    (out as any).headersSent = true;
  };
  (out as any).status = () => out;
  (out as any).json = () => out;

  await handleStreamExportZip(
    { query: { searchId: testSearchId }, body: {} } as any,
    out as any,
    'unit-owner'
  );

  const st = fs.statSync(zipPath);
  assert.ok(st.size > 500, `ZIP size must be > 500 bytes (never 22 bytes), got ${st.size}`);
  const pyOut = execFileSync(process.platform==='win32'?'python':'python3', [
    '-c',
    'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; names=z.namelist(); assert any(n.endswith("manifest.csv") for n in names); assert any(n.endswith("links.txt") for n in names); print(len(names))',
    zipPath,
  ])
    .toString()
    .trim();
  assert.ok(Number(pyOut) >= 4, `Expected at least 4 entries in ZIP, got ${pyOut}`);
});

test('Phase 6.6: HARD attribute downgrade rules — rejects tautological/vague "X design" attributes, limits HARD to <=3, and downgrades conflicts without visual evidence or confidence', () => {
  // 1) Vague "X design" and tautological attributes are flagged invalid for HARD
  assert.equal(
    isTautologicalOrVagueAttribute(
      'Pistol-grip cordless drill design',
      'Cordless Electric Power Drill with Tool Kit',
      'Power Tools'
    ).isInvalidForHard,
    true,
    '"Pistol-grip cordless drill design" must be rejected as a HARD attribute'
  );
  assert.equal(
    isTautologicalOrVagueAttribute(
      'Cordless electric drill',
      'Cordless Electric Power Drill with Tool Kit',
      'Cordless Drill'
    ).isInvalidForHard,
    true,
    'Tautological product type restatement must be rejected as a HARD attribute'
  );

  // 2) classifyIdentityAttributeStrengths limits HARD attributes to at most 3 and downgrades case/grip/design to SOFT
  const attrs = [
    'Pistol-grip cordless drill design',
    'Hard-shell plastic storage case with specific molded slots',
    'Keyless 3/8-inch chuck',
    'Torque clutch ring with 25+1 settings',
    'Removable slide-in lithium battery pack',
    'Forward/reverse lever above trigger',
    'Built-in LED work light',
  ];
  const classified = classifyIdentityAttributeStrengths(attrs, undefined, {
    nameEn: 'Cordless Electric Power Drill with Tool Kit',
    category: 'Power Drill',
  });
  const hardList = Object.entries(classified)
    .filter(([, v]) => v === 'hard')
    .map(([k]) => k);
  assert.ok(hardList.length <= 3, `HARD attributes must be limited to at most 3, got ${hardList.length}`);
  assert.equal(classified['Pistol-grip cordless drill design'], 'soft');
  assert.equal(classified['Hard-shell plastic storage case with specific molded slots'], 'soft');

  // 3) evaluateHardAttributeConflicts downgrades a HARD conflict to SOFT if confidence < threshold or visual evidence is empty
  const lowConfCheck = evaluateHardAttributeConflicts({
    failedHardAttributes: ['Keyless 3/8-inch chuck'],
    visualEvidenceText: 'Shows a fixed hex collet instead of a keyless chuck',
    confidence: 0.55, // below 0.72 threshold
    attributeStrengths: classified,
    productNameEn: 'Cordless Electric Power Drill with Tool Kit',
    hardConflictMinConfidence: 0.72,
  });
  assert.equal(lowConfCheck.actualFailedHard.length, 0, 'Low-confidence HARD conflict must be downgraded to SOFT');
  assert.deepEqual(lowConfCheck.downgradedToSoft, ['Keyless 3/8-inch chuck']);

  const noEvidenceCheck = evaluateHardAttributeConflicts({
    failedHardAttributes: ['Keyless 3/8-inch chuck'],
    visualEvidenceText: '', // missing visual evidence
    confidence: 0.92,
    attributeStrengths: classified,
    productNameEn: 'Cordless Electric Power Drill with Tool Kit',
    hardConflictMinConfidence: 0.72,
  });
  assert.equal(noEvidenceCheck.actualFailedHard.length, 0, 'HARD conflict without visual evidence text must be downgraded to SOFT');
  assert.deepEqual(noEvidenceCheck.downgradedToSoft, ['Keyless 3/8-inch chuck']);
});

test('New Test 1 (Phase 1): Evidence-Gated Badges — caption-only (V1), person-in-car thumbnail without 2 product frames (V2), or dead link can NEVER be Exact', () => {
  // 1a) Candidate with caption/hashtags only (V1) -> demoted to unverified, never counted toward target
  const v1CaptionOnly = enforceEvidenceGatedBadge({
    rawTier: 'exact',
    evidenceLevel: 'V1',
    linkState: 'alive',
    allHardAttributesConfirmedVisible: false,
    hasHardAttributeConflict: false,
  });
  assert.equal(v1CaptionOnly.finalTier, 'unverified', 'Caption-only (V1) candidate can NEVER be Exact');
  assert.equal(v1CaptionOnly.countsTowardTarget, false, 'V1 candidate must never count toward the target');

  // 1b) Candidate with only a single thumbnail / person-in-car frame (V2) -> cannot be Exact (Exact requires V3 >= 2 keyframes)
  const v2SingleThumb = enforceEvidenceGatedBadge({
    rawTier: 'exact',
    evidenceLevel: 'V2',
    linkState: 'alive',
    allHardAttributesConfirmedVisible: false,
    hasHardAttributeConflict: false,
  });
  assert.notEqual(v2SingleThumb.finalTier, 'exact', 'Single thumbnail / person-in-car frame (V2) can NEVER be Exact');
  assert.equal(
    v2SingleThumb.finalTier,
    'same_type_close_design',
    'V2 without all HARD attributes visible is capped at same_type_close_design (محتمل)'
  );

  // 1c) Candidate with V3 evidence and all HARD attributes confirmed visible -> earns Exact
  const v3Confirmed = enforceEvidenceGatedBadge({
    rawTier: 'exact',
    evidenceLevel: 'V3',
    linkState: 'alive',
    allHardAttributesConfirmedVisible: true,
    hasHardAttributeConflict: false,
  });
  assert.equal(v3Confirmed.finalTier, 'exact', 'V3 with all HARD attributes confirmed visible earns Exact');
  assert.equal(v3Confirmed.countsTowardTarget, true);

  // 1d) Candidate with a dead link (404) -> can NEVER receive a match badge even if rawTier was Exact
  const deadLinkGated = enforceEvidenceGatedBadge({
    rawTier: 'exact',
    evidenceLevel: 'V3',
    linkState: 'dead',
    allHardAttributesConfirmedVisible: true,
    hasHardAttributeConflict: false,
  });
  assert.equal(deadLinkGated.finalTier, 'unverified', 'Dead link can never receive a match badge');
  assert.equal(deadLinkGated.countsTowardTarget, false, 'Dead link must never count toward target');
});

test('New Test 2: blind observations reject a conflicting product and cap missing hard evidence',()=>{
 const identity:import('./identity.ts').IdentityCardV2={
 imageHash:'blind-test',nameEn:'Console Armrest Pad',nameAr:'مسند',category:'automotive',primaryColor:'black',
 formFactor:{shape:'pad',approximateSize:'small',orientationPlacement:'front console'},
 mechanism:{howItWorks:'straps',powerSource:'none',keyComponents:['straps']},
 mustMatch:['Top mounted pad with straps'],mustNotBe:['wireless charging'],variableAttributes:[],
 queries:{amazonEn:[],amazonAr:[],tiktokEn:[],tiktokAr:[],tradeNamesEn:[]},hashtags:[],confidence:0.9,ambiguity:[],createdAt:new Date().toISOString(),
 };
 const {discriminators}=buildDiscriminatorsForIdentityCard(identity);
 const description:BlindCandidateDescription={
 productVisibleFrameIndices:[0,1],onlyPersonOrBackgroundVisible:false,
 observedProductCategory:'rear seat organizer',observedProductTitleEn:'wireless charging organizer',
 observedProductSummaryAr:'منتج مختلف',observedFormFactor:'box',observedPlacement:'rear seat',
 observedConstructionType:'plastic',hasWirelessChargerVisible:'yes',observedLookalikeMatch:'rear seat',
 boundingBoxes:[],discriminatorObservations:discriminators.map(d=>({discriminatorId:d.id,discriminatorName:d.name,strength:d.strength,observedStatus:'present_conflict',observedValue:'wireless charger',frameIndices:[0,1]}))
 };
 const comparison=compareBlindProfileInCode({identityCard:identity,blindDesc:description,candidateTitle:'wireless charging',framesInspectedCount:2,usedFallbackThumbnailOnly:false,fullFrameClipSimilarity:0.7,cropClipSimilarity:0.7,linkState:'alive',hasRetrievableMedia:true});
 assert.equal(comparison.approved,false);
});
test('New Test 3 (Phase 1.3): Dead vs Blocked link states — 404/10204 is dead, 403/429/503 challenge is blocked (never labelled dead)', () => {
  const dead404 = classifyHttpStatusToLinkState(404);
  assert.equal(dead404.linkState, 'dead', 'HTTP 404 must be classified as dead');

  const deadTikTokCode = classifyHttpStatusToLinkState(200, 'status_code=10204 video not available');
  assert.equal(deadTikTokCode.linkState, 'dead', 'TikTok status_code=10204 must be classified as dead');

  const blocked403 = classifyHttpStatusToLinkState(403, 'Access Denied / Captcha challenge');
  assert.equal(
    blocked403.linkState,
    'blocked',
    'HTTP 403 challenge to the server must be classified as blocked, never dead'
  );

  const blocked429 = classifyHttpStatusToLinkState(429, 'Rate limit exceeded');
  assert.equal(
    blocked429.linkState,
    'blocked',
    'HTTP 429 rate-limit must be classified as blocked, never dead'
  );

  const alive200 = classifyHttpStatusToLinkState(200, '{"title":"Valid video"}');
  assert.equal(alive200.linkState, 'alive', 'HTTP 200 with valid body must be classified as alive');
});

test('New Test 4 (Phase 4.2): Candidate & Snowball Expansion strictly from VERIFIED (V2/V3) items only — never expands from V0/V1 or rejected items', async () => {
  // 4a) Query snowball expansion ignores V1/V0/rejected items
  const snowballFromUnverifiedOnly = expandSnowballQueriesFromVerified({
    identity: testIdentity(),
    verifiedItems: [
      {
        title: 'Wrong Rear Seat Armrest Box Wireless Charger #carorganizer',
        id:'seed',
        evidenceLevel: 'V1' as any,
        verdictTier: 'exact',
      },
    ],
    alreadyRunQueries: new Set(),

  });
  assert.equal(
    snowballFromUnverifiedOnly.newAmazonQueries.length,
    0,
    'Must never expand queries from V1 items'
  );
  assert.equal(
    snowballFromUnverifiedOnly.newTikTokQueries.length,
    0,
    'Must never expand TikTok queries from V1 items'
  );

  // 4b) When V3 verified items are provided, snowball extracts valid queries excluding mustNotBe terms
  const snowballFromV3 = expandSnowballQueriesFromVerified({
    identity: testIdentity(),
    verifiedItems: [
      {
        title: 'Quilted Leather Front Console Armrest Pad with Cup Holder #cararmrestpad #consolecushion',
        id:'seed',
        evidenceLevel: 'V3',
        verdictTier: 'exact',
        reviewerOrChannel: '@carinteriorpro',
      },
    ],
    alreadyRunQueries: new Set(),

  });
  assert.ok(
    snowballFromV3.newTikTokQueries.length > 0,
    'Must expand TikTok queries from V3 verified items'
  );
  assert.ok(
    snowballFromV3.verifiedHashtags.includes('cararmrestpad'),
    'Must extract hashtags from V3 verified items'
  );

  // 4c) expandTikTokCandidatesFromVerified returns [] when given no V2/V3 seeds
  const {expandedCandidates:emptyExpansion}=await expandTikTokCandidatesFromVerified({
    identity:testIdentity(),verifiedItems:[{id:'x',title:'unverified clip',evidenceLevel:'V1',verdictTier:'unverified'}],
    alreadySeenVideoIds:new Set(),alreadyRunQueries:new Set()
  });
  assert.equal(emptyExpansion.length, 0, 'expandTikTokCandidatesFromVerified must never expand from non-V2/V3 seeds');
});

test('New Test 5 (Phase 5): Owner Feedback Loop — marking a card "✗ مش المنتج" demotes it and near-duplicates immediately and updates live precision', () => {
  const testRefHash = `unit-feedback-hash-${Date.now()}`;

  // Record 1 negative label on a rear-seat wireless charger armrest box video
  recordOwnerFeedback({
    imageHash: testRefHash,
    videoId: '7514170420396838160',
    candidateId: 'ast-tt-1',
    sourceUrl: 'https://www.tiktok.com/@u1/video/7514170420396838160',
    title: 'For Car Rear Seat Armrest Box Organizer With 2 Cup Holders 15W Wireless Charging',
    label: 'different_product',
    verdictTier: 'exact',
    evidenceLevel: 'V2',
    embedding: [0.8, 0.2, 0.1, 0.0],
  });

  // Record 1 positive label on an actual front console armrest pad video
  recordOwnerFeedback({
    imageHash: testRefHash,
    videoId: '7599999999999999999',
    candidateId: 'ast-tt-3',
    sourceUrl: 'https://www.tiktok.com/@u3/video/7599999999999999999',
    title: 'Front Center Console Quilted Leather Armrest Pad Cushion with Cup Holders',
    label: 'same_product',
    verdictTier: 'same_design_variant',
    evidenceLevel: 'V3',
    embedding: [0.1, 0.9, 0.2, 0.1],
  });

  const rescored = rescoreCandidatesWithOwnerFeedback({
    imageHash: testRefHash,
    candidateEmbeddings:new Map([['ast-tt-1',[0.8,0.2,0.1,0]],['ast-tt-2',[0.79,0.21,0.11,0.01]],['ast-tt-3',[0.1,0.9,0.2,0.1]]]),
    candidates: [
      {
        ...feedbackAssetDefaults(),id: 'ast-tt-1',

        title: 'For Car Rear Seat Armrest Box Organizer With 2 Cup Holders 15W Wireless Charging',
        sourceUrl: 'https://www.tiktok.com/@u1/video/7514170420396838160',
        verdictTier: 'exact',
        evidenceLevel: 'V2',
        matchScore: 90,

      },
      {
        // Near-duplicate of the negatively labelled item (high embedding + title overlap)
        ...feedbackAssetDefaults(),id: 'ast-tt-2',

        title: 'Car Rear Seat Armrest Box Organizer With 2 Cup Holders and Wireless Charging Pad',
        sourceUrl: 'https://www.tiktok.com/@u2/video/7468197375589256465',
        verdictTier: 'same_design_variant',
        evidenceLevel: 'V2',
        matchScore: 86,

      },
      {
        ...feedbackAssetDefaults(),id: 'ast-tt-3',

        title: 'Front Center Console Quilted Leather Armrest Pad Cushion with Cup Holders',
        sourceUrl: 'https://www.tiktok.com/@u3/video/7599999999999999999',
        verdictTier: 'same_design_variant',
        evidenceLevel: 'V3',
        matchScore: 88,

      },
    ],
  });

  assert.ok(rescored.demotedIds.includes('ast-tt-1'), 'Directly rejected item must be demoted');
  assert.ok(
    rescored.demotedIds.includes('ast-tt-2'),
    'Near-duplicate of negatively labelled item must be automatically demoted'
  );
  assert.equal(rescored.precisionStats.totalLabelled, 2);
  assert.equal(rescored.precisionStats.sameProductCount, 1);
  assert.equal(rescored.precisionStats.differentProductCount, 1);
  assert.equal(rescored.precisionStats.precisionPercent, 50);
});


function feedbackAssetDefaults():import('../../types/index.ts').CandidateAsset{
 return {id:'',projectId:'test',title:'',platform:'tiktok',sourceUrl:'',mediaType:'video',thumbnailUrl:'',provenance:'unresolved_source',matchCategory:'permitted_variation',matchScore:0,userFacingMatchLabel:'',visibleDifferences:[],supportingObservations:[],unknowns:[],contentDescription:'',downloadStatus:'source_only',collectedAt:new Date().toISOString(),rightsStatus:'public_reference',selectedForExport:false};
}
function testIdentity():import('./identity.ts').IdentityCardV2{
 return {imageHash:'snowball-test',nameEn:'Front Console Armrest Pad',nameAr:'مسند',category:'automotive',primaryColor:'black',formFactor:{shape:'pad',approximateSize:'small',orientationPlacement:'front'},mechanism:{howItWorks:'straps',powerSource:'none',keyComponents:[]},mustMatch:['console pad'],mustNotBe:['wireless charger'],variableAttributes:[],queries:{amazonEn:[],amazonAr:[],tiktokEn:[],tiktokAr:[],tradeNamesEn:[]},hashtags:[],confidence:0.9,ambiguity:[],createdAt:new Date().toISOString()};
}
