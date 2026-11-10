import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { CandidateAsset, SwipeVerdict } from '../types/index.ts';
import { getSwipeVerdictLabel, computeWinnerSignal } from '../utils/rules.ts';
import { AssetPreviewModal } from './AssetPreviewModal.tsx';
import {
  BookmarkCheck,
  Search,
  Sparkles,
  Trash2,
  Eye,
  Download,
  ExternalLink,
  Flame,
  Play,
  Loader2,
  Compass,
} from 'lucide-react';

const VERDICT_TABS: { id: 'all' | SwipeVerdict; label: string }[] = [
  { id: 'all', label: 'الكل' },
  { id: 'winner', label: 'فائز • Winner' },
  { id: 'testing', label: 'للاختبار • Testing' },
  { id: 'reference', label: 'مرجع • Reference' },
  { id: 'loser', label: 'مستبعد • Loser' },
];

export const LibraryView: React.FC = () => {
  const {
    library,
    refreshLibrary,
    updateSwipeItem,
    removeFromSwipeFile,
    generateCreativeBrief,
    downloadWithSession,
    setActiveTab,
    showToast,
  } = useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [verdictFilter, setVerdictFilter] = useState<'all' | SwipeVerdict>('all');
  const [platformFilter, setPlatformFilter] = useState<'all' | 'amazon' | 'tiktok'>('all');
  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    refreshLibrary();
  }, []);

  const isAssetTikTok = (a: CandidateAsset) =>
    a.platform === 'tiktok' || Boolean(a.sourceUrl?.includes('tiktok.com'));

  const filteredAssets = library.filter((asset) => {
    const verdict = asset.swipeVerdict || 'winner';
    if (verdictFilter !== 'all' && verdict !== verdictFilter) return false;
    if (platformFilter === 'amazon' && isAssetTikTok(asset)) return false;
    if (platformFilter === 'tiktok' && !isAssetTikTok(asset)) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const matchTitle = (asset.title || '').toLowerCase().includes(q);
      const matchNotes = (asset.editorNotes || '').toLowerCase().includes(q);
      const matchReviewer = (asset.reviewerOrChannel || '').toLowerCase().includes(q);
      if (!matchTitle && !matchNotes && !matchReviewer) return false;
    }
    return true;
  });

  const winnersCount = library.filter((a) => (a.swipeVerdict || 'winner') === 'winner').length;
  const testingCount = library.filter((a) => a.swipeVerdict === 'testing').length;
  const analyzedCount = library.filter((a) => Boolean(a.creativeAnalysis)).length;

  const handleVerdictChange = async (asset: CandidateAsset, nextVerdict: SwipeVerdict) => {
    await updateSwipeItem(asset.id, { swipeVerdict: nextVerdict });
    showToast('تم تحديث تصنيف الفيديو في Swipe File', 'info');
  };

  const handleSaveNotes = async (asset: CandidateAsset) => {
    const nextNotes = notesDrafts[asset.id] ?? asset.editorNotes ?? '';
    await updateSwipeItem(asset.id, { editorNotes: nextNotes });
    showToast('تم حفظ ملاحظات المونتير', 'success');
  };

  const handleQuickAnalyze = async (asset: CandidateAsset) => {
    setGeneratingId(asset.id);
    try {
      const res = await generateCreativeBrief({
        productName: asset.title,
        videoTitle: asset.title,
        platform: asset.platform,
        reviewerOrChannel: asset.reviewerOrChannel,
        assetId: asset.id,
      });
      if (res) {
        showToast('تم توليد Hooks وسكريبت الفيديو وحفظه في Swipe File', 'success');
      }
    } finally {
      setGeneratingId(null);
    }
  };

  const handleDownloadAsset = async (asset: CandidateAsset) => {
    setDownloadingId(asset.id);
    try {
      const ext = asset.mediaType === 'video' ? 'mp4' : 'jpg';
      const targetUrl = asset.downloadUrl || asset.mediaUrl;
      const projectId = asset.projectId || 'swipe-library';
      const isEphemeral =
        projectId.startsWith('ephemeral-') || projectId.startsWith('swipe-');
      const dlUrl =
        isEphemeral && targetUrl
          ? `/api/stream-search/download?url=${encodeURIComponent(
              targetUrl
            )}&type=${asset.mediaType}&title=${encodeURIComponent(asset.title || asset.id)}`
          : `/api/projects/${projectId}/assets/${asset.id}/download`;
      await downloadWithSession(dlUrl, `${asset.id}_swipe.${ext}`);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header & Summary Strip */}
      <div className="bg-white rounded-2xl border border-[#E2E5DF] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BookmarkCheck className="w-5 h-5 text-[#247C72]" />
              <h2 className="text-lg font-extrabold text-[#181B1A] tracking-tight">
                مكتبة Swipe File وبنك الـ Hooks
              </h2>
            </div>
            <p className="text-xs text-[#616764] mt-1">
              احتفظ بأقوى فيديوهات المراجعات والكريتيف مع نسخة محلية دائمة، تقييم الفائزين (Winner / Testing)، وتحليل الـ Hooks والسكريبت
            </p>
          </div>

          <div className="relative w-full sm:w-60">
            <Search className="w-4 h-4 text-[#616764] absolute right-3 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="ابحث في العناوين أو الملاحظات..."
              className="w-full pr-9 pl-3 py-2 text-xs rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] focus:bg-white focus:border-[#247C72] focus:outline-hidden"
            />
          </div>
        </div>

        {/* KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-[#F0F2EE]">
          <div className="rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-[#616764]">إجمالي المحفوظات</div>
            <div className="text-base font-extrabold text-[#181B1A] tabular-nums mt-0.5">
              {library.length}
            </div>
          </div>
          <div className="rounded-xl bg-emerald-50/60 border border-emerald-200 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-emerald-800">فيديوهات فائزة • Winners</div>
            <div className="text-base font-extrabold text-emerald-900 tabular-nums mt-0.5">
              {winnersCount}
            </div>
          </div>
          <div className="rounded-xl bg-amber-50/60 border border-amber-200 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-amber-800">للاختبار • Testing</div>
            <div className="text-base font-extrabold text-amber-900 tabular-nums mt-0.5">
              {testingCount}
            </div>
          </div>
          <div className="rounded-xl bg-[#EAF3F2]/60 border border-[#247C72]/25 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-[#247C72]">مزودة بتحليل Hook & سكريبت</div>
            <div className="text-base font-extrabold text-[#181B1A] tabular-nums mt-0.5">
              {analyzedCount}
            </div>
          </div>
        </div>

        {/* Verdict & Platform Filters */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#F0F2EE]">
          <div className="flex items-center gap-1.5 flex-wrap">
            {VERDICT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setVerdictFilter(tab.id)}
                className={`px-3 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                  verdictFilter === tab.id
                    ? 'bg-[#247C72] text-white border-[#247C72]'
                    : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPlatformFilter('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                platformFilter === 'all'
                  ? 'bg-[#181B1A] text-white border-[#181B1A]'
                  : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF]'
              }`}
            >
              كل المنصات
            </button>
            <button
              type="button"
              onClick={() => setPlatformFilter('amazon')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                platformFilter === 'amazon'
                  ? 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]'
                  : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF]'
              }`}
            >
              أمازون
            </button>
            <button
              type="button"
              onClick={() => setPlatformFilter('tiktok')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer ${
                platformFilter === 'tiktok'
                  ? 'bg-[#181B1A] text-white border-[#181B1A]'
                  : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF]'
              }`}
            >
              تيك توك
            </button>
          </div>
        </div>
      </div>

      {/* Swipe Cards Grid */}
      {filteredAssets.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {filteredAssets.map((asset) => {
            const isTikTok = isAssetTikTok(asset);
            const verdict = asset.swipeVerdict || 'winner';
            const verdictInfo = getSwipeVerdictLabel(verdict);
            const winnerSignal = asset.winnerSignal || computeWinnerSignal(asset);
            const noteValue = notesDrafts[asset.id] ?? asset.editorNotes ?? '';

            return (
              <div
                key={asset.id}
                className="bg-white rounded-2xl border border-[#E2E5DF] overflow-hidden flex flex-col justify-between"
              >
                {/* Thumbnail */}
                <div
                  onClick={() => setPreviewingAsset(asset)}
                  className="relative aspect-video bg-[#181B1A] cursor-pointer overflow-hidden group"
                >
                  {asset.thumbnailUrl ? (
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.title}
                      className="w-full h-full object-cover group-hover:scale-102 transition-transform"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/70 text-xs px-4 text-center">
                      {asset.title}
                    </div>
                  )}

                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                    <span className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold border ${verdictInfo.badgeClass}`}>
                      {verdictInfo.labelAr} • {verdictInfo.labelEn}
                    </span>
                  </div>

                  <div className="absolute top-2.5 left-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/75 text-amber-300 text-[10px] font-bold tabular-nums">
                    <Flame className="w-3 h-3 text-amber-400" />
                    <span>{winnerSignal.score}</span>
                  </div>

                  <div className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-black/75 text-white text-[11px] font-medium tabular-nums">
                    <Play className="w-3 h-3 fill-white" />
                    <span>{asset.durationSeconds ? `${asset.durationSeconds}ث` : 'فيديو'}</span>
                  </div>
                </div>

                {/* Card Details */}
                <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          isTikTok
                            ? 'bg-[#181B1A] text-white border-[#181B1A]'
                            : 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]/30'
                        }`}
                      >
                        {isTikTok ? 'تيك توك • TikTok' : 'أمازون • Amazon'}
                      </span>

                      <button
                        type="button"
                        onClick={() => removeFromSwipeFile(asset.id)}
                        className="text-[#616764] hover:text-red-600 p-1 rounded-lg transition-colors cursor-pointer"
                        title="حذف من Swipe File"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <h4
                      onClick={() => setPreviewingAsset(asset)}
                      className="font-bold text-[#181B1A] text-sm line-clamp-2 cursor-pointer hover:text-[#247C72]"
                    >
                      {asset.title}
                    </h4>

                    {/* Quick Verdict Switcher */}
                    <div className="flex items-center gap-1 flex-wrap pt-1">
                      {(['winner', 'testing', 'reference', 'loser'] as SwipeVerdict[]).map((v) => {
                        const info = getSwipeVerdictLabel(v);
                        return (
                          <button
                            key={v}
                            type="button"
                            onClick={() => handleVerdictChange(asset, v)}
                            className={`px-2 py-0.5 rounded-md text-[10px] font-bold border cursor-pointer transition-colors ${
                              verdict === v
                                ? 'bg-[#247C72] text-white border-[#247C72]'
                                : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                            }`}
                          >
                            {info.labelAr}
                          </button>
                        );
                      })}
                    </div>

                    {/* Editor Notes */}
                    <div className="flex items-center gap-1.5 pt-1">
                      <input
                        type="text"
                        value={noteValue}
                        onChange={(e) =>
                          setNotesDrafts((prev) => ({ ...prev, [asset.id]: e.target.value }))
                        }
                        placeholder="ملاحظات للمونتير أو زاوية الإعلان..."
                        className="flex-1 rounded-lg border border-[#E2E5DF] bg-[#FAFBF9] px-2.5 py-1.5 text-xs text-[#181B1A] focus:bg-white focus:border-[#247C72] focus:outline-hidden"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveNotes(asset)}
                        className="px-2.5 py-1.5 rounded-lg bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-[11px] font-bold cursor-pointer shrink-0"
                      >
                        حفظ
                      </button>
                    </div>

                    {/* Saved Creative Analysis Snippet */}
                    {asset.creativeAnalysis && (
                      <div className="rounded-xl bg-[#EAF3F2]/50 border border-[#247C72]/25 p-2.5 space-y-1">
                        <div className="text-[10px] font-bold text-[#247C72]">
                          أقوى Hook مقترح:
                        </div>
                        <p className="text-xs font-bold text-[#181B1A] line-clamp-2">
                          {asset.creativeAnalysis.hooksAr[0]}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Card Footer */}
                  <div className="pt-3 border-t border-[#F0F2EE] flex items-center justify-between gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPreviewingAsset(asset)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-xs font-semibold cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>معاينة & سكريبت</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleQuickAnalyze(asset)}
                        disabled={generatingId === asset.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#181B1A] hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                      >
                        {generatingId === asset.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5 text-teal-400" />
                        )}
                        <span>{asset.creativeAnalysis ? 'تحديث Hook' : 'توليد Hook'}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleDownloadAsset(asset)}
                        disabled={downloadingId === asset.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#181B1A] text-xs font-semibold cursor-pointer"
                      >
                        {downloadingId === asset.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#247C72]" />
                        ) : (
                          <Download className="w-3.5 h-3.5 text-[#247C72]" />
                        )}
                        <span>تنزيل</span>
                      </button>

                      <a
                        href={asset.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-[#E2E5DF] hover:bg-[#F6F7F4] text-[#616764] text-xs font-medium"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-[#E2E5DF] p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-[#EAF3F2] text-[#247C72] flex items-center justify-center mx-auto">
            <BookmarkCheck className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-[#181B1A] text-base">
            {library.length > 0
              ? 'لا توجد عناصر تطابق التصفية الحالية'
              : 'مكتبة Swipe File فارغة حالياً'}
          </h3>
          <p className="text-xs text-[#616764] max-w-md mx-auto leading-relaxed">
            اضغط على زر <strong>Swipe</strong> على أي فيديو من نتائج بحث أمازون أو تيك توك لحفظ نسخة دائمة منه، تصنيفه كفائز (Winner)، وتوليد Hooks وسكريبت إعلاني جاهز للتصوير أو المونتاج.
          </p>
          {library.length === 0 && (
            <button
              type="button"
              onClick={() => setActiveTab('search')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#247C72] hover:bg-[#1E665E] text-white text-xs font-bold cursor-pointer"
            >
              <Compass className="w-4 h-4" />
              <span>ابدأ بحثاً جديداً</span>
            </button>
          )}
        </div>
      )}

      {/* Preview Modal */}
      <AssetPreviewModal
        asset={previewingAsset}
        onClose={() => setPreviewingAsset(null)}
      />
    </div>
  );
};
