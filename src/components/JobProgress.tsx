import {sessionMetrics} from '../utils/sessionMetrics.ts';
import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Project } from '../types/index.ts';
import {
  RotateCcw,
  StopCircle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  ExternalLink
} from 'lucide-react';

interface Props {
  project: Project;
  onOpenManualModal: () => void;
}

export const JobProgress: React.FC<Props> = ({ project, onOpenManualModal }) => {
  const { t, showToast, setCurrentProject, refreshProjects, apiFetch, cancelStreamingSearch, startStreamingSearch } = useApp();
  const [showDetails, setShowDetails] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [videoTargetInput, setVideoTargetInput] = useState<string>(
    String(project.targetVideoCount || 10)
  );
  const [photoTargetInput, setPhotoTargetInput] = useState<string>(
    String(project.targetPhotoCount || 10)
  );

  React.useEffect(() => {
    setVideoTargetInput(String(project.targetVideoCount || 10));
    setPhotoTargetInput(String(project.targetPhotoCount || 10));
  }, [project.id, project.targetVideoCount, project.targetPhotoCount]);

  const isEphemeral = project.id.startsWith('ephemeral-');

  const isRunning =
    project.jobState === 'queued' ||
    project.jobState === 'analyzing' ||
    project.jobState === 'searching' ||
    project.jobState === 'inspecting' ||
    project.jobState === 'downloading' ||
    project.jobState === 'verifying';

  const syncProjectNow = async () => {
    if (isEphemeral) return;
    try {
      const res = await apiFetch(`/api/projects/${project.id}`);
      if (res.ok) {
        const updated = await res.json();
        setCurrentProject(updated);
      }
    } catch {}
    await refreshProjects();
  };

  const handleCancel = async () => {
    if (isEphemeral) {
      cancelStreamingSearch();
      showToast('تم إيقاف البحث', 'info');
      return;
    }
    setIsActionLoading(true);
    try {
      await apiFetch(`/api/projects/${project.id}/cancel`, { method: 'POST' });
      await syncProjectNow();
      showToast('تم إيقاف البحث', 'info');
    } catch {
      showToast('فشل إيقاف البحث', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRerun = async () => {
    const parsedVid = Math.min(500, Math.max(1, parseInt(videoTargetInput, 10) || project.targetVideoCount || 10));
    const parsedPh = Math.min(500, Math.max(1, parseInt(photoTargetInput, 10) || project.targetPhotoCount || 10));
    setVideoTargetInput(String(parsedVid));
    setPhotoTargetInput(String(parsedPh));

    if (isEphemeral) {
      const sp = project.settings?.sourcePriority || ['amazon', 'tiktok'];
      const resolvedSourcePlatform: 'all' | 'amazon' | 'tiktok' =
        sp.includes('tiktok') && sp.includes('amazon')
          ? 'all'
          : sp.includes('tiktok')
          ? 'tiktok'
          : 'amazon';
      showToast('تمت إعادة تشغيل البحث بالعدد المطلوب', 'success');
      await startStreamingSearch({
        previousAssets:project.jobState==='completed_partial'?project.candidates:undefined,
        productName: project.userNotes || project.name,
        productUrl: project.productListingUrl,
        mediaType: project.mediaTypeRequested,
        sourcePlatform: resolvedSourcePlatform,
        sourceVideoCounts: project.sourceVideoCounts,
        targetVideoCount: project.sourceVideoCounts ? project.sourceVideoCounts.amazon + project.sourceVideoCounts.tiktok : parsedVid,
        targetPhotoCount: parsedPh,
        referenceImage: project.referenceImages?.[0]?.url,
        imageConfirmedLocally: Boolean(project.verifiedExpansion),
        similarReviews:project.similarReviews,verifiedExpansion: project.verifiedExpansion,
      });
      return;
    }

    setIsActionLoading(true);
    try {
      // Immediately clear old candidates in UI before starting the new search
      setCurrentProject({
        ...project,
        jobState: 'searching',
        targetVideoCount: parsedVid,
        targetPhotoCount: parsedPh,
        candidates: [],
      });
      await apiFetch(`/api/projects/${project.id}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetVideoCount: parsedVid,
          targetPhotoCount: parsedPh,
        }),
      });
      showToast('تمت إعادة تشغيل البحث', 'success');
      await syncProjectNow();
    } catch {
      showToast('فشل إعادة تشغيل البحث', 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  const hasQuotaWarning = (project.logs || []).some(
    (l) => l.message.includes('429') || l.message.includes('حصة البحث غير متاحة مؤقتاً')
  );
  const hasNameOnlyWarning = (project.logs || []).some(
    (l) => l.message.includes('البحث بالاسم فقط')
  );

  const getStageInfo = () => {
    switch (project.jobState) {
      case 'analyzing':
        return { label: t.analyzing, color: 'text-[#247C72] bg-[#EAF3F2] border-[#247C72]/30', spin: true };
      case 'searching':
        return { label: t.searching, color: 'text-[#247C72] bg-[#EAF3F2] border-[#247C72]/30', spin: true };
      case 'inspecting':
        return { label: t.inspecting, color: 'text-[#247C72] bg-[#EAF3F2] border-[#247C72]/30', spin: true };
      case 'downloading':
        return { label: t.downloading, color: 'text-[#247C72] bg-[#EAF3F2] border-[#247C72]/30', spin: true };
      case 'verifying':
        return { label: t.verifying, color: 'text-[#247C72] bg-[#EAF3F2] border-[#247C72]/30', spin: true };
      case 'completed':
        return { label: t.completed, color: 'text-emerald-700 bg-emerald-50 border-emerald-200', spin: false };
      case 'completed_partial':
        return {
          label: hasQuotaWarning && (project.candidates || []).length === 0 ? 'حصة البحث غير متاحة مؤقتاً' : t.completedPartial,
          color: 'text-amber-700 bg-amber-50 border-amber-200',
          spin: false,
        };
      case 'failed':
        return { label: t.failed, color: 'text-red-700 bg-red-50 border-red-200', spin: false };
      case 'cancelled':
        return { label: t.cancelled, color: 'text-[#616764] bg-[#F6F7F4] border-[#E2E5DF]', spin: false };
      default:
        return { label: 'جاهز', color: 'text-[#616764] bg-[#F6F7F4] border-[#E2E5DF]', spin: false };
    }
  };

  const stage = getStageInfo();
  const candidates = project.candidates || [];
  const videoCount = candidates.filter((c) => c.mediaType === 'video').length;
  const photoCount = candidates.filter((c) => c.mediaType === 'photo').length;
  const targetVideos = project.targetVideoCount || 10;
  const targetPhotos = project.targetPhotoCount || 10;

  const quotaSummary =
    project.mediaTypeRequested === 'video'
      ? `فيديوهات: ${videoCount}/${targetVideos}`
      : project.mediaTypeRequested === 'photo'
      ? `صور: ${photoCount}/${targetPhotos}`
      : `فيديوهات: ${videoCount}/${targetVideos} • صور: ${photoCount}/${targetPhotos}`;

  return (
    <div className="bg-white rounded-2xl border border-[#E2E5DF] shadow-[0_2px_10px_rgba(0,0,0,0.02)] overflow-hidden">
      {/* Compact Header + Single-Line Progress */}
      <div className="p-4 sm:px-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {project.referenceImages?.[0] && (
            <img
              src={project.referenceImages[0].url}
              alt={project.name}
              className="w-10 h-10 rounded-lg object-cover border border-[#E2E5DF] shrink-0"
            />
          )}
          <div className="min-w-0">
            <h1 className="text-sm sm:text-base font-bold text-[#181B1A] truncate">
              {project.name}
            </h1>
            {project.productListingUrl && <small className="text-[#247C72]">المنتج المثبّت · {project.productListingUrl.match(/(?:dp|product)\/([A-Z0-9]{10})/i)?.[1]||'الصفحة المختارة'}</small>}

            {project.jobState==='completed_partial' && project.logs.at(-1)?.message &&
              <p role="status" className="mt-1 text-xs text-amber-800">{project.logs.at(-1)?.message}</p>}
            {/* Single-line progress summary */}
            <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-[#616764]">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-semibold text-[11px] ${stage.color}`}>
                {stage.spin ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : project.jobState === 'completed' ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <AlertCircle className="w-3 h-3" />
                )}
                <span>{stage.label}</span>
              </span>
              <span className="font-medium text-[#181B1A]">{quotaSummary}</span>
              {hasNameOnlyWarning && (
                <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md font-medium">
                  البحث بالاسم فقط — مطابقة الصورة غير مؤكدة
                </span>
              )}
              {!isRunning && hasQuotaWarning && (
                <span className="text-[11px] text-amber-800 font-medium">
                  • حصة البحث غير متاحة مؤقتاً
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => {
              cancelStreamingSearch();
              setCurrentProject(null);
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#247C72] hover:bg-[#1E665E] text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            <span>بحث جديد</span>
          </button>

          {isRunning ? (
            <button
              onClick={handleCancel}
              disabled={isActionLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-semibold transition-colors cursor-pointer"
            >
              <StopCircle className="w-3.5 h-3.5" />
              <span>إيقاف</span>
            </button>
          ) : (
            <button
              onClick={handleRerun}
              disabled={isActionLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#E2E5DF] bg-[#FAFBF9] hover:bg-[#F6F7F4] text-[#181B1A] text-xs font-semibold transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{project.jobState==='completed_partial'?'كمّل البحث عن الناقص':'تحديث'}</span>
            </button>
          )}

          <button
            onClick={() => setShowDetails(!showDetails)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-[#FAFBF9] text-xs font-medium transition-colors cursor-pointer"
          >
            <span>التفاصيل</span>
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Collapsible Details Section */}
      {showDetails && (
        <div className="border-t border-[#E2E5DF] bg-[#FAFBF9] p-4 space-y-3 text-xs">
          {(sessionMetrics.videoSearches>0||sessionMetrics.downloadAttempts>0)&&<p>أداء الجلسة · متوسط وقت أول فيديو {sessionMetrics.videoSearches?Math.round(sessionMetrics.firstVideoMs/sessionMetrics.videoSearches/1000)+' ث':'—'} · التنزيلات الجاهزة {sessionMetrics.downloadsReady}/{sessionMetrics.downloadAttempts}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {(project.mediaTypeRequested === 'video' || project.mediaTypeRequested === 'both') && (
                <label className="inline-flex items-center gap-1.5 text-[#181B1A] font-medium">
                  <span>العدد المطلوب للفيديوهات:</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={project.sourceVideoCounts ? project.targetVideoCount : videoTargetInput}
                    onChange={(e) => setVideoTargetInput(e.target.value)}
                    disabled={isRunning || Boolean(project.sourceVideoCounts)}
                    className="w-16 h-7 px-2 rounded-lg bg-white border border-[#E2E5DF] text-xs font-semibold text-[#181B1A]"
                  />
                </label>
              )}
              {(project.mediaTypeRequested === 'photo' || project.mediaTypeRequested === 'both') && (
                <label className="inline-flex items-center gap-1.5 text-[#181B1A] font-medium">
                  <span>الصور:</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={photoTargetInput}
                    onChange={(e) => setPhotoTargetInput(e.target.value)}
                    disabled={isRunning}
                    className="w-16 h-7 px-2 rounded-lg bg-white border border-[#E2E5DF] text-xs font-semibold text-[#181B1A]"
                  />
                </label>
              )}
              {!isRunning && (
                <button
                  type="button"
                  onClick={handleRerun}
                  disabled={isActionLoading}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#247C72] hover:bg-[#1E665E] text-white text-xs font-semibold transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>سحب بالعدد الجديد</span>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[#616764] font-medium">روابط بحث سريعة:</span>
              {[
                ['تيك توك', 'https://www.tiktok.com/search?q='],
                ['أمازون أمريكا', 'https://www.amazon.com/s?k='],
                ['أمازون مصر', 'https://www.amazon.eg/s?k='],
                ['أمازون السعودية', 'https://www.amazon.sa/s?k='],
                ['يوتيوب', 'https://www.youtube.com/results?search_query='],
              ].map(([label, url]) => (
                <a
                  key={label}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-[#E2E5DF] text-[#181B1A] hover:border-[#247C72] transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                  href={url + encodeURIComponent(project.productProfile?.suggestedNameEn || project.name)}
                >
                  <span>{label}</span>
                  <ExternalLink className="w-3 h-3 text-[#616764]" />
                </a>
              ))}
            </div>

            <button
              onClick={onOpenManualModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EAF3F2] text-[#247C72] font-semibold hover:bg-[#DCECE9] transition-colors cursor-pointer"
            >
              <LinkIcon className="w-3.5 h-3.5" />
              <span>إضافة رابط مباشر</span>
            </button>
          </div>

          {project.logs.length > 0 && (
            <div className="rounded-xl bg-[#181B1A] text-slate-200 font-mono text-[11px] p-3 max-h-40 overflow-y-auto space-y-1">
              {project.logs.slice(-15).map((log, index) => (
                <div key={index} className="flex items-start gap-2">
                  <span className="text-slate-500 shrink-0">
                    [{new Date(log.timestamp).toLocaleTimeString()}]
                  </span>
                  <span className="text-slate-300">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
