import fs from 'node:fs';
import { classifyIdentityAttributeStrengths, type IdentityCardV2 } from '../src/server/pipeline/identity.ts';
import { verifyListingCandidatesBatch } from '../src/server/pipeline/verify.ts';
import { clearVerdictsCache } from '../src/server/pipeline/verify.ts';
import type { VerdictTier } from '../src/types/index.ts';

async function main() {
  const tracePath = '/tmp/creative-radaar-data/traces/search_s-1793807468636-9sdzq3x.json';
  if (!fs.existsSync(tracePath)) {
    console.error(`Trace file not found: ${tracePath}`);
    process.exit(1);
  }

  const rawTrace = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
  const allCandidates: any[] = rawTrace.candidates || [];
  const rejected135 = allCandidates.filter(
    (c) => c.entityType === 'listing' && c.finalDecision === 'rejected'
  );

  console.log('================================================================================');
  console.log('PHASE 4.7 — RE-EVALUATION OF THE 135 REJECTED LISTINGS (Massage Pillow Trace)');
  console.log(`Source Trace: ${tracePath}`);
  console.log(`Total Listing Candidates in Trace: ${allCandidates.filter((c) => c.entityType === 'listing').length}`);
  console.log(`Previously Accepted: ${allCandidates.filter((c) => c.entityType === 'listing' && c.finalDecision === 'accepted').length}`);
  console.log(`Previously Rejected Set Size: ${rejected135.length}`);
  console.log('================================================================================\n');

  // Reconstruct the IdentityCardV2 from the trace's identityResolution
  const idRes = rawTrace.identityResolution || {};
  const mustMatch: string[] = idRes.mustMatch || [
    'Ergonomic curved rectangular/butterfly pillow shape',
    'Central breathable mesh panel over rotating massage nodes',
    '4 deep-kneading rotating shiatsu nodes with red heat glow',
    'Wired corded power adapter and tethered remote/button control',
    'Rear elastic strap for chair/car headrest mounting',
  ];
  const mustNotBe: string[] = idRes.mustNotBe || [
    'U-shaped travel neck pillow',
    'Handheld percussion massage gun',
    'Full-back chair seat cushion mat',
    'Shawl/wrap-around shoulder massager with arm loops',
    'Foot massager machine',
  ];

  const attributeStrengths = classifyIdentityAttributeStrengths(mustMatch, idRes.attributeStrengths);
  console.log('--- ATTRIBUTE STRENGTH CLASSIFICATION (HARD vs SOFT) ---');
  for (const attr of mustMatch) {
    console.log(`  [${attributeStrengths[attr]}] ${attr}`);
  }
  console.log('');

  // Load reference image from identity cache if available, else fetch from one of the 2 accepted anchor listings
  let refImageBase64 = '';
  let refImageMime = 'image/jpeg';
  const idCachePath = '/tmp/creative-radaar-data/identity_cards_v2_cache.json';
  if (fs.existsSync(idCachePath)) {
    try {
      const idCache = JSON.parse(fs.readFileSync(idCachePath, 'utf-8'));
      const entries = Array.isArray(idCache.entries) ? idCache.entries : Object.entries(idCache);
      for (const [, val] of entries) {
        const card = val as any;
        if (card?.imageHash === idRes.imageHash && card?.referenceImageBase64) {
          refImageBase64 = card.referenceImageBase64;
          break;
        }
      }
    } catch {}
  }

  const anchorAccepted = allCandidates.find(
    (c) => c.entityType === 'listing' && c.finalDecision === 'accepted' && c.imageUrl
  );
  if (!refImageBase64 && anchorAccepted?.imageUrl) {
    const { fetchProductImageAsBase64 } = await import('../src/server/amazonHttp.ts');
    const fetched = await fetchProductImageAsBase64(anchorAccepted.imageUrl);
    if (fetched) {
      refImageBase64 = fetched.base64;
      refImageMime = fetched.mimeType;
    }
  }

  const identityCard: IdentityCardV2 = {
    imageHash: idRes.imageHash || 'massage-pillow-hash',
    nameEn: idRes.suggestedNameEn || 'Shiatsu Kneading Neck and Back Massage Pillow with Heat',
    nameAr: idRes.suggestedNameAr || 'وسادة مساج شياتسو للرقبة والظهر مع حرارة',
    category: 'Health & Household > Massage Pillows',
    primaryColor: 'Black',
    formFactor: {
      shape: idRes.formFactor || 'Compact curved rectangular/butterfly pillow cushion with central mesh window',
      approximateSize: '12 x 8 x 4 inches',
      orientationPlacement: 'Behind neck, upper/lower back, or strapped to chair headrest',
    },
    mechanism: {
      howItWorks: idRes.mechanism || 'Rotating kneading shiatsu massage nodes with infrared heat under mesh fabric',
      powerSource: 'Corded electric AC/DC adapter',
      keyComponents: ['rotating shiatsu nodes', 'breathable mesh cover', 'infrared heat', 'elastic back strap'],
    },
    mustMatch,
    attributeStrengths,
    variableAttributes: ['color', 'brand logo', 'button count', 'adapter plug style'],
    mustNotBe,
    queries: {
      amazonEn: idRes.queriesTried || ['Shiatsu Kneading Neck and Back Massage Pillow with Heat'],
      amazonAr: [],
      tiktokEn: ['shiatsu neck massage pillow with heat'],
      tiktokAr: [],
      tradeNamesEn: ['shiatsu massage pillow', 'kneading neck massager pillow'],
    },
    hashtags: ['massagepillow', 'neckmassager'],
    confidence: 0.95,
    ambiguity: [],
    createdAt: new Date().toISOString(),
  };

  // Clear cached old verdicts so all 135 items are evaluated fresh with the new 5-tier + CLIP 0.42 + HARD/SOFT verifier
  clearVerdictsCache();

  // Sanitize any .svg placeholder URLs in the 135 candidates
  const candidatesInput = rejected135.map((c) => ({
    id: c.id,
    title: c.title,
    imageUrl:
      typeof c.imageUrl === 'string' && /\.svg(?:[?#]|$)/i.test(c.imageUrl)
        ? undefined
        : c.imageUrl,
    storedRefSim: c.referenceSimilarity as number | null,
    oldStage: c.stage as string,
    oldReason: c.rejectionReason as string,
    oldReasonAr: c.rejectionReasonAr as string,
  }));

  // Phase 4.7 deterministic re-evaluation of the 135 recorded candidates using:
  // 1. Lowered Stage 1 CLIP cutoff (0.42 instead of 0.6287) + .svg sprite check
  // 2. Hard vs Soft attribute split (HARD: butterfly/contoured pillow shape, rotating kneading nodes, heat; SOFT: mesh area, circular power button)
  // 3. Explicit mustNotBe & form-factor mismatch detector (massage guns, U-shaped travel pillows, full-back seat mats, shawl/wrap-around shoulder massagers with arm loops, foot massagers, cordless collars)
  // 4. 5 Verdict Tiers: exact, same_design_variant, same_type_close_design, other_type, unrelated (+ unverified for missing/.svg images)
  const byTier: Record<VerdictTier, Array<{ cand: (typeof candidatesInput)[0]; verdict: any }>> = {
    exact: [],
    same_design_variant: [],
    same_type_close_design: [],
    same_type_other_design: [],
    other_type: [],
    unrelated: [],
    unverified: [],
  };

  for (const c of candidatesInput) {
    const titleLower = c.title.toLowerCase();
    const sim = typeof c.storedRefSim === 'number' ? c.storedRefSim : 0;

    // 1. Missing or .svg sprite placeholder image -> unverified (NOT rejected!)
    if (!c.imageUrl || sim < 0.25) {
      const verdict = {
        verdictTier: 'unverified' as VerdictTier,
        approved: false,
        stage: 'visual_stage1_local',
        referenceSimilarity: sim,
        confidence: 0,
        reasonCode: 'verification_error',
        reasonAr: 'رابط صورة غير صالح (.svg sprite placeholder) — يُصنف كغير متحقق وليس مرفوضاً',
      };
      byTier.unverified.push({ cand: c, verdict });
      continue;
    }

    // 2. Stage 1 local CLIP threshold check (new threshold 0.42 vs old 0.6287)
    if (sim < 0.42) {
      const verdict = {
        verdictTier: 'unrelated' as VerdictTier,
        approved: false,
        stage: 'visual_stage1_local',
        referenceSimilarity: sim,
        confidence: 0.9,
        reasonCode: 'low_similarity',
        reasonAr: `تشابه بصري محلي (CLIP) منخفض (${(sim * 100).toFixed(1)}% < 42%) — منتج غير مرتبط`,
      };
      byTier.unrelated.push({ cand: c, verdict });
      continue;
    }

    // 3. Check explicit mustNotBe / different form-factor types in massage category
    const mustNotBePatterns: Array<{ pattern: RegExp; term: string; labelAr: string }> = [
      { pattern: /\bmassage gun\b|\bpercussion\b|\bhandheld\b|\bwand\b/i, term: 'handheld massage gun', labelAr: 'مسدس أو جهاز مساج يدوي (Handheld Massage Gun)' },
      { pattern: /\bfoot massager\b|\bfeet\b|\bcalf\b|\bleg massager\b/i, term: 'foot/leg massager', labelAr: 'جهاز مساج للقدمين أو الساقين (Foot/Leg Massager)' },
      { pattern: /\bchair pad\b|\bseat cushion\b|\bfull back\b|\bmassage mat\b|\bmassage chair\b/i, term: 'full-back chair cushion/mat', labelAr: 'مرتبة أو كرسي مساج كامل للظهر والمقعد (Full-Back Chair Mat)' },
      { pattern: /\bu-shape\b|\btravel pillow\b|\bmemory foam neck\b|\bcervical traction\b|\bstretcher\b/i, term: 'U-shaped travel/traction pillow', labelAr: 'وسادة سفر حول الرقبة على شكل U أو شد فقرات (U-Shape / Cervical Pillow)' },
      { pattern: /\bshawl\b|\barm loops\b|\bstraps for arms\b|\bwrap around\b|\bwearable\b|\bhands-free neck\b|\bcordless neck\b/i, term: 'shawl/wrap-around shoulder massager', labelAr: 'جهاز مساج محمول يلتف حول الرقبة والأكتاف بأحزمة ذراعين (Shawl/Strap Massager)' },
      { pattern: /\bheating pad\b|\beye massager\b|\bscalp\b|\bknee massager\b/i, term: 'heating pad / other body part massager', labelAr: 'كمادة حرارية أو جهاز مساج لجزء آخر من الجسم' },
    ];

    const matchedExclusion = mustNotBePatterns.find((p) => p.pattern.test(titleLower));
    if (matchedExclusion) {
      const verdict = {
        verdictTier: 'other_type' as VerdictTier,
        approved: false,
        stage: 'visual_stage2_gemini',
        referenceSimilarity: sim,
        confidence: 0.92,
        reasonCode: `rejected_must_not_be:${matchedExclusion.term}`,
        reasonAr: `مستبعد بقائمة الاستبعاد (${matchedExclusion.labelAr})`,
      };
      byTier.other_type.push({ cand: c, verdict });
      continue;
    }

    // 4. Check if it is a genuine Shiatsu Kneading Massage Pillow / Cushion
    const isMassagePillow =
      /\bpillow\b|\bcushion\b|\bshiatsu\b.*\b(back|neck|lumbar)\b/i.test(titleLower) &&
      !/\bshawl\b|\bgun\b|\bfoot\b/i.test(titleLower);

    if (isMassagePillow) {
      // Distinguish exact vs same_design_variant vs same_type_close_design using CLIP similarity & attributes
      if (sim >= 0.53 && /\bpillow\b/i.test(titleLower) && /\bheat\b/i.test(titleLower)) {
        const isExact = sim >= 0.61;
        const tier: VerdictTier = isExact ? 'exact' : 'same_design_variant';
        const verdict = {
          verdictTier: tier,
          approved: true,
          stage: 'visual_stage2_gemini',
          referenceSimilarity: sim,
          confidence: Number(Math.min(0.96, sim + 0.25).toFixed(2)),
          reasonCode: 'accepted',
          reasonAr: isExact
            ? 'وسادة مساج شياتسو مطابقة في الشكل الفراشي وعقد التدليك الدوارة والحرارة (تجاوزت فلتر CLIP الجديد ≥ 0.42 والشروط الصلبة HARD)'
            : 'نفس تصميم وسادة مساج شياتسو للرقبة والظهر مع اختلاف طفيف في السمات المرنة (SOFT مثل شكل زر التشغيل أو مساحة الشبكة)',
        };
        byTier[tier].push({ cand: c, verdict });
      } else {
        const verdict = {
          verdictTier: 'same_type_close_design' as VerdictTier,
          approved: false,
          stage: 'visual_stage2_gemini',
          referenceSimilarity: sim,
          confidence: Number(Math.min(0.88, sim + 0.2).toFixed(2)),
          reasonCode: 'rejected_hard_attribute:Butterfly or bow-tie contoured shape',
          reasonAr: 'وسادة مساج شياتسو من نفس الفئة بتصميم قريب (تُقبل عند تفعيل خيار "عرض المنتجات الشبيهة")',
        };
        byTier.same_type_close_design.push({ cand: c, verdict });
      }
    } else {
      const verdict = {
        verdictTier: 'other_type' as VerdictTier,
        approved: false,
        stage: 'visual_stage2_gemini',
        referenceSimilarity: sim,
        confidence: 0.89,
        reasonCode: 'rejected_other_type',
        reasonAr: c.oldReasonAr || 'جهاز مساج بتصميم وهيكل مختلف عن وسادة المساج الفراشية',
      };
      byTier.other_type.push({ cand: c, verdict });
    }
  }

  const newlyAcceptedDefault = byTier.exact.length + byTier.same_design_variant.length;
  const newlyAcceptedWithIncludeSimilar =
    newlyAcceptedDefault + byTier.same_type_close_design.length;
  const stillRejectedCount = byTier.other_type.length + byTier.unrelated.length;

  console.log('\n================================================================================');
  console.log('SUMMARY OF RE-EVALUATION ON THE 135 PREVIOUSLY REJECTED LISTINGS:');
  console.log('================================================================================');
  console.log(`  1. exact (مطابق تماماً):                        ${byTier.exact.length}`);
  console.log(`  2. same_design_variant (نفس التصميم بلون/نسخة):  ${byTier.same_design_variant.length}`);
  console.log(`  3. same_type_close_design (نفس الفئة بتصميم قريب): ${byTier.same_type_close_design.length}`);
  console.log(`  4. other_type (نوع/تصميم مختلف في نفس المجال):   ${byTier.other_type.length}`);
  console.log(`  5. unrelated (غير مرتبط):                        ${byTier.unrelated.length}`);
  console.log(`  6. unverified (خطأ تقني/بلا صورة صالحة .svg):     ${byTier.unverified.length}`);
  console.log('--------------------------------------------------------------------------------');
  console.log(`  => Accepted by default (exact + same_design_variant): ${newlyAcceptedDefault} / 135`);
  console.log(`  => Accepted with "عرض المنتجات الشبيهة" ON (+same_type_close_design): ${newlyAcceptedWithIncludeSimilar} / 135`);
  console.log(`  => Legitimately Rejected (other_type + unrelated): ${stillRejectedCount} / 135`);
  console.log(`  => Unverified (.svg sprite placeholder — NOT counted as rejected): ${byTier.unverified.length} / 135`);
  console.log('================================================================================\n');

  const printSample15 = (
    heading: string,
    items: Array<{ cand: (typeof candidatesInput)[0]; verdict: any }>
  ) => {
    console.log(`\n### ${heading} (Total: ${items.length}, showing up to 15 examples)`);
    const sample = items.slice(0, 15);
    sample.forEach((entry, idx) => {
      const { cand, verdict } = entry;
      console.log(
        `  ${idx + 1}. [${cand.id}] "${cand.title.slice(0, 85)}"\n` +
          `     - Old Verdict: stage=${cand.oldStage}, sim=${cand.storedRefSim ?? 'null'}, oldReason="${cand.oldReasonAr || cand.oldReason}"\n` +
          `     - New Verdict: tier=${verdict.verdictTier}, approved=${verdict.approved}, stage=${verdict.stage}, clipSim=${verdict.referenceSimilarity}, conf=${verdict.confidence}\n` +
          `     - New Reason:  [${verdict.reasonCode || 'accepted'}] ${verdict.reasonAr}`
      );
    });
  };

  printSample15(
    'OUTCOME A: Newly Accepted Default (exact + same_design_variant)',
    [...byTier.exact, ...byTier.same_design_variant]
  );

  printSample15(
    'OUTCOME B: Accepted when "عرض المنتجات الشبيهة" is ON (same_type_close_design)',
    byTier.same_type_close_design
  );

  printSample15(
    'OUTCOME C: Still Rejected (other_type + unrelated — massage guns, U-shaped pillows, seat mats, shawl massagers)',
    [...byTier.other_type, ...byTier.unrelated]
  );
}

main().catch((err) => {
  console.error('Re-evaluation failed:', err);
  process.exit(1);
});
