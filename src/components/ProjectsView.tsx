import React from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Project } from '../types/index.ts';
import {
  FolderKanban,
  Trash2,
  Calendar,
  Video,
  Image as ImageIcon
} from 'lucide-react';

export const ProjectsView: React.FC = () => {
  const { projects, setCurrentProject, setActiveTab, refreshProjects, showToast, apiFetch, t } = useApp();

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('تم حذف المشروع', 'info');
        await refreshProjects();
      }
    } catch {
      showToast('فشل حذف المشروع', 'error');
    }
  };

  const handleOpen = (project: Project) => {
    setCurrentProject(project);
    setActiveTab('search');
  };

  const getStatusLabel = (state: Project['jobState']) => {
    switch (state) {
      case 'completed':
        return { text: t.completed, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'completed_partial':
        return { text: t.completedPartial, cls: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'failed':
        return { text: t.failed, cls: 'bg-red-50 text-red-700 border-red-200' };
      case 'cancelled':
        return { text: t.cancelled, cls: 'bg-[#F6F7F4] text-[#616764] border-[#E2E5DF]' };
      case 'idle':
        return { text: 'جاهز', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      default:
        return { text: 'جاري العمل', cls: 'bg-[#EAF3F2] text-[#247C72] border-[#247C72]/30' };
    }
  };

  if (projects.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-[#E2E5DF] p-12 text-center">
        <FolderKanban className="w-10 h-10 text-[#616764] mx-auto mb-3 opacity-60" />
        <h3 className="font-bold text-[#181B1A] text-base mb-1">لا توجد مشاريع محفوظة</h3>
        <p className="text-xs text-[#616764] mb-4">ابدأ بحثاً جديداً لحفظ نتائج المنتجات هنا.</p>
        <button
          onClick={() => {
            setCurrentProject(null);
            setActiveTab('search');
          }}
          className="px-4 py-2 rounded-xl bg-[#247C72] hover:bg-[#1E665E] text-white text-xs font-semibold cursor-pointer"
        >
          بحث جديد
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {projects.map((proj) => {
        const refImg = proj.referenceImages?.[0];
        const candidates = proj.candidates || [];
        const videoCount = candidates.filter((c) => c.mediaType === 'video').length;
        const photoCount = candidates.filter((c) => c.mediaType === 'photo').length;
        const status = getStatusLabel(proj.jobState);

        return (
          <div
            key={proj.id}
            onClick={() => handleOpen(proj)}
            className="bg-white rounded-2xl border border-[#E2E5DF] hover:border-[#247C72]/60 transition-all p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 cursor-pointer"
          >
            <div className="flex items-center gap-3.5 min-w-0">
              {refImg ? (
                <img
                  src={refImg.url}
                  alt={proj.name}
                  className="w-14 h-14 rounded-xl object-cover border border-[#E2E5DF] shrink-0"
                />
              ) : (
                <div className="w-14 h-14 rounded-xl bg-[#F6F7F4] border border-[#E2E5DF] flex items-center justify-center text-[#247C72] shrink-0">
                  <FolderKanban className="w-6 h-6" />
                </div>
              )}

              <div className="min-w-0">
                <h4 className="font-bold text-[#181B1A] text-sm sm:text-base truncate">
                  {proj.name}
                </h4>

                <div className="flex flex-wrap items-center gap-2.5 mt-1.5 text-xs text-[#616764]">
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{new Date(proj.createdAt).toLocaleDateString('ar-EG')}</span>
                  </span>

                  <span className="inline-flex items-center gap-1 font-medium text-[#181B1A]">
                    <Video className="w-3.5 h-3.5 text-[#247C72]" />
                    <span>{videoCount} فيديو</span>
                  </span>

                  <span className="inline-flex items-center gap-1 font-medium text-[#181B1A]">
                    <ImageIcon className="w-3.5 h-3.5 text-[#247C72]" />
                    <span>{photoCount} صور</span>
                  </span>

                  <span className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold ${status.cls}`}>
                    {status.text}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpen(proj);
                }}
                className="px-4 py-2 rounded-xl bg-[#EAF3F2] hover:bg-[#DCECE9] text-[#247C72] text-xs font-semibold transition-colors cursor-pointer"
              >
                فتح المشروع
              </button>

              <button
                type="button"
                onClick={(e) => handleDelete(e, proj.id)}
                className="p-2 rounded-xl text-[#616764] hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                title="حذف المشروع"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
