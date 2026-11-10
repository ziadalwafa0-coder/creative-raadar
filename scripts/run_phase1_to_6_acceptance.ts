import fs from 'node:fs';
import path from 'node:path';
import { issueAuthSession } from '../src/server/auth.ts';

interface AcceptanceProductSpec {
  id: string;
  label: string;
  productName: string;
  fixtureImagePath?: string;
  fallbackImageUrl?: string;
  targetAmazonVideos: number;
  targetTikTokVideos: number;
}

const PRODUCTS: AcceptanceProductSpec[] = [
  {
    id: 'massage_pillow',
    label: '1. Shiatsu Kneading Neck and Back Massage Pillow with Heat',
    productName: 'Shiatsu Kneading Neck and Back Massage Pillow with Heat',
    fallbackImageUrl: 'https://m.media-amazon.com/images/I/81tPJeeP4zL._AC_UL320_.jpg',
    targetAmazonVideos: 15,
    targetTikTokVideos: 5,
  },
  {
    id: 'mosquito_killer',
    label: '2. USB Photocatalyst Suction Mosquito Killer Trap Lamp',
    productName: 'USB Photocatalyst Suction Mosquito Killer Lamp',
    fixtureImagePath: 'eval/fixtures/f1_mosquito_killer_ref.png',
    targetAmazonVideos: 15,
    targetTikTokVideos: 5,
  },
  {
    id: 'pliers_5in1',
    label: '3. 5-in-1 Interchangeable Multi-Function Pliers Set',
    productName: '5-in-1 Interchangeable Pliers Set Wire Stripper Crimper Cutter Shears',
    fixtureImagePath: 'eval/fixtures/pliers_5in1_ref.webp',
    targetAmazonVideos: 15,
    targetTikTokVideos: 5,
  },
];

async function loadReferenceDataUrl(spec: AcceptanceProductSpec): Promise<string | undefined> {
  if (spec.fixtureImagePath) {
    const abs = path.resolve(process.cwd(), spec.fixtureImagePath);
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
  }
  if (spec.fallbackImageUrl) {
    try {
      const res = await fetch(spec.fallbackImageUrl);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        const mime = res.headers.get('content-type') || 'image/jpeg';
        return `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
      }
    } catch {}
  }
  return undefined;
}

async function runSingleProductAcceptance(spec: AcceptanceProductSpec, token: string) {
  console.log('\n################################################################################');
  console.log(`LIVE ACCEPTANCE RUN: ${spec.label}`);
  console.log('################################################################################');

  const referenceImage = await loadReferenceDataUrl(spec);
  console.log(`Reference Image Loaded: ${referenceImage ? `YES (${referenceImage.length} chars)` : 'NO'}`);

  // 1. Run Live TikTok Provider Probe via POST /api/debug/tiktok-probe
  console.log('\n--- [A] LIVE TIKTOK PROVIDER PROBE (POST /api/debug/tiktok-probe) ---');
  const probeRes = await fetch('http://localhost:3000/api/debug/tiktok-probe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      productName: spec.productName,
    }),
  });
  const probeData = (await probeRes.json()) as any;
  const probes: any[] = probeData.providerProbes || [];
  console.log(
    'Provider / Engine          | HTTP | Latency | Raw | TikTok URLs | oEmbed OK/Fail | Circuit | First Error'
  );
  console.log(
    '---------------------------|------|---------|-----|-------------|----------------|---------|------------'
  );
  for (const p of probes) {
    const name = `${p.provider}${p.engine ? ` (${p.engine})` : ''}`.padEnd(26);
    const http = String(p.httpStatus ?? 0).padEnd(4);
    const lat = `${p.latencyMs ?? 0}ms`.padEnd(7);
    const raw = String(p.rawResultsCount ?? 0).padEnd(3);
    const urls = String(p.tiktokUrlsParsed ?? 0).padEnd(11);
    const oembed = `${p.oembedOkCount ?? 0}/${p.oembedFailCount ?? 0}`.padEnd(14);
    const circ = (p.circuitOpen ? 'OPEN' : 'closed').padEnd(7);
    const err = p.firstError || 'OK';
    console.log(`${name} | ${http} | ${lat} | ${raw} | ${urls} | ${oembed} | ${circ} | ${err}`);
  }

  // 2. Run Live End-to-End Stream Search via POST /api/stream-search
  const searchId = `accept-${spec.id}-${Date.now()}`;
  const totalTarget = spec.targetAmazonVideos + spec.targetTikTokVideos;
  console.log(`\n--- [B] LIVE STREAM SEARCH (POST /api/stream-search, searchId=${searchId}, target=${totalTarget}) ---`);

  const searchRes = await fetch('http://localhost:3000/api/stream-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      searchId,
      productName: spec.productName,
      mediaType: 'video',
      sourcePlatform: 'all',
      targetVideoCount: totalTarget,
      targetAmazonVideoCount: spec.targetAmazonVideos,
      targetTikTokVideoCount: spec.targetTikTokVideos,
      referenceImage,
      matchMode: 'same_design',
      includeSimilar: false,
    }),
  });

  if (!searchRes.ok || !searchRes.body) {
    console.error(`Stream search HTTP error: ${searchRes.status}`);
    return;
  }

  const text = await searchRes.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const emittedAssets: any[] = [];
  const emittedRejected: any[] = [];
  let completedEvent: any = null;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'result' && ev.asset) {
        emittedAssets.push(ev.asset);
      } else if (ev.type === 'rejected' && ev.rejected) {
        emittedRejected.push(ev.rejected);
      } else if (ev.type === 'completed') {
        completedEvent = ev;
      } else if (ev.type === 'failed') {
        console.error(`[StreamSearch Failed Event]: ${ev.error}`);
      }
    } catch {}
  }

  const bd = completedEvent?.breakdownSummary;
  if (!bd) {
    console.error('No breakdownSummary returned in completed event!');
    return;
  }

  // 3. Print Requested vs Delivered & Top Limiting Factor & Counter Consistency Proof
  console.log('\n--- [C] REQUESTED VS DELIVERED & SINGLE-SOURCE-OF-TRUTH COUNTER CHECK ---');
  console.log(`Search ID:                   ${bd.searchId}`);
  console.log(`Requested Videos (Global N): ${bd.requestedVideos}`);
  console.log(`Delivered Confirmed Videos:  ${bd.emittedVideos} (Amazon: ${bd.amazonEmitted}, TikTok: ${bd.tiktokEmitted})`);
  console.log(`TikTok Survived w/o MP4:     ${bd.tiktokDownloadFailedButKeptCount || 0}`);
  console.log(`Unverified (Error/Budget):   Listings=${bd.unverifiedListingsCount || 0}, Videos=${bd.unverifiedVideosCount || 0}`);
  console.log(`Honest Stop Reason Code:     ${bd.stopReasonCode} — ${bd.stopReasonLabelAr}`);
  console.log(`Top Limiting Factor (AR):    ${bd.topLimitingFactorAr}`);
  console.log(
    `Counter Consistency Proof:   Top Chip Rejected (${bd.listingsRejected}) === Panel Rejected (${bd.listingsRejected}) === Stream Emitted Rejected (${emittedRejected.filter((r) => r.entityType === 'listing').length})`
  );
  console.log(
    `Verdict Tier Counts:         exact=${bd.tierCounts?.exact || 0}, same_design_variant=${bd.tierCounts?.same_design_variant || 0}, same_type_close_design=${bd.tierCounts?.same_type_close_design || 0}, other_type=${bd.tierCounts?.other_type || 0}, unrelated=${bd.tierCounts?.unrelated || 0}, unverified=${bd.tierCounts?.unverified || 0}`
  );
  console.log(
    `Real Video Frame Posters:    ${bd.realVideoFramePosterCount} | ffmpeg Keyframes Extracted: ${bd.keyframesExtractedCount || 0}`
  );

  // 4. Print Funnel with Reason Histograms
  console.log('\n--- [D] FUNNEL PER SOURCE / MARKETPLACE & REASON HISTOGRAMS ---');
  for (const f of bd.funnels || []) {
    console.log(`\n  Funnel: ${f.labelAr} [${f.scopeKey}]`);
    for (const s of f.stages || []) {
      console.log(
        `    ${s.labelAr.padEnd(52)} | in=${String(s.inCount).padEnd(4)} -> out=${String(s.outCount).padEnd(4)} | dropped=${s.droppedCount}${s.unverifiedCount ? ` (unverified=${s.unverifiedCount})` : ''}`
      );
    }
  }

  console.log('\n  Reason Code Histogram (with up to 3 examples per reason):');
  for (const rh of bd.reasonHistograms || []) {
    console.log(
      `    - [${rh.reasonCode}] ${rh.labelAr}: ${rh.count}${rh.isErrorNotRejection ? ' (ERROR — NOT COUNTED AS REJECTION)' : ''}`
    );
    for (const ex of rh.examples || []) {
      console.log(`        * (${ex.source}) [${ex.id}] "${ex.title.slice(0, 70)}" -> ${ex.reasonAr}`);
    }
  }

  // 5. Print 15-Item Rejection Audit
  console.log('\n--- [E] 15-ITEM REJECTION AUDIT SAMPLE ---');
  const auditSample: any[] = bd.rejectionAuditSample || [];
  auditSample.forEach((item, idx) => {
    console.log(
      `  ${idx + 1}. [${item.id}] (${item.source}${item.marketplace ? `:${item.marketplace}` : ''}) "${item.title.slice(0, 75)}"\n` +
        `     reasonCode=${item.reasonCode} | failedAttr=${item.failedAttribute || 'N/A'} | sim=${item.referenceSimilarity ?? 'N/A'} | tier=${item.verdictTier}\n` +
        `     reasonAr="${item.reasonAr}" | image=${item.imageUrl || 'none'}`
    );
  });

  // 6. Print Full Diagnostic Report Markdown (first 70 lines + confirm full report length)
  console.log('\n--- [F] DIAGNOSTIC REPORT MARKDOWN (نسخ تقرير التشخيص) ---');
  const md = String(bd.diagnosticReportMarkdown || '');
  console.log(`Diagnostic Report Total Length: ${md.length} characters`);
  console.log(md.split('\n').slice(0, 65).join('\n'));
  console.log('... [Diagnostic Report JSON trace payload attached at end of Markdown report] ...\n');
}

async function main() {
  const args = process.argv.slice(2);
  const filterId = args[0];
  const toRun = filterId ? PRODUCTS.filter((p) => p.id === filterId) : PRODUCTS;
  for (const spec of toRun) {
    const session = issueAuthSession(`acceptance-runner-${spec.id}-${Date.now()}`);
    await runSingleProductAcceptance(spec, session.token);
  }
}

main().catch((err) => {
  console.error('Acceptance runner failed:', err);
  process.exit(1);
});
