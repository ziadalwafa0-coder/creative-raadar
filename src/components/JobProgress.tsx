import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  Loader2,
  ShoppingBag,
  Sparkles,
  Copy,
  Check,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Sliders,
  Download,
  Activity,
  AlertTriangle,
  Filter,
  Table,
  Layers,
  RotateCcw,
  Plus,
} from 'lucide-react';
import { useApp } from '../context/AppContext.tsx';
import {
  Project,
  TikTokProviderProbeItem,
  ReasonHistogramEntry,
} from '../types/index.ts';

interface RuntimeSettingsData {
  strictnessPreset: 'strict' | 'balanced' | 'lenient';
  thresholds: {
    stage1LocalDirectRejectSimilarity: number;
    stage1LocalSendToGeminiMinSimilarity: number;
    stage2AcceptMinConfidence: number;
    phashDedupeMaxDistance: number;
  };
  searchDepth: {
    pagesPerQuery: number;
    maxQueries: number;
    maxListingsToInspect: number;
    consecutiveZeroYieldStopK: number;
    sortVariants: Array<'relevance' | 'review-rank' | 'popularity-rank'>;
  };
  marketplaces: {
    US: boolean;
    UK: boolean;
    DE: boolean;
    CA: boolean;
    AE: boolean;
    SA: boolean;
    EG: boolean;
  };
  sourceCaps: {
    amazonMax: number;
    tiktokMax: number;
  };
  geminiDailyBudget: number;
  tiktokProviders: {
    serpHydration: boolean;
    urlImport: boolean;
    playwright: boolean;
    apify: boolean;
    order: string[];
  };
  attributeStrengthOverrides: Record<string, 'HARD' | 'SOFT' | 'IGNORE'>;
}

interface Props {
  project: Project;
  onOpenManualModal?: () => void;
}

export const JobProgress: React.FC<Props> = ({ project, onOpenManualModal }) => {
  const { setCurrentProject, cancelStreamingSearch, apiFetch, showToast } = useApp();
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [showFunnels, setShowFunnels] = useState(true);
  const [showQueryPlan, setShowQueryPlan] = useState(false);
  const [selectedReasonChip, setSelectedReasonChip] = useState<string | null>(null);

  // Settings drawer state
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [settings, setSettings] = useState<RuntimeSettingsData | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);

  // Live TikTok probe state
  const [probingTikTok, setProbingTikTok] = useState(false);
  const [liveTikTokProbes, setLiveTikTokProbes] = useState<TikTokProviderProbeItem[] | null>(null);
  const [showTikTokProbePanel, setShowTikTokProbePanel] = useState(false);

  const loadSettings = async () => {
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings || data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (showSettingsDrawer && !settings) {
      loadSettings();
    }
  }, [showSettingsDrawer]);

  const handleSaveSettings = async (patch: Partial<RuntimeSettingsData>) => {
    setSavingSettings(true);
    setSettingsSavedMsg(null);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings || data);
        setSettingsSavedMsg('تم حفظ الإعدادات فوراً (تُطبّق في البحث القادم بدون إعادة بناء)');
        showToast('تم حفظ إعدادات البحث والتحقق بنجاح', 'success');
        setTimeout(() => setSettingsSavedMsg(null), 3500);
      }
    } catch (e: any) {
      setSettingsSavedMsg(`خطأ في حفظ الإعدادات: ${e.message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRunTikTokProbe = async () => {
    setProbingTikTok(true);
    setShowTikTokProbePanel(true);
    try {
      const idCard = project.identityCard;
      const res = await apiFetch('/api/debug/tiktok-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: project.name || idCard?.nameEn || 'Shiatsu Kneading Neck and Back Massage Pillow',
          identityCard: idCard,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setLiveTikTokProbes(data.providerProbes || []);
        showToast(`اختبار تيك توك المباشر اكتمل: تم فحص ${(data.providerProbes || []).length} مزود/محرك بحث`, 'info');
      }
    } catch (e: any) {
      showToast(`فشل اختبار تيك توك المباشر: ${e.message}`, 'error');
    } finally {
      setProbingTikTok(false);
    }
  };

  const breakdown = project.breakdownSummary;
  const allCandidates = project.candidates || [];
  const verifiedVideoResults = allCandidates.filter(
    (r) =>
      r.mediaType === 'video' &&
      r.verifiedByAi !== false &&
      r.matchCategory !== 'insufficient_evidence'
  );

  // SINGLE SOURCE OF TRUTH: Every displayed counter is derived from breakdown (SearchTrace) first,
  // falling back to live array lengths only while streaming before finalize
  const confirmedVideoCount = breakdown ? breakdown.emittedVideos : verifiedVideoResults.length;
  const targetVideos = breakdown ? breakdown.requestedVideos : (project.targetVideoCount || 20);

  const amazonCount = breakdown
    ? (breakdown.amazonEmitted ?? verifiedVideoResults.filter((r) => r.platform === 'amazon').length)
    : verifiedVideoResults.filter((r) => r.platform === 'amazon').length;
  const tiktokCount = breakdown
    ? (breakdown.tiktokEmitted ?? verifiedVideoResults.filter((r) => r.platform === 'tiktok').length)
    : verifiedVideoResults.filter((r) => r.platform === 'tiktok').length;

  const matchedCount = breakdown
    ? (breakdown.matchedCount ??
        verifiedVideoResults.filter(
          (r) => !r.verdictTier || r.verdictTier === 'exact' || r.verdictTier === 'same_design_variant'
        ).length)
    : verifiedVideoResults.filter(
        (r) => !r.verdictTier || r.verdictTier === 'exact' || r.verdictTier === 'same_design_variant'
      ).length;

  const similarCount = breakdown
    ? (breakdown.similarCount ??
        verifiedVideoResults.filter(
          (r) => r.verdictTier === 'same_type_close_design' || r.verdictTier === 'same_type_other_design'
        ).length)
    : verifiedVideoResults.filter(
        (r) => r.verdictTier === 'same_type_close_design' || r.verdictTier === 'same_type_other_design'
      ).length;

  // SINGLE SOURCE OF TRUTH for rejected count: top chip, warning banner, and panel ALL read breakdown.rejectedTotal
  const rejectedTotalCount = breakdown
    ? (breakdown.rejectedTotal ?? breakdown.listingsRejected)
    : (project.rejectedCandidates?.length || 0);

  const unverifiedCount = breakdown
    ? (breakdown.verification_error ??
        ((breakdown.unverifiedListingsCount || 0) + (breakdown.unverifiedVideosCount || 0)))
    : allCandidates.filter((r) => r.verifiedByAi === false || r.matchCategory === 'insufficient_evidence').length;

  const isRunning =
    project.jobState === 'analyzing' ||
    project.jobState === 'searching' ||
    project.jobState === 'inspecting' ||
    project.jobState === 'downloading' ||
    project.jobState === 'verifying';

  const handleCopyDiagnosticReport = () => {
    if (!breakdown?.diagnosticReportMarkdown) return;
    navigator.clipboard.writeText(breakdown.diagnosticReportMarkdown);
    setCopiedReport(true);
    showToast('تم نسخ تقرير التشخيص الكامل (Markdown + JSON)', 'success');
    setTimeout(() => setCopiedReport(false), 2500);
  };

  const handleCopyLogs = () => {
    const text = (project.logs || [])
      .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.stage}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text || 'لا توجد سجلات');
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };

  const activeReasonEntry: ReasonHistogramEntry | undefined =
    breakdown?.reasonHistograms?.find((r) => r.reasonCode === selectedReasonChip);

  const displayedProbes: TikTokProviderProbeItem[] =
    liveTikTokProbes || breakdown?.providerProbes || [];

  const stopReasonBadgeColor = (code?: string) => {
    if (code?.startsWith('provider_failed:')) {
      return 'bg-red-50 text-red-700 border-red-300';
    }
    switch (code) {
      case 'target_reached':
        return 'bg-emerald-50 text-emerald-700 border-emerald-300';
      case 'amazon_blocked':
      case 'tiktok_unreachable':
      case 'gemini_budget':
        return 'bg-red-50 text-red-700 border-red-300';
      case 'insufficient_search':
      case 'exhausted_candidates':
      case 'timeout':
      default:
        return 'bg-amber-50 text-amber-800 border-amber-300';
    }
  };

  const rawSearchId = breakdown?.searchId || project.id.replace(/^ephemeral-/, '');

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs mb-4" dir="rtl">
      {/* Header Row: Honest Stop Reason + Global Target Counter + Diagnostic Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 flex-wrap">
          {isRunning ? (
            <Loader2 className="w-5 h-5 text-[#247C72] animate-spin" />
          ) : breakdown?.stopReasonCode === 'target_reached' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          )}

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-slate-900">
                {project.name}
              </h3>
              <span className="text-xs font-bold text-slate-700">
                —{' '}
                {isRunning
                  ? 'جاري البحث والتحقق البصري الصارم...'
                  : (breakdown?.stopReasonLabelAr ||
                      (confirmedVideoCount >= targetVideos
                        ? 'اكتمل الهدف المطلوب'
                        : 'انتهى البحث قبل اكتمال الهدف (نفاد المرشحين)'))}
              </span>
              {breakdown?.stopReasonCode && (
                <span
                  data-testid="honest-stop-reason-badge"
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border font-bold ${stopReasonBadgeColor(breakdown.stopReasonCode)}`}
                >
                  {breakdown.stopReasonCode}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Copy Diagnostic Report, Download Trace JSON, Test TikTok, Settings Drawer, New Search */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {breakdown?.diagnosticReportMarkdown && (
            <button
              type="button"
              onClick={handleCopyDiagnosticReport}
              data-testid="copy-diagnostic-report-btn"
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-[#247C72] hover:bg-[#1E665E] px-3 py-1.5 rounded-lg shadow-xs transition-colors cursor-pointer"
            >
              {copiedReport ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-200" />
                  <span>تم نسخ تقرير التشخيص</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>نسخ تقرير التشخيص</span>
                </>
              )}
            </button>
          )}

          {rawSearchId && (
            <a
              href={`/api/debug/search?id=${encodeURIComponent(rawSearchId)}`}
              download={`trace_${rawSearchId}.json`}
              target="_blank"
              rel="noreferrer"
              data-testid="download-trace-btn"
              className="flex items-center gap-1 text-xs font-bold text-slate-700 hover:text-[#247C72] bg-slate-100 hover:bg-slate-200/70 px-2.5 py-1.5 rounded-lg border border-slate-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>تنزيل التتبع</span>
            </a>
          )}

          <button
            type="button"
            onClick={handleRunTikTokProbe}
            disabled={probingTikTok}
            data-testid="test-tiktok-probe-btn"
            className="flex items-center gap-1 text-xs font-bold text-pink-700 bg-pink-50 hover:bg-pink-100 border border-pink-200 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
          >
            {probingTikTok ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Activity className="w-3.5 h-3.5" />
            )}
            <span>اختبار تيك توك</span>
          </button>

          <button
            type="button"
            onClick={() => setShowSettingsDrawer(!showSettingsDrawer)}
            data-testid="toggle-settings-drawer-btn"
            className={`flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer ${
              showSettingsDrawer
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-slate-50 text-slate-700 hover:bg-slate-100 border-slate-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>إعدادات الضبط</span>
          </button>

          {onOpenManualModal && (
            <button
              type="button"
              onClick={onOpenManualModal}
              className="flex items-center gap-1 text-xs font-bold text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>إضافة رابط</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              cancelStreamingSearch();
              setCurrentProject(null);
            }}
            className="flex items-center gap-1 text-xs font-bold text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>بحث جديد</span>
          </button>
        </div>
      </div>

      {/* Top Metrics Chips — ALL DERIVED FROM SINGLE TRACE STORE, NO /500 DENOMINATORS */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span
          data-testid="top-confirmed-videos-chip"
          className={`text-xs font-bold px-3 py-1.5 rounded-lg border ${
            confirmedVideoCount >= targetVideos
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-indigo-50 text-indigo-800 border-indigo-200'
          }`}
        >
          المؤكد {confirmedVideoCount} من {targetVideos} المطلوب (مطابق {matchedCount} + شبيه {similarCount})
        </span>

        <span
          data-testid="top-amazon-videos-chip"
          className="text-xs font-bold px-2.5 py-1.5 rounded-lg border bg-amber-50 text-amber-800 border-amber-200 flex items-center gap-1"
          title="عدد الفيديوهات المؤكدة من أمازون"
        >
          <ShoppingBag className="w-3.5 h-3.5 text-amber-600" />
          أمازون: {amazonCount} فيديو {amazonCount > 0 ? '✓' : breakdown?.stopReasonCode === 'amazon_blocked' ? '⚠️' : '•'}
        </span>

        <span
          data-testid="top-tiktok-videos-chip"
          className="text-xs font-bold px-2.5 py-1.5 rounded-lg border bg-pink-50 text-pink-800 border-pink-200 flex items-center gap-1"
          title="عدد الفيديوهات المؤكدة من تيك توك"
        >
          <Sparkles className="w-3.5 h-3.5 text-pink-600" />
          تيك توك: {tiktokCount} فيديو {tiktokCount > 0 ? '✓' : '•'}
        </span>

        <span
          data-testid="top-rejected-listings-chip"
          className="text-xs font-bold px-2.5 py-1.5 rounded-lg border bg-red-50 text-red-700 border-red-200 flex items-center gap-1"
          title={`نصي: ${breakdown?.rejected_by_text_prefilter ?? 0} | بصري محلي: ${breakdown?.rejected_by_local_visual ?? 0} | Gemini: ${breakdown?.rejected_by_gemini ?? 0} | سمة أساسية: ${breakdown?.rejected_by_hard_attribute ?? 0}`}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          مرفوض بالتحقق: {rejectedTotalCount}
        </span>

        {unverifiedCount > 0 && (
          <span
            data-testid="top-unverified-chip"
            className="text-xs font-bold px-2.5 py-1.5 rounded-lg border bg-slate-100 text-slate-700 border-slate-300 flex items-center gap-1"
            title="عناصر تعذّر فحصها بسبب خطأ اتصال أو نفاد ميزانية Gemini — لا تُحسب كمرفوضة ولا تُضاف للنتائج المؤكدة"
          >
            <EyeOff className="w-3.5 h-3.5" />
            verification_error: {unverifiedCount}
          </span>
        )}

        {breakdown?.geminiUsage && (
          <span
            className={`text-xs font-bold px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
              breakdown.geminiUsage.exhausted
                ? 'bg-red-50 text-red-700 border-red-300'
                : 'bg-slate-50 text-slate-700 border-slate-200'
            }`}
          >
            استهلاك Gemini في البحث: {breakdown.geminiUsage.callsUsedInSearch} نداء
            {breakdown.geminiUsage.exhausted && ' (نفدت)'}
          </span>
        )}
      </div>

      {/* TOP LIMITING FACTOR BANNER (One clear Arabic sentence) */}
      {breakdown?.topLimitingFactorAr && (
        <div
          data-testid="top-limiting-factor-banner"
          className="mb-3 p-3 rounded-xl bg-amber-50/90 border border-amber-300 text-amber-950 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs font-bold leading-relaxed">
            {breakdown.topLimitingFactorAr}
          </div>
        </div>
      )}

      {/* PHASE 2: Persisted Runtime Settings Drawer (Tune Without Editing Code) */}
      {showSettingsDrawer && (
        <div className="mb-4 p-4 bg-slate-900 text-slate-100 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-teal-400" />
              <h4 className="text-xs font-bold text-white">
                ضبط معايير البحث والتحقق (محفوظة في config/settings.json بدون إعادة بناء)
              </h4>
            </div>
            {settingsSavedMsg && (
              <span className="text-[11px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-700 px-2.5 py-0.5 rounded">
                {settingsSavedMsg}
              </span>
            )}
          </div>

          {!settings ? (
            <div className="text-xs text-slate-400 py-4 text-center">جاري تحميل الإعدادات...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              {/* Column 1: Strictness Preset & Thresholds */}
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700 space-y-2.5">
                <div className="font-bold text-teal-300">1. مستوى الصرامة والعتبات (Thresholds)</div>
                <div className="flex gap-1.5">
                  {(['strict', 'balanced', 'lenient'] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={savingSettings}
                      onClick={() => handleSaveSettings({ strictnessPreset: preset })}
                      className={`flex-1 py-1.5 px-2 rounded font-bold text-[11px] border transition-colors cursor-pointer ${
                        settings.strictnessPreset === preset
                          ? 'bg-[#247C72] text-white border-teal-400'
                          : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      {preset === 'strict' ? 'صارم' : preset === 'balanced' ? 'متوازن' : 'متساهل'}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5 pt-1">
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>عتبة الرفض المحلي (CLIP Stage 1):</span>
                    <input
                      type="number"
                      step="0.02"
                      min="0.20"
                      max="0.80"
                      value={settings.thresholds.stage1LocalDirectRejectSimilarity}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          thresholds: {
                            ...settings.thresholds,
                            stage1LocalDirectRejectSimilarity: Number(e.target.value),
                          },
                        })
                      }
                      className="w-16 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>عتبة قبول Gemini (Stage 2 Confidence):</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.35"
                      max="0.95"
                      value={settings.thresholds.stage2AcceptMinConfidence}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          thresholds: {
                            ...settings.thresholds,
                            stage2AcceptMinConfidence: Number(e.target.value),
                          },
                        })
                      }
                      className="w-16 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>ميزانية Gemini اليومية:</span>
                    <input
                      type="number"
                      step="50"
                      min="20"
                      max="5000"
                      value={settings.geminiDailyBudget}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          geminiDailyBudget: Number(e.target.value),
                        })
                      }
                      className="w-20 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                </div>
              </div>

              {/* Column 2: Search Depth & Marketplaces */}
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700 space-y-2.5">
                <div className="font-bold text-amber-300">2. عمق البحث والأسواق (Amazon Depth)</div>
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>صفحات لكل استعلام (Pages/Query):</span>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={settings.searchDepth.pagesPerQuery}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          searchDepth: {
                            ...settings.searchDepth,
                            pagesPerQuery: Number(e.target.value),
                          },
                        })
                      }
                      className="w-14 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>أقصى عدد منتجات للفحص:</span>
                    <input
                      type="number"
                      step="20"
                      min="30"
                      max="500"
                      value={settings.searchDepth.maxListingsToInspect}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          searchDepth: {
                            ...settings.searchDepth,
                            maxListingsToInspect: Number(e.target.value),
                          },
                        })
                      }
                      className="w-16 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>التوقف بعد K صفحات صفرية (Stop K):</span>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={settings.searchDepth.consecutiveZeroYieldStopK}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          searchDepth: {
                            ...settings.searchDepth,
                            consecutiveZeroYieldStopK: Number(e.target.value),
                          },
                        })
                      }
                      className="w-14 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                </div>

                <div className="pt-1">
                  <div className="text-[10px] text-slate-400 mb-1">الأسواق المفعّلة (Marketplaces):</div>
                  <div className="flex flex-wrap gap-1">
                    {(['US', 'UK', 'DE', 'CA', 'AE', 'SA', 'EG'] as const).map((mkt) => (
                      <button
                        key={mkt}
                        type="button"
                        onClick={() =>
                          setSettings({
                            ...settings,
                            marketplaces: {
                              ...settings.marketplaces,
                              [mkt]: !settings.marketplaces[mkt],
                            },
                          })
                        }
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border cursor-pointer ${
                          settings.marketplaces[mkt]
                            ? 'bg-amber-500 text-slate-950 border-amber-300'
                            : 'bg-slate-900 text-slate-500 border-slate-700'
                        }`}
                      >
                        {mkt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Column 3: Source Max Caps & TikTok Providers */}
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700 space-y-2.5">
                <div className="font-bold text-pink-300">3. السقف الأقصى للمصادر ومزودي تيك توك</div>
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>سقف أمازون الأقصى (Amazon Max Cap):</span>
                    <input
                      type="number"
                      min="5"
                      max="100"
                      value={settings.sourceCaps.amazonMax}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          sourceCaps: {
                            ...settings.sourceCaps,
                            amazonMax: Number(e.target.value),
                          },
                        })
                      }
                      className="w-14 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                  <label className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>سقف تيك توك الأقصى (TikTok Max Cap):</span>
                    <input
                      type="number"
                      min="5"
                      max="100"
                      value={settings.sourceCaps.tiktokMax}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          sourceCaps: {
                            ...settings.sourceCaps,
                            tiktokMax: Number(e.target.value),
                          },
                        })
                      }
                      className="w-14 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-left font-mono text-white"
                    />
                  </label>
                </div>

                <div className="pt-1 space-y-1">
                  <div className="text-[10px] text-slate-400">مزودو تيك توك (Providers):</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { key: 'serpHydration', label: 'SERP Engines (8)' },
                        { key: 'urlImport', label: 'URL Import' },
                        { key: 'playwright', label: 'Playwright' },
                        { key: 'apify', label: 'Apify' },
                      ] as const
                    ).map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() =>
                          setSettings({
                            ...settings,
                            tiktokProviders: {
                              ...settings.tiktokProviders,
                              [p.key]: !settings.tiktokProviders[p.key],
                            },
                          })
                        }
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${
                          settings.tiktokProviders[p.key]
                            ? 'bg-pink-600 text-white border-pink-400'
                            : 'bg-slate-900 text-slate-500 border-slate-700'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={() => handleSaveSettings(settings)}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                  >
                    {savingSettings ? 'جاري الحفظ...' : 'حفظ جميع الإعدادات'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PHASE 3.3: Live TikTok Provider Probe Output Table */}
      {(showTikTokProbePanel || displayedProbes.length > 0) && (
        <div className="mb-3 bg-pink-50/50 border border-pink-200 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-pink-600" />
              <span className="text-xs font-bold text-pink-950">
                فحص مزودي ومحركات تيك توك المباشر (TikTok Discovery &amp; Hydration Probes)
              </span>
            </div>
            {showTikTokProbePanel && (
              <button
                type="button"
                onClick={() => setShowTikTokProbePanel(false)}
                className="text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                إخفاء
              </button>
            )}
          </div>

          {probingTikTok ? (
            <div className="text-xs text-pink-800 py-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                جاري اختبار محركات البحث (Naver, DDG Lite/HTML, Bing RSS, Yahoo, Brave, SearXNG, Google CSE) ومزودي تيك توك...
              </span>
            </div>
          ) : displayedProbes.length === 0 ? (
            <div className="text-xs text-slate-500">
              اضغط &ldquo;اختبار تيك توك&rdquo; لتشغيل فحص حي لجميع المزودين.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] text-right border-collapse">
                <thead>
                  <tr className="bg-pink-100/70 text-pink-950 border-b border-pink-200">
                    <th className="py-1.5 px-2 font-bold">المزود / المحرك</th>
                    <th className="py-1.5 px-2 font-bold">HTTP</th>
                    <th className="py-1.5 px-2 font-bold">الزمن (ms)</th>
                    <th className="py-1.5 px-2 font-bold">نتائج خام</th>
                    <th className="py-1.5 px-2 font-bold">روابط تيك توك</th>
                    <th className="py-1.5 px-2 font-bold">oEmbed (نجاح/فشل)</th>
                    <th className="py-1.5 px-2 font-bold">قاطع الدائرة</th>
                    <th className="py-1.5 px-2 font-bold">الحالة / أول خطأ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pink-100">
                  {displayedProbes.map((p, idx) => (
                    <tr key={`${p.provider}-${p.engine || idx}`} className="hover:bg-pink-100/30">
                      <td className="py-1.5 px-2 font-mono font-bold text-slate-900">
                        {p.provider}
                        {p.engine ? ` (${p.engine})` : ''}
                      </td>
                      <td className="py-1.5 px-2 font-mono">
                        <span
                          className={`px-1.5 py-0.5 rounded font-bold ${
                            p.httpStatus === 200
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {p.httpStatus ?? '-'}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 font-mono text-slate-600">{p.latencyMs}ms</td>
                      <td className="py-1.5 px-2 font-mono font-bold">{p.rawResultsCount}</td>
                      <td className="py-1.5 px-2 font-mono font-bold text-indigo-700">
                        {p.tiktokUrlsParsed}
                      </td>
                      <td className="py-1.5 px-2 font-mono">
                        <span className="text-emerald-700 font-bold">{p.oembedOkCount}</span> /{' '}
                        <span className="text-red-600">{p.oembedFailCount}</span>
                      </td>
                      <td className="py-1.5 px-2 font-mono">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            p.circuitOpen
                              ? 'bg-red-100 text-red-700'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {p.circuitOpen ? 'open' : 'closed'}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-slate-600 max-w-xs truncate" title={p.firstError}>
                        {p.firstError || 'OK'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* PHASE 1 & 4 & 6: Single Source of Truth Diagnostic Panel */}
      {breakdown && (
        <div className="mb-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <button
              type="button"
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-2 text-xs font-bold text-slate-800 hover:text-[#247C72] transition-colors cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4 text-[#247C72]" />
              <span>لوحة التشخيص الكاملة وقمع التصفية (Single Source of Truth Trace)</span>
              {showBreakdown ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowFunnels(!showFunnels)}
                className={`text-[11px] font-bold px-2 py-0.5 rounded border flex items-center gap-1 cursor-pointer ${
                  showFunnels
                    ? 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]/40'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                <Filter className="w-3 h-3" />
                <span>قمع المراحل ({breakdown.funnels?.length || 0})</span>
              </button>
              <button
                type="button"
                onClick={() => setShowQueryPlan(!showQueryPlan)}
                className={`text-[11px] font-bold px-2 py-0.5 rounded border flex items-center gap-1 cursor-pointer ${
                  showQueryPlan
                    ? 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]/40'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                <Table className="w-3 h-3" />
                <span>خطة الاستعلامات ({breakdown.queryPlan?.length || 0})</span>
              </button>
            </div>
          </div>

          {showBreakdown && (
            <div className="space-y-3 pt-2 border-t border-slate-200/80 text-xs">
              {/* Summary Grid — Derived 100% from breakdown */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-[10px] text-slate-500">صفحات البحث والأسواق</div>
                  <div className="font-bold text-slate-900 mt-0.5">
                    {breakdown.pagesFetched} صفحة ({(breakdown.marketplacesSearched || []).join(', ') || '-'})
                  </div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-[10px] text-slate-500">عناصر فُحصت (مقبول / مرفوض / غير متحقق)</div>
                  <div className="font-bold text-slate-900 mt-0.5" data-testid="panel-inspected-accepted-rejected">
                    {breakdown.listingsInspected} منتج | مقبول: {breakdown.listingsAccepted} | مرفوض إجمالي: {rejectedTotalCount} | خطأ: {unverifiedCount}
                  </div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-[10px] text-slate-500">إطارات الفيديو المستخرجة (ffmpeg)</div>
                  <div className="font-bold text-slate-900 mt-0.5" data-testid="panel-ffmpeg-frames-stat">
                    ملصقات: {breakdown.realVideoFramePosterCount} | إطارات: {breakdown.keyframesExtractedCount || 0}
                    {breakdown.keyframesFailedCount ? ` (فشل ${breakdown.keyframesFailedCount})` : ''}
                  </div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-[10px] text-slate-500">المؤكد من المطلوب (مطابق / شبيه)</div>
                  <div className="font-bold text-[#247C72] mt-0.5">
                    المؤكد {breakdown.emittedVideos} من {breakdown.requestedVideos} المطلوب (مطابق {matchedCount} + شبيه {similarCount})
                  </div>
                </div>
              </div>

              {/* PHASE 2.3: Semantic Rejection Counters Breakdown */}
              <div
                data-testid="semantic-rejection-counters"
                className="bg-white p-2.5 rounded-lg border border-slate-200 flex flex-wrap items-center gap-2 text-[11px]"
              >
                <span className="font-bold text-slate-700">تفصيل عدادات الاستبعاد الموحدة:</span>
                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-mono">
                  rejected_by_text_prefilter: {breakdown.rejected_by_text_prefilter ?? 0}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-mono">
                  rejected_by_local_visual: {breakdown.rejected_by_local_visual ?? 0}
                </span>
                <span className="px-2 py-0.5 rounded bg-red-50 text-red-800 border border-red-200 font-mono">
                  rejected_by_gemini: {breakdown.rejected_by_gemini ?? 0}
                </span>
                <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 font-mono">
                  rejected_by_hard_attribute: {breakdown.rejected_by_hard_attribute ?? 0}
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-900 border border-amber-200 font-mono">
                  verification_error: {breakdown.verification_error ?? 0}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
                  duplicates: {breakdown.duplicates ?? 0}
                </span>
              </div>

              {/* PHASE 1 & 6: Evidence Levels Histogram (V3/V2/V1/V0) + Link-State Histogram (alive/blocked/dead) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {breakdown.evidenceLevelHistogram && (
                  <div
                    data-testid="evidence-level-histogram"
                    className="bg-white p-2.5 rounded-lg border border-slate-200"
                  >
                    <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                      توزيع مستويات الأدلة البصرية (Evidence Levels — V3/V2 فقط تُقبل):
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold font-mono">
                        V3 (&ge;2 إطارات): {breakdown.evidenceLevelHistogram.V3 ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200 font-bold font-mono">
                        V2 (إطار/صورة): {breakdown.evidenceLevelHistogram.V2 ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-mono">
                        V1 (نص فقط — مخفي): {breakdown.evidenceLevelHistogram.V1 ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300 font-mono">
                        V0 (بدون ميديا): {breakdown.evidenceLevelHistogram.V0 ?? 0}
                      </span>
                    </div>
                  </div>
                )}

                {breakdown.linkStateHistogram && (
                  <div
                    data-testid="link-state-histogram"
                    className="bg-white p-2.5 rounded-lg border border-slate-200"
                  >
                    <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                      حالة الروابط (Link States — التمييز بين المعطل 404 والمحجوب 403):
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold font-mono">
                        alive (يعمل): {breakdown.linkStateHistogram.alive ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold font-mono">
                        blocked (تحدي خادم 403): {breakdown.linkStateHistogram.blocked ?? 0}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 font-bold font-mono">
                        dead (معطل 404): {breakdown.linkStateHistogram.dead ?? 0}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* PHASE 6: Per-Attribute Rejection Histogram */}
              {breakdown.perAttributeRejectionHistogram &&
                breakdown.perAttributeRejectionHistogram.length > 0 && (
                  <div
                    data-testid="per-attribute-rejection-histogram"
                    className="bg-white p-2.5 rounded-lg border border-slate-200"
                  >
                    <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                      أسباب الاستبعاد حسب كل سمة مميزة (Per-Discriminator / Attribute Rejections):
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {Object.entries(breakdown.perAttributeRejectionHistogram).map(([attribute,count], idx) => (
                        <span
                          key={`${attribute}-${idx}`}
                          className="px-2 py-0.5 rounded border font-mono bg-amber-50 text-amber-800 border-amber-200"
                        >
                          [{attribute}] {attribute}: {count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

              {/* PHASE 5.2: Verdict Tiers Breakdown */}
              {breakdown.tierCounts && (
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 mb-1.5">
                    <Layers className="w-3.5 h-3.5 text-[#247C72]" />
                    <span>توزيع درجات التطابق البصري (Verdict Tiers — سلم التخفيف التلقائي: مرحلة {breakdown.relaxationPassesRun || 1}):</span>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                      مطابق تماماً (exact • V3): {breakdown.tierCounts.exact || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200 font-bold">
                      نفس التصميم بلون/نسخة (same_design_variant • V2+): {breakdown.tierCounts.same_design_variant || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                      نفس الفئة بتصميم قريب (same_type_close_design): {breakdown.tierCounts.same_type_close_design || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-orange-50 text-orange-800 border border-orange-200 font-bold">
                      نفس الفئة بتصميم آخر (same_type_other_design): {breakdown.tierCounts.same_type_other_design || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                      فئة مختلفة (other_type): {breakdown.tierCounts.other_type || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200">
                      غير مرتبط (unrelated): {breakdown.tierCounts.unrelated || 0}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300">
                      غير متحقق منه (unverified): {breakdown.tierCounts.unverified || 0}
                    </span>
                  </div>
                </div>
              )}

              {/* PHASE 1.2 & 1.3: Interactive Reason Code Histogram Chips (Click a chip to inspect example items) */}
              {breakdown.reasonHistograms && breakdown.reasonHistograms.length > 0 && (
                <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                  <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                    توزيع أسباب الاستبعاد والأخطاء (اضغط على أي سبب لعرض أمثلة بالصور):
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {breakdown.reasonHistograms.map((entry) => {
                      const isSelected = selectedReasonChip === entry.reasonCode;
                      return (
                        <button
                          key={entry.reasonCode}
                          type="button"
                          onClick={() => setSelectedReasonChip(isSelected ? null : entry.reasonCode)}
                          data-testid={`reason-chip-${entry.reasonCode}`}
                          className={`text-[11px] px-2.5 py-1 rounded-lg border font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                            isSelected
                              ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                              : entry.isErrorNotRejection
                              ? 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                              : 'bg-red-50/70 text-red-800 border-red-200 hover:bg-red-100'
                          }`}
                        >
                          <span>{entry.labelAr}</span>
                          <span className="font-mono text-[10px] opacity-80">({entry.reasonCode})</span>
                          <span className="px-1.5 py-0.2 rounded bg-black/10 font-mono">{entry.count}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Expanded 3 Examples for Selected Reason Chip */}
                  {activeReasonEntry && (
                    <div className="mt-2.5 p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-bold text-slate-800">
                          أمثلة على السبب: {activeReasonEntry.labelAr} ({activeReasonEntry.reasonCode}) — الإجمالي: {activeReasonEntry.count}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedReasonChip(null)}
                          className="text-[10px] text-slate-500 hover:text-slate-800 cursor-pointer"
                        >
                          إغلاق
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {activeReasonEntry.examples.map((ex) => (
                          <div key={ex.id} className="bg-white p-2 rounded border border-slate-200 flex gap-2 items-start">
                            {ex.imageUrl ? (
                              <img
                                src={ex.imageUrl}
                                alt={ex.title}
                                className="w-12 h-12 object-contain rounded bg-slate-50 border border-slate-100 shrink-0"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded bg-slate-100 flex items-center justify-center text-[9px] text-slate-400 shrink-0">
                                بلا صورة
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] font-mono text-slate-500 truncate">
                                {ex.id} [{ex.source}]
                              </div>
                              <a
                                href={ex.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-bold text-slate-800 hover:text-[#247C72] line-clamp-1"
                                title={ex.title}
                              >
                                {ex.title}
                              </a>
                              <div className="text-[10px] text-red-700 line-clamp-2 mt-0.5" title={ex.reasonAr}>
                                {ex.reasonAr}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* PHASE 4.1: TikTok Funnel by Provider */}
              {breakdown.tiktokProviderFunnels && breakdown.tiktokProviderFunnels.length > 0 && (
                <div
                  data-testid="tiktok-provider-funnel-panel"
                  className="bg-white p-2.5 rounded-lg border border-pink-200 space-y-2"
                >
                  <div className="text-[11px] font-bold text-pink-950">
                    قمع تيك توك التفصيلي حسب المزود (SERP → URLs Parsed → oEmbed OK → Pre-Ranked → Frame Check → Accepted):
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px] text-right border-collapse">
                      <thead>
                        <tr className="bg-pink-50 text-pink-950 border-b border-pink-200">
                          <th className="py-1 px-2 font-bold">المزود</th>
                          <th className="py-1 px-2 font-bold">SERP خام</th>
                          <th className="py-1 px-2 font-bold">روابط مستخرجة</th>
                          <th className="py-1 px-2 font-bold">oEmbed صالح</th>
                          <th className="py-1 px-2 font-bold">Pre-Ranked</th>
                          <th className="py-1 px-2 font-bold">فحص الإطارات</th>
                          <th className="py-1 px-2 font-bold text-emerald-700">مقبول (V2/V3)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pink-100">
                        {breakdown.tiktokProviderFunnels.map((tf, idx) => (
                          <tr key={`${tf.provider}-${idx}`} className="hover:bg-pink-50/40">
                            <td className="py-1 px-2 font-mono font-bold">{tf.provider}</td>
                            <td className="py-1 px-2 font-mono">{tf.serpResults}</td>
                            <td className="py-1 px-2 font-mono">{tf.tiktokUrlsParsed}</td>
                            <td className="py-1 px-2 font-mono">{tf.oembedOk}</td>
                            <td className="py-1 px-2 font-mono">{tf.preRankedPassed}</td>
                            <td className="py-1 px-2 font-mono">{tf.sentToFrameVerification}</td>
                            <td className="py-1 px-2 font-mono font-bold text-emerald-700">{tf.acceptedCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PHASE 1.2: Funnel Per Source / Marketplace / Provider */}
              {showFunnels && breakdown.funnels && breakdown.funnels.length > 0 && (
                <div className="bg-white p-2.5 rounded-lg border border-slate-200 space-y-2">
                  <div className="text-[11px] font-bold text-slate-800">
                    قمع التصفية التفصيلي لكل مصدر وسوق (found → deduped → text pre-filter → local visual → Gemini attribute check → accepted):
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px] text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-700 border-b border-slate-200">
                          <th className="py-1.5 px-2 font-bold">المصدر / السوق</th>
                          <th className="py-1.5 px-2 font-bold">1. المكتشف (Found)</th>
                          <th className="py-1.5 px-2 font-bold">2. بعد التكرار (Dedup)</th>
                          <th className="py-1.5 px-2 font-bold">3. الفلتر النصي</th>
                          <th className="py-1.5 px-2 font-bold">4. البصري المحلي (CLIP)</th>
                          <th className="py-1.5 px-2 font-bold">5. تحقق Gemini</th>
                          <th className="py-1.5 px-2 font-bold text-emerald-700">6. مقبول (Accepted)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {breakdown.funnels.map((f) => {
                          const stageMap = new Map(f.stages.map((s) => [s.stageId, s]));
                          return (
                            <tr key={f.scopeKey} className="hover:bg-slate-50">
                              <td className="py-1.5 px-2 font-bold text-slate-900">{f.labelAr}</td>
                              <td className="py-1.5 px-2 font-mono">{stageMap.get('found')?.outCount ?? 0}</td>
                              <td className="py-1.5 px-2 font-mono">{stageMap.get('deduped')?.outCount ?? 0}</td>
                              <td className="py-1.5 px-2 font-mono">{stageMap.get('text_prefilter')?.outCount ?? 0}</td>
                              <td className="py-1.5 px-2 font-mono">{stageMap.get('local_visual')?.outCount ?? 0}</td>
                              <td className="py-1.5 px-2 font-mono">{stageMap.get('gemini_attribute_check')?.outCount ?? 0}</td>
                              <td className="py-1.5 px-2 font-mono font-bold text-emerald-700">
                                {stageMap.get('accepted')?.outCount ?? 0}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PHASE 3.4 & 4.2: Query Scoreboard (لوحة الاستعلامات: query, platform, results, parsed, probe accepted-rate, final accepted) */}
              {breakdown.queryScoreboard && breakdown.queryScoreboard.length > 0 && (
                <div
                  data-testid="query-scoreboard-panel"
                  className="bg-white p-2.5 rounded-lg border border-slate-200 space-y-2"
                >
                  <div className="text-[11px] font-bold text-slate-800">
                    لوحة الاستعلامات (Query Scoreboard — query, platform, results, parsed, probe accepted-rate, final accepted):
                  </div>
                  <div className="overflow-x-auto max-h-56 overflow-y-auto">
                    <table className="w-full text-[11px] text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 sticky top-0">
                          <th className="py-1 px-2">الاستعلام (Query)</th>
                          <th className="py-1 px-2">المنصة / السوق</th>
                          <th className="py-1 px-2">النتائج (Results)</th>
                          <th className="py-1 px-2">المحللة (Parsed)</th>
                          <th className="py-1 px-2">نسبة قبول الفحص الأولي (Probe Accepted-Rate)</th>
                          <th className="py-1 px-2">المقبول النهائي (Final Accepted)</th>
                          <th className="py-1 px-2">الحالة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {breakdown.queryScoreboard.map((qs, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="py-1 px-2 font-mono text-slate-800 max-w-xs truncate" title={qs.query}>
                              {qs.query}
                            </td>
                            <td className="py-1 px-2 font-mono font-bold">
                              {qs.source || `${qs.source}:${qs.marketplace}`}
                            </td>
                            <td className="py-1 px-2 font-mono">{qs.resultsCount}</td>
                            <td className="py-1 px-2 font-mono">{qs.parsedCount ?? qs.resultsCount}</td>
                            <td className="py-1 px-2 font-mono font-bold text-indigo-700">
                              {Math.round(((qs.probeAcceptedRate ?? qs.precisionProxy) || 0) * 100)}% (CLIP: {qs.avgClipSimilarity || 0})
                            </td>
                            <td className="py-1 px-2 font-mono font-bold text-emerald-700">
                              {qs.acceptedCount ?? qs.acceptedCount}
                            </td>
                            <td className="py-1 px-2 font-mono">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  qs.status === 'ok'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : qs.status === 'blocked'
                                    ? 'bg-red-50 text-red-700'
                                    : 'bg-amber-50 text-amber-800'
                                }`}
                              >
                                {qs.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PHASE 1.5: Visible Query Plan Table */}
              {showQueryPlan && breakdown.queryPlan && breakdown.queryPlan.length > 0 && (
                <div className="bg-white p-2.5 rounded-lg border border-slate-200 space-y-2">
                  <div className="text-[11px] font-bold text-slate-800">
                    خطة الاستعلامات المنفذة (Query Plan — الجولات، الأسواق، الترتيب، الصفحات، العائد):
                  </div>
                  <div className="overflow-x-auto max-h-56 overflow-y-auto">
                    <table className="w-full text-[11px] text-right border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 sticky top-0">
                          <th className="py-1 px-2">الجولة</th>
                          <th className="py-1 px-2">المصدر</th>
                          <th className="py-1 px-2">السوق/المحرك</th>
                          <th className="py-1 px-2">الاستعلام</th>
                          <th className="py-1 px-2">الترتيب</th>
                          <th className="py-1 px-2">صفحات</th>
                          <th className="py-1 px-2">نتائج</th>
                          <th className="py-1 px-2">جديدة</th>
                          <th className="py-1 px-2">فيديوهات</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {breakdown.queryPlan.map((q, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="py-1 px-2 font-mono font-bold text-[#247C72]">{q.round}</td>
                            <td className="py-1 px-2 font-mono">{q.source}</td>
                            <td className="py-1 px-2 font-mono font-bold">{q.marketplace || '-'}</td>
                            <td className="py-1 px-2 font-mono text-slate-800 max-w-xs truncate" title={q.query}>
                              {q.query}
                            </td>
                            <td className="py-1 px-2 font-mono text-slate-500">{q.sortVariant || 'relevance'}</td>
                            <td className="py-1 px-2 font-mono">{q.pagesFetched}</td>
                            <td className="py-1 px-2 font-mono">{q.listingsReturned}</td>
                            <td className="py-1 px-2 font-mono font-bold text-emerald-700">{q.listingsNew}</td>
                            <td className="py-1 px-2 font-mono font-bold text-[#247C72]">{q.videosFound}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Live Execution Logs */}
      {project.logs && project.logs.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowLogs(!showLogs)}
              className="flex items-center gap-1.5 text-xs font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              <Terminal className="w-3.5 h-3.5 text-slate-400" />
              <span>سجل العمليات المباشر ({project.logs.length})</span>
              {showLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleCopyLogs}
              className="flex items-center gap-1 text-[11px] font-medium text-[#247C72] hover:text-[#1E665E] bg-[#EAF3F2] px-2 py-0.5 rounded transition-colors cursor-pointer"
            >
              {copiedLogs ? (
                <>
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span className="text-emerald-700">تم النسخ</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>نسخ السجل</span>
                </>
              )}
            </button>
          </div>
          {showLogs && (
            <div
              className="mt-2 bg-slate-900 text-slate-200 rounded-lg p-2.5 font-mono text-[11px] max-h-36 overflow-y-auto space-y-1"
              dir="ltr"
            >
              {project.logs.map((l, idx) => (
                <div
                  key={`${l.timestamp}-${idx}`}
                  className={`leading-relaxed ${
                    l.level === 'error'
                      ? 'text-red-400'
                      : l.level === 'warn'
                      ? 'text-amber-300'
                      : l.level === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-300'
                  }`}
                >
                  <span className="text-slate-500">[{l.timestamp}]</span> [{l.stage}] {l.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
