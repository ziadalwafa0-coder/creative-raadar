import React, { useState, useEffect } from 'react';
import { Project, CandidateAsset, RejectedCandidateItem } from '../types/index.ts';
import { useApp } from '../context/AppContext.tsx';
import { AssetCard } from './AssetCard.tsx';
import { AssetPreviewModal } from './AssetPreviewModal.tsx';
import {
  Download,
  RotateCcw,
  Loader2,
  FolderOpen,
  Film,
  CheckSquare,
  Square,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';

interface Props {
  project: Project;
}

export const ResultsGallery: React.FC<Props> = ({ project }) => {
  const {
    showToast,
    refreshProjects,
    apiFetch,
    downloadWithSession,
    acceptRejectedCandidate,
    sessionId,
  } = useApp();

  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);
  const [isRetryingAllFailed, setIsRetryingAllFailed] = useState<boolean>(false);
  const [isBulkDownloadingMp4, setIsBulkDownloadingMp4] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [prepareZipStatus, setPrepareZipStatus] = useState<{
    running: boolean;
    readyCount: number;
    linkOnlyCount: number;
    failedCount: number;
    items: Array<{
      id: string;
      title: string;
      platform: string;
      status: string;
      fileName?: string;
      fileSizeBytes?: number;
      reason?: string;
      tier: string;
    }>;
  } | null>(null);
  const [platformFilter, setPlatformFilter] = useState<'all' | 'amazon' | 'tiktok'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showRejectedTray, setShowRejectedTray] = useState<boolean>(false);
  const [showUnverifiedByAi, setShowUnverifiedByAi] = useState<boolean>(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [prunedAssetIds, setPrunedAssetIds] = useState<Set<string>>(new Set());
  const [ownerOverridesMap, setOwnerOverridesMap] = useState<Map<string, Partial<CandidateAsset>>>(
    () => new Map()
  );
  const [ownerPrecisionBanner, setOwnerPrecisionBanner] = useState<{
    sameCount: number;
    differentCount: number;
    totalLabelled: number;
    precisionPercent: number;
    lastChangedCount: number;
    proposedThresholdChangeAr?: string;
  } | null>(null);
  const seenCandidateIdsRef = useState<Set<string>>(() => new Set())[0];

  const allCandidates = (project.candidates || [])
    .filter((c) => !prunedAssetIds.has(c.id))
    .map((c) => {
      const ov = ownerOverridesMap.get(c.id);
      return ov ? { ...c, ...ov } : c;
    });
  const rejectedCandidates = project.rejectedCandidates || [];

  // Phase 1 Rule 2 & 3: V1/V0 or dead link or owner-rejected items are NEVER counted as verified matches
  // and belong in the separate collapsed "غير متحقق" section (hidden by default).
  const isUnverifiedItem = (c: CandidateAsset) =>
    c.verifiedByAi === false ||
    c.matchCategory === 'insufficient_evidence' ||
    c.verdictTier === 'unverified' ||
    c.verdictTier === 'unrelated' ||
    c.evidenceLevel === 'V0' ||
    c.evidenceLevel === 'V1' ||
    c.linkState === 'dead' ||
    c.isDead === true ||
    c.ownerFeedback === 'different_product';

  const verifiedCandidates = allCandidates.filter((c) => !isUnverifiedItem(c));
  const unverifiedCandidates = allCandidates.filter((c) => isUnverifiedItem(c));
  const candidates = verifiedCandidates;

  const isAssetTikTok = (c: CandidateAsset) =>
    c.platform === 'tiktok' || Boolean(c.sourceUrl?.includes('tiktok.com'));

  const amazonCandidates = candidates.filter((c) => !isAssetTikTok(c));
  const tiktokCandidates = candidates.filter((c) => isAssetTikTok(c));

  const visibleCandidates =
    platformFilter === 'amazon'
      ? amazonCandidates
      : platformFilter === 'tiktok'
      ? tiktokCandidates
      : candidates;

  // Automatically select only AI-verified (V2/V3) candidates by default
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const c of verifiedCandidates) {
        if (!seenCandidateIdsRef.has(c.id)) {
          seenCandidateIdsRef.add(c.id);
          next.add(c.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [verifiedCandidates, seenCandidateIdsRef]);

  // Phase 5: Owner Feedback Handler ("✓ نفس المنتج" / "✗ مش المنتج")
  const handleOwnerFeedback = async (
    asset: CandidateAsset,
    label: 'same_product' | 'different_product'
  ) => {
    const referenceHash =
      project.identityCard?.imageHash ||
      project.breakdownSummary?.identityCard?.imageHash ||
      project.id;
    try {
      const res = await apiFetch('/api/feedback/owner-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          referenceHash,
          candidateId: asset.id,
          videoId: asset.id,
          platform: isAssetTikTok(asset) ? 'tiktok' : 'amazon',
          url: asset.sourceUrl || asset.mediaUrl,
          title: asset.title,
          label,
          previousTier: asset.verdictTier || 'exact',
          previousEvidenceLevel: asset.evidenceLevel || 'V2',
          extractedFrameUrls: asset.extractedFrameUrls || [],
          blindObservations: asset.blindObservations || [],
          currentCandidates: allCandidates.map((c) => ({
            id: c.id,
            videoId: c.id,
            title: c.title,
            url: c.sourceUrl || c.mediaUrl || '',
            verdictTier: (c.verdictTier as any) || 'exact',
            evidenceLevel: c.evidenceLevel || 'V2',
            matchScore: c.matchScore,
            ownerFeedback: c.id === asset.id ? label : c.ownerFeedback,
          })),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const nextMap = new Map(ownerOverridesMap);
        nextMap.set(asset.id, {
          ownerFeedback: label,
          verdictTier: label === 'different_product' ? 'unrelated' : asset.verdictTier,
          verifiedByAi: label === 'different_product' ? false : true,
        });

        if (Array.isArray(data.updatedCandidates)) {
          for (const upd of data.updatedCandidates) {
            if (upd.demotedByFeedback || upd.id === asset.id) {
              nextMap.set(upd.id, {
                ownerFeedback:
                  upd.id === asset.id
                    ? label
                    : upd.ownerFeedback || (upd.demotedByFeedback ? 'different_product' : undefined),
                verdictTier: upd.verdictTier,
                verifiedByAi: upd.verdictTier !== 'rejected' && upd.verdictTier !== 'unverified',
                userFacingMatchLabel: upd.feedbackReasonAr,
              });
            }
          }
        }
        setOwnerOverridesMap(nextMap);

        if (label === 'different_product') {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(asset.id);
            for (const demId of data.demotedIds || []) {
              next.delete(demId);
            }
            return next;
          });
        }

        if (data.precisionStats) {
          setOwnerPrecisionBanner({
            sameCount: data.precisionStats.sameProductCount || 0,
            differentCount: data.precisionStats.differentProductCount || 0,
            totalLabelled: data.precisionStats.totalLabelled || 1,
            precisionPercent: Math.round((data.precisionStats.overallPrecision || 0) * 100),
            lastChangedCount: data.changedCount || 1,
            proposedThresholdChangeAr: data.precisionStats.proposedThresholdChange?.reasonAr,
          });
        }

        showToast(
          label === 'same_product'
            ? `تم تسجيل "✓ نفس المنتج" وإعادة تقييم القائمة (${data.changedCount || 1} عنصر تأثر)`
            : `تم استبعاد العنصر والنتائج المشابهة له (${data.changedCount || 1} عنصر تأثر)`,
          label === 'same_product' ? 'success' : 'info'
        );
      }
    } catch {
      showToast('تعذر حفظ تقييم المالك', 'error');
    }
  };

  // Compute live precision from current cards if owner has labelled any
  const labelledCards = allCandidates.filter(
    (c) => c.ownerFeedback === 'same_product' || c.ownerFeedback === 'different_product'
  );
  const positiveLabelledCount = labelledCards.filter(
    (c) => c.ownerFeedback === 'same_product'
  ).length;
  const totalLabelledCount = ownerPrecisionBanner?.totalLabelled ?? labelledCards.length;
  const effectivePositiveCount = ownerPrecisionBanner?.sameCount ?? positiveLabelledCount;
  const effectivePrecisionPct =
    ownerPrecisionBanner?.precisionPercent ??
    (totalLabelledCount > 0 ? Math.round((effectivePositiveCount / totalLabelledCount) * 100) : 100);

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(candidates.map((c) => c.id)));
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleSelectPlatformOnly = (platform: 'amazon' | 'tiktok') => {
    const matching = candidates
      .filter((c) => (platform === 'tiktok' ? isAssetTikTok(c) : !isAssetTikTok(c)))
      .map((c) => c.id);
    setSelectedIds(new Set(matching));
  };

  const selectedCandidates =
    selectedIds.size > 0
      ? candidates.filter((c) => selectedIds.has(c.id))
      : candidates;

  const failedCount = candidates.filter((c) => c.downloadStatus === 'download_failed').length;
  const downloadableCandidates = selectedCandidates.filter((c) => {
    const targetUrl = c.downloadUrl || c.mediaUrl;
    return (
      c.downloadStatus === 'verified_available' ||
      (targetUrl && !targetUrl.includes('youtube.com') && !targetUrl.includes('youtu.be'))
    );
  });
  const videoCandidates = downloadableCandidates.filter((c) => c.mediaType === 'video');

  const isEphemeralProject = project.id.startsWith('ephemeral-');
  const rawSearchId = project.id.replace(/^ephemeral-/, '');
  const tokenParam = sessionId ? `&token=${encodeURIComponent(sessionId)}` : '';
  const exportZipHref = isEphemeralProject
    ? `/api/stream-search/export-zip?searchId=${encodeURIComponent(rawSearchId)}${tokenParam}`
    : `/api/projects/${encodeURIComponent(project.id)}/export?type=all${tokenParam}`;

  // Keep server's recentSearchResults synced with current UI selected candidates
  useEffect(() => {
    if (!isEphemeralProject || selectedCandidates.length === 0) return;
    apiFetch('/api/stream-search/prepare-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchId: rawSearchId,
        productName: project.name,
        assets: selectedCandidates,
      }),
    }).catch(() => {});
  }, [isEphemeralProject, rawSearchId, project.name, selectedCandidates.length]);

  const handleExportZipClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (isExportingZip || selectedCandidates.length === 0) return;

    setIsExportingZip(true);
    setPrepareZipStatus({
      running: true,
      readyCount: 0,
      linkOnlyCount: 0,
      failedCount: 0,
      items: selectedCandidates.map((c) => ({
        id: c.id,
        title: c.title,
        platform: c.platform || 'amazon',
        status: 'pending',
        tier: c.verdictTier || c.matchCategory || 'exact',
      })),
    });

    showToast(
      `جاري تجهيز الملفات والتحقق من صلاحيتها لعدد ${selectedCandidates.length} عنصر محدد...`,
      'info'
    );

    try {
      const prepRes = await apiFetch('/api/stream-search/prepare-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId: rawSearchId || project.id,
          productName: project.name,
          assets: selectedCandidates,
          verifyDownloads: true,
        }),
      });

      if (prepRes.ok) {
        const prepData = await prepRes.json();
        setPrepareZipStatus({
          running: false,
          readyCount: prepData.readyCount || 0,
          linkOnlyCount: prepData.linkOnlyCount || 0,
          failedCount: prepData.failedCount || 0,
          items: prepData.items || [],
        });

        if ((prepData.readyCount || 0) === 0 && (prepData.linkOnlyCount || 0) === 0) {
          showToast('لا توجد ملفات أو روابط صالحة للتصدير في العناصر المحددة', 'error');
          return;
        }
      }

      const safeZipName = `${(project.name || 'Creative_Radaar_Export')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 36) || 'Creative_Radaar_Export'}_${new Date().toISOString().split('T')[0]}.zip`;

      const ok = await downloadWithSession(exportZipHref, safeZipName);
      if (ok) {
        showToast('تم تجهيز وتنزيل حزمة (.ZIP) بنجاح مع manifest.csv و links.txt', 'success');
      }
    } finally {
      setIsExportingZip(false);
    }
  };

  const handleRetryFailed = async () => {
    const failedAssets = candidates.filter((c) => c.downloadStatus === 'download_failed');
    if (failedAssets.length === 0) return;

    setIsRetryingAllFailed(true);
    showToast(`جاري إعادة محاولة تنزيل ${failedAssets.length} ملف...`, 'info');

    try {
      for (const asset of failedAssets) {
        await apiFetch(`/api/projects/${project.id}/assets/${asset.id}/retry`, { method: 'POST' });
      }
      await refreshProjects();
      showToast('اكتملت إعادة محاولة التنزيل', 'success');
    } catch {
      showToast('حدث خطأ أثناء إعادة المحاولة', 'error');
    } finally {
      setIsRetryingAllFailed(false);
    }
  };

  const handleBulkDownloadVideos = async () => {
    if (videoCandidates.length === 0) {
      showToast('لا توجد فيديوهات محددة متاحة للتنزيل المباشر', 'warn');
      return;
    }

    setIsBulkDownloadingMp4(true);
    showToast(`جاري بدء تنزيل ${videoCandidates.length} فيديو محدد مباشرة من الخادم...`, 'info');

    try {
      for (let i = 0; i < videoCandidates.length; i++) {
        const asset = videoCandidates[i];
        const targetUrl = asset.downloadUrl || asset.mediaUrl;
        const isEphemeral =
          !asset.projectId ||
          asset.projectId.startsWith('ephemeral-') ||
          isEphemeralProject;
        const dlUrl =
          isEphemeral && targetUrl
            ? `/api/stream-search/download?url=${encodeURIComponent(
                targetUrl
              )}&type=${asset.mediaType}&title=${encodeURIComponent(asset.title || asset.id)}${tokenParam}`
            : `/api/projects/${project.id}/assets/${asset.id}/download${sessionId ? `?token=${encodeURIComponent(sessionId)}` : ''}`;

        await downloadWithSession(dlUrl, `${asset.id}_video_${i + 1}.mp4`);
      }
      showToast(`اكتمل تنزيل ${videoCandidates.length} فيديو`, 'success');
    } finally {
      setIsBulkDownloadingMp4(false);
    }
  };

  const handleAcceptRejected = async (item: RejectedCandidateItem) => {
    setAcceptingId(item.id);
    try {
      await acceptRejectedCandidate(item);
    } finally {
      setAcceptingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Phase 5.3: Live Owner Precision Banner */}
      {(totalLabelledCount > 0 || allCandidates.length > 0) && (
        <div
          data-testid="owner-precision-banner"
          className="bg-[#FAFBF9] rounded-2xl border border-[#E2E5DF] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 text-xs font-bold text-[#181B1A]">
            <ShieldCheck className="w-4 h-4 text-[#247C72]" />
            <span>
              دقة النتائج حسب تقييمك:{' '}
              <span className="text-[#247C72] tabular-nums">
                {effectivePositiveCount} من {totalLabelledCount}
              </span>{' '}
              {totalLabelledCount > 0 && (
                <span className="text-[#616764] font-mono">({effectivePrecisionPct}%)</span>
              )}
            </span>
            {ownerPrecisionBanner && ownerPrecisionBanner.lastChangedCount > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200">
                تأثر بآخر تقييم: {ownerPrecisionBanner.lastChangedCount} عنصر
              </span>
            )}
          </div>
          {ownerPrecisionBanner?.proposedThresholdChangeAr ? (
            <div className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg">
              اقتراح ضبط العتبات (بعد &ge;20 تقييم): {ownerPrecisionBanner.proposedThresholdChangeAr}
            </div>
          ) : (
            <div className="text-[11px] text-[#616764]">
              استخدم «✓ نفس المنتج» أو «✗ مش المنتج» على أي بطاقة لتحديث الترتيب واستبعاد المتشابهات الخاطئة فوراً
            </div>
          )}
        </div>
      )}

      {/* Phase 3.2: Visible "تجهيز الملفات" (Prepare Files before ZIP) Status Panel */}
      {prepareZipStatus && (
        <div
          data-testid="prepare-zip-status-panel"
          className="bg-slate-900 text-slate-100 rounded-2xl border border-slate-700 p-4 space-y-2.5"
          dir="rtl"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {prepareZipStatus.running ? (
                <Loader2 className="w-4 h-4 text-teal-400 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              )}
              <span className="text-xs font-bold text-white">
                تجهيز الملفات للحزمة (.ZIP) — جاهز كملف MP4: {prepareZipStatus.readyCount} | رابط ومضمن (link_only): {prepareZipStatus.linkOnlyCount} | فشل: {prepareZipStatus.failedCount}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPrepareZipStatus(null)}
              className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
            >
              إخفاء
            </button>
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 text-[11px]">
            {prepareZipStatus.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 bg-slate-800/80 px-2.5 py-1.5 rounded border border-slate-700"
              >
                <span className="truncate text-slate-200 max-w-md" title={item.title}>
                  [{item.platform}] {item.title}
                </span>
                <div className="flex items-center gap-2 shrink-0 font-mono">
                  {item.fileName && (
                    <span className="text-teal-300 text-[10px]">
                      {item.fileName} ({Math.round((item.fileSizeBytes || 0) / 1024)} KB)
                    </span>
                  )}
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      item.status === 'ready'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                        : item.status === 'pending'
                        ? 'bg-slate-700 text-slate-300'
                        : item.status === 'link_only'
                        ? 'bg-amber-950 text-amber-300 border border-amber-700'
                        : 'bg-red-950 text-red-300 border border-red-700'
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Clean Action & Platform Selection Bar */}
      {allCandidates.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-semibold text-[#616764]">
                إجمالي النتائج المؤكدة بصرياً (V2/V3):{' '}
                <span className="text-[#181B1A] font-bold tabular-nums">{verifiedCandidates.length}</span>
              </div>
              <span className="text-[#E2E5DF]">•</span>
              <div className="text-xs font-semibold text-[#247C72]">
                المحدد للتصدير: <span className="font-bold tabular-nums">{selectedIds.size}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {failedCount > 0 && (
                <button
                  onClick={handleRetryFailed}
                  disabled={isRetryingAllFailed}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-semibold transition-colors cursor-pointer"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isRetryingAllFailed ? 'animate-spin' : ''}`} />
                  <span>إعادة محاولة الفاشلة ({failedCount})</span>
                </button>
              )}

              {videoCandidates.length > 0 && (
                <button
                  onClick={handleBulkDownloadVideos}
                  disabled={isBulkDownloadingMp4}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#247C72]/30 bg-[#EAF3F2] hover:bg-[#DCECE9] disabled:opacity-60 text-[#247C72] text-xs font-semibold transition-colors cursor-pointer"
                >
                  {isBulkDownloadingMp4 ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Film className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {selectedIds.size > 0 && selectedIds.size < candidates.length
                      ? `تنزيل الفيديوهات المحددة (${videoCandidates.length})`
                      : `تنزيل كل الفيديوهات (${videoCandidates.length})`}
                  </span>
                </button>
              )}

              <a
                href={exportZipHref}
                download
                onClick={handleExportZipClick}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#247C72] hover:bg-[#1E665E] text-white text-xs font-semibold transition-colors cursor-pointer ${
                  isExportingZip ? 'opacity-70 pointer-events-none' : ''
                }`}
              >
                {isExportingZip ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>
                  {isExportingZip
                    ? 'جاري تجهيز (.ZIP)...'
                    : selectedIds.size > 0 && selectedIds.size < candidates.length
                    ? `تنزيل المحدد (.ZIP) (${selectedCandidates.length})`
                    : 'تنزيل الكل (.ZIP)'}
                </span>
              </a>
            </div>
          </div>

          {/* Platform Filter & Quick Selection Controls */}
          <div className="pt-2.5 border-t border-[#F0F2EE] flex flex-wrap items-center justify-between gap-2">
            {/* Filter by Platform */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-semibold text-[#616764] ml-1">عرض المنصة:</span>
              <button
                type="button"
                onClick={() => setPlatformFilter('all')}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors cursor-pointer tabular-nums ${
                  platformFilter === 'all'
                    ? 'bg-[#247C72] text-white border-[#247C72]'
                    : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                }`}
              >
                الكل ({candidates.length})
              </button>
              <button
                type="button"
                onClick={() => setPlatformFilter('amazon')}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors cursor-pointer tabular-nums ${
                  platformFilter === 'amazon'
                    ? 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]'
                    : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                }`}
              >
                أمازون • Amazon ({amazonCandidates.length})
              </button>
              <button
                type="button"
                onClick={() => setPlatformFilter('tiktok')}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors cursor-pointer tabular-nums ${
                  platformFilter === 'tiktok'
                    ? 'bg-[#181B1A] text-white border-[#181B1A]'
                    : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                }`}
              >
                تيك توك • TikTok ({tiktokCandidates.length})
              </button>
            </div>

            {/* Quick Select by Platform */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={handleSelectAll}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-[#FAFBF9] hover:bg-[#EAF3F2] text-[#181B1A] border border-[#E2E5DF] transition-colors cursor-pointer"
              >
                <CheckSquare className="w-3 h-3 text-[#247C72]" />
                <span>تحديد الكل للتصدير</span>
              </button>
              {amazonCandidates.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleSelectPlatformOnly('amazon')}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-[#FAFBF9] hover:bg-[#EAF3F2] text-[#247C72] border border-[#E2E5DF] transition-colors cursor-pointer tabular-nums"
                >
                  تحديد أمازون فقط ({amazonCandidates.length})
                </button>
              )}
              {tiktokCandidates.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleSelectPlatformOnly('tiktok')}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-[#FAFBF9] hover:bg-slate-100 text-[#181B1A] border border-[#E2E5DF] transition-colors cursor-pointer tabular-nums"
                >
                  تحديد تيك توك فقط ({tiktokCandidates.length})
                </button>
              )}
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-[#FAFBF9] hover:bg-red-50 text-[#616764] hover:text-red-600 border border-[#E2E5DF] transition-colors cursor-pointer"
                >
                  <Square className="w-3 h-3" />
                  <span>إلغاء التحديد</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmed Results Grid (V2/V3 Only) */}
      {visibleCandidates.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visibleCandidates.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              isSelected={selectedIds.has(asset.id)}
              onToggleSelect={handleToggleSelect}
              onPreview={(a) => setPreviewingAsset(a)}
              onReportDead={(id) => setPrunedAssetIds((prev) => new Set([...prev, id]))}
              onOwnerFeedback={handleOwnerFeedback}
            />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] p-10 text-center">
          <div className="w-11 h-11 rounded-xl bg-[#F6F7F4] text-[#616764] flex items-center justify-center mx-auto mb-3">
            <FolderOpen className="w-5 h-5" />
          </div>
          <h4 className="font-bold text-[#181B1A] text-sm mb-1">
            {candidates.length > 0
              ? 'لا توجد فيديوهات ضمن تصفية هذه المنصة'
              : 'لا توجد نتائج مؤكدة بصرياً (V2/V3) حتى الآن'}
          </h4>
          <p className="text-xs text-[#616764] max-w-sm mx-auto">
            {candidates.length > 0
              ? 'يمكنك التبديل إلى "الكل" بالأعلى لعرض جميع الفيديوهات المستخرجة.'
              : 'الدقة قبل العدد: لا يتم عرض أي نتيجة كـ "مطابق" ما لم يثبت ظهور المنتج في الإطارات.'}
          </p>
        </div>
      )}

      {/* Phase 1.2: Collapsed Section for Unverified (V1/V0) or Owner-Demoted Items (Hidden by Default) */}
      {unverifiedCandidates.length > 0 && (
        <div
          data-testid="unverified-collapsed-section"
          className="bg-white rounded-2xl border border-amber-200 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setShowUnverifiedByAi(!showUnverifiedByAi)}
            className="w-full px-4 py-3 bg-amber-50/70 hover:bg-amber-50 flex items-center justify-between gap-2 text-right cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <div>
                <div className="text-xs font-bold text-amber-950">
                  عناصر غير متحققة بصرياً (V1/V0 أو مستبعدة) — ({unverifiedCandidates.length} عنصر)
                </div>
                <div className="text-[11px] text-amber-800">
                  مخفية افتراضياً ولا تُحتسب إطلاقاً ضمن العدد المطلوب لأن الدليل نصي فقط أو غير كافٍ
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-xs font-bold text-amber-900">
              <span>{showUnverifiedByAi ? 'إخفاء' : 'عرض العناصر غير المتحققة'}</span>
              {showUnverifiedByAi ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showUnverifiedByAi && (
            <div className="p-4 border-t border-amber-200 grid grid-cols-1 sm:grid-cols-2 gap-4 bg-amber-50/20">
              {unverifiedCandidates.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  isSelected={false}
                  onPreview={(a) => setPreviewingAsset(a)}
                  onReportDead={(id) => setPrunedAssetIds((prev) => new Set([...prev, id]))}
                  onOwnerFeedback={handleOwnerFeedback}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Phase 1.8 & Phase 6: Rejection Audit View (15-item random sample + >40% override warning) */}
      {rejectedCandidates.length > 0 && (
        <RejectionAuditSection
          project={project}
          rejectedCandidates={rejectedCandidates}
          showRejectedTray={showRejectedTray}
          setShowRejectedTray={setShowRejectedTray}
          acceptingId={acceptingId}
          onAcceptRejected={handleAcceptRejected}
          apiFetch={apiFetch}
          showToast={showToast}
        />
      )}

      {/* Detail Preview Modal */}
      <AssetPreviewModal
        asset={previewingAsset}
        onClose={() => setPreviewingAsset(null)}
      />
    </div>
  );
};

interface RejectionAuditProps {
  project: Project;
  rejectedCandidates: RejectedCandidateItem[];
  showRejectedTray: boolean;
  setShowRejectedTray: (v: boolean) => void;
  acceptingId: string | null;
  onAcceptRejected: (item: RejectedCandidateItem) => Promise<void>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  showToast: (msg: string, type?: 'info' | 'success' | 'warn' | 'error') => void;
}

const RejectionAuditSection: React.FC<RejectionAuditProps> = ({
  project,
  rejectedCandidates,
  showRejectedTray,
  setShowRejectedTray,
  acceptingId,
  onAcceptRejected,
  apiFetch,
  showToast,
}) => {
  const [auditMode, setAuditMode] = useState<'sample15' | 'all'>('sample15');
  const [sampleSeed, setSampleSeed] = useState<number>(1);
  const [relaxedAttributes, setRelaxedAttributes] = useState<Set<string>>(new Set());

  // Compute deterministic random sample of 15 items based on sampleSeed
  const sampledRejected = React.useMemo(() => {
    if (auditMode === 'all' || rejectedCandidates.length <= 15) {
      return rejectedCandidates;
    }
    const copy = [...rejectedCandidates];
    let s = sampleSeed * 9301 + 49297;
    for (let i = copy.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      const j = Math.floor((s / 233280) * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, 15);
  }, [rejectedCandidates, auditMode, sampleSeed]);

  // Compute live override stats per reason code / attribute (>40% threshold warning)
  const liveWarnings = React.useMemo(() => {
    const byReason = new Map<string, { total: number; overridden: number; attr?: string }>();
    for (const item of rejectedCandidates) {
      const code =
        item.reasonCode ||
        (item.failedAttribute ? `rejected_hard_attribute:${item.failedAttribute}` : 'rejected_other_type');
      const cur = byReason.get(code) || { total: 0, overridden: 0, attr: item.failedAttribute };
      cur.total += 1;
      if (item.acceptedByUser) cur.overridden += 1;
      byReason.set(code, cur);
    }

    const warnings: Array<{
      reasonCode: string;
      attributeName?: string;
      totalRejected: number;
      overriddenCount: number;
      overrideRate: number;
      warningAr: string;
    }> = (project.breakdownSummary?.overrideWarnings || []).map((w) => ({
      reasonCode: w.reasonCode,
      attributeName: w.reasonCode.startsWith('rejected_hard_attribute:')
        ? w.reasonCode.replace('rejected_hard_attribute:', '')
        : undefined,
      totalRejected: w.totalRejected,
      overriddenCount: w.overriddenCount,
      overrideRate: w.overrideRatio,
      warningAr: w.warningAr,
    }));

    for (const [code, stats] of byReason.entries()) {
      if (stats.overridden >= 1 && stats.total >= 1) {
        const rate = stats.overridden / stats.total;
        if (rate > 0.4 && !warnings.some((w) => w.reasonCode === code)) {
          warnings.push({
            reasonCode: code,
            attributeName: stats.attr,
            totalRejected: stats.total,
            overriddenCount: stats.overridden,
            overrideRate: Number(rate.toFixed(2)),
            warningAr: `هذا الشرط ربما صارم أكثر من اللازم (${code}): تم قبول ${stats.overridden} من أصل ${stats.total} (${Math.round(rate * 100)}%). يُقترح تخفيفه إلى مرن (SOFT) أو تجاهله.`,
          });
        }
      }
    }
    return warnings;
  }, [rejectedCandidates, project.breakdownSummary?.overrideWarnings]);

  const handleRelaxAttribute = async (attrName: string) => {
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attributeStrengthOverrides: { [attrName]: 'SOFT' },
        }),
      });
      if (project.identityCard?.imageHash) {
        await apiFetch('/api/gemini/identity', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageHash: project.identityCard.imageHash,
            attributeStrengths: {
              ...(project.identityCard.attributeStrengths || {}),
              [attrName]: 'SOFT',
            },
          }),
        });
      }
      setRelaxedAttributes((prev) => new Set([...prev, attrName]));
      showToast(`تم تخفيف الشرط "${attrName}" من HARD إلى SOFT بنجاح`, 'success');
    } catch {
      showToast('تعذر تخفيف الشرط', 'error');
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-[#E2E5DF] overflow-hidden">
      <div className="px-4 py-3 bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setShowRejectedTray(!showRejectedTray)}
          className="flex items-center gap-2 text-right cursor-pointer"
        >
          <span className="w-7 h-7 rounded-lg bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
            <Ban className="w-4 h-4" />
          </span>
          <div>
            <div className="text-xs font-bold text-[#181B1A]">
              تدقيق المرفوضات (Rejection Audit — عينة عشوائية من 15 منتجاً من أصل {rejectedCandidates.length} مرفوض)
            </div>
            <div className="text-[11px] text-[#616764]">
              راجع أسباب الرفض والشرط الذي فشل؛ الضغط على «اقبل» يتجاوز الرفض وينبهك إذا كان الشرط صارماً أكثر من اللازم (&gt;40%)
            </div>
          </div>
        </button>

        <div className="flex items-center gap-2 flex-wrap">
          {showRejectedTray && rejectedCandidates.length > 15 && (
            <>
              <button
                type="button"
                onClick={() => {
                  setAuditMode('sample15');
                  setSampleSeed((s) => s + 1);
                }}
                className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border cursor-pointer ${
                  auditMode === 'sample15'
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-slate-700 border-slate-200'
                }`}
              >
                عينة عشوائية (15 عنصر) ↻
              </button>
              <button
                type="button"
                onClick={() => setAuditMode('all')}
                className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border cursor-pointer ${
                  auditMode === 'all'
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-slate-700 border-slate-200'
                }`}
              >
                عرض الكل ({rejectedCandidates.length})
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowRejectedTray(!showRejectedTray)}
            className="flex items-center gap-1 text-xs font-semibold text-[#247C72] cursor-pointer"
          >
            <span>{showRejectedTray ? 'إخفاء' : 'فتح تدقيق المرفوضات'}</span>
            {showRejectedTray ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Warning banner when >40% of items from one reason/attribute are overridden */}
      {liveWarnings.length > 0 && (
        <div className="px-4 py-2.5 bg-amber-50 border-t border-amber-200 space-y-1.5">
          {liveWarnings.map((w) => (
            <div
              key={w.reasonCode}
              data-testid="strictness-override-warning"
              className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-amber-950"
            >
              <span>⚠️ {w.warningAr}</span>
              {w.attributeName && !relaxedAttributes.has(w.attributeName) && (
                <button
                  type="button"
                  onClick={() => handleRelaxAttribute(w.attributeName!)}
                  className="px-2.5 py-1 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-bold cursor-pointer"
                >
                  تخفيف الشرط &ldquo;{w.attributeName}&rdquo; إلى مرن (SOFT)
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showRejectedTray && (
        <div className="p-4 border-t border-[#E2E5DF] grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[520px] overflow-y-auto">
          {sampledRejected.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] p-3 flex items-start gap-3 justify-between"
            >
              <div className="flex items-start gap-3 min-w-0">
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.title}
                    className="w-14 h-14 rounded-lg object-cover border border-[#E2E5DF] bg-white shrink-0"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 text-[10px] shrink-0">
                    بدون صورة
                  </div>
                )}
                <div className="min-w-0 space-y-1">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold text-[#181B1A] hover:text-[#247C72] line-clamp-1 inline-flex items-center gap-1"
                    title={item.title}
                  >
                    <span className="truncate">{item.title}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                  <div className="flex flex-wrap items-center gap-1">
                    {item.reasonCode && (
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-800">
                        {item.reasonCode}
                      </span>
                    )}
                    {item.evidenceLevel && (
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-white">
                        {item.evidenceLevel}
                      </span>
                    )}
                    {item.failedAttribute && (
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                        الشرط الفاشل: {item.failedAttribute}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-semibold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-md inline-block">
                    {item.reasonAr}
                  </div>
                  {item.mustNotBeHit && item.mustNotBeHit.length > 0 && (
                    <div className="text-[10px] text-[#616764]" dir="ltr">
                      MustNotBe hit: {item.mustNotBeHit.join(', ')}
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0">
                {item.acceptedByUser ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>تم القبول</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={acceptingId === item.id}
                    onClick={() => onAcceptRejected(item)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white text-xs font-bold transition-colors cursor-pointer"
                  >
                    {acceptingId === item.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    <span>اقبل</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
