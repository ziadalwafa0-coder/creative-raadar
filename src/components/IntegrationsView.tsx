import React from 'react';
import { useApp } from '../context/AppContext.tsx';
import {
  Cpu,
  CheckCircle2,
  AlertTriangle,
  Info,
  ShieldAlert,
  Search,
  Download,
  Eye,
  Key,
  Layers
} from 'lucide-react';

export const IntegrationsView: React.FC = () => {
  const { providers } = useApp();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">المصادر والتكاملات المزودة</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          مراقبة حالة موصلات المتاجر، محركات البحث بالذكاء الاصطناعي، وخوادم التحميل الآمن
        </p>
      </div>

      {/* Honest Architecture Alert */}
      <div className="p-4 rounded-2xl bg-teal-50/70 border border-teal-200 flex items-start gap-3">
        <Info className="w-5 h-5 text-teal-700 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-teal-900 leading-relaxed">
          <p className="font-bold mb-0.5">سياسة الشفافية الهندسية الصارمة (Honest Connector Architecture):</p>
          <p className="text-teal-800">
            تعتمد منصة ReviewScout على تكاملات واقعية مع محرك جيميناي ونظام البحث الأرضي (Google Grounding) لاستكشاف مراجعات أمازون ويوتيوب الحقيقية. لا ندعي الاتصال بأي مزود ما لم تكن قدراته البرمجية مدعومة ومفحوصة بالفعل.
          </p>
        </div>
      </div>

      {/* Providers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {providers.map((p) => {
          const isReady = p.state === 'ready';

          return (
            <div
              key={p.id}
              className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between space-y-4"
            >
              <div>
                {/* Title & Status */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-700 font-bold">
                      <Cpu className="w-4 h-4 text-teal-600" />
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm">{p.nameAr}</h4>
                      <span className="text-[10px] text-slate-400 font-mono">{p.name}</span>
                    </div>
                  </div>

                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                      isReady
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}
                  >
                    {isReady ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                    <span>{isReady ? 'مفعّل وجاهز' : 'يحتاج إعداد'}</span>
                  </span>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed mb-3">
                  {p.descriptionAr}
                </p>

                {/* Supported Operations Matrix */}
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 mb-3">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                    العمليات المدعومة:
                  </span>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${p.supportedOperations.discovery ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      <span className={p.supportedOperations.discovery ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                        استكشاف الروابط (Discovery)
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${p.supportedOperations.reviewAccess ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      <span className={p.supportedOperations.reviewAccess ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                        الوصول للمراجعات (Reviews)
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${p.supportedOperations.visualInspection ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      <span className={p.supportedOperations.visualInspection ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                        الفحص البصري (Inspection)
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${p.supportedOperations.download ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      <span className={p.supportedOperations.download ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                        تنزيل الملف الأصلي (Download)
                      </span>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <p className="text-[11px] text-slate-500 flex items-center gap-1">
                  <Info className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <span>{p.notesAr}</span>
                </p>
              </div>

              {/* Secrets Requirements */}
              {p.requiredSecrets.length > 0 && (
                <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1 text-slate-500">
                    <Key className="w-3.5 h-3.5 text-slate-400" />
                    <span>المفاتيح:</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {p.requiredSecrets.map((s, idx) => (
                      <code key={idx} className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded-sm">
                        {s}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
