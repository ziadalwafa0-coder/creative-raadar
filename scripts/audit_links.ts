import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/server/config.ts';
import {
  fetchAmazonHtml,
  hasAmazonProductMarker,
  isAmazonDeadListing,
  isAmazonCaptchaOrRobot,
} from '../src/server/amazonHttp.ts';
import { fetch as undiciFetch } from 'undici';

interface LinkAuditResult {
  url: string;
  type: 'product' | 'video';
  marketplace: string;
  asin: string;
  status: number | string;
  dogDetected: boolean;
  markerFound: boolean;
  verdict: 'PASS' | 'FAIL_DEAD' | 'FAIL_BLOCKED' | 'FAIL_ERROR';
  detail: string;
}

function findTargetTrace(searchIdArg?: string): any | null {
  const tracesDir = path.join(DATA_DIR, 'traces');
  if (searchIdArg) {
    const directFile = path.join(tracesDir, `${searchIdArg}.json`);
    if (fs.existsSync(directFile)) {
      return JSON.parse(fs.readFileSync(directFile, 'utf-8'));
    }
    const searchPrefixFile = path.join(tracesDir, `search_${searchIdArg}.json`);
    if (fs.existsSync(searchPrefixFile)) {
      return JSON.parse(fs.readFileSync(searchPrefixFile, 'utf-8'));
    }
  }

  if (!fs.existsSync(tracesDir)) return null;
  const files = fs
    .readdirSync(tracesDir)
    .filter((f) => f.endsWith('.json') && !f.includes('test-trace') && f !== 'search_latest.json')
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(tracesDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return null;
  const latestFile = path.join(tracesDir, files[0].name);
  console.log(`[Audit] Inspecting latest search trace: ${latestFile}`);
  return JSON.parse(fs.readFileSync(latestFile, 'utf-8'));
}

async function auditLink(
  item: { url: string; type: 'product' | 'video'; marketplace?: string; asin?: string }
): Promise<LinkAuditResult> {
  const { url, type } = item;
  const asin = item.asin || (url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || '-').toUpperCase();
  const marketplace = item.marketplace || (url.includes('.sa') ? 'SA' : url.includes('.eg') ? 'EG' : url.includes('.ae') ? 'AE' : url.includes('.co.uk') ? 'UK' : 'US');

  if (type === 'video') {
    try {
      const resp = await undiciFetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      const pass = resp.status >= 200 && resp.status < 400;
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'video',
        marketplace,
        asin,
        status: resp.status,
        dogDetected: false,
        markerFound: pass,
        verdict: pass ? 'PASS' : 'FAIL_DEAD',
        detail: pass ? 'Video stream active' : `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'video',
        marketplace,
        asin,
        status: 'ERR',
        dogDetected: false,
        markerFound: false,
        verdict: 'FAIL_ERROR',
        detail: (err as Error)?.message || 'Fetch error',
      };
    }
  }

  // Product Listing Link
  try {
    const html = await fetchAmazonHtml(url, {
      minHtmlChars: 500,
      timeoutMs: 12000,
    });
    const deadCheck = isAmazonDeadListing(200, html, url);
    const marker = hasAmazonProductMarker(html);

    if (deadCheck.isDead) {
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'product',
        marketplace,
        asin,
        status: 200,
        dogDetected: true,
        markerFound: marker,
        verdict: 'FAIL_DEAD',
        detail: deadCheck.reason || 'Dog page / Not found',
      };
    }

    if (!marker) {
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'product',
        marketplace,
        asin,
        status: 200,
        dogDetected: false,
        markerFound: false,
        verdict: 'FAIL_DEAD',
        detail: 'Missing product markers (#productTitle, #dp-container)',
      };
    }

    return {
      url: url.length > 60 ? url.slice(0, 57) + '...' : url,
      type: 'product',
      marketplace,
      asin,
      status: 200,
      dogDetected: false,
      markerFound: true,
      verdict: 'PASS',
      detail: 'Product markers verified',
    };
  } catch (err: any) {
    if (err.name === 'AmazonDeadListingError') {
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'product',
        marketplace,
        asin,
        status: err.status || 404,
        dogDetected: true,
        markerFound: false,
        verdict: 'FAIL_DEAD',
        detail: err.reason || 'Dead listing 404',
      };
    }
    if (err.name === 'AmazonBlockError') {
      return {
        url: url.length > 60 ? url.slice(0, 57) + '...' : url,
        type: 'product',
        marketplace,
        asin,
        status: err.status || 503,
        dogDetected: false,
        markerFound: false,
        verdict: 'FAIL_BLOCKED',
        detail: 'Amazon blocked request (WAF/CAPTCHA)',
      };
    }
    return {
      url: url.length > 60 ? url.slice(0, 57) + '...' : url,
      type: 'product',
      marketplace,
      asin,
      status: 'ERR',
      dogDetected: false,
      markerFound: false,
      verdict: 'FAIL_ERROR',
      detail: err?.message || 'Network error',
    };
  }
}

async function main(): Promise<void> {
  const targetId = process.argv[2]?.replace(/^--searchId=/, '');
  const trace = findTargetTrace(targetId);

  if (!trace) {
    console.error('❌ No search trace found in DATA_DIR/traces.');
    process.exit(1);
  }

  console.log(`\n================================================================================`);
  console.log(`🔍 AUDITING DISPLAYED LINKS FOR SEARCH: ${trace.searchId}`);
  console.log(`Product: "${trace.request?.productName || 'Unknown'}"`);
  console.log(`================================================================================\n`);

  const emittedCandidates = (trace.candidates || []).filter(
    (c: any) =>
      c.finalDecision === 'accepted' &&
      (c.entityType === 'video' || c.entityType === 'photo')
  );

  const linksToAudit: Array<{
    url: string;
    type: 'product' | 'video';
    marketplace?: string;
    asin?: string;
  }> = [];

  const seenUrls = new Set<string>();

  for (const cand of emittedCandidates) {
    if (cand.url && !seenUrls.has(cand.url)) {
      seenUrls.add(cand.url);
      const isVideo = cand.entityType === 'video' || cand.url.includes('.mp4') || cand.url.includes('.m3u8');
      linksToAudit.push({
        url: cand.url,
        type: isVideo ? 'video' : 'product',
        marketplace: cand.provenanceData?.marketplace,
        asin: cand.parentId || cand.id,
      });
    }

    // Also check product listing URL if candidate is a video
    if (cand.parentId && /^[B0-9][A-Z0-9]{9}$/.test(cand.parentId)) {
      const mp = cand.provenanceData?.marketplace || 'US';
      const mpDomain =
        mp === 'UK'
          ? 'www.amazon.co.uk'
          : mp === 'SA'
          ? 'www.amazon.sa'
          : mp === 'AE'
          ? 'www.amazon.ae'
          : mp === 'EG'
          ? 'www.amazon.eg'
          : mp === 'DE'
          ? 'www.amazon.de'
          : 'www.amazon.com';
      const prodUrl = `https://${mpDomain}/dp/${cand.parentId}`;
      if (!seenUrls.has(prodUrl)) {
        seenUrls.add(prodUrl);
        linksToAudit.push({
          url: prodUrl,
          type: 'product',
          marketplace: mp,
          asin: cand.parentId,
        });
      }
    }
  }

  if (linksToAudit.length === 0) {
    console.log('No emitted links found in trace to audit.');
    process.exit(0);
  }

  console.log(`Auditing ${linksToAudit.length} displayed links (product pages & video streams)...\n`);

  const results: LinkAuditResult[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < linksToAudit.length; i += CONCURRENCY) {
    const chunk = linksToAudit.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (item, idx) => {
        const res = await auditLink(item);
        console.log(`[${i + idx + 1}/${linksToAudit.length}] ${res.type.padEnd(7)} | ${res.marketplace} | ${res.asin.padEnd(10)} | ${res.verdict} | ${res.detail}`);
        return res;
      })
    );
    results.push(...chunkResults);
  }

  // Format ASCII Table
  console.log(
    `┌──────────────────────────────────────────────────────────┬─────┬────────────┬────────┬─────┬────────┬──────────────┐`
  );
  console.log(
    `│ URL                                                      │ MP  │ ASIN       │ STATUS │ DOG │ MARKER │ VERDICT      │`
  );
  console.log(
    `├──────────────────────────────────────────────────────────┼─────┼────────────┼────────┼─────┼────────┼──────────────┤`
  );

  for (const r of results) {
    const urlCol = r.url.padEnd(56);
    const mpCol = (r.marketplace || 'US').padEnd(3);
    const asinCol = (r.asin || '-').padEnd(10);
    const statusCol = String(r.status).padEnd(6);
    const dogCol = (r.dogDetected ? 'YES' : 'NO ').padEnd(3);
    const markerCol = (r.markerFound ? 'YES' : 'NO ').padEnd(6);
    const verdictCol = r.verdict.padEnd(12);

    console.log(
      `│ ${urlCol} │ ${mpCol} │ ${asinCol} │ ${statusCol} │ ${dogCol} │ ${markerCol} │ ${verdictCol} │`
    );
  }

  console.log(
    `└──────────────────────────────────────────────────────────┴─────┴────────────┴────────┴─────┴────────┴──────────────┘\n`
  );

  const deadCount = results.filter((r) => r.verdict === 'FAIL_DEAD').length;
  const passCount = results.filter((r) => r.verdict === 'PASS').length;
  const blockedCount = results.filter((r) => r.verdict === 'FAIL_BLOCKED').length;

  console.log(`Summary:`);
  console.log(`  - Total links checked: ${results.length}`);
  console.log(`  - Passed (200 + Product Marker Verified): ${passCount}`);
  console.log(`  - Dead / Dog pages (404/Missing markers): ${deadCount}`);
  console.log(`  - Blocked / WAF: ${blockedCount}`);

  if (deadCount > 0) {
    console.error(`\n❌ AUDIT FAILED: ${deadCount} dead/404 links detected in results.`);
    process.exit(1);
  } else {
    console.log(`\n✅ AUDIT PASSED: Zero dead links found (0 dog pages). All product links verified.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
