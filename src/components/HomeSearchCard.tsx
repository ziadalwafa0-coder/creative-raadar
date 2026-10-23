import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Upload, X, RefreshCw, Video, Image as ImageIcon, Layers } from 'lucide-react';
import { Project } from '../types/index.ts';

export const HomeSearchCard: React.FC = () => {
  const { setCurrentProject, setActiveTab, showToast, apiFetch, droppedFile, setDroppedFile } = useApp();

  const [productName, setProductName] = useState('');
  const [mediaType, setMediaType] = useState<Project['mediaTypeRequested']>('both');
  const [targetVideoInput, setTargetVideoInput] = useState<string>('10');
  const [targetPhotoInput, setTargetPhotoInput] = useState<string>('10');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setValidationError('يرجى اختيار ملف صورة صالح');
      return;
    }
    setValidationError(null);
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    if (droppedFile) {
      handleImageFile(droppedFile);
      setDroppedFile(null);
    }
  }, [droppedFile]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleImageFile(e.target.files?.[0]);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    handleImageFile(e.dataTransfer.files?.[0]);
  };

  const clampCount = (rawVal: string | number) => {
    const val = typeof rawVal === 'string' ? parseInt(rawVal.trim(), 10) : rawVal;
    if (Number.isNaN(val) || val < 1) return 10;
    return Math.max(1, Math.min(500, Math.floor(val)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = productName.trim();

    if (!trimmed && !imagePreview) {
      setValidationError('يرجى إدخال اسم المنتج أو رفع صورته للبدء');
      return;
    }

    setValidationError(null);
    setIsSubmitting(true);

    const isUrl = /^https?:\/\//i.test(trimmed);
    const safeVideoCount = clampCount(targetVideoInput);
    const safePhotoCount = clampCount(targetPhotoInput);
    setTargetVideoInput(String(safeVideoCount));
    setTargetPhotoInput(String(safePhotoCount));

    try {
      const detectedMime =
        imagePreview?.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i)?.[1] || 'image/jpeg';
      const referenceImages = imagePreview
        ? [
            {
              id: `img-${Date.now()}`,
              url: imagePreview,
              base64Data: imagePreview,
              mimeType: detectedMime,
              isPrimary: true,
              label: 'صورة المنتج',
            },
          ]
        : [];

      const res = await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed || 'بحث بالصورة',
          referenceImages,
          productListingUrl: isUrl ? trimmed : undefined,
          mediaTypeRequested: mediaType,
          targetVideoCount: safeVideoCount,
          targetPhotoCount: safePhotoCount,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'تعذر إنشاء المشروع');
      }

      const project = await res.json();
      setCurrentProject(project);
      setActiveTab('search');

      await apiFetch(`/api/projects/${project.id}/search`, {
        method: 'POST',
      });

      const updatedRes = await apiFetch(`/api/projects/${project.id}`);
      if (updatedRes.ok) {
        const updatedProj = await updatedRes.json();
        setCurrentProject(updatedProj);
      }
    } catch (error: any) {
      showToast(error.message || 'حدث خطأ أثناء بدء البحث', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[760px] mx-auto">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl border border-[#E2E5DF] shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5 sm:p-7 space-y-5"
      >
        {/* 1) Large Drag/Drop Product Image Box */}
        <div>
          <label className="block text-sm font-semibold text-[#181B1A] mb-2">
            صورة المنتج
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
          />

          {!imagePreview ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed transition-all p-7 sm:p-9 text-center flex flex-col items-center justify-center gap-2.5 ${
                isDragging
                  ? 'border-[#247C72] bg-[#EAF3F2]/50'
                  : 'border-[#D5D9D2] bg-[#FAFBF9] hover:border-[#247C72]/60 hover:bg-[#F6F7F4]'
              }`}
            >
              <div className="w-11 h-11 rounded-xl bg-[#EAF3F2] text-[#247C72] flex items-center justify-center">
                <Upload className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-[#181B1A]">
                اسحب وأفلت صورة المنتج هنا، أو اضغط للاختيار
              </p>
              <p className="text-xs text-[#616764]">PNG, JPG, WEBP</p>
            </div>
          ) : (
            <div className="rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3.5 min-w-0">
                <img
                  src={imagePreview}
                  alt="معاينة المنتج"
                  className="w-16 h-16 rounded-lg object-cover border border-[#E2E5DF] bg-white shrink-0"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#181B1A] truncate">
                    تم إرفاق صورة المنتج
                  </p>
                  <p className="text-xs text-[#616764] mt-0.5">
                    جاهزة للبحث والمطابقة
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-[#E2E5DF] text-[#181B1A] hover:bg-[#F6F7F4] flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>استبدال</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImagePreview(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-[#E2E5DF] text-red-600 hover:bg-red-50 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>إزالة</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 2) Product Name Field */}
        <div>
          <label
            htmlFor="product-name-input"
            className="block text-sm font-semibold text-[#181B1A] mb-2"
          >
            اسم المنتج
          </label>
          <input
            id="product-name-input"
            type="text"
            value={productName}
            onChange={(e) => {
              setProductName(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder="أدخل اسم المنتج أو رابط الصفحة..."
            className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
          />
        </div>

        {/* 3) Media Type Selector (فيديوهات / صور / الاثنين) */}
        <div>
          <label className="block text-sm font-semibold text-[#181B1A] mb-2">
            نوع النتائج
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            <button
              type="button"
              onClick={() => setMediaType('video')}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                mediaType === 'video'
                  ? 'bg-[#EAF3F2] border-[#247C72] text-[#247C72] font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <Video className="w-4 h-4" />
              <span>فيديوهات</span>
            </button>
            <button
              type="button"
              onClick={() => setMediaType('photo')}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                mediaType === 'photo'
                  ? 'bg-[#EAF3F2] border-[#247C72] text-[#247C72] font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <ImageIcon className="w-4 h-4" />
              <span>صور</span>
            </button>
            <button
              type="button"
              onClick={() => setMediaType('both')}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                mediaType === 'both'
                  ? 'bg-[#EAF3F2] border-[#247C72] text-[#247C72] font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>الاثنين</span>
            </button>
          </div>
        </div>

        {/* 4) Independent Video & Photo Counts (1..500, default 10) */}
        <div
          className={`grid gap-3 ${
            mediaType === 'both' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'
          }`}
        >
          {(mediaType === 'video' || mediaType === 'both') && (
            <div>
              <label
                htmlFor="target-video-count"
                className="block text-sm font-semibold text-[#181B1A] mb-1.5"
              >
                عدد الفيديوهات
              </label>
              <input
                id="target-video-count"
                type="number"
                min={1}
                max={500}
                value={targetVideoInput}
                onChange={(e) => setTargetVideoInput(e.target.value)}
                onBlur={() => setTargetVideoInput(String(clampCount(targetVideoInput)))}
                className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm font-medium text-[#181B1A] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
              />
            </div>
          )}

          {(mediaType === 'photo' || mediaType === 'both') && (
            <div>
              <label
                htmlFor="target-photo-count"
                className="block text-sm font-semibold text-[#181B1A] mb-1.5"
              >
                عدد الصور
              </label>
              <input
                id="target-photo-count"
                type="number"
                min={1}
                max={500}
                value={targetPhotoInput}
                onChange={(e) => setTargetPhotoInput(e.target.value)}
                onBlur={() => setTargetPhotoInput(String(clampCount(targetPhotoInput)))}
                className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm font-medium text-[#181B1A] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
              />
            </div>
          )}
        </div>

        {validationError && (
          <p className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {validationError}
          </p>
        )}

        {/* 5) Single Primary Button: ابدأ البحث */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full h-12 rounded-xl bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white font-semibold text-sm transition-colors flex items-center justify-center cursor-pointer"
        >
          {isSubmitting ? 'جاري بدء البحث...' : 'ابدأ البحث'}
        </button>
      </form>
    </div>
  );
};
