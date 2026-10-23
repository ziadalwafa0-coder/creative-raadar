import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext.tsx';
import {
  Upload,
  Image as ImageIcon,
  SlidersHorizontal,
  Sparkles,
  Check,
  ChevronDown,
  ChevronUp,
  X,
  Layers,
  Video,
  Camera,
  Shield,
  HelpCircle,
  ExternalLink,
  Info
} from 'lucide-react';
import { MediaType, MatchStrictness, ContentSourcePreference, SearchSettings } from '../types/index.ts';

interface SamplePreset {
  id: string;
  nameAr: string;
  nameEn: string;
  url: string;
  mediaType: MediaType;
  videoCount: number;
  photoCount: number;
  productListingUrl: string;
  notes: string;
}

const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'sample-espresso',
    nameAr: 'ماكينة إسبريسو يدوية محمولة (Portable Espresso Maker)',
    nameEn: 'Portable Handheld Espresso Maker',
    url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=800&q=80',
    mediaType: 'both',
    videoCount: 4,
    photoCount: 6,
    productListingUrl: 'https://www.amazon.com/dp/B07978C553',
    notes: 'البحث عن فيديوهات ضخ القهوة اليدوي وصور الكريمة الحقيقية وتجارب التخييم',
  },
  {
    id: 'sample-headphones',
    nameAr: 'سماعات رأس لاسلكية بخاصية عزل الضوضاء (Wireless ANC Headphones)',
    nameEn: 'Wireless Active Noise Cancelling Headphones',
    url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80',
    mediaType: 'video',
    videoCount: 5,
    photoCount: 4,
    productListingUrl: 'https://www.amazon.com/dp/B08N5WRWNW',
    notes: 'التركيز على مراجعات الميكروفون الحقيقية واختبار جودة عزل الصوت في الشارع',
  },
  {
    id: 'sample-mouse',
    nameAr: 'ماوس لاسلكي مريح للمكتب (Ergonomic Office Mouse)',
    nameEn: 'Ergonomic Wireless Office Mouse',
    url: 'https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=800&q=80',
    mediaType: 'both',
    videoCount: 3,
    photoCount: 5,
    productListingUrl: 'https://www.amazon.com/dp/B09HM94VDS',
    notes: 'البحث عن صور الماوس على مكاتب حقيقية وفيديوهات صوت النقرات الهادئة',
  },
];

export const NewProjectModal: React.FC = () => {
  const {
    t,
    isNewSearchOpen,
    setIsNewSearchOpen,
    setCurrentProject,
    refreshProjects,
    showToast,
    droppedFile,
    setDroppedFile,
  } = useApp();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedImage, setSelectedImage] = useState<{ url: string; base64Data?: string; fileName: string } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [videoCount, setVideoCount] = useState<number>(10);
  const [photoCount, setPhotoCount] = useState<number>(0);
  const [productName, setProductName] = useState<string>('');
  const [productUrl, setProductUrl] = useState<string>('');
  const [userNotes, setUserNotes] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Advanced Settings
  const [strictness, setStrictness] = useState<MatchStrictness>('color_allowed');
  const [contentSources, setContentSources] = useState<ContentSourcePreference>('customer_only');
  const [maxSearchDepth, setMaxSearchDepth] = useState<number>(5);
  const [maxProcessingTime, setMaxProcessingTime] = useState<number>(120);

  // Process dropped file from global window drop if present
  useEffect(() => {
    if (droppedFile) {
      processFile(droppedFile);
      setDroppedFile(null);
    }
  }, [droppedFile]);

  const processFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      showToast('يرجى إفلات ملف صورة صالح (JPEG, PNG, WebP)', 'error');
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      showToast('حجم الصورة كبير جداً (الحد الأقصى 25 ميجابايت)', 'warn');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setSelectedImage({
        url: URL.createObjectURL(file),
        base64Data: base64,
        fileName: file.name,
      });
      showToast('تم التقاط صورة المنتج بنجاح!', 'success');
    };
    reader.readAsDataURL(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      processFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          processFile(file);
          break;
        }
      }
    }
  };

  const handleSelectPreset = (preset: SamplePreset) => {
    setSelectedImage({
      url: preset.url,
      fileName: `${preset.id}.jpg`,
    });
    setProductName(preset.nameAr);
    setProductUrl(preset.productListingUrl);
    setUserNotes(preset.notes);
    setMediaType(preset.mediaType);
    setVideoCount(preset.videoCount);
    setPhotoCount(preset.photoCount);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = productName.trim();
    const cleanUrl = productUrl.trim();

    if (!selectedImage && !cleanName && !cleanUrl) {
      showToast('يرجى كتابة اسم المنتج أو رابطه أو رفع صورة للمنتج', 'warn');
      return;
    }

    setIsSubmitting(true);

    try {
      const settings: Partial<SearchSettings> = {
        strictness,
        contentSources,
        maxSearchDepth,
        maxProcessingTimeSeconds: maxProcessingTime,
      };

      const finalName = cleanName || (selectedImage ? selectedImage.fileName.replace(/\.[^/.]+$/, '') : 'مشروع جديد');

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: finalName,
          referenceImages: selectedImage
            ? [
                {
                  id: `ref-${Date.now()}`,
                  url: selectedImage.url,
                  base64Data: selectedImage.base64Data,
                  mimeType: 'image/jpeg',
                  fileName: selectedImage.fileName,
                },
              ]
            : [],
          mediaTypeRequested: mediaType,
          targetVideoCount: videoCount,
          targetPhotoCount: photoCount,
          userNotes,
          productListingUrl: cleanUrl || undefined,
          settings,
        }),
      });

      if (!res.ok) {
        throw new Error('فشل إنشاء المشروع');
      }

      const createdProject = await res.json();
      setCurrentProject(createdProject);
      await refreshProjects();
      setIsNewSearchOpen(false);

      // Automatically trigger background search
      fetch(`/api/projects/${createdProject.id}/search`, { method: 'POST' }).catch(console.error);

      showToast('بدأت عملية البحث والتحقق من الميديا بنجاح!', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isNewSearchOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-3xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-100 bg-[#FAFAFA]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-600/10 text-teal-700 flex items-center justify-center font-bold">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">{t.navNewSearch}</h2>
              <p className="text-xs text-slate-500">
                {t.tagline}
              </p>
            </div>
          </div>
          <button
            onClick={() => setIsNewSearchOpen(false)}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          onPaste={handlePaste}
          className="p-6 space-y-6 max-h-[82vh] overflow-y-auto"
        >
          {/* 1. Reference Image Upload */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-bold text-slate-900">
                {t.uploadTitle} <span className="text-rose-500">*</span>
              </label>
              <span className="text-[11px] font-semibold text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60">
                يدعم السحب والإفلات (Drag & Drop) أو اللصق (Ctrl+V)
              </span>
            </div>

            {selectedImage ? (
              <div
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`relative rounded-xl border p-4 flex items-center gap-4 transition-all ${
                  isDraggingOver
                    ? 'border-2 border-dashed border-teal-500 bg-teal-100/50 ring-4 ring-teal-500/20'
                    : 'border-teal-200 bg-teal-50/40'
                }`}
              >
                <img
                  src={selectedImage.url}
                  alt="Reference Preview"
                  className="w-24 h-24 object-cover rounded-lg border border-slate-200 shadow-xs"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-teal-800 font-bold text-sm">
                    <Check className="w-4 h-4 text-teal-600" />
                    <span>تم التقاط صورة المنتج المرجعية</span>
                  </div>
                  <p className="text-xs text-slate-500 truncate mt-1">{selectedImage.fileName}</p>
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedImage(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline cursor-pointer"
                    >
                      حذف واختيار صورة أخرى
                    </button>
                    <span className="text-slate-300">|</span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-semibold text-teal-700 hover:text-teal-800 hover:underline cursor-pointer"
                    >
                      تغيير الصورة
                    </button>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 group ${
                  isDraggingOver
                    ? 'border-teal-600 bg-teal-50/80 ring-4 ring-teal-500/20 scale-[1.01]'
                    : 'border-slate-300 hover:border-teal-500 hover:bg-teal-50/20'
                }`}
              >
                <div
                  className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3 transition-all ${
                    isDraggingOver
                      ? 'bg-teal-600 text-white scale-110 shadow-md shadow-teal-600/30'
                      : 'bg-slate-100 group-hover:bg-teal-100 group-hover:text-teal-700 text-slate-500'
                  }`}
                >
                  <Upload className="w-7 h-7" />
                </div>
                {isDraggingOver ? (
                  <div>
                    <p className="text-base font-extrabold text-teal-800 animate-pulse">
                      أفلت صورة المنتج الآن للرفع الفوري!
                    </p>
                    <p className="text-xs text-teal-600 mt-1">اترك الملف لبدء استخراج البيانات والبحث</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-bold text-slate-800">{t.uploadSubtitle}</p>
                    <p className="text-xs text-slate-400 mt-1.5 flex items-center justify-center gap-2">
                      <span>PNG, JPG, WebP (حتى 25 ميجابايت)</span>
                      <span>•</span>
                      <span className="text-teal-700 font-semibold">أو الصق مباشرة بالضغط على Ctrl+V</span>
                    </p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
            )}

            {/* Quick Demo Presets */}
            <div className="mt-3.5">
              <span className="text-xs font-semibold text-slate-500 block mb-2">{t.orUseSample}</span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {SAMPLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleSelectPreset(preset)}
                    className="flex items-center gap-2.5 p-2 rounded-lg border border-slate-200 hover:border-teal-400 hover:bg-teal-50/40 text-right transition-all text-xs group"
                  >
                    <img
                      src={preset.url}
                      alt={preset.nameAr}
                      className="w-10 h-10 rounded-md object-cover border border-slate-200 flex-shrink-0"
                    />
                    <div className="truncate">
                      <p className="font-bold text-slate-800 group-hover:text-teal-700 truncate">
                        {preset.nameAr.split('(')[0]}
                      </p>
                      <span className="text-[10px] text-slate-400 block truncate">{preset.nameEn}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 2. Media Type Selection */}
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-2">{t.mediaTypeLabel}</label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: 'video', label: t.typeVideos, icon: Video },
                { id: 'photo', label: t.typePhotos, icon: Camera },
                { id: 'both', label: t.typeBoth, icon: Layers },
              ].map((item) => {
                const Icon = item.icon;
                const isSelected = mediaType === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMediaType(item.id as MediaType)}
                    className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 transition-all cursor-pointer ${
                      isSelected
                        ? 'border-teal-600 bg-teal-50/60 text-teal-900 shadow-xs'
                        : 'border-slate-200 hover:border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className={`w-5 h-5 mb-1.5 ${isSelected ? 'text-teal-600' : 'text-slate-400'}`} />
                    <span className="text-xs font-bold">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Desired Count Pickers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(mediaType === 'video' || mediaType === 'both') && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  {t.videoCountLabel}
                </label>
                <div className="flex items-center gap-2">
                  {[3, 5, 10, 15].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setVideoCount(cnt)}
                      className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all ${
                        videoCount === cnt
                          ? 'bg-teal-600 text-white border-teal-600 shadow-xs'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {cnt}
                    </button>
                  ))}
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={videoCount}
                    onChange={(e) => setVideoCount(Number(e.target.value))}
                    className="w-16 py-1.5 px-2 text-center text-xs font-bold rounded-lg border border-slate-200 focus:outline-teal-500"
                  />
                </div>
              </div>
            )}

            {(mediaType === 'photo' || mediaType === 'both') && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  {t.photoCountLabel}
                </label>
                <div className="flex items-center gap-2">
                  {[4, 8, 12, 20].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setPhotoCount(cnt)}
                      className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all ${
                        photoCount === cnt
                          ? 'bg-teal-600 text-white border-teal-600 shadow-xs'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {cnt}
                    </button>
                  ))}
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={photoCount}
                    onChange={(e) => setPhotoCount(Number(e.target.value))}
                    className="w-16 py-1.5 px-2 text-center text-xs font-bold rounded-lg border border-slate-200 focus:outline-teal-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 4. Optional Helper Details */}
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <span className="text-xs font-bold text-slate-600 block">{t.optionalFields}</span>

            <input
              type="text"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder={t.productNamePlaceholder}
              className="w-full text-xs px-3.5 py-2.5 rounded-lg border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden"
            />

            <input
              type="url"
              value={productUrl}
              onChange={(e) => setProductUrl(e.target.value)}
              placeholder={t.productUrlPlaceholder}
              className="w-full text-xs px-3.5 py-2.5 rounded-lg border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden"
            />

            <textarea
              rows={2}
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder={t.notesPlaceholder}
              className="w-full text-xs px-3.5 py-2 rounded-lg border border-slate-200 focus:border-teal-500 focus:ring-1 focus:ring-teal-500 focus:outline-hidden resize-none"
            />
          </div>

          {/* 5. Advanced Search Settings (Expandable) */}
          <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/50">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-bold text-slate-700 hover:bg-slate-100/70 transition-colors"
            >
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-teal-600" />
                <span>{t.searchSettings}</span>
              </div>
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvanced && (
              <div className="p-4 pt-2 border-t border-slate-200 space-y-4 text-xs">
                {/* A. Strictness */}
                <div>
                  <label className="font-bold text-slate-800 block mb-1.5">
                    {t.matchingStrictnessTitle}
                  </label>
                  <div className="space-y-1.5">
                    {[
                      { id: 'color_allowed', label: t.strictnessColor },
                      { id: 'exact', label: t.strictnessExact },
                      { id: 'similar_disclosed', label: t.strictnessSimilar },
                    ].map((s) => (
                      <label key={s.id} className="flex items-center gap-2 cursor-pointer text-slate-600">
                        <input
                          type="radio"
                          name="strictness"
                          checked={strictness === s.id}
                          onChange={() => setStrictness(s.id as MatchStrictness)}
                          className="text-teal-600 focus:ring-teal-500"
                        />
                        <span>{s.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* B. Content Source */}
                <div>
                  <label className="font-bold text-slate-800 block mb-1.5">
                    {t.contentSourceTitle}
                  </label>
                  <div className="space-y-1.5">
                    {[
                      { id: 'customer_only', label: t.sourceCustomerOnly },
                      { id: 'customer_and_creator', label: t.sourceCustomerAndCreator },
                      { id: 'all_including_seller', label: t.sourceAllIncludingSeller },
                    ].map((src) => (
                      <label key={src.id} className="flex items-center gap-2 cursor-pointer text-slate-600">
                        <input
                          type="radio"
                          name="contentSources"
                          checked={contentSources === src.id}
                          onChange={() => setContentSources(src.id as ContentSourcePreference)}
                          className="text-teal-600 focus:ring-teal-500"
                        />
                        <span>{src.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* C. Source Priority & Budget */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200">
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">{t.maxDepth}</label>
                    <input
                      type="number"
                      min="1"
                      max="15"
                      value={maxSearchDepth}
                      onChange={(e) => setMaxSearchDepth(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 bg-white"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">{t.maxTime}</label>
                    <input
                      type="number"
                      min="30"
                      max="600"
                      value={maxProcessingTime}
                      onChange={(e) => setMaxProcessingTime(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 bg-white"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Primary Action Button */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting || (!selectedImage && !productName.trim() && !productUrl.trim())}
              className={`w-full py-3.5 px-6 rounded-xl font-bold text-white text-sm shadow-md transition-all flex items-center justify-center gap-2 ${
                isSubmitting || (!selectedImage && !productName.trim() && !productUrl.trim())
                  ? 'bg-slate-300 cursor-not-allowed text-slate-500 shadow-none'
                  : 'bg-teal-600 hover:bg-teal-700 active:scale-[0.99] shadow-teal-600/25 cursor-pointer'
              }`}
            >
              <Sparkles className="w-5 h-5" />
              <span>{isSubmitting ? 'جاري تجهيز المشروع...' : t.startSearch}</span>
            </button>
            <p className="text-[11px] text-slate-400 text-center mt-2 flex items-center justify-center gap-1">
              <Shield className="w-3.5 h-3.5 text-teal-600" />
              <span>تعتمد المنصة على التحليل الفيزيائي الصارم ولا تقوم باختلاق أو توليد ميديا وهمية.</span>
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
