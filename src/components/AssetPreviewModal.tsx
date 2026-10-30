import React, { useState } from 'react';
import { CandidateAsset } from '../types/index.ts';
import { useApp } from '../context/AppContext.tsx';
import { getProvenanceLabel } from '../utils/rules.ts';
import { X, ExternalLink, Download, Loader2 } from 'lucide-react';

interface Props {
  asset: CandidateAsset | null;
  onClose: () => void;
}

export const AssetPreviewModal: React.FC<Props> = ({ asset, onClose }) => {
  const { lang, downloadWithSession, sessionId } = useApp();
  const [isDownloading, setIsDownloading] = useState(false);

  if (!asset) return null;

  const provInfo = getProvenanceLabel(asset.provenance, lang);
  const isVideo = asset.mediaType === 'video';
  const targetMediaUrl = asset.downloadUrl || asset.mediaUrl;
  const isDownloaded =
    asset.downloadStatus === 'verified_available' ||
    (Boolean(targetMediaUrl) &&
      !targetMediaUrl?.includes('youtube.com') &&
      !targetMediaUrl?.includes('youtu.be'));

  const isEphemeral = !asset.projectId || asset.projectId.startsWith('ephemeral-');
  const tokenParam = sessionId ? `&token=${encodeURIComponent(sessionId)}` : '';
  const streamPreviewSrc =
    isEphemeral && targetMediaUrl
      ? `/api/stream-search/download?url=${encodeURIComponent(targetMediaUrl)}&type=${asset.mediaType}&inline=1${tokenParam}`
      : !isEphemeral && asset.projectId
      ? `/api/projects/${asset.projectId}/assets/${asset.id}/download?inline=1${tokenParam}`
      : targetMediaUrl || asset.thumbnailUrl;

  const handleDownloadSingle = async () => {
    setIsDownloading(true);
    try {
      const ext = isVideo ? 'mp4' : 'jpg';
      const fallbackFilename = `${asset.id}_verified.${ext}`;
      const dlUrl =
        isEphemeral && targetMediaUrl
          ? `/api/stream-search/download?url=${encodeURIComponent(
              targetMediaUrl
            )}&type=${asset.mediaType}&title=${encodeURIComponent(asset.title || asset.id)}`
          : `/api/projects/${asset.projectId}/assets/${asset.id}/download`;
      await downloadWithSession(dlUrl, fallbackFilename);
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
            <span className="text-xs font-bold px-2.5 py-0.5 rounded-md border shrink-0 bg-[#EAF3F2] text-[#247C72] border-[#247C72]/30">
              أمازون • Amazon
            </span>
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
            {isVideo ? (
              <video
                key={streamPreviewSrc}
                preload="metadata"
                src={streamPreviewSrc}
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
                src={streamPreviewSrc}
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
                  className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-xl border border-[#247C72]/30 bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-xs font-semibold transition-colors"
                >
                  <span>صفحة المنتج على أمازون</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#247C72]" />
                </a>
              )}
            </div>

            {asset.reviewerOrChannel && (
              <span className="text-xs text-[#616764]">
                المصدر: <strong className="text-[#181B1A]">{asset.reviewerOrChannel}</strong>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
