import React, { useState, useEffect } from 'react';
import { Project, CandidateAsset } from '../types/index.ts';
import { useApp } from '../context/AppContext.tsx';
import { AssetCard } from './AssetCard.tsx';
import { AssetPreviewModal } from './AssetPreviewModal.tsx';
import { Download, RotateCcw, Loader2, FolderOpen, Film } from 'lucide-react';

interface Props {
  project: Project;
}

export const ResultsGallery: React.FC<Props> = ({ project }) => {
  const { showToast, refreshProjects, apiFetch, downloadWithSession, sessionId } = useApp();

  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);
  const [isRetryingAllFailed, setIsRetryingAllFailed] = useState<boolean>(false);
  const [isBulkDownloadingMp4, setIsBulkDownloadingMp4] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);

  const candidates = project.candidates || [];
  const failedCount = candidates.filter((c) => c.downloadStatus === 'download_failed').length;
  const downloadableCandidates = candidates.filter((c) => {
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

  // Keep server's recentSearchResults synced with current UI candidates (survives server restarts)
  useEffect(() => {
    if (!isEphemeralProject || candidates.length === 0) return;
    apiFetch('/api/stream-search/prepare-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchId: rawSearchId,
        productName: project.name,
        assets: candidates,
      }),
    }).catch(() => {});
  }, [isEphemeralProject, rawSearchId, project.name, candidates.length]);

  const handleExportZipClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (isExportingZip || candidates.length === 0) return;

    setIsExportingZip(true);
    showToast('جاري تجهيز وتنزيل حزمة (.ZIP) مباشرة من الخادم...', 'info');

    try {
      if (isEphemeralProject) {
        await apiFetch('/api/stream-search/prepare-zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchId: rawSearchId,
            productName: project.name,
            assets: candidates,
          }),
        }).catch(() => {});
      }

      const safeZipName = `${(project.name || 'Creative_Radaar_Export')
        .replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_')
        .slice(0, 40)}_${new Date().toISOString().split('T')[0]}.zip`;

      const ok = await downloadWithSession(exportZipHref, safeZipName);
      if (ok) {
        showToast('تم تنزيل حزمة (.ZIP) بنجاح', 'success');
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
      showToast('لا توجد فيديوهات متاحة للتنزيل المباشر', 'warn');
      return;
    }

    setIsBulkDownloadingMp4(true);
    showToast(`جاري بدء تنزيل ${videoCandidates.length} فيديو مباشرة من الخادم...`, 'info');

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

  return (
    <div className="space-y-4">
      {/* Clean Action Bar */}
      {candidates.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold text-[#616764]">
            إجمالي النتائج: <span className="text-[#181B1A] font-bold">{candidates.length}</span>
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

            {videoCandidates.length > 1 && (
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
                <span>تنزيل كل الفيديوهات ({videoCandidates.length})</span>
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
              <span>{isExportingZip ? 'جاري تجهيز (.ZIP)...' : 'تنزيل الكل (.ZIP)'}</span>
            </a>
          </div>
        </div>
      )}

      {/* Results Grid */}
      {candidates.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {candidates.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onPreview={(a) => setPreviewingAsset(a)}
            />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] p-10 text-center">
          <div className="w-11 h-11 rounded-xl bg-[#F6F7F4] text-[#616764] flex items-center justify-center mx-auto mb-3">
            <FolderOpen className="w-5 h-5" />
          </div>
          <h4 className="font-bold text-[#181B1A] text-sm mb-1">
            لا توجد نتائج متاحة حتى الآن
          </h4>
          <p className="text-xs text-[#616764] max-w-sm mx-auto">
            تظهر الفيديوهات والصور هنا فور اكتمال استخراجها، أو يمكنك فتح التفاصيل لإضافة رابط مباشر.
          </p>
        </div>
      )}

      {/* Detail Preview Modal */}
      <AssetPreviewModal
        asset={previewingAsset}
        onClose={() => setPreviewingAsset(null)}
      />
    </div>
  );
};
