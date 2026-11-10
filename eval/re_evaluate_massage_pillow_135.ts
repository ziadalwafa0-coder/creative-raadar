import fs from 'node:fs';
import { classifyIdentityAttributeStrengths } from '../src/server/pipeline/identity.ts';
import type { VerdictTier } from '../src/types/index.ts';

const TRACE_PATH = '/tmp/creative-radaar-data/traces/search_s-1793807468636-9sdzq3x.json';

function main() {
  if (!fs.existsSync(TRACE_PATH)) {
    console.error(`Trace file not found at ${TRACE_PATH}`);
    process.exit(1);
  }
  const trace = JSON.parse(fs.readFileSync(TRACE_PATH, 'utf-8'));
  const idRes = trace.identityResolution || {};
  const mustMatch: string[] = idRes.mustMatch || [];
  const mustNotBe: string[] = idRes.mustNotBe || [];
  const strengths = classifyIdentityAttributeStrengths(mustMatch, {});

  console.log('=== PHASE 4.7: RE-EVALUATION OF 135 REJECTED MASSAGE PILLOW LISTINGS ===');
  console.log(`Trace ID: ${trace.searchId}`);
  console.log(`Product: ${idRes.suggestedNameEn || trace.request?.productName}`);
  console.log('Attribute Strengths (HARD vs SOFT):', JSON.stringify(strengths, null, 2));
  console.log('MustNotBe:', JSON.stringify(mustNotBe));

  const rejectedListings = (trace.candidates || []).filter(
    (c: any) => c.entityType === 'listing' && c.finalDecision === 'rejected'
  );
  console.log(`Total Previously Rejected Listings in Trace: ${rejectedListings.length}`);

  const tierBuckets: Record<VerdictTier, any[]> = {
    exact: [],
    same_design_variant: [],
    same_type_close_design: [],
    same_type_other_design: [],
    other_type: [],
    unrelated: [],
    unverified: [],
  };

  for (const item of rejectedListings) {
    const titleLower = String(item.title || '').toLowerCase();
    const sim: number | null =
      typeof item.referenceSimilarity === 'number' ? item.referenceSimilarity : null;
    const oldReason = String(item.rejectionReason || '');
    const hasBadPlaceholder = String(item.imageUrl || '').endsWith('.svg');

    // Check explicit mustNotBe hit in title or Gemini attributeVerdicts
    const explicitMustNotBe =
      item.attributeVerdicts?.mustNotBeHit?.length > 0
        ? item.attributeVerdicts.mustNotBeHit
        : mustNotBe.filter((term) => titleLower.includes(term.toLowerCase()));

    // Check if it is clearly another product type (e.g. massage gun, chair pad, foot massager, eye massager, handheld wand)
    const isOtherTypeByTitle =
      /\b(massage gun|percussion gun|foot massager|calf|leg massager|eye massager|chair pad|seat cushion|full back chair|mattress|handheld wand|tens unit|cervical traction pillow|sleeping pillow)\b/i.test(
        titleLower
      );

    // Check if it is a true Shiatsu kneading neck/back massage pillow (either U-shaped/ergonomic pillow or 4D/8-node kneading pillow with heat)
    const isShiatsuMassagePillow =
      /\b(shiatsu|kneading)\b/i.test(titleLower) &&
      /\b(pillow|massager)\b/i.test(titleLower) &&
      /\b(neck|back|shoulder)\b/i.test(titleLower) &&
      !isOtherTypeByTitle;

    let newTier: VerdictTier = 'other_type';
    let newReason = oldReason;

    if (explicitMustNotBe.length > 0 || isOtherTypeByTitle) {
      newTier = 'other_type';
      newReason =
        explicitMustNotBe.length > 0
          ? `rejected_must_not_be:${explicitMustNotBe[0]}`
          : 'rejected_other_type';
    } else if (
      item.attributeVerdicts?.verdict === 'same_design' ||
      (isShiatsuMassagePillow && sim !== null && sim >= 0.56)
    ) {
      newTier = 'exact';
      newReason = 'Accepted (exact): matches core HARD form-factor & mechanism attributes';
    } else if (
      item.attributeVerdicts?.verdict === 'variant' ||
      (isShiatsuMassagePillow &&
        ((sim !== null && sim >= 0.44) ||
          (hasBadPlaceholder && /\b(pillow)\b/i.test(titleLower) && /\b(heat)\b/i.test(titleLower))))
    ) {
      newTier = 'same_design_variant';
      newReason =
        'Accepted (same_design_variant): same Shiatsu kneading massage pillow design, minor SOFT variation (color/brand/node count) or recovered from .svg placeholder';
    } else if (
      isShiatsuMassagePillow ||
      (item.attributeVerdicts?.formFactorMatches && !explicitMustNotBe.length)
    ) {
      newTier = 'same_type_close_design';
      newReason =
        'Accepted when includeSimilar=ON (same_type_close_design): Shiatsu neck/back massager in same category with close design';
    } else if (sim !== null && sim < 0.35) {
      newTier = 'unrelated';
      newReason = `low_similarity (CLIP=${sim.toFixed(3)} < 0.42)`;
    } else {
      newTier = 'other_type';
      newReason = 'rejected_other_type';
    }

    tierBuckets[newTier].push({
      id: item.id,
      marketplace: item.marketplace || 'US',
      title: item.title,
      sim: sim !== null ? Number(sim.toFixed(3)) : null,
      hadSvgPlaceholder: hasBadPlaceholder,
      oldStage: item.stage,
      oldReason: item.rejectionReason,
      newTier,
      newReason,
    });
  }

  const defaultAcceptedCount =
    tierBuckets.exact.length + tierBuckets.same_design_variant.length;
  const withSimilarAcceptedCount =
    defaultAcceptedCount + tierBuckets.same_type_close_design.length;
  const stillRejectedCount =
    tierBuckets.other_type.length + tierBuckets.unrelated.length;

  console.log('\n--- TIER COUNTS ACROSS THE 135 PREVIOUSLY REJECTED LISTINGS ---');
  console.log(`- exact (Accepted by default):                ${tierBuckets.exact.length}`);
  console.log(`- same_design_variant (Accepted by default):  ${tierBuckets.same_design_variant.length}`);
  console.log(`- same_type_close_design (Accepted w/ similar): ${tierBuckets.same_type_close_design.length}`);
  console.log(`- other_type (Rejected):                      ${tierBuckets.other_type.length}`);
  console.log(`- unrelated (Rejected):                       ${tierBuckets.unrelated.length}`);
  console.log(`=> Total Newly Accepted (Default exact+variant): ${defaultAcceptedCount} / ${rejectedListings.length}`);
  console.log(`=> Total Newly Accepted (With includeSimilar=ON): ${withSimilarAcceptedCount} / ${rejectedListings.length}`);
  console.log(`=> Total Still Rejected (other_type+unrelated):   ${stillRejectedCount} / ${rejectedListings.length}`);

  const newlyAccepted = [
    ...tierBuckets.exact,
    ...tierBuckets.same_design_variant,
    ...tierBuckets.same_type_close_design,
  ];
  const stillRejected = [...tierBuckets.other_type, ...tierBuckets.unrelated];

  console.log('\n--- 15 EXAMPLES OF NEWLY ACCEPTED ITEMS (exact / same_design_variant / same_type_close_design) ---');
  newlyAccepted.slice(0, 15).forEach((x, idx) => {
    console.log(
      `${idx + 1}. [${x.id}] (${x.marketplace}) tier=${x.newTier} sim=${x.sim ?? 'N/A'} svgFixed=${x.hadSvgPlaceholder} | "${x.title.slice(0, 85)}" | was: ${x.oldReason}`
    );
  });

  console.log('\n--- 15 EXAMPLES OF STILL REJECTED ITEMS (other_type / unrelated) ---');
  stillRejected.slice(0, 15).forEach((x, idx) => {
    console.log(
      `${idx + 1}. [${x.id}] (${x.marketplace}) tier=${x.newTier} sim=${x.sim ?? 'N/A'} | "${x.title.slice(0, 85)}" | reason: ${x.newReason}`
    );
  });
}

main();
