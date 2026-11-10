import fs from 'fs';
import path from 'path';
import {
  resolveIdentityCardV2,
  IdentityResolutionFailedError,
  upsertManualIdentityCard,
} from '../src/server/pipeline/identity.js';
import {
  setSimulatedGeminiBudgetExhausted,
  getDailyGeminiBudgetStatus,
  verifyListingCandidatesBatch,
} from '../src/server/pipeline/verify.js';
import { runFixtureCalibration } from './calibrate.js';
import { runTikTokProviderSpike } from '../src/server/sources/tiktok/index.js';
import { probeAmazonMarketplacesLive } from '../src/server/amazonSearch.js';
import { handleStreamSearch } from '../src/server/streamSearch.js';
import { getSearchTrace } from '../src/server/pipeline/trace.js';
import type { Request, Response } from 'express';

function loadImageAsDataUrl(relPath: string, mime = 'image/png'): string {
  const full = path.resolve(process.cwd(), relPath);
  const buf = fs.readFileSync(full);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function runSearchCapture(body: Record<string, any>): Promise<{
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

  await handleStreamSearch(req, res, 'eval_verifier');
  return { events, searchId };
}

async function main() {
  console.log('================================================================================');
  console.log('ITEM 3: FAIL-CLOSED IDENTITY VERIFICATION (SIMULATED GEMINI FAILURE)');
  console.log('================================================================================');
  const f1DataUrl = loadImageAsDataUrl('eval/fixtures/f1_mosquito_killer_ref.png', 'image/png');
  try {
    await resolveIdentityCardV2({
      base64Data: f1DataUrl,
      mimeType: 'image/png',
      simulateFailure: true,
      backoffBaseMs: 50,
    });
  } catch (err: any) {
    if (err instanceof IdentityResolutionFailedError) {
      console.log('[Direct resolveIdentityCardV2 Failure Proof]:');
      console.log(JSON.stringify({
        errorName: err.name,
        code: err.code,
        attemptsMade: err.attemptsMade,
        message: err.message,
        arabicMessage: err.arabicMessage,
      }, null, 2));
    } else {
      console.error('Unexpected error:', err);
    }
  }

  const failedStream = await runSearchCapture({
    productName: '',
    referenceImageBase64: f1DataUrl,
    requestedVideos: 20,
    matchingMode: 'same_design',
    simulateIdentityFailure: true,
  });
  const failedEvt = failedStream.events.find((e) => e.type === 'failed');
  const failedTrace = failedStream.searchId ? getSearchTrace(failedStream.searchId) : null;
  console.log('[Stream Search Fail-Closed Proof (0 searches executed)]:');
  console.log(JSON.stringify({
    searchId: failedStream.searchId,
    emittedEventType: failedEvt?.type,
    emittedError: failedEvt?.error,
    traceStopReasons: failedTrace?.summary?.stopReasons,
    pagesFetched: failedTrace?.summary.pagesFetched,
    listingsDiscovered: failedTrace?.summary.listingsDiscovered,
    listingsInspected: failedTrace?.summary.listingsInspected,
    listingsAccepted: failedTrace?.summary.listingsAccepted,
    videosEmitted: failedTrace?.summary.videosEmitted,
  }, null, 2));

  console.log('\n================================================================================');
  console.log('ITEM 4: NO PADDING & GEMINI BUDGET EXHAUSTION VERIFICATION');
  console.log('================================================================================');
  setSimulatedGeminiBudgetExhausted(true);
  console.log('[Budget Status When Exhausted]:', JSON.stringify(getDailyGeminiBudgetStatus(), null, 2));

  const manualMosquitoCard = upsertManualIdentityCard({
    base64Data: f1DataUrl,
    nameEn: 'USB Photocatalyst Suction Mosquito Killer Lamp',
    nameAr: 'صاعق ناموس ومصيدة حشرات بالشفط الضوئي USB',
    formFactorShape: 'Small cylindrical tabletop enclosure with recessed circular UV intake and bottom collection cage',
    mechanismHowItWorks: 'UV light attraction + internal suction fan (no exposed electric grid)',
    mustMatch: ['cylindrical body', 'recessed UV ring', 'internal suction fan'],
    mustNotBe: ['exposed high-voltage metal grid zapper', 'bug zapper racket', 'ultrasonic plug-in'],
    variableAttributes: ['color', 'brand', 'box'],
  });

  const unverifiedMap = await verifyListingCandidatesBatch({
    identity: manualMosquitoCard,
    referenceImageBase64: f1DataUrl,
    referenceImageMimeType: 'image/png',
    matchMode: 'same_design',
    candidates: [
      {
        id: 'B09725M28H',
        title: 'Indoor Mosquito Trap Lamp USB Suction Fan Bug Catcher',
        url: 'https://www.amazon.com/dp/B09725M28H',
        imageUrl: 'https://m.media-amazon.com/images/I/61f2c+a1BGL._AC_UL320_.jpg',
        imageBase64: f1DataUrl,
      },
    ],
  });
  const unverifiedRes = unverifiedMap.get('B09725M28H')!;
  console.log('[Candidate Verification Under Exhausted Budget]:');
  console.log(JSON.stringify(unverifiedRes, null, 2));
  setSimulatedGeminiBudgetExhausted(false);
  console.log('[Budget Status Restored]:', JSON.stringify(getDailyGeminiBudgetStatus(), null, 2));

  console.log('\n================================================================================');
  console.log('ITEM 5: LOCAL VISUAL STAGE (CLIP EMBEDDING + CALIBRATION)');
  console.log('================================================================================');
  const calReport = await runFixtureCalibration();
  console.log(JSON.stringify(calReport, null, 2));

  console.log('\n================================================================================');
  console.log('ITEM 6: TIKTOK END-TO-END PROVIDER & SEARCH ROUTE SPIKE (MOSQUITO KILLER)');
  console.log('================================================================================');
  const realMosquitoIdentity = await resolveIdentityCardV2({
    base64Data: f1DataUrl,
    mimeType: 'image/png',
    forceRefresh: false,
  });
  const tiktokSpike = await runTikTokProviderSpike(realMosquitoIdentity);
  console.log(JSON.stringify(tiktokSpike, null, 2));

  console.log('\n================================================================================');
  console.log('ITEM 7: LIVE AMAZON MARKETPLACE VIDEO JSON PROBE (US, UK, DE, AE, SA, EG)');
  console.log('================================================================================');
  const marketplaceProbes = await probeAmazonMarketplacesLive('B07F3NH96Q');
  console.log(JSON.stringify(marketplaceProbes, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
