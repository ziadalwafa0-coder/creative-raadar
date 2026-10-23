import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Settings, Globe, Shield, HardDrive, Trash2, CheckCircle2, BarChart3, Cpu } from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { lang, setLang, t, showToast, setActiveTab } = useApp();
  const [retentionDays, setRetentionDays] = useState('90');
  const [defaultStrictness, setDefaultStrictness] = useState('color_allowed');

  const handleSaveSettings = () => {
    showToast('تم حفظ إعدادات مساحة العمل بنجاح', 'success');
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">إعدادات مساحة العمل</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          تخصيص لغة الواجهة، معايير المطابقة الافتراضية، وسياسات الاحتفاظ بالملفات
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6 text-xs">
        {/* Language & Layout */}
        <div className="space-y-2">
          <label className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <Globe className="w-4 h-4 text-teal-600" />
            <span>لغة الواجهة والاتجاه (Language & Direction)</span>
          </label>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <button
              type="button"
              onClick={() => setLang('ar')}
              className={`p-3 rounded-xl border text-right transition-all font-bold ${
                lang === 'ar'
                  ? 'border-teal-600 bg-teal-50 text-teal-900'
                  : 'border-slate-200 hover:bg-slate-50 text-slate-600'
              }`}
            >
              <span className="block text-sm">العربية (مصر / الخليج)</span>
              <span className="text-[10px] text-slate-400 font-normal">الاتجاه الافتراضي من اليمين لليسار (RTL)</span>
            </button>

            <button
              type="button"
              onClick={() => setLang('en')}
              className={`p-3 rounded-xl border text-left transition-all font-bold ${
                lang === 'en'
                  ? 'border-teal-600 bg-teal-50 text-teal-900'
                  : 'border-slate-200 hover:bg-slate-50 text-slate-600'
              }`}
            >
              <span className="block text-sm">English (US / UK)</span>
              <span className="text-[10px] text-slate-400 font-normal">Left-to-Right layout (LTR)</span>
            </button>
          </div>
        </div>

        {/* Default Matching Strictness */}
        <div className="space-y-2 pt-4 border-t border-slate-100">
          <label className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-teal-600" />
            <span>درجة المطابقة البصرية الافتراضية للمشاريع الجديدة</span>
          </label>
          <div className="space-y-2 max-w-lg">
            {[
              { id: 'color_allowed', label: 'نفس التصميم مع السماح باختلاف اللون أو المقاس (موصى به للتجارة الإلكترونية)' },
              { id: 'exact', label: 'نفس التصميم ونفس اللون بدقة متطابقة فقط' },
              { id: 'similar_disclosed', label: 'تصاميم مشابهة مع إبراز الفروقات الفيزيائية' },
            ].map((opt) => (
              <label key={opt.id} className="flex items-center gap-2.5 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
                <input
                  type="radio"
                  name="defaultStrictness"
                  checked={defaultStrictness === opt.id}
                  onChange={() => setDefaultStrictness(opt.id)}
                  className="text-teal-600 focus:ring-teal-500"
                />
                <span className="text-slate-800 font-medium">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Media Retention */}
        <div className="space-y-2 pt-4 border-t border-slate-100">
          <label className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-teal-600" />
            <span>فترة الاحتفاظ بالملفات المؤكدة (Media Retention Policy)</span>
          </label>
          <select
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            className="w-full max-w-xs px-3 py-2 rounded-lg border border-slate-200 bg-white font-semibold"
          >
            <option value="30">30 يوماً بعد اكتمال البحث</option>
            <option value="90">90 يوماً (الافتراضي للشركات)</option>
            <option value="180">180 يوماً</option>
            <option value="unlimited">احتفاظ دائم في المكتبة</option>
          </select>
        </div>

        {/* Save Button */}
        <div className="pt-4 border-t border-slate-100 flex items-center justify-between">
          <button
            type="button"
            onClick={handleSaveSettings}
            className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold transition-all shadow-xs cursor-pointer"
          >
            حفظ التغييرات
          </button>
        </div>
      </div>

      {/* Advanced Workspace Tools (Separated from primary flow) */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
        <h3 className="font-bold text-slate-800 text-sm">أدوات مساحة العمل المتقدمة</h3>
        <p className="text-xs text-slate-500">
          يمكنك فحص إحصاءات الملفات وحالة محركات وتكاملات البحث
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('usage')}
            className="flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-teal-500/50 hover:bg-teal-50/30 transition-all text-right cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-600 group-hover:text-white transition-colors">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <span className="block text-xs font-bold text-slate-800">إحصاءات الاستخدام ومساحة التخزين</span>
              <span className="text-[11px] text-slate-400">فحص عدد عمليات البحث والملفات المحفوظة</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('integrations')}
            className="flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-teal-500/50 hover:bg-teal-50/30 transition-all text-right cursor-pointer group"
          >
            <div className="w-9 h-9 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-600 group-hover:text-white transition-colors">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <span className="block text-xs font-bold text-slate-800">حالة محركات البحث والتكاملات</span>
              <span className="text-[11px] text-slate-400">متابعة جاهزية Gemini وAmazon وYouTube</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
