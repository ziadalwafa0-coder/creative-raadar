import React, { useState } from 'react';
import { CandidateAsset } from '../types/index.ts';
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
  Loader2
} from 'lucide-react';

interface Props {
  asset: CandidateAsset;
  onPreview: (asset: CandidateAsset) => void;
  onToggleSelect?: (id: string) => void;
}

export const AssetCard: React.FC<Props> = ({ asset, onPreview }) => {
  const { lang, currentProject, refreshProjects, showToast, apiFetch, downloadWithSession } = useApp();
  const provInfo = getProvenanceLabel(asset.provenance, lang);

  const [isRetrying, setIsRetrying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const isVideo = asset.mediaType === 'video';
  const isTikTok = asset.platform === 'tiktok' || Boolean(asset.sourceUrl?.includes('tiktok.com'));
  const isDownloaded =
    asset.downloadStatus === 'verified_available' ||
    (Boolean(asset.mediaUrl) &&
      !asset.mediaUrl?.includes('youtube.com') &&
      !asset.mediaUrl?.includes('youtu.be'));
  const isFailed = asset.downloadStatus === 'download_failed';

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
    if (!currentProject) return;
    setIsDownloading(true);
    try {
      const ext = isVideo ? 'mp4' : 'jpg';
      const targetUrl = asset.downloadUrl || asset.mediaUrl;
      const isEphemeral = !asset.projectId || asset.projectId.startsWith('ephemeral-') || currentProject.id.startsWith('ephemeral-');
      const dlUrl = isEphemeral && targetUrl
        ? `/api/stream-search/download?url=${encodeURIComponent(targetUrl)}&type=${asset.mediaType}&title=${encodeURIComponent(asset.title || asset.id)}`
        : `/api/projects/${currentProject.id}/assets/${asset.id}/download`;
      await downloadWithSession(
        dlUrl,
        `${asset.id}_verified.${ext}`
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="group bg-white rounded-2xl border border-[#E2E5DF] hover:border-[#247C72]/50 transition-all overflow-hidden flex flex-col justify-between">
      {/* Thumbnail Surface */}
      <div
        className="relative aspect-video w-full bg-[#181B1A] overflow-hidden cursor-pointer"
        onClick={() => onPreview(asset)}
      >
        {asset.thumbnailUrl && !imgFailed ? (
          <img
            src={asset.thumbnailUrl}
            alt={asset.title}
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#202422] text-slate-300 p-4 text-center select-none">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-[#56B3A8] mb-2">
              {isVideo ? <Video className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
            </div>
            <span className="text-xs font-medium line-clamp-1 max-w-[85%]">{asset.title}</span>
          </div>
        )}

        {/* Media Type & Duration Tag */}
        <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/75 text-white text-[11px] font-medium">
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
              {provInfo.label}
            </span>
          </div>

          <h4
            onClick={() => onPreview(asset)}
            className="font-bold text-[#181B1A] text-sm line-clamp-2 leading-snug cursor-pointer hover:text-[#247C72] transition-colors mb-1"
          >
            {asset.title}
          </h4>

          {asset.productListingUrl && (
            <a
              href={asset.productListingUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#247C72] hover:underline mb-1.5 max-w-full"
              title={asset.productListingUrl}
            >
              <ExternalLink className="w-3 h-3 shrink-0" />
              <span className="truncate">
                {isTikTok && asset.productListingUrl.includes('tiktok.com')
                  ? 'فتح الفيديو على تيك توك'
                  : 'صفحة المنتج على أمازون'}
              </span>
            </a>
          )}

          {asset.reviewerOrChannel && (
            <p className="text-xs text-[#616764] mb-2 truncate">
              {asset.reviewerOrChannel}
            </p>
          )}
        </div>

        {/* Footer Actions: Preview, Individual Download, Source Link */}
        <div className="pt-3 border-t border-[#F0F2EE] flex items-center justify-between gap-2 mt-2">
          <button
            onClick={() => onPreview(asset)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-xs font-semibold transition-colors cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>معاينة</span>
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
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
