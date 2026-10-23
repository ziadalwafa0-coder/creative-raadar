import React from 'react';
import { useApp } from '../context/AppContext.tsx';
import { HardDrive, Download, Search, CheckCircle2, Shield, Info, Layers } from 'lucide-react';

export const UsageView: React.FC = () => {
  const { usage, projects, library } = useApp();

  const searchesCount = usage?.monthlySearchesUsed || 0;
  const verifiedCount = library.length;
  const storageUsedMB = Math.round((usage?.storageUsedBytes || 0) / (1024 * 1024));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">إحصائيات مساحة العمل</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          متابعة مباشرة لنشاط البحث وتنزيل الوسائط المؤكدة في جلستك الحالية
        </p>
      </div>

      {/* Gauges Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Metric 1: Searches */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-600">عمليات البحث المنفذة</span>
            <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center">
              <Search className="w-4 h-4" />
            </div>
          </div>

          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-black text-slate-900">{searchesCount}</span>
            <span className="text-xs text-slate-400">عملية بحث</span>
          </div>

          <span className="text-[11px] text-slate-500">بحث ميديا نشط بدون اشتراكات أو قيود وهمية</span>
        </div>

        {/* Metric 2: Verified Downloads */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-600">الفيديوهات المحملة المؤكدة</span>
            <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center">
              <Download className="w-4 h-4" />
            </div>
          </div>

          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-black text-slate-900">{verifiedCount}</span>
            <span className="text-xs text-slate-400">ملف MP4 جاهز</span>
          </div>

          <span className="text-[11px] text-slate-500">تم التحقق من بصمتها وحجمها على الخادم</span>
        </div>

        {/* Metric 3: Storage */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-600">المساحة الفعلية المستخدمة</span>
            <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-700 flex items-center justify-center">
              <HardDrive className="w-4 h-4" />
            </div>
          </div>

          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-black text-slate-900">{storageUsedMB}</span>
            <span className="text-xs text-slate-400">ميجابايت (MB)</span>
          </div>

          <span className="text-[11px] text-slate-500">حجم ملفات الفيديو المحفوظة في مساحة العمل</span>
        </div>
      </div>

      {/* Transparent Policy Card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 border border-teal-200 font-bold text-xs">
              استخدام مفتوح لرواد العمل
            </span>
            <span className="text-xs text-emerald-600 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>مساحة عمل معزولة ومحمية</span>
            </span>
          </div>
          <p className="text-xs text-slate-600 max-w-xl">
            المنصة متاحة للاستخدام المباشر لكل من يملك الرابط؛ لكل زائر جلسة مستقلة ومعزولة تضمن خصوصية مشاريعك وتنزيلاتك. تخضع طلبات البحث لحصص الاستعلام ومعدلات حماية الخوادم الخارجية.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 px-3.5 py-2.5 rounded-xl border border-slate-200">
          <Info className="w-4 h-4 text-teal-700 flex-shrink-0" />
          <span>في حال نفاد حصة الاستعلام المؤقتة (429)، يمكنك دائماً إضافة الروابط يدوياً دون أي توقف.</span>
        </div>
      </div>
    </div>
  );
};
