import React, { useEffect, useState } from 'react';
import { CandidateAsset } from '../types/index.ts';
import { useApp } from '../context/AppContext.tsx';
import { getProvenanceLabel } from '../utils/rules.ts';
import { X, ExternalLink, Download, Loader2 } from 'lucide-react';

interface Props {
  asset: CandidateAsset | null;
  onClose: () => void;
}

export const AssetPreviewModal: React.FC<Props> = ({ asset, onClose }) => {
  const { lang, apiFetch, downloadWithSession } = useApp();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    let currentObjectUrl: string | null = null;

    if (!asset) {
      setBlobUrl(null);
      return;
    }

    if (asset.downloadStatus === 'verified_available') {
      setIsLoadingMedia(true);
      apiFetch(`/api/projects/${asset.projectId}/assets/${asset.id}/download?inline=1`)
        .then(async (res) => {
          if (!res.ok) throw new Error('Failed to load inline media');
          const contentType = (res.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json')) {
            throw new Error('JSON error instead of media');
          }
          const blob = await res.blob();
          if (!active) return;
          currentObjectUrl = URL.createObjectURL(blob);
          setBlobUrl(currentObjectUrl);
        })
        .catch(() => {
          if (active) setBlobUrl(null);
        })
        .finally(() => {
          if (active) setIsLoadingMedia(false);
        });
    } else {
      setBlobUrl(null);
    }

    return () => {
      active = false;
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
      }
    };
  }, [asset?.id, asset?.projectId, asset?.downloadStatus]);

  if (!asset) return null;

  const provInfo = getProvenanceLabel(asset.provenance, lang);
  const isVideo = asset.mediaType === 'video';
  const isDownloaded = asset.downloadStatus === 'verified_available';
  const effectiveSrc = blobUrl || asset.mediaUrl || asset.thumbnailUrl;

  const handleDownloadSingle = async () => {
    setIsDownloading(true);
    try {
      const ext = isVideo ? 'mp4' : 'jpg';
      await downloadWithSession(
        `/api/projects/${asset.projectId}/assets/${asset.id}/download`,
        `${asset.id}_verified.${ext}`
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-[#E2E5DF] max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E5DF] bg-[#FAFBF9]">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-md border shrink-0 ${provInfo.badge}`}>
              {provInfo.label}
            </span>
            <h3 className="text-sm font-bold text-[#181B1A] truncate">
              {asset.title}
            </h3>
          </div>

          <button
            onClick={onClose}
            className="text-[#616764] hover:text-[#181B1A] p-1.5 rounded-lg hover:bg-[#F6F7F4] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Media Player */}
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="relative rounded-xl overflow-hidden bg-black aspect-video flex items-center justify-center">
            {isLoadingMedia ? (
              <div className="flex flex-col items-center gap-2 text-white text-xs">
                <Loader2 className="w-6 h-6 animate-spin text-[#56B3A8]" />
                <span>جاري تحميل المعاينة...</span>
              </div>
            ) : isVideo ? (
              <video
                key={effectiveSrc}
                src={effectiveSrc}
                poster={asset.thumbnailUrl}
                controls
                className="w-full h-full object-contain"
                autoPlay
                playsInline
              >
                متصفحك لا يدعم تشغيل هذا الفيديو مباشرة.
              </video>
            ) : (
              <img
                src={effectiveSrc}
                alt={asset.title}
                className="w-full h-full object-contain"
              />
            )}
          </div>

          {/* Actions Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2">
              {isDownloaded && (
                <button
                  onClick={handleDownloadSingle}
                  disabled={isDownloading}
                  className="inline-flex items-center gap-1.5 py-2 px-4 rounded-xl bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white font-semibold text-xs transition-colors cursor-pointer"
                >
                  {isDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  <span>تنزيل الملف</span>
                </button>
              )}

              <a
                href={asset.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-xl border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#181B1A] text-xs font-semibold transition-colors"
              >
                <span>فتح المصدر</span>
                <ExternalLink className="w-3.5 h-3.5 text-[#616764]" />
              </a>

              {asset.productListingUrl && asset.productListingUrl !== asset.sourceUrl && (
                <a
                  href={asset.productListingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-xl border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#181B1A] text-xs font-semibold transition-colors"
                >
                  <span>صفحة المنتج</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#616764]" />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
