import React, { useState } from 'react';
import { CandidateAsset, EvidenceLevel, LinkState } from '../types/index.ts';
import { getProvenanceLabel } from '../utils/rules.ts';
import { useApp } from '../context/AppContext.tsx';
import {
  Video,
  Camera,
  ExternalLink,
  Eye,
  Download,
  RotateCcw,
  Play,
  Loader2,
  Check,
  ShieldCheck,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  Film,
} from 'lucide-react';

interface Props {
  asset: CandidateAsset;
  onPreview: (asset: CandidateAsset) => void;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
  onReportDead?: (id: string) => void;
  onOwnerFeedback?: (asset: CandidateAsset, label: 'same_product' | 'different_product') => Promise<void>;
}

export const AssetCard: React.FC<Props> = ({
  asset,
  onPreview,
  isSelected = true,
  onToggleSelect,
  onReportDead,
  onOwnerFeedback,
}) => {
  const {
    lang,
    currentProject,
    refreshProjects,
    showToast,
    apiFetch,
    downloadWithSession,
  } = useApp();
  const provInfo = getProvenanceLabel(asset.provenance, lang);

  const [isRetrying, setIsRetrying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const [isDeadReported, setIsDeadReported] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState<'same_product' | 'different_product' | null>(null);
  const [activeFramePreview, setActiveFramePreview] = useState<string | null>(null);

  const isVideo = asset.mediaType === 'video';
  const isTikTok = asset.platform === 'tiktok' || Boolean(asset.sourceUrl?.includes('tiktok.com'));

  const isDownloaded =
    asset.downloadStatus === 'verified_available' ||
    (Boolean(asset.mediaUrl) &&
      !asset.mediaUrl?.includes('youtube.com') &&
      !asset.mediaUrl?.includes('youtu.be'));
  const isFailed = asset.downloadStatus === 'download_failed';

  // Phase 1 Evidence Level & Link State Enforcement:
  const effectiveLinkState: LinkState =
    isDeadReported || asset.isDead ? 'dead' : asset.linkState || 'alive';

  const extractedFrames = asset.extractedFrameUrls || [];
  const effectiveEvidenceLevel: EvidenceLevel =
    asset.evidenceLevel ||
    (extractedFrames.length >= 2
      ? 'V3'
      : asset.posterSource === 'real_video_frame' || Boolean(asset.thumbnailUrl)
      ? 'V2'
      : 'V1');

  const isRejectedByOwner = asset.ownerFeedback === 'different_product';
  const isConfirmedByOwner = asset.ownerFeedback === 'same_product';

  // Phase 1 Rule 2 & 3:
  // - Dead link or V1/V0 or owner-rejected can NEVER receive a match badge ("مطابق تماماً" / "نفس التصميم")
  // - "مطابق تماماً" (Exact) requires V3
  // - "نفس التصميم" requires V2+
  const canShowMatchBadge =
    effectiveLinkState !== 'dead' &&
    !isRejectedByOwner &&
    effectiveEvidenceLevel !== 'V0' &&
    effectiveEvidenceLevel !== 'V1' &&
    asset.verifiedByAi !== false;

  const isExactTier =
    canShowMatchBadge &&
    effectiveEvidenceLevel === 'V3' &&
    (asset.verdictTier === 'exact' || asset.matchCategory === 'exact_design' || isConfirmedByOwner);

  const isSameDesignVariantTier =
    canShowMatchBadge &&
    !isExactTier &&
    (effectiveEvidenceLevel === 'V3' || effectiveEvidenceLevel === 'V2') &&
    (asset.verdictTier === 'exact' ||
      asset.verdictTier === 'same_design_variant' ||
      asset.matchCategory === 'exact_design' ||
      asset.matchCategory === 'permitted_variation' ||
      isConfirmedByOwner);

  const isCloseDesignTier =
    canShowMatchBadge &&
    !isExactTier &&
    !isSameDesignVariantTier &&
    (asset.verdictTier === 'same_type_close_design' || asset.matchCategory === 'similar_differences');

  const inlineVideoFrameSrc =
    isVideo && (asset.downloadUrl || asset.mediaUrl)
      ? `/api/stream-search/download?url=${encodeURIComponent(
          asset.downloadUrl || asset.mediaUrl || ''
        )}&type=video&inline=1#t=1.0`
      : '';

  const displayHeroImage = activeFramePreview || asset.thumbnailUrl;

  const handleRetryDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentProject) return;
    setIsRetrying(true);
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/assets/${asset.id}/retry`, {
        method: 'POST',
      });
      if (res.ok) {
        showToast('تمت إعادة محاولة تنزيل الملف', 'info');
        await refreshProjects();
      } else {
        showToast('تعذر تنزيل الملف، متاح كمصدر فقط', 'warn');
      }
    } catch {
      showToast('فشل الاتصال بالخادم', 'error');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleSingleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDownloading(true);
    try {
      const ext = isVideo ? 'mp4' : 'jpg';
      const targetUrl = asset.downloadUrl || asset.mediaUrl;
      const projectId = asset.projectId || currentProject?.id || 'ephemeral';
      const isEphemeral = !projectId || projectId.startsWith('ephemeral-');
      const dlUrl =
        isEphemeral && targetUrl
          ? `/api/stream-search/download?url=${encodeURIComponent(
              targetUrl
            )}&type=${asset.mediaType}&title=${encodeURIComponent(asset.title || asset.id)}`
          : `/api/projects/${projectId}/assets/${asset.id}/download`;
      await downloadWithSession(dlUrl, `${asset.id}_verified.${ext}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleReportDeadLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDeadReported(true);
    try {
      await apiFetch('/api/links/report-dead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asin: asset.asin,
          url: asset.productListingUrl || asset.sourceUrl,
          searchId: asset.searchId,
          assetId: asset.id,
          reason: 'User reported broken link via UI',
        }),
      });
      showToast('تم الإبلاغ واستبعاد الرابط المعطل من النتائج المؤكدة', 'info');
      onReportDead?.(asset.id);
    } catch {
      showToast('تم الإبلاغ عن الرابط المعطل', 'info');
    }
  };

  const handleOwnerLabelClick = async (
    e: React.MouseEvent,
    label: 'same_product' | 'different_product'
  ) => {
    e.stopPropagation();
    if (!onOwnerFeedback || submittingFeedback) return;
    setSubmittingFeedback(label);
    try {
      await onOwnerFeedback(asset, label);
    } finally {
      setSubmittingFeedback(null);
    }
  };

  return (
    <div
      data-testid="asset-card"
      data-evidence-level={effectiveEvidenceLevel}
      data-link-state={effectiveLinkState}
      className={`group bg-white rounded-2xl border transition-all overflow-hidden flex flex-col justify-between ${
        isRejectedByOwner
          ? 'border-red-300 bg-red-50/20 opacity-75'
          : onToggleSelect && isSelected
          ? 'border-[#247C72] ring-1 ring-[#247C72]/25'
          : 'border-[#E2E5DF] hover:border-[#247C72]/50'
      }`}
    >
      {/* Thumbnail Surface */}
      <div
        className="relative aspect-video w-full bg-[#181B1A] overflow-hidden cursor-pointer"
        onClick={() => onPreview(asset)}
      >
        {displayHeroImage && !imgFailed ? (
          <img
            src={displayHeroImage}
            alt={asset.title}
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
            loading="lazy"
          />
        ) : inlineVideoFrameSrc && !videoThumbFailed ? (
          <video
            src={inlineVideoFrameSrc}
            preload="metadata"
            muted
            playsInline
            onError={() => setVideoThumbFailed(true)}
            className="w-full h-full object-cover pointer-events-none"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#202422] text-slate-300 p-4 text-center select-none">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-[#56B3A8] mb-2">
              {isVideo ? <Video className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
            </div>
            <span className="text-xs font-medium line-clamp-1 max-w-[85%]">{asset.title}</span>
          </div>
        )}

        {/* Phase 1 Evidence-Gated Verdict Badge (Top-Right) */}
        <div className="absolute top-2.5 right-2.5 z-10 flex flex-col items-end gap-1">
          {effectiveLinkState === 'dead' ? (
            <span
              data-testid="verdict-badge-dead"
              title="الرابط معطل (404) — لا يمكن منح شارة تطابق لرابط غير متاح"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-700/95 text-white border border-red-400/40 shadow-xs"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>غير متحقق (الرابط معطل)</span>
            </span>
          ) : isRejectedByOwner ? (
            <span
              data-testid="verdict-badge-owner-rejected"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-700/95 text-white border border-red-400/40 shadow-xs"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>مستبعد بتقييمك (مش المنتج)</span>
            </span>
          ) : isExactTier ? (
            <span
              data-testid="verdict-badge-exact"
              title={asset.userFacingMatchLabel || 'مطابق تماماً — مؤكد من إطارين أو أكثر من الفيديو (V3)'}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-600/95 text-white border border-emerald-400/40 shadow-xs"
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>مطابق تماماً (Exact • V3)</span>
            </span>
          ) : isSameDesignVariantTier ? (
            <span
              data-testid="verdict-badge-variant"
              title={asset.userFacingMatchLabel || 'نفس التصميم (لون/نسخة) — مؤكد بصرياً (V2+)'}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-teal-700/95 text-white border border-teal-400/40 shadow-xs"
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>نفس التصميم (لون/نسخة • {effectiveEvidenceLevel})</span>
            </span>
          ) : isCloseDesignTier ? (
            <span
              data-testid="verdict-badge-close"
              title={asset.userFacingMatchLabel || 'محتمل — نفس الفئة بتصميم قريب'}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-600/95 text-white border border-amber-400/40 shadow-xs"
            >
              <span>محتمل • تصميم قريب ({effectiveEvidenceLevel})</span>
            </span>
          ) : (
            <span
              data-testid="verdict-badge-unverified"
              title="غير متحقق بصرياً (V1/V0) — لا يُحتسب ضمن الهدف"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-800/95 text-amber-200 border border-amber-400/40 shadow-xs"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>غير متحقق ({effectiveEvidenceLevel})</span>
            </span>
          )}

          {/* Evidence Level & Crop Similarity Chip */}
          <span
            data-testid="evidence-level-chip"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-black/80 text-white border border-white/20"
            title={
              effectiveEvidenceLevel === 'V3'
                ? 'V3: تم التحقق من إطارين أو أكثر من الفيديو مع تطابق كافة السمات الإلزامية'
                : effectiveEvidenceLevel === 'V2'
                ? 'V2: تم التحقق من إطار واحد أو الصورة المصغرة'
                : effectiveEvidenceLevel === 'V1'
                ? 'V1: نص/عنوان فقط بدون رؤية واضحة للمنتج'
                : 'V0: لم يتم جلب وسائط'
            }
          >
            <span>الدليل: {effectiveEvidenceLevel}</span>
            {extractedFrames.length > 0 && <span>({extractedFrames.length} إطارات)</span>}
            {typeof asset.cropClipSimilarity === 'number' && (
              <span>• CLIP {Math.round(asset.cropClipSimilarity * 100)}%</span>
            )}
          </span>
        </div>

        {/* Distinct Export Selection Checkbox (Top-Left) */}
        {onToggleSelect && canShowMatchBadge && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(asset.id);
            }}
            title={isSelected ? 'إلغاء التحديد من التصدير' : 'تحديد لتصدير الحزمة'}
            className={`absolute top-2.5 left-2.5 z-10 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-semibold border shadow-xs transition-all cursor-pointer ${
              isSelected
                ? 'bg-black/75 text-white border-white/50'
                : 'bg-black/50 hover:bg-black/75 text-white/80 border-white/25'
            }`}
          >
            <span
              className={`w-3.5 h-3.5 rounded flex items-center justify-center border ${
                isSelected ? 'bg-[#247C72] text-white border-[#247C72]' : 'border-white/70'
              }`}
            >
              {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
            </span>
            <span>تصدير</span>
          </button>
        )}

        {/* Media Type & Duration Tag */}
        <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/75 text-white text-[11px] font-medium tabular-nums">
          {isVideo ? (
            <>
              <Play className="w-3 h-3 fill-white text-white" />
              <span>{asset.durationSeconds ? `${asset.durationSeconds}ث` : 'فيديو'}</span>
            </>
          ) : (
            <>
              <Camera className="w-3 h-3" />
              <span>صورة</span>
            </>
          )}
        </div>
      </div>

      {/* Phase 2.3 Extracted Keyframes Strip (if 2+ frames extracted via ffmpeg) */}
      {extractedFrames.length > 0 && (
        <div
          data-testid="extracted-keyframes-strip"
          className="px-3 py-1.5 bg-[#FAFBF9] border-b border-[#E2E5DF] flex items-center gap-1.5 overflow-x-auto"
        >
          <span className="text-[10px] font-bold text-[#616764] shrink-0 inline-flex items-center gap-1">
            <Film className="w-3 h-3 text-[#247C72]" />
            إطارات الفحص:
          </span>
          {extractedFrames.map((frameUrl, idx) => (
            <button
              key={frameUrl}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActiveFramePreview(activeFramePreview === frameUrl ? null : frameUrl);
              }}
              className={`w-10 h-7 rounded overflow-hidden border shrink-0 cursor-pointer transition-all ${
                activeFramePreview === frameUrl
                  ? 'border-[#247C72] ring-1 ring-[#247C72]'
                  : 'border-slate-300 opacity-85 hover:opacity-100'
              }`}
              title={`معاينة إطار الفيديو رقم ${idx + 1}`}
            >
              <img src={frameUrl} alt={`Frame ${idx + 1}`} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}

      {/* Body Information */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                isTikTok
                  ? 'bg-[#181B1A] text-white border-[#181B1A]'
                  : 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]/30'
              }`}
            >
              {isTikTok ? 'تيك توك • TikTok' : 'أمازون • Amazon'}
            </span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${provInfo.badge}`}>
              {isTikTok ? 'إعلان/مراجعة صانع محتوى (UGC)' : provInfo.label}
            </span>

            {/* Phase 1.3 Real Link State Indicator (alive vs blocked vs dead) */}
            {effectiveLinkState === 'alive' && (
              <span
                data-testid="link-state-alive"
                title={asset.linkStateReasonAr || 'الرابط يعمل ومتاح'}
                className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-emerald-50 text-emerald-800 border-emerald-200"
              >
                الرابط يعمل ✓
              </span>
            )}
            {effectiveLinkState === 'blocked' && (
              <span
                data-testid="link-state-blocked"
                title={
                  asset.linkStateReasonAr ||
                  'الخادم واجه تحدياً (403/Captcha)؛ الرابط ليس معطلاً ويمكن فتحه في المتصفح'
                }
                className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-amber-50 text-amber-800 border-amber-200"
              >
                حجب خادم (403) • يعمل بالمتصفح
              </span>
            )}
            {effectiveLinkState === 'dead' && (
              <span
                data-testid="link-state-dead"
                title={asset.linkStateReasonAr || 'الرابط معطل (404 / غير موجود)'}
                className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-red-50 text-red-700 border-red-200"
              >
                رابط معطل (404)
              </span>
            )}
          </div>

          <h4
            onClick={() => onPreview(asset)}
            className="font-bold text-[#181B1A] text-sm line-clamp-2 leading-snug cursor-pointer hover:text-[#247C72] transition-colors mb-1"
          >
            {asset.title}
          </h4>

          {effectiveLinkState === 'dead' ? (
            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-md mb-1.5">
              <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
              <span>{asset.linkStateReasonAr || 'صفحة المنتج أو الفيديو غير متاحة (404)'}</span>
            </div>
          ) : asset.productListingUrl ? (
            <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
              <a
                href={asset.productListingUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#247C72] hover:underline max-w-[72%]"
                title={asset.productListingUrl}
              >
                <ExternalLink className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  {isTikTok && asset.productListingUrl.includes('tiktok.com')
                    ? 'فتح الفيديو على تيك توك'
                    : 'صفحة المنتج على أمازون'}
                </span>
              </a>
              <button
                type="button"
                onClick={handleReportDeadLink}
                title="الإبلاغ في حال كانت الصفحة المحولة إليها محذوفة (404)"
                className="text-[10px] text-slate-500 hover:text-red-600 hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded px-1.5 py-0.5 transition-colors cursor-pointer shrink-0"
              >
                إبلاغ عن 404
              </button>
            </div>
          ) : null}

          {asset.reviewerOrChannel && (
            <p className="text-xs text-[#616764] mb-1.5 truncate">
              {asset.reviewerOrChannel}
            </p>
          )}

          {/* Phase 2 Blind Observations Summary (if available) */}
          {asset.blindObservations && asset.blindObservations.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {asset.blindObservations.slice(0, 3).map((obs) => (
                <span
                  key={obs.discriminatorId}
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${
                    obs.observedStatus === 'present_match'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : obs.observedStatus === 'present_conflict'
                      ? 'bg-red-50 text-red-800 border-red-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                  title={`${obs.discriminatorName}: ${obs.observedValue}`}
                >
                  {obs.observedStatus === 'present_match'
                    ? '✓'
                    : obs.observedStatus === 'present_conflict'
                    ? '✗'
                    : '?'}{' '}
                  {obs.discriminatorName.slice(0, 26)}
                </span>
              ))}
            </div>
          )}

          {asset.downloadFailureReason && (
            <div
              data-testid="card-download-unavailable-reason"
              className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md mb-1.5 truncate"
              title={`تنزيل غير متاح: ${asset.downloadFailureReason}`}
            >
              تنزيل غير متاح: {asset.downloadFailureReason}
            </div>
          )}

          {/* Phase 5 Owner Feedback Loop Buttons on EVERY card */}
          {onOwnerFeedback && (
            <div
              data-testid="owner-feedback-bar"
              className="mt-2 pt-2 border-t border-dashed border-[#E2E5DF] flex items-center justify-between gap-1.5"
            >
              <span className="text-[10px] font-bold text-[#616764]">تقييم المالك:</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="btn-owner-same-product"
                  disabled={submittingFeedback !== null}
                  onClick={(e) => handleOwnerLabelClick(e, 'same_product')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                    isConfirmedByOwner
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                      : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-200'
                  }`}
                >
                  <ThumbsUp className="w-3 h-3" />
                  <span>✓ نفس المنتج</span>
                </button>
                <button
                  type="button"
                  data-testid="btn-owner-different-product"
                  disabled={submittingFeedback !== null}
                  onClick={(e) => handleOwnerLabelClick(e, 'different_product')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all cursor-pointer ${
                    isRejectedByOwner
                      ? 'bg-red-600 text-white border-red-600 shadow-xs'
                      : 'bg-red-50 hover:bg-red-100 text-red-800 border-red-200'
                  }`}
                >
                  <ThumbsDown className="w-3 h-3" />
                  <span>✗ مش المنتج</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Clean Footer Actions: Preview / Embed, Download, Source Link */}
        <div className="pt-3 border-t border-[#F0F2EE] flex items-center justify-between gap-2 mt-2">
          <button
            onClick={() => onPreview(asset)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-xs font-semibold transition-colors cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>{asset.downloadFailureReason || !isDownloaded ? 'عرض / Embed' : 'معاينة'}</span>
          </button>

          <div className="flex items-center gap-1.5">
            {isDownloaded && (
              <button
                onClick={handleSingleDownload}
                disabled={isDownloading}
                title="تنزيل"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#181B1A] text-xs font-semibold transition-colors cursor-pointer"
              >
                {isDownloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#247C72]" />
                ) : (
                  <Download className="w-3.5 h-3.5 text-[#247C72]" />
                )}
                <span>تنزيل</span>
              </button>
            )}

            {isFailed && (
              <button
                onClick={handleRetryDownload}
                disabled={isRetrying}
                title="إعادة محاولة التنزيل"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-semibold transition-colors cursor-pointer"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
                <span>إعادة</span>
              </button>
            )}

            <a
              href={asset.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="فتح المصدر"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#616764] hover:text-[#181B1A] text-xs font-medium transition-colors"
            >
              <span>المصدر</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
