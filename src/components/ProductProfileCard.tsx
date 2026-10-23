import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { VisualAttribute, Project } from '../types/index.ts';
import {
  CheckCircle2,
  Edit3,
  Save,
  Tag,
  Box,
  Eye,
  Sliders,
  AlertCircle,
  HelpCircle,
  Sparkles,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

interface Props {
  project: Project;
}

export const ProductProfileCard: React.FC<Props> = ({ project }) => {
  const { t, showToast, commitProject, getSelectionEpoch, refreshProjects, apiFetch } = useApp();
  const profile = project.productProfile;

  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [formData, setFormData] = useState<VisualAttribute | undefined>(profile);
  const [isSaving, setIsSaving] = useState(false);

  if (!profile) return null;

  const handleSave = async () => {
    if (!formData) return;
    const epoch = getSelectionEpoch();
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productProfile: formData }),
      });
      if (res.ok) {
        const updated = await res.json();
        if (!commitProject(updated, epoch)) return;
        await refreshProjects();
        setIsEditing(false);
        showToast('تم حفظ تعديلات مواصفات المنتج بنجاح!', 'success');
      }
    } catch (err) {
      showToast('فشل حفظ التعديلات', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const confidenceColor =
    profile.confidence === 'high'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : profile.confidence === 'medium'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden mb-6">
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-100 bg-[#FAFAFA] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-teal-600/10 text-teal-700 flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-slate-900 text-sm sm:text-base">
                {t.productProfileTitle}
              </h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${confidenceColor}`}>
                دقة التعرف: {profile.confidence === 'high' ? 'عالية' : profile.confidence === 'medium' ? 'متوسطة' : 'منخفضة'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{t.editableNotice}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isEditing ? (
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold shadow-xs cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'جاري الحفظ...' : 'حفظ التعديلات'}</span>
            </button>
          ) : (
            <button
              onClick={() => {
                setFormData(profile);
                setIsEditing(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>تعديل المواصفات</span>
            </button>
          )}

          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          >
            {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-5 sm:p-6 space-y-5 text-xs">
          {isEditing && formData ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="font-bold text-slate-700 block mb-1">الاسم بالعربية:</label>
                  <input
                    type="text"
                    value={formData.suggestedNameAr}
                    onChange={(e) => setFormData({ ...formData, suggestedNameAr: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-700 block mb-1">الاسم بالإنجليزية:</label>
                  <input
                    type="text"
                    value={formData.suggestedNameEn}
                    onChange={(e) => setFormData({ ...formData, suggestedNameEn: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200"
                  />
                </div>
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">الهندسة والتصميم الفيزيائي:</label>
                <input
                  type="text"
                  value={formData.distinctiveGeometry}
                  onChange={(e) => setFormData({ ...formData, distinctiveGeometry: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="font-bold text-slate-700 block mb-1">السمات الإلزامية للمطابقة (مفصولة بفاصلة):</label>
                  <textarea
                    rows={2}
                    value={formData.mustMatchAttributes.join(', ')}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        mustMatchAttributes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200"
                  />
                </div>
                <div>
                  <label className="font-bold text-slate-700 block mb-1">الفروقات المسموح بها (مثل الألوان):</label>
                  <textarea
                    rows={2}
                    value={formData.allowedDifferences.join(', ')}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        allowedDifferences: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Column 1: Names & Category */}
              <div className="space-y-3">
                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.categoryLabel}
                  </span>
                  <span className="inline-block px-2.5 py-1 rounded-md bg-slate-100 text-slate-800 font-bold text-xs">
                    {profile.category}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    الاسم المستنتج:
                  </span>
                  <p className="font-extrabold text-slate-900 text-sm leading-snug">
                    {profile.suggestedNameAr}
                  </p>
                  <p className="text-slate-500 text-[11px] font-mono mt-0.5">
                    {profile.suggestedNameEn}
                  </p>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.geometryLabel}
                  </span>
                  <p className="text-slate-700 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                    {profile.distinctiveGeometry}
                  </p>
                </div>
              </div>

              {/* Column 2: Components & Must Match */}
              <div className="space-y-3">
                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.mustMatchLabel}
                  </span>
                  <ul className="space-y-1">
                    {(profile.mustMatchAttributes || []).map((attr, idx) => (
                      <li key={idx} className="flex items-start gap-1.5 text-slate-800">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                        <span>{attr}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.allowedDiffsLabel}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {(profile.allowedDifferences || []).map((diff, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 border border-teal-200/60 font-medium"
                      >
                        {diff}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.materialsLabel}
                  </span>
                  <p className="text-slate-600">{(profile.materials || []).join(' • ')}</p>
                </div>
              </div>

              {/* Column 3: Inferences & Unknowns */}
              <div className="space-y-3 bg-slate-50/70 p-3.5 rounded-xl border border-slate-100">
                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.mechanismLabel}
                  </span>
                  <p className="text-slate-700">{profile.mechanism}</p>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 text-amber-500" />
                    <span>{t.unknownsLabel}</span>
                  </span>
                  <p className="text-slate-500 leading-normal">
                    {(profile.unknownAttributes && profile.unknownAttributes.length > 0)
                      ? profile.unknownAttributes.join(' • ')
                      : 'لا توجد سمات غامضة رئيسية.'}
                  </p>
                </div>

                <div>
                  <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider mb-1">
                    {t.queriesLabel}
                  </span>
                  <div className="space-y-1">
                    {(profile.multilingualQueries?.ar || []).slice(0, 2).map((q, idx) => (
                      <code
                        key={idx}
                        className="block text-[11px] text-teal-900 bg-teal-50/80 px-2 py-1 rounded-sm border border-teal-100 truncate"
                      >
                        {q}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
