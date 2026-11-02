import {reviewTone} from '../utils/reviewTone.ts';
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
  const { showToast, refreshProjects, apiFetch, fetchMediaBlob, downloadWithSession, sessionId } = useApp();

  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);
  const [isRetryingAllFailed, setIsRetryingAllFailed] = useState<boolean>(false);
  const [isBulkDownloadingMp4, setIsBulkDownloadingMp4] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);

  const candidates = project.candidates || [];
  const [tab,setTab]=useState<'amazon'|'tiktok'>(project.settings?.sourcePriority?.[0]==='tiktok'?'tiktok':'amazon');
  const showTabs=project.mediaTypeRequested!=='photo' && (project.sourceVideoCounts || (project.settings?.sourcePriority?.includes('amazon') && project.settings?.sourcePriority?.includes('tiktok')));
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [tone,setTone]=useState('');
  const visible=candidates.filter(asset=>(!showTabs||asset.platform===tab)&&(!tone||reviewTone(asset.title,asset.reviewStars)===tone));
  const terminalMessage = ['completed_partial', 'failed'].includes(project.jobState)
    ? project.logs.at(-1)?.message
    : undefined;
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

  const handleExportZipClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (isExportingZip || candidates.length === 0) return;

    setIsExportingZip(true);
    showToast('جاري تجهيز وتنزيل حزمة (.ZIP) مباشرة من الخادم...', 'info');

    try {
      if(selected.size && isEphemeralProject){
        const {downloadZip}=await import('client-zip');
        const manifest:Array<{file:string;source:string}>=[];
        const failed=new Set<string>();
        async function* files(){
          for(const asset of candidates.filter(a=>selected.has(a.id))){
            const url=asset.downloadUrl||asset.mediaUrl;
            const file=url&&await fetchMediaBlob('/api/stream-search/download?'+new URLSearchParams({url,type:asset.mediaType}),true);
            if(!file || !file.blob.size){failed.add(asset.id);continue;}
            const name=(manifest.length+1)+'-'+asset.platform+(asset.mediaType==='video'?'.mp4':'.jpg');
            manifest.push({file:name,source:asset.sourceUrl});
            yield {name,input:file.blob};
          }
          if(!manifest.length)throw Error('تعذّر تحميل الملفات المختارة. الاختيار محفوظ لإعادة المحاولة.');
          yield {name:'Sources.json',input:JSON.stringify(manifest,null,2)};
        }
        const blob=await downloadZip(files()).blob();
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');link.href=url;link.download='Creative-Radaar-selected.zip';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),60000);
        if(failed.size)setSelected(failed);
        showToast('تم تجهيز '+manifest.length+' ملف'+(failed.size?'، والملفات الفاشلة محددة لإعادة المحاولة.':''),failed.size?'warn':'success');
        return;
      }
      let href=exportZipHref;
      if (isEphemeralProject) {
        const exportId=crypto.randomUUID();
        const assets=selected.size?candidates.filter(a=>selected.has(a.id)):candidates;
        const ready=await apiFetch('/api/stream-search/prepare-zip',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({searchId:exportId,productName:project.name,assets})});
        if(!ready.ok){showToast('تعذّر تجهيز الملفات المختارة','warn');return;}
        href='/api/stream-search/export-zip?searchId='+exportId+tokenParam;
      }

      const safeZipName = `${(project.name || 'Creative_Radaar_Export')
        .replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_')
        .slice(0, 40)}_${new Date().toISOString().split('T')[0]}.zip`;

      const ok = await downloadWithSession(href, safeZipName);
      if (ok) {
        showToast('تم تنزيل حزمة (.ZIP) بنجاح', 'success');
      }
    } catch(error){
      showToast(error instanceof Error?error.message:'تعذّر تجهيز الملفات المختارة','warn');
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
              <span>{isExportingZip ? 'جاري تجهيز (.ZIP)...' : selected.size?'تنزيل المختار ('+selected.size+')':'تنزيل الكل (.ZIP)'}</span>
            </a>
          </div>
        </div>
      )}

      {showTabs && <div role="group" aria-label="مصدر النتائج" className="flex gap-2">
        {(['amazon','tiktok'] as const).map(source=>{
          const count=candidates.filter(item=>item.platform===source&&item.mediaType==='video').length;
          const quota=project.sourceVideoCounts?.[source];
          return <button type="button" key={source} aria-pressed={source===tab} onClick={()=>setTab(source)}
            className={'rounded-xl border px-4 py-2 text-sm '+(source===tab?'bg-[#247C72] text-white':'bg-white')}>
            {source==='amazon'?'أمازون':'تيك توك'} ({count}{quota?' / '+quota:''}) {project.sourceStatus?.[source]}
          </button>;
        })}
      </div>}
      {!!candidates.length && <label className="text-sm">تقييم الفيديو <select value={tone} onChange={e=>setTone(e.target.value)}>
        {['','إيجابي','سلبي','مختلط','محايد','غير واضح'].map(t=><option key={t} value={t}>{t||'الكل'}</option>)}</select></label>}
      {/* Results Grid */}
      {visible.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visible.map((asset) => (
            <div key={asset.id}>{isEphemeralProject && <label className="text-sm"><input type="checkbox" checked={selected.has(asset.id)}
              onChange={()=>setSelected(old=>{const next=new Set(old);if(next.has(asset.id))next.delete(asset.id);else next.add(asset.id);return next;})}/> اختيار للتنزيل</label>}
            <AssetCard
              asset={asset}
              onPreview={(a) => setPreviewingAsset(a)}
            /></div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] p-10 text-center">
          <div className="w-11 h-11 rounded-xl bg-[#F6F7F4] text-[#616764] flex items-center justify-center mx-auto mb-3">
            <FolderOpen className="w-5 h-5" />
          </div>
          <h4 className="font-bold text-[#181B1A] text-sm mb-1">
            {terminalMessage ? 'لم يتم جلب نتائج مطابقة' : 'لا توجد نتائج متاحة حتى الآن'}
          </h4>
          <p className="text-xs text-[#616764] max-w-sm mx-auto">
            {showTabs ? 'لم تصل نتائج من هذا المصدر حتى الآن.' : terminalMessage || 'تظهر الفيديوهات والصور هنا فور اكتمال استخراجها، أو يمكنك فتح التفاصيل لإضافة رابط مباشر.'}
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
