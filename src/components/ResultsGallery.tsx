import React, { useState } from 'react';
import { Project, CandidateAsset } from '../types/index.ts';
import { useApp } from '../context/AppContext.tsx';
import { AssetCard } from './AssetCard.tsx';
import { AssetPreviewModal } from './AssetPreviewModal.tsx';
import { Download, RotateCcw, Loader2, FolderOpen } from 'lucide-react';

interface Props {
  project: Project;
}

export const ResultsGallery: React.FC<Props> = ({ project }) => {
  const { showToast, refreshProjects, apiFetch, downloadWithSession } = useApp();

  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);
  const [isRetryingAllFailed, setIsRetryingAllFailed] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const candidates = project.candidates || [];
  const failedCount = candidates.filter((c) => c.downloadStatus === 'download_failed').length;

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

  const handleExportZip = async () => {
    if (candidates.length === 0) {
      showToast('لا توجد نتائج لتنزيلها بعد', 'warn');
      return;
    }

    setIsExporting(true);
    showToast('جاري تجهيز وتنزيل الحزمة (.ZIP)...', 'info');
    try {
      const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_');
      const ok = await downloadWithSession(
        `/api/projects/${project.id}/export?type=all`,
        `Creative_Radaar_${safeName}.zip`
      );
      if (ok) {
        showToast('تم تنزيل الحزمة (.ZIP) بنجاح', 'success');
      }
    } finally {
      setIsExporting(false);
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

          <div className="flex items-center gap-2">
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

            <button
              onClick={handleExportZip}
              disabled={isExporting}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              {isExporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>تنزيل الكل (.ZIP)</span>
            </button>
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
