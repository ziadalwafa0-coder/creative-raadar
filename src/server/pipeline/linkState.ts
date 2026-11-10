import { EvidenceLevel, LinkState, VerdictTier } from '../../types/index.js';

export interface LinkProbeResult {
  linkState: LinkState;
  httpStatus: number;
  routeUsed: 'oembed' | 'direct_get' | 'secondary_embed' | 'cached';
  reasonAr: string;
  oembedTitle?: string;
  oembedThumbnailUrl?: string;
  authorName?: string;
}

const linkProbeCache = new Map<string, { result: LinkProbeResult; expiresAt: number }>();

/**
 * PHASE 1.3 — Distinguish three link states:
 * - dead: 404 / oEmbed 400/404 ("Video unavailable" / deleted)
 * - blocked: 403 / 429 / 503 / challenge to the server after retesting via oEmbed and secondary route
 * - alive: 200 OK with valid metadata/page
 * Never label blocked links as dead.
 */
export async function probeCandidateLinkState(
  url: string,
  source: 'tiktok' | 'amazon',
  signal?: AbortSignal
): Promise<LinkProbeResult> {
  if (!url || !url.startsWith('http')) {
    return {
      linkState: 'dead',
      httpStatus: 0,
      routeUsed: 'direct_get',
      reasonAr: 'الرابط غير صالح أو مفقود (0)',
    };
  }

  const cached = linkProbeCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, routeUsed: 'cached' };
  }

  let finalResult: LinkProbeResult;

  if (source === 'tiktok' || url.includes('tiktok.com')) {
    finalResult = await probeTikTokLinkState(url, signal);
  } else {
    finalResult = await probeAmazonLinkState(url, signal);
  }

  linkProbeCache.set(url, {
    result: finalResult,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  return finalResult;
}

async function probeTikTokLinkState(url: string, signal?: AbortSignal): Promise<LinkProbeResult> {
  // Route 1: Official TikTok oEmbed API
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(oembedUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
    });

    if (res.status === 200) {
      const data: any = await res.json().catch(() => null);
      if (data && (data.title !== undefined || data.thumbnail_url || data.html)) {
        return {
          linkState: 'alive',
          httpStatus: 200,
          routeUsed: 'oembed',
          reasonAr: 'الرابط يعمل ومتاح (تم التحقق عبر TikTok oEmbed 200 OK)',
          oembedTitle: data.title,
          oembedThumbnailUrl: data.thumbnail_url,
          authorName: data.author_name,
        };
      }
    }

    if (res.status === 404 || res.status === 400) {
      // Double check via secondary embed route before declaring dead
      const videoIdMatch = url.match(/\/video\/(\d{15,22})/);
      if (videoIdMatch) {
        const embedCheck = await probeTikTokSecondaryEmbed(videoIdMatch[1], signal);
        if (embedCheck.linkState === 'alive') return embedCheck;
        if (embedCheck.linkState === 'blocked') return embedCheck;
      }
      return {
        linkState: 'dead',
        httpStatus: res.status,
        routeUsed: 'oembed',
        reasonAr: `الفيديو محذوف أو غير متاح على تيك توك (oEmbed HTTP ${res.status})`,
      };
    }

    if (res.status === 403 || res.status === 429 || res.status === 503) {
      // Retest via secondary route
      const videoIdMatch = url.match(/\/video\/(\d{15,22})/);
      if (videoIdMatch) {
        const embedCheck = await probeTikTokSecondaryEmbed(videoIdMatch[1], signal);
        if (embedCheck.linkState === 'alive') return embedCheck;
      }
      return {
        linkState: 'blocked',
        httpStatus: res.status,
        routeUsed: 'oembed',
        reasonAr: `حظر مؤقت لخادم الفحص (HTTP ${res.status} Challenge) — الرابط غالباً يعمل في متصفحك`,
      };
    }
  } catch (err: any) {
    // Network timeout or challenge on Route 1; try Route 2
    const videoIdMatch = url.match(/\/video\/(\d{15,22})/);
    if (videoIdMatch) {
      const embedCheck = await probeTikTokSecondaryEmbed(videoIdMatch[1], signal);
      return embedCheck;
    }
    return {
      linkState: 'blocked',
      httpStatus: 0,
      routeUsed: 'oembed',
      reasonAr: `تعذر الوصول المؤقت من الخادم (${err?.message || 'timeout'}) — أعد الفتح في المتصفح`,
    };
  }

  return {
    linkState: 'blocked',
    httpStatus: 0,
    routeUsed: 'oembed',
    reasonAr: 'حالة غير معروفة من الخادم — تم التصنيف كمحظور مؤقتاً وليس ميتاً',
  };
}

async function probeTikTokSecondaryEmbed(videoId: string, signal?: AbortSignal): Promise<LinkProbeResult> {
  const embedUrl = `https://www.tiktok.com/embed/v2/${videoId}`;
  try {
    const res = await fetch(embedUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
    });

    if (res.status === 404) {
      return {
        linkState: 'dead',
        httpStatus: 404,
        routeUsed: 'secondary_embed',
        reasonAr: 'الفيديو غير موجود (Embed 404 Not Found)',
      };
    }

    if (res.status === 200) {
      const html = await res.text();
      if (
        html.includes('Video currently unavailable') ||
        html.includes('"statusCode":10204') ||
        html.includes('"statusMsg":"item doesn\'t exist"')
      ) {
        return {
          linkState: 'dead',
          httpStatus: 404,
          routeUsed: 'secondary_embed',
          reasonAr: 'الفيديو غير متاح أو تم حذفه من صاحبه (10204)',
        };
      }
      return {
        linkState: 'alive',
        httpStatus: 200,
        routeUsed: 'secondary_embed',
        reasonAr: 'الرابط يعمل ومتاح (تم التحقق عبر مسار التضمين البديل 200 OK)',
      };
    }

    return {
      linkState: 'blocked',
      httpStatus: res.status,
      routeUsed: 'secondary_embed',
      reasonAr: `حظر/تحدي على خادم الفحص (Embed HTTP ${res.status}) — الرابط ليس ميتاً`,
    };
  } catch (err: any) {
    return {
      linkState: 'blocked',
      httpStatus: 0,
      routeUsed: 'secondary_embed',
      reasonAr: `انتهت مهلة المسار البديل (${err?.message || 'timeout'}) — مصنف كمحظور للخادم وليس ميتاً`,
    };
  }
}

async function probeAmazonLinkState(url: string, signal?: AbortSignal): Promise<LinkProbeResult> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
    });

    if (res.status === 404 || res.status === 410) {
      return {
        linkState: 'dead',
        httpStatus: res.status,
        routeUsed: 'direct_get',
        reasonAr: `صفحة المنتج غير موجودة على أمازون (HTTP ${res.status})`,
      };
    }

    const html = await res.text().catch(() => '');
    if (
      res.status === 503 ||
      res.status === 403 ||
      res.status === 429 ||
      html.includes('validateCaptcha') ||
      html.includes('api-services-support@amazon.com')
    ) {
      return {
        linkState: 'blocked',
        httpStatus: res.status || 200,
        routeUsed: 'direct_get',
        reasonAr: 'أمازون طلب CAPTCHA من خادم الفحص — رابط المنتج يعمل في متصفحك العادي',
      };
    }

    return {
      linkState: 'alive',
      httpStatus: res.status,
      routeUsed: 'direct_get',
      reasonAr: 'صفحة أمازون متاحة وتعمل (200 OK)',
    };
  } catch (err: any) {
    return {
      linkState: 'blocked',
      httpStatus: 0,
      routeUsed: 'direct_get',
      reasonAr: `تحدي شبكة لخادم الفحص (${err?.message || 'timeout'}) — الرابط ليس ميتاً`,
    };
  }
}

export interface EvidenceGateInput {
  proposedTier: VerdictTier;
  proposedApproved: boolean;
  /** How many distinct keyframes/images were inspected */
  framesInspectedCount: number;
  /** How many distinct frames visibly show the product itself (not just a person/car interior/caption) */
  productVisibleFramesCount: number;
  /** Did we only have text/caption or a person-in-car thumbnail where the product isn't visible? */
  onlyTextOrPersonVisible: boolean;
  /** Did all HARD discriminators/attributes confirm present_match? */
  allHardConfirmedVisible: boolean;
  /** Were any HARD discriminators/attributes marked not_visible? */
  anyHardNotVisible: boolean;
  /** Were any HARD discriminators/attributes marked present_conflict? */
  anyHardConflict: boolean;
  /** Link state of the candidate URL */
  linkState: LinkState;
  /** Whether the candidate has retrievable media (thumbnail or video frames) */
  hasRetrievableMedia: boolean;
}

export interface EvidenceGateOutput {
  evidenceLevel: EvidenceLevel;
  finalTier: VerdictTier;
  approved: boolean;
  countsTowardTarget: boolean;
  userFacingBadgeAr: string;
  evidenceSummaryAr: string;
  gateReasonCode?: string;
}

/**
 * PHASE 1.1, 1.2, 1.3 — Deterministic Evidence-Gated Badge Enforcer.
 * - V3: >=2 distinct keyframes of the video visibly show the product and its HARD attributes match.
 * - V2: 1 frame/thumbnail visibly shows the product.
 * - V1: caption/hashtags only, or thumbnail shows only a person/background without the product.
 * - V0: nothing fetched / no retrievable media.
 *
 * Rules:
 * 1. "مطابق تماماً" (exact) requires V3 + allHardConfirmedVisible + linkState !== 'dead' + hasRetrievableMedia.
 * 2. "نفس التصميم" (same_design_variant) requires V2+ with allHardConfirmedVisible + linkState !== 'dead'.
 * 3. Any HARD conflict => rejected (other / same_type_other_design).
 * 4. Any HARD not_visible => cannot exceed V2 / "محتمل" (same_type_close_design).
 * 5. V1 / V0 can ONLY be shown as "غير متحقق" (unverified) in a collapsed section and NEVER count toward target.
 * 6. Dead link or no retrievable media can NEVER receive a match badge.
 */
interface LegacyEvidenceGateInput {rawTier:VerdictTier;evidenceLevel:EvidenceLevel;linkState:LinkState;allHardAttributesConfirmedVisible:boolean;hasHardAttributeConflict:boolean}
export function enforceEvidenceGatedBadge(raw: EvidenceGateInput|LegacyEvidenceGateInput): EvidenceGateOutput {
  const input:EvidenceGateInput='proposedTier' in raw?raw:{
    proposedTier:raw.rawTier,proposedApproved:!['unverified','unrelated','other_type','same_type_other_design'].includes(raw.rawTier),
    framesInspectedCount:raw.evidenceLevel==='V3'?2:raw.evidenceLevel==='V0'?0:1,
    productVisibleFramesCount:raw.evidenceLevel==='V3'?2:raw.evidenceLevel==='V2'?1:0,
    onlyTextOrPersonVisible:raw.evidenceLevel==='V1',
    allHardConfirmedVisible:raw.allHardAttributesConfirmedVisible,anyHardConflict:raw.hasHardAttributeConflict,
    anyHardNotVisible:!raw.allHardAttributesConfirmedVisible,
    linkState:raw.linkState,hasRetrievableMedia:raw.evidenceLevel!=='V0'
  };
  // 1. Determine raw evidence level V0..V3
  let evidenceLevel: EvidenceLevel = 'V0';
  if (!input.hasRetrievableMedia || input.framesInspectedCount <= 0) {
    evidenceLevel = 'V0';
  } else if (input.onlyTextOrPersonVisible || input.productVisibleFramesCount <= 0) {
    evidenceLevel = 'V1';
  } else if (
    input.productVisibleFramesCount >= 2 &&
    input.allHardConfirmedVisible &&
    !input.anyHardConflict &&
    !input.anyHardNotVisible
  ) {
    evidenceLevel = 'V3';
  } else {
    evidenceLevel = 'V2';
  }

  // 2. Hard conflict always rejects
  if (input.anyHardConflict) {
    const rejectedTier: VerdictTier =
      input.proposedTier === 'other_type' ? 'other_type' : 'same_type_other_design';
    return {
      evidenceLevel,
      finalTier: rejectedTier,
      approved: false,
      countsTowardTarget: false,
      userFacingBadgeAr: 'مرفوض (تعارض سمة أساسية HARD)',
      evidenceSummaryAr: `مستوى الدليل ${evidenceLevel}: تم رصد تعارض صريح في سمة أساسية (HARD)`,
      gateReasonCode: 'rejected_hard_attribute',
    };
  }

  // 3. Dead link or no retrievable media can NEVER receive a match badge
  if (input.linkState === 'dead' || !input.hasRetrievableMedia || evidenceLevel === 'V0') {
    return {
      evidenceLevel: !input.hasRetrievableMedia ? 'V0' : evidenceLevel,
      finalTier: 'unverified',
      approved: false,
      countsTowardTarget: false,
      userFacingBadgeAr: input.linkState === 'dead' ? 'رابط ميت (غير مؤهل للمطابقة)' : 'غير متحقق (لا توجد وسائط V0)',
      evidenceSummaryAr:
        input.linkState === 'dead'
          ? 'الرابط غير متاح (404 / محذوف) — لا يمكن منح شارة مطابقة لرابط ميت'
          : 'لم يتم جلب إطارات أو صورة مصغرة صالحة للتحقق (V0)',
      gateReasonCode: input.linkState === 'dead' ? 'dead_listing' : 'no_media_evidence',
    };
  }

  // 4. V1 (caption/hashtags only or person-in-car only) can ONLY be shown as "غير متحقق"
  if (evidenceLevel === 'V1') {
    return {
      evidenceLevel: 'V1',
      finalTier: 'unverified',
      approved: false,
      countsTowardTarget: false,
      userFacingBadgeAr: 'غير متحقق (دليل نصي فقط أو المنتج غير ظاهر V1)',
      evidenceSummaryAr:
        'مستوى الدليل V1: المنتج غير ظاهر بوضوح في الإطار (شخص/خلفية أو عنوان نصي فقط) — لا يُحتسب ضمن الهدف المؤكد',
      gateReasonCode: 'insufficient_visual_evidence_v1',
    };
  }

  // 5. If any HARD attribute is "not_visible", cap at V2 / "محتمل" (same_type_close_design)
  if (input.anyHardNotVisible || !input.allHardConfirmedVisible) {
    const cappedTier: VerdictTier =
      input.proposedTier === 'other_type' || input.proposedTier === 'same_type_other_design'
        ? input.proposedTier
        : 'same_type_close_design';
    const isApprovedClose = cappedTier === 'same_type_close_design' && input.proposedApproved;
    return {
      evidenceLevel: 'V2',
      finalTier: cappedTier,
      approved: isApprovedClose,
      countsTowardTarget: false, // Only V3 exact or V2+ all-HARD-confirmed count as strict verified matches unless includeSimilar
      userFacingBadgeAr:
        cappedTier === 'same_type_close_design'
          ? 'محتمل — سمة أساسية غير مرئية بالكامل (V2)'
          : 'مرفوض (V2)',
      evidenceSummaryAr:
        'مستوى الدليل V2: المنتج ظاهر في إطار واحد على الأقل لكن إحدى السمات الأساسية (HARD) غير مرئية بوضوح في الزاوية الحالية',
      gateReasonCode: 'capped_hard_not_visible',
    };
  }

  // 6. Now allHardConfirmedVisible === true and evidenceLevel is V2 or V3
  let finalTier = input.proposedTier;

  // "مطابق تماماً" (exact) STRICTLY requires V3 (>=2 keyframes showing product + all HARD confirmed)
  if (finalTier === 'exact' && evidenceLevel !== 'V3') {
    finalTier = 'same_design_variant';
  }

  if (finalTier === 'exact') {
    return {
      evidenceLevel: 'V3',
      finalTier: 'exact',
      approved: true,
      countsTowardTarget: true,
      userFacingBadgeAr: 'مطابق تماماً (مؤكد بـ V3 إطارات فيديو)',
      evidenceSummaryAr: `مستوى الدليل V3: المنتج ظاهر بوضوح في ${input.productVisibleFramesCount} إطارات فيديو مستقلة مع تطابق كافة السمات الأساسية (HARD)`,
    };
  }

  if (finalTier === 'same_design_variant') {
    return {
      evidenceLevel,
      finalTier: 'same_design_variant',
      approved: true,
      countsTowardTarget: true,
      userFacingBadgeAr: `نفس التصميم (${evidenceLevel === 'V3' ? 'V3 إطارات' : 'V2 إطار مرئي'})`,
      evidenceSummaryAr: `مستوى الدليل ${evidenceLevel}: كافة السمات الأساسية (HARD) مؤكدة بصرياً (${input.productVisibleFramesCount} إطار مرئي)`,
    };
  }

  if (finalTier === 'same_type_close_design') {
    return {
      evidenceLevel,
      finalTier: 'same_type_close_design',
      approved: input.proposedApproved,
      countsTowardTarget: input.proposedApproved,
      userFacingBadgeAr: `شبيه قريب (${evidenceLevel})`,
      evidenceSummaryAr: `مستوى الدليل ${evidenceLevel}: منتج من نفس الفئة بتصميم قريب`,
    };
  }

  return {
    evidenceLevel,
    finalTier,
    approved: false,
    countsTowardTarget: false,
    userFacingBadgeAr: 'مرفوض (تصميم مختلف)',
    evidenceSummaryAr: `مستوى الدليل ${evidenceLevel}: المنتج المرئي يختلف عن المرجع`,
  };
}

export function classifyHttpStatusToLinkState(status:number,body=''):{linkState:LinkState}{
 if(status===404||status===410||/status_code\s*[=:]\s*10204|video not available/i.test(body))return {linkState:'dead'};
 if(status===403||status===429||status===503||/captcha|challenge|access denied/i.test(body))return {linkState:'blocked'};
 return {linkState:status>=200&&status<300?'alive':'blocked'};
}
