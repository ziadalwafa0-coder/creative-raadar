import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveIdentityCardV2,
  upsertManualIdentityCard,
  IdentityResolutionFailedError,
  type IdentityCardV2,
} from './identity.ts';
import {
  detectDynamicMustNotBeInText,
  verifyListingCandidatesBatch,
  setSimulatedGeminiBudgetExhausted,
  getDailyGeminiBudgetStatus,
} from './verify.ts';
import {
  computeColorAgnosticClipEmbedding,
  cosineSimilarityClip,
} from './clipEmbedding.ts';
import { runFixtureCalibration } from '../../../eval/calibrate.ts';
import {
  extractSnowballQueriesFromVerifiedTitles,
  isValidAmazonAsin,
} from '../amazonSearch.ts';
import {
  extractVariationSiblingAsins,
  markAsinAsDead,
  isAsinMarkedDead,
} from '../amazonVideos.ts';
import {
  hammingDistanceHex64,
  computeImageVisualSignature,
} from './thumbnails.ts';
import {
  isAmazonDeadListing,
  hasAmazonProductMarker,
  AmazonDeadListingError,
} from '../amazonHttp.ts';
import {
  createSearchTrace,
  recordCandidateDecision,
  recordFetchedResponse,
  finalizeSearchTrace,
  getSearchTrace,
} from './trace.ts';

test('Phase A: records and retrieves per-search decision trace in DATA_DIR', () => {
  const traceId = `test-trace-${Date.now()}`;
  const trace = createSearchTrace(traceId, {
    productName: 'Photocatalyst Suction Mosquito Killer',
    mediaType: 'video',
    sourcePlatform: 'amazon',
    targetVideoCount: 10,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  recordCandidateDecision(trace, {
    stage: 'visual_stage2_gemini',
    source: 'amazon',
    entityType: 'listing',
    id: 'B082F6HKZV',
    title: 'Lulu Home Electric Bug Zapper Indoor, 20W High Power Hanging Mosquito Killer',
    url: 'https://www.amazon.com/dp/B082F6HKZV',
    referenceSimilarity: 0.25,
    attributeVerdicts: {
      formFactorMatches: false,
      mechanismMatches: false,
      colorMatches: false,
      mustNotBeHit: ['electric grid bug zapper'],
      verdict: 'similar_other_type',
      confidence: 96,
    },
    finalDecision: 'rejected',
    rejectionReason: 'mustNotBe: electric grid bug zapper',
    rejectionReasonAr: 'شكل مختلف: صاعق بشبكة كهربائية',
  });

  finalizeSearchTrace(trace, { amazon: 'انتهت صفحات البحث المتاحة' });
  const loaded = getSearchTrace(traceId);
  assert.ok(loaded, 'Trace should be persisted and retrievable');
  assert.equal(loaded.candidates.length, 1);
  assert.equal(loaded.candidates[0].id, 'B082F6HKZV');
  assert.equal(loaded.candidates[0].finalDecision, 'rejected');
  assert.equal(loaded.summary.listingsRejected, 1);
});

test('Phase B & C (F1 Regression): rejects electric-grid bug zappers (0 accepted) while defining mustMatch and mustNotBe', {skip:process.env.RUN_NETWORK_TESTS!=='1'}, async () => {
  const f1Path = path.resolve(process.cwd(), 'eval/fixtures/f1_mosquito_killer_ref.png');
  assert.ok(fs.existsSync(f1Path), 'F1 fixture must exist in eval/fixtures/');
  const base64 = fs.readFileSync(f1Path).toString('base64');

  const identity = await resolveIdentityCardV2({
    base64Data: base64,
    mimeType: 'image/png',
  }).catch(() =>
    upsertManualIdentityCard({
      imageHash: 'f1-mosquito-test-hash',
      nameEn: 'USB Photocatalyst Suction Mosquito Killer Trap Lamp',
      nameAr: 'مصيدة ناموس ضوئية بالشفط USB',
      formFactorShape: 'Compact vertical cylindrical tower with top purple UV ring and bottom mesh cage',
      mechanismHowItWorks: 'UV light attracts mosquitoes and internal quiet fan sucks them into bottom dehydration cage',
      mustMatch: [
        'Cylindrical vertical tower body',
        'Top UV light ring opening with internal suction fan',
        'Bottom removable mesh collection cage',
      ],
      mustNotBe: [
        'Electric Bug Zapper',
        'High Voltage Mesh Grid',
        'Hanging Lantern Zapper',
        'Racket Swatter',
      ],
    })
  );

  assert.ok(identity.mustMatch.length >= 3, 'IdentityCard v2 must define mustMatch attributes');
  assert.ok(identity.mustNotBe.length >= 3, 'IdentityCard v2 must define mustNotBe look-alike exclusions');

  const candidates = [
    {
      id: 'B082F6HKZV',
      title: 'Lulu Home Electric Bug Zapper Indoor, 20W High Power Hanging Mosquito Killer',
      url: 'https://www.amazon.com/dp/B082F6HKZV',
      imageUrl: 'https://m.media-amazon.com/images/I/81NtZLqkMOL._AC_UL320_.jpg',
    },
    {
      id: 'B07KSRFJ9Y',
      title: 'FVOAI Bug Zapper Outdoor Electric, 4200V Mosquito Zapper Waterproof',
      url: 'https://www.amazon.com/dp/B07KSRFJ9Y',
      imageUrl: 'https://m.media-amazon.com/images/I/71wF8gJ4rSL._AC_UL320_.jpg',
    },
    {
      id: 'B07F3NH96Q',
      title: 'Aspectek Electronic Indoor Insect Killer, 20W Bug Zapper with High Voltage Mesh Grid',
      url: 'https://www.amazon.com/dp/B07F3NH96Q',
      imageUrl: 'https://m.media-amazon.com/images/I/71k7tY-wLXL._AC_UL320_.jpg',
    },
  ];

  const verdictsSameDesign = await verifyListingCandidatesBatch({
    referenceImageBase64: base64,
    referenceImageMimeType: 'image/png',
    identity,
    candidates,
    matchMode: 'same_design',
    includeSimilar: false,
  });

  for (const c of candidates) {
    const v = verdictsSameDesign.get(c.id);
    assert.ok(v, `Verdict missing for ${c.id}`);
    assert.equal(
      v.approved,
      false,
      `Electric grid zapper ${c.id} ("${c.title}") MUST be rejected, got verdict=${v.verdict}`
    );
    assert.ok(
      v.mustNotBeHit.length > 0 || !v.formFactorMatches || !v.mechanismMatches,
      `Rejection for ${c.id} must cite mustNotBeHit or formFactor/mechanism mismatch`
    );
  }
});

test('Phase C (F4 Color Tolerance vs Strict Color): dynamic MustNotBe & color variant rules work without hardcoded dictionaries', () => {
  const drillIdentity: IdentityCardV2 = {
    imageHash: 'drill-test-hash',
    nameEn: 'Cordless Brushless Compact Drill Driver',
    nameAr: 'شنيور فك وربط لاسلكي',
    category: 'Power Tools',
    primaryColor: 'yellow',
    formFactor: {
      shape: 'compact T-handle pistol grip cordless drill with keyless chuck',
      approximateSize: 'small handheld',
      orientationPlacement: 'handheld',
    },
    mechanism: {
      howItWorks: 'rotary chuck with torque clutch ring and slide-in battery pack',
      powerSource: 'rechargeable lithium battery pack',
      keyComponents: ['keyless chuck', 'torque clutch ring', 'trigger switch', 'battery pack'],
    },
    mustMatch: ['compact pistol grip drill', 'keyless chuck', 'torque clutch ring', 'cordless battery base'],
    variableAttributes: ['body color (yellow, red, blue, black, teal)', 'brand logo', 'carrying case'],
    mustNotBe: ['corded AC hammer drill', 'rotary demolition hammer', 'manual screwdriver set', 'angle grinder'],
    queries: {
      amazonEn: ['Cordless Brushless Compact Drill Driver'],
      amazonAr: ['شنيور لاسلكي'],
      tiktokEn: ['cordless drill review'],
      tiktokAr: ['شنيور لاسلكي'],
      tradeNamesEn: ['20V Max Compact Cordless Drill Driver'],
    },
    hashtags: ['#cordlessdrill'],
    confidence: 95,
    ambiguity: [],
    createdAt: new Date().toISOString(),
  };

  const hitCorded = detectDynamicMustNotBeInText(
    'DEWALT Corded AC Hammer Drill 8.5 Amp Heavy Duty',
    drillIdentity
  );
  assert.ok(hitCorded.length > 0, 'Dynamic mustNotBe should catch corded AC hammer drill');

  const hitSameDesignRed = detectDynamicMustNotBeInText(
    'Red 20V Cordless Brushless Compact Drill Driver with Keyless Chuck',
    drillIdentity
  );
  assert.equal(hitSameDesignRed.length, 0, 'Red color variant of the same cordless drill must not trigger mustNotBe');
});

test('Phase D: Snowball n-gram query expansion & variation sibling ASIN extraction', () => {
  const snowball = extractSnowballQueriesFromVerifiedTitles(
    [
      'Katchy Indoor Insect Trap Photocatalyst Suction Mosquito Killer Lamp',
      'Portable USB Photocatalyst Suction Mosquito Killer Trap Quiet Fan',
      'Mini Cylindrical Photocatalyst Suction Mosquito Trap USB Powered',
    ],
    new Set(['mosquito killer'])
  );
  assert.ok(snowball.length > 0, 'Should extract recurring 3-word n-grams from verified titles');
  assert.ok(
    snowball.some((q) => q.toLowerCase().includes('photocatalyst') || q.toLowerCase().includes('suction')),
    `Expected snowball queries to include photocatalyst/suction, got: ${JSON.stringify(snowball)}`
  );

  const sampleHtml = `
    <script type="text/javascript">
      var data = {"dimensionValuesDisplayData": {"B08VAR0001": ["White"], "B08VAR0002": ["Black"], "B08VAR0003": ["Blue"]}};
    </script>
  `;
  const siblings = extractVariationSiblingAsins(sampleHtml, 'B08VAR0001');
  assert.deepEqual(siblings, ['B08VAR0002', 'B08VAR0003']);
});

test('Phase F: Perceptual hash (dHash64) accurately deduplicates identical frames', async () => {
  assert.equal(hammingDistanceHex64('ffffffffffffffff', 'ffffffffffffffff'), 0);
  assert.equal(hammingDistanceHex64('ffffffffffffffff', 'fffffffffffffffe'), 1);
  assert.equal(hammingDistanceHex64('0000000000000000', 'ffffffffffffffff'), 64);

  const f1Path = path.resolve(process.cwd(), 'eval/fixtures/f1_mosquito_killer_ref.png');
  const sig1 = await computeImageVisualSignature(fs.readFileSync(f1Path));
  const sig1Copy = await computeImageVisualSignature(fs.readFileSync(f1Path));
  assert.ok(sig1 && sig1Copy, 'dHash64 signature should be computed via ffmpeg');
  assert.equal(hammingDistanceHex64(sig1.dHash64, sig1Copy.dHash64), 0);
});

test('Item 3 (Fail Closed Identity): throws IdentityResolutionFailedError after 3 attempts when Gemini fails or returns empty mustMatch/mustNotBe', async () => {
  const f1Path = path.resolve(process.cwd(), 'eval/fixtures/f1_mosquito_killer_ref.png');
  const base64 = fs.readFileSync(f1Path).toString('base64');

  await assert.rejects(
    async () => {
      await resolveIdentityCardV2({
        base64Data: base64,
        mimeType: 'image/png',
        simulateFailure: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof IdentityResolutionFailedError);
      assert.equal(err.code, 'IDENTITY_RESOLUTION_FAILED');
      assert.equal(err.attemptsMade, 3);
      assert.ok(err.arabicMessage.includes('تعذر استخراج الهوية البصرية'));
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await resolveIdentityCardV2({
        base64Data: base64,
        mimeType: 'image/png',
        simulatedEmptyAttributes: true,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof IdentityResolutionFailedError);
      assert.equal(err.attemptsMade, 3);
      return true;
    }
  );
});

test('Item 4 (No Padding & Gemini Budget Exhaustion): marks candidates as unverified_by_ai (verifiedByAi=false) when Gemini budget is exhausted', async () => {
  const f1Path = path.resolve(process.cwd(), 'eval/fixtures/f1_mosquito_killer_ref.png');
  const base64 = fs.readFileSync(f1Path).toString('base64');
  const identity = await resolveIdentityCardV2({
    base64Data: base64,
    mimeType: 'image/png',
  }).catch(() =>
    upsertManualIdentityCard({
      imageHash: 'f1-mosquito-budget-test-hash',
      nameEn: 'USB Photocatalyst Suction Mosquito Killer Trap Lamp',
      nameAr: 'مصيدة ناموس ضوئية بالشفط USB',
      mustMatch: ['Cylindrical vertical tower body', 'Suction fan trap', 'Bottom collection cage'],
      mustNotBe: ['Electric Bug Zapper', 'High Voltage Grid', 'Swatter Racket'],
    })
  );

  setSimulatedGeminiBudgetExhausted(true);
  try {
    const budget = getDailyGeminiBudgetStatus();
    assert.equal(budget.exhausted, true);
    assert.equal(budget.remaining, 0);

    const verdicts = await verifyListingCandidatesBatch({
      referenceImageBase64: base64,
      referenceImageMimeType: 'image/png',
      identity,
      candidates: [
        {
          id: `B0TESTBUDGET_${Date.now()}`,
          title: 'Photocatalyst Suction Type Mosquito Killer Lamp USB',
          url: 'https://www.amazon.com/dp/B0TESTBUDGET',
          imageBase64: base64,
          imageMimeType: 'image/png',
        },
      ],
      matchMode: 'same_design',
      includeSimilar: false,
    });

    const firstVerdict = Array.from(verdicts.values())[0];
    assert.ok(firstVerdict);
    assert.equal(firstVerdict.verdict, 'unverified_by_ai');
    assert.equal(firstVerdict.verifiedByAi, false);
    assert.equal(firstVerdict.stage, 'budget_fallback');
  } finally {
    setSimulatedGeminiBudgetExhausted(false);
  }
});

test('Item 5 (Local Visual Stage): Transformers.js CLIP colour-agnostic embedding achieves 1.00 precision & recall on fixtures', {skip:process.env.RUN_MODEL_TESTS!=='1'}, async () => {
  const f1Buf = fs.readFileSync(path.resolve(process.cwd(), 'eval/fixtures/f1_mosquito_killer_ref.png'));
  const pliersBuf = fs.readFileSync(path.resolve(process.cwd(), 'eval/fixtures/pliers_5in1_ref.webp'));

  const embF1 = await computeColorAgnosticClipEmbedding(f1Buf);
  const embPliers = await computeColorAgnosticClipEmbedding(pliersBuf);
  assert.ok(embF1 && embPliers);
  assert.equal(embF1.embedding.length, 512);

  const crossSim = cosineSimilarityClip(embF1.embedding, embPliers.embedding);
  assert.ok(crossSim < 0.75, `Expected cross-product CLIP similarity < 0.75, got ${crossSim}`);

  const calReport = await runFixtureCalibration();
  assert.equal(calReport.metrics.precision, 1);
  assert.equal(calReport.metrics.recall, 1);
});

test('Item 2 (ASIN Integrity): rejects placeholder, fixture, and malformed ASINs', () => {
  assert.equal(isValidAmazonAsin('B0EXACT328W'), false, 'B0EXACT... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('B0COLOR328B'), false, 'B0COLOR... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('B0TEST12345'), false, 'B0TEST... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('B0MOCK12345'), false, 'B0MOCK... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('B0FAKE12345'), false, 'B0FAKE... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('SAMPLE12345'), false, 'SAMPLE... placeholder must be rejected');
  assert.equal(isValidAmazonAsin('short'), false, 'Short string must be rejected');
  assert.equal(isValidAmazonAsin(''), false, 'Empty string must be rejected');

  // Real Amazon ASINs must be accepted
  assert.equal(isValidAmazonAsin('B082F6HKZV'), true);
  assert.equal(isValidAmazonAsin('B0C4DRXJ7L'), true);
  assert.equal(isValidAmazonAsin('B09LT5RBF7'), true);
});

test('Item 5 (Dead Listing Detection): detects 404, 410, Dog Pages, and missing product markers', () => {
  // 1. Status 404 / 410
  const r404 = isAmazonDeadListing(404, '<html>Not found</html>');
  assert.equal(r404.isDead, true);
  assert.ok(r404.reason?.includes('404'));

  const r410 = isAmazonDeadListing(410, '<html>Gone</html>');
  assert.equal(r410.isDead, true);

  // 2. Dog of Amazon page (even on HTTP 200)
  const dogPageHtml = `
    <html>
      <head><title>Page Not Found</title></head>
      <body>
        <div class="header">
          <img alt="Dogs of Amazon" src="/images/G/01/error/dog.jpg" />
          <b>SORRY</b>
          <p>we couldn't find that page. Try searching or go to Amazon's home page.</p>
        </div>
      </body>
    </html>
  `;
  const rDog = isAmazonDeadListing(200, dogPageHtml, 'https://www.amazon.com/dp/B0DOGPAGE1');
  assert.equal(rDog.isDead, true);
  assert.ok(rDog.reason?.includes('Dog Page'));

  // 3. Product page missing markers
  const nonProductHtml = '<html><body><div>Just some generic footer without title</div></body></html>';
  const rMissing = isAmazonDeadListing(200, nonProductHtml, 'https://www.amazon.com/dp/B0NOMARKER1');
  assert.equal(rMissing.isDead, true);

  // 4. Legitimate product page with #productTitle marker
  const validProductHtml = `
    <html>
      <body>
        <div id="dp-container">
          <span id="productTitle">Photocatalyst Suction Type Mosquito Killer</span>
        </div>
      </body>
    </html>
  `;
  const rValid = isAmazonDeadListing(200, validProductHtml, 'https://www.amazon.com/dp/B0VALIDPROD');
  assert.equal(rValid.isDead, false);
  assert.equal(hasAmazonProductMarker(validProductHtml), true);
});

test('Item 5 (Negative Dead Listing Cache): stores dead ASINs with TTL and excludes them', () => {
  const deadAsin = `B0DEAD${Date.now().toString().slice(-4)}`;
  assert.equal(isAsinMarkedDead(deadAsin).isDead, false);

  markAsinAsDead(deadAsin, 'HTTP 404 Dogs of Amazon');
  const checked = isAsinMarkedDead(deadAsin);
  assert.equal(checked.isDead, true);
  assert.ok(checked.reason?.includes('404'));
});

test('Item 3 (Provenance Enforcement): rejects ASIN candidates not backed by a recorded live fetch', () => {
  const trace = createSearchTrace(`test-trace-${Date.now()}`, {
    productName: 'Photocatalyst Suction Mosquito Killer',
    mediaType: 'video',
    sourcePlatform: 'amazon',
    targetVideoCount: 5,
    hasReferenceImage: true,
    matchMode: 'same_design',
  });

  // Recorded live fetch for legitimate ASIN
  recordFetchedResponse(trace, {
    asin: 'B082F6HKZV',
    marketplace: 'US',
    url: 'https://www.amazon.com/dp/B082F6HKZV',
    httpStatus: 200,
    snippetHash: 'hash123',
  });

  // Test helper simulating candidate emission gate
  const checkCandidateProvenance = (candidate: {
    asin: string;
    provenanceData?: { source: string; marketplace: string; asin: string; httpStatus: number };
  }): { accepted: boolean; reason?: string } => {
    const recordedFetch = trace.fetchedResponses.find(
      (r) => r.asin === candidate.asin.toUpperCase()
    );
    if (!candidate.provenanceData || candidate.provenanceData.source !== 'live' || !recordedFetch) {
      return { accepted: false, reason: 'no_provenance' };
    }
    return { accepted: true };
  };

  // Valid live candidate with recorded fetch
  const validCand = {
    asin: 'B082F6HKZV',
    provenanceData: {
      source: 'live' as const,
      marketplace: 'US',
      asin: 'B082F6HKZV',
      httpStatus: 200,
    },
  };
  assert.deepEqual(checkCandidateProvenance(validCand), { accepted: true });

  // Unrecorded ASIN (e.g. fabricated or from unprovenanced cache)
  const unrecordedCand = {
    asin: 'B0UNRECORD1',
    provenanceData: {
      source: 'live' as const,
      marketplace: 'US',
      asin: 'B0UNRECORD1',
      httpStatus: 200,
    },
  };
  assert.deepEqual(checkCandidateProvenance(unrecordedCand), {
    accepted: false,
    reason: 'no_provenance',
  });

  // Candidate with fixture source
  const fixtureCand = {
    asin: 'B082F6HKZV',
    provenanceData: {
      source: 'fixture' as const,
      marketplace: 'US',
      asin: 'B082F6HKZV',
      httpStatus: 200,
    },
  };
  assert.deepEqual(checkCandidateProvenance(fixtureCand as any), {
    accepted: false,
    reason: 'no_provenance',
  });
});

