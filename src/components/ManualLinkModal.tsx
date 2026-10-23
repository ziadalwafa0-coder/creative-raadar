import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { ProvenanceClassification } from '../types/index.ts';
import {
  Link as LinkIcon,
  X,
  Plus,
  ShieldCheck,
  Video,
  FileCheck,
  AlertCircle,
  HelpCircle,
  ExternalLink
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
}

export const ManualLinkModal: React.FC<Props> = ({ isOpen, onClose, projectId }) => {
  const { currentProject, setCurrentProject, refreshProjects, showToast, apiFetch } = useApp();

  const [sourceUrl, setSourceUrl] = useState('');
  const [directMediaUrl, setDirectMediaUrl] = useState('');
  const [title, setTitle] = useState('');
  const [reviewerOrChannel, setReviewerOrChannel] = useState('');
  const [provenance, setProvenance] = useState<ProvenanceClassification>('unresolved_source');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  let activeProjectId = projectId || currentProject?.id;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      showToast('يرجى إدخال رابط المصدر', 'warn');
      return;
    }

    setIsSubmitting(true);

    try {
      if (!activeProjectId) {
        const created = await apiFetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title.trim() || 'فيديوهات مضافة بروابط', mediaTypeRequested: 'video', targetVideoCount: 10 }) });
        if (!created.ok) throw new Error('تعذر إنشاء مشروع للروابط');
        const project = await created.json(); activeProjectId = project.id; setCurrentProject(project);
      }
      const res = await apiFetch(`/api/projects/${activeProjectId}/manual-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceUrl: sourceUrl.trim(),
          directMediaUrl: directMediaUrl.trim() || undefined,
          title: title.trim() || undefined,
          reviewerOrChannel: reviewerOrChannel.trim() || undefined,
          provenance,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'فشلت إضافة الرابط');
      }

      showToast('تمت إضافة رابط المراجعة بنجاح!', 'success');
      setSourceUrl('');
      setDirectMediaUrl('');
      setTitle('');
      setReviewerOrChannel('');
      const updated = await apiFetch(`/api/projects/${activeProjectId}`);
      if (updated.ok) setCurrentProject(await updated.json());
      await refreshProjects();
      onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6" dir="rtl">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-100 bg-[#FAFAFA]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold border border-teal-200/50">
              <LinkIcon className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-base">إضافة روابط مراجعات يدوياً</h3>
              <p className="text-[11px] text-slate-500">
                أضف روابط مراجعات العملاء مباشرة دون الاعتماد على حصة الذكاء الاصطناعي
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {/* Source Link */}
          <div>
            <label className="font-bold text-slate-800 block mb-1.5">
              رابط صفحة المراجعة أو المنتج <span className="text-rose-500">*</span>
            </label>
            <input
              type="url"
              required
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://www.amazon.eg/gp/customer-reviews/... أو رابط فيديو يوتيوب"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden text-slate-800"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              يدعم روابط مراجعات أمازون، فيديوهات العملاء، روابط يوتيوب، أو صفحات التقييمات.
            </p>
          </div>

          {/* Optional Direct Media Link */}
          <div>
            <label className="font-bold text-slate-800 block mb-1.5 flex items-center justify-between">
              <span>رابط ملف الفيديو المباشر (اختياري)</span>
              <span className="text-[11px] font-normal text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md">
                MP4 أو بث HLS (.m3u8)
              </span>
            </label>
            <input
              type="url"
              value={directMediaUrl}
              onChange={(e) => setDirectMediaUrl(e.target.value)}
              placeholder="https://.../video.mp4 أو رابط m.media-amazon.com"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden text-slate-800"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              إذا لم يتوفر رابط مباشر، سيظل الرابط محفوظاً كمصدر للمشاهدة دون اعتباره ملفاً تم سحبه.
            </p>
          </div>

          {/* Provenance Classification */}
          <div>
            <label className="font-bold text-slate-800 block mb-1.5">
              نوع المصدر — حسب ما يظهر في الصفحة
            </label>
            <select
              value={provenance}
              onChange={(e) => setProvenance(e.target.value as ProvenanceClassification)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden text-slate-800 bg-white"
            >
              <option value="unresolved_source">مصدر لم يتم التحقق من نوعه بعد</option>
              <option value="unverified_customer_review">مراجعة عميل غير موسومة (Customer Review)</option>
              <option value="vine_free_product">عضو برنامج أمازون فاين للمنتجات المجانية (Amazon Vine)</option>
              <option value="affiliate_creator_demo">صانع محتوى / مسوق بالعمولة (Creator Demo)</option>
              <option value="seller_manufacturer_demo">فيديو البائع أو المصنع الرسمي (Seller Demo)</option>
            </select>
          </div>

          {/* Reviewer Name & Title */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="font-bold text-slate-700 block mb-1">اسم المشتري أو القناة:</label>
              <input
                type="text"
                value={reviewerOrChannel}
                onChange={(e) => setReviewerOrChannel(e.target.value)}
                placeholder="اسم صاحب الفيديو، إن ظهر"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden"
              />
            </div>
            <div>
              <label className="font-bold text-slate-700 block mb-1">عنوان أو ملخص المراجعة:</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="مثال: تجربة فتح العلبة واستخدام 3 أشهر"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden"
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className={`w-full py-3 px-4 rounded-xl font-bold text-white text-xs flex items-center justify-center gap-2 shadow-sm transition-all cursor-pointer ${
                isSubmitting ? 'bg-slate-300' : 'bg-teal-600 hover:bg-teal-700 shadow-teal-600/20'
              }`}
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>{isSubmitting ? 'جاري الفحص والإضافة...' : 'إضافة الرابط إلى المشروع'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
