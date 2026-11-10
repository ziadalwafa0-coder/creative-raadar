import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext.tsx';
import {
  Upload,
  X,
  RefreshCw,
  Video,
  Image as ImageIcon,
  Layers,
  Link as LinkIcon,
  ExternalLink,
  Sparkles,
  Loader2,
  CheckCircle2,
  Plus,
  ShieldCheck,
  Ban,
} from 'lucide-react';
import { Project, IdentityCardV2Client, MatchMode } from '../types/index.ts';

interface GeminiCommercialIdentity {
  commercialNameEn: string;
  commercialNameAr: string;
  amazonQueries: string[];
  identityCard?: IdentityCardV2Client;
}


export const HomeSearchCard: React.FC = () => {
  const {
    showToast,
    apiFetch,
    droppedFile,
    setDroppedFile,
    startStreamingSearch,
    cancelStreamingSearch,
    autoResolvedProductName,
  } = useApp();

  const [productName, setProductName] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<'amazon' | 'tiktok' | 'all'>('all');
  const [mediaType, setMediaType] = useState<Project['mediaTypeRequested']>('video');
  const [targetVideoInput, setTargetVideoInput] = useState<string>('10');
  const [targetAmazonVideoInput, setTargetAmazonVideoInput] = useState<string>('10');
  const [targetTikTokVideoInput, setTargetTikTokVideoInput] = useState<string>('10');
  const [targetPhotoInput, setTargetPhotoInput] = useState<string>('10');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isIdentifyingImage, setIsIdentifyingImage] = useState(false);
  const [geminiIdentity, setGeminiIdentity] = useState<GeminiCommercialIdentity | null>(null);
  const [mustMatchChips, setMustMatchChips] = useState<string[]>([]);
  const [mustNotBeChips, setMustNotBeChips] = useState<string[]>([]);
  const [attributeStrengths, setAttributeStrengths] = useState<Record<string, 'HARD' | 'SOFT' | 'IGNORE'>>({});
  const [newMustMatchInput, setNewMustMatchInput] = useState('');
  const [newMustNotBeInput, setNewMustNotBeInput] = useState('');
  const [matchMode, setMatchMode] = useState<MatchMode>('same_design');
  const [includeSimilar, setIncludeSimilar] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [identityFailedErrorAr, setIdentityFailedErrorAr] = useState<string | null>(null);
  const [showManualIdentityForm, setShowManualIdentityForm] = useState<boolean>(false);
  const [manualFormFactor, setManualFormFactor] = useState<string>('');
  const [manualMechanism, setManualMechanism] = useState<string>('');
  const [geminiBudget, setGeminiBudget] = useState<{
    used: number;
    max: number;
    remaining: number;
    exhausted: boolean;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const identifyPromiseRef = useRef<Promise<GeminiCommercialIdentity | null> | null>(null);

  const inferDefaultStrength = (attr: string, idx: number): 'HARD' | 'SOFT' => {
    const lower = attr.toLowerCase();
    if (
      /\b(colou?r|black|white|grey|gray|blue|red|green|pink|beige|brown|gold|silver|logo|brand|box|packaging|cable|adapter|count|nodes?|buttons?|led|light|strap|mesh|fabric|size|dimension)\b/i.test(
        lower
      )
    ) {
      return 'SOFT';
    }
    return idx < 4 ? 'HARD' : 'SOFT';
  };

  const refreshGeminiBudget = () => {
    apiFetch('/api/gemini/budget')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.max === 'number') {
          setGeminiBudget(data);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    refreshGeminiBudget();
  }, []);

  const syncIdentityPatchToServer = (
    imageHash: string | undefined,
    nextMustMatch: string[],
    nextMustNotBe: string[],
    nextStrengths?: Record<string, 'HARD' | 'SOFT' | 'IGNORE'>
  ) => {
    if (nextStrengths) {
      apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributeStrengthOverrides: nextStrengths }),
      }).catch(() => {});
    }
    if (!imageHash) return;
    apiFetch('/api/gemini/identity', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageHash,
        mustMatch: nextMustMatch,
        mustNotBe: nextMustNotBe,
        attributeStrengths: nextStrengths || attributeStrengths,
      }),
    }).catch(() => {});
  };

  const runGeminiCommercialIdentification = async (
    dataUrl: string
  ): Promise<GeminiCommercialIdentity | null> => {
    setIsIdentifyingImage(true);
    setIdentityFailedErrorAr(null);
    setShowManualIdentityForm(false);
    setGeminiIdentity(null);
    setMustMatchChips([]);
    setMustNotBeChips([]);
    setAttributeStrengths({});

    const promise = (async (): Promise<GeminiCommercialIdentity | null> => {
      try {
        const res = await apiFetch('/api/gemini/identify-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: dataUrl,
          }),
        });
        const data = await res.json().catch(() => ({}));
        refreshGeminiBudget();
        if (
          !res.ok ||
          !data?.commercialNameEn ||
          !data?.identityCard?.mustMatch?.length ||
          !data?.identityCard?.mustNotBe?.length
        ) {
          const arabicErr =
            data?.error ||
            'تعذر استخراج بطاقة الهوية البصرية للمنتج (mustMatch / mustNotBe) بعد 3 محاولات. تم إيقاف البحث تلقائياً لمنع ظهور منتجات خاطئة — يرجى تعبئة نموذج الهوية اليدوي بالأسفل للمتابعة.';
          setIdentityFailedErrorAr(arabicErr);
          setShowManualIdentityForm(true);
          return null;
        }
        const card: IdentityCardV2Client = data.identityCard || data.profile?.identityCardV2;
        const resolved: GeminiCommercialIdentity = {
          commercialNameEn: data.commercialNameEn,
          commercialNameAr: data.commercialNameAr || '',
          amazonQueries: Array.isArray(data.amazonQueries)
            ? data.amazonQueries
            : [data.commercialNameEn],
          identityCard: card,
        };
        setGeminiIdentity(resolved);
        setProductName(resolved.commercialNameEn);
        const mm = card.mustMatch || [];
        setMustMatchChips(mm);
        setMustNotBeChips(card.mustNotBe || []);
        const initialStrengths: Record<string, 'HARD' | 'SOFT' | 'IGNORE'> = {};
        if (card.attributeStrengths) {
          for (const [k, v] of Object.entries(card.attributeStrengths)) {
            const up = String(v).toUpperCase();
            initialStrengths[k] = up === 'HARD' ? 'HARD' : up === 'IGNORE' ? 'IGNORE' : 'SOFT';
          }
        }
        mm.forEach((attr, idx) => {
          if (!initialStrengths[attr]) {
            initialStrengths[attr] = inferDefaultStrength(attr, idx);
          }
        });
        setAttributeStrengths(initialStrengths);
        return resolved;
      } catch {
        const arabicErr =
          'تعذر الاتصال بخدمة التحليل البصري (Gemini) بعد 3 محاولات — يرجى تعبئة نموذج بطاقة الهوية اليدوي للمتابعة.';
        setIdentityFailedErrorAr(arabicErr);
        setShowManualIdentityForm(true);
        return null;
      } finally {
        setIsIdentifyingImage(false);
        identifyPromiseRef.current = null;
      }
    })();
    identifyPromiseRef.current = promise;
    return promise;
  };

  const compressImageForUpload = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        const MAX_DIM = 960;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      };
      img.src = objUrl;
    });
  };

  const handleImageFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setValidationError('يرجى اختيار ملف صورة صالح');
      return;
    }
    setValidationError(null);
    try {
      const dataUrl = await compressImageForUpload(file);
      setImagePreview(dataUrl);
      runGeminiCommercialIdentification(dataUrl);
    } catch {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        setImagePreview(dataUrl);
        runGeminiCommercialIdentification(dataUrl);
      };
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    if (droppedFile) {
      handleImageFile(droppedFile);
      setDroppedFile(null);
    }
  }, [droppedFile]);

  useEffect(() => {
    if (autoResolvedProductName && autoResolvedProductName.trim()) {
      setProductName(autoResolvedProductName.trim());
    }
  }, [autoResolvedProductName]);

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
    let currentIdentity = geminiIdentity;
    if (identifyPromiseRef.current) {
      currentIdentity = await Promise.race([
        identifyPromiseRef.current,
        new Promise<GeminiCommercialIdentity | null>((resolve) =>
          setTimeout(() => resolve(geminiIdentity || null), 3500)
        ),
      ]);
    }

    const trimmedName = (productName || currentIdentity?.commercialNameEn || '').trim();
    const trimmedUrl = productUrl.trim();

    if (!trimmedName && !trimmedUrl && !imagePreview) {
      setValidationError('يرجى كتابة اسم المنتج أو رفع صورته أو إدخال رابط مباشر لصفحة المنتج لبدء البحث');
      return;
    }

    // Item 3 (FAIL CLOSED IDENTITY): If an image is attached, require either a resolved Identity Card OR manual mustMatch + mustNotBe + nameEn
    if (
      imagePreview &&
      (!trimmedName || mustMatchChips.length === 0 || mustNotBeChips.length === 0)
    ) {
      setShowManualIdentityForm(true);
      setValidationError(
        identityFailedErrorAr ||
          'لا يمكن بدء البحث بالصورة بدون تحديد مواصفات التصميم الإلزامية (mustMatch) والمستبعدات (mustNotBe). يرجى استكمال بطاقة الهوية اليدوية أولاً.'
      );
      return;
    }

    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl) && !/\bB0[A-Z0-9]{8}\b/i.test(trimmedUrl)) {
      setValidationError('يرجى إدخال رابط صفحة منتج صحيح يبدأ بـ https://');
      return;
    }

    setValidationError(null);
    setIsSubmitting(true);
    cancelStreamingSearch();

    const safeSingleVideoCount = clampCount(targetVideoInput);
    const safeAmazonVideoCount = clampCount(targetAmazonVideoInput);
    const safeTikTokVideoCount = clampCount(targetTikTokVideoInput);
    const safePhotoCount = clampCount(targetPhotoInput);
    setTargetVideoInput(String(safeSingleVideoCount));
    setTargetAmazonVideoInput(String(safeAmazonVideoCount));
    setTargetTikTokVideoInput(String(safeTikTokVideoCount));
    setTargetPhotoInput(String(safePhotoCount));

    const effectiveVideoCount =
      sourcePlatform === 'all'
        ? safeAmazonVideoCount + safeTikTokVideoCount
        : safeSingleVideoCount;

    const effectiveName =
      trimmedName ||
      currentIdentity?.commercialNameEn ||
      trimmedUrl ||
      (imagePreview ? 'بحث بالصورة' : '');

    try {
      await startStreamingSearch({
        productName: effectiveName,
        productUrl: trimmedUrl || undefined,
        mediaType,
        sourcePlatform,
        targetVideoCount: effectiveVideoCount,
        targetAmazonVideoCount: sourcePlatform === 'all' ? safeAmazonVideoCount : undefined,
        targetTikTokVideoCount: sourcePlatform === 'all' ? safeTikTokVideoCount : undefined,
        targetPhotoCount: safePhotoCount,
        referenceImage: imagePreview,
        matchMode,
        includeSimilar,
        mustMatch: mustMatchChips.length > 0 ? mustMatchChips : currentIdentity?.identityCard?.mustMatch,
        mustNotBe: mustNotBeChips.length > 0 ? mustNotBeChips : currentIdentity?.identityCard?.mustNotBe,
        identityCard: currentIdentity?.identityCard
          ? {
              ...currentIdentity.identityCard,
              mustMatch: mustMatchChips.length > 0 ? mustMatchChips : currentIdentity.identityCard.mustMatch,
              mustNotBe: mustNotBeChips.length > 0 ? mustNotBeChips : currentIdentity.identityCard.mustNotBe,
              attributeStrengths,
            }
          : null,
      });
    } catch (error: any) {
      showToast(error.message || 'حدث خطأ أثناء بدء البحث', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const directPreviewHref =
    productUrl.trim() && /^https?:\/\//i.test(productUrl.trim())
      ? productUrl.trim()
      : productName.trim() && /^https?:\/\//i.test(productName.trim())
      ? productName.trim()
      : (geminiIdentity?.commercialNameEn || productName.trim())
      ? sourcePlatform === 'tiktok'
        ? `https://www.tiktok.com/search/video?q=${encodeURIComponent(
            geminiIdentity?.commercialNameEn || productName.trim()
          )}`
        : `https://www.amazon.com/s?k=${encodeURIComponent(
            geminiIdentity?.commercialNameEn || productName.trim()
          )}`
      : sourcePlatform === 'tiktok'
      ? 'https://www.tiktok.com'
      : 'https://www.amazon.com';

  return (
    <div className="w-full max-w-[760px] mx-auto">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl border border-[#E2E5DF] shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5 sm:p-7 space-y-5"
      >
        {/* 1) Large Drag/Drop Product Image Box + Gemini Vision Commercial Name Layer */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <label className="block text-sm font-semibold text-[#181B1A]">
              صورة المنتج (طبقة التعرف التجاري الذكي عبر Gemini)
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {geminiBudget && (
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border ${
                    geminiBudget.exhausted
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF]'
                  }`}
                  title="ميزانية التحقق البصري اليومية عبر Gemini"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-[#247C72]" />
                  <span>
                    ميزانية Gemini اليومية: {geminiBudget.remaining}/{geminiBudget.max} متبقي
                    {geminiBudget.exhausted ? ' (مستنفدة — وضع محلي فقط)' : ''}
                  </span>
                </span>
              )}

            </div>
          </div>
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
                اسحب وأفلت صورة المنتج هنا ليتعرف Gemini على اسمه التجاري في أمازون، أو اضغط للاختيار
              </p>
              <p className="text-xs text-[#616764]">PNG, JPG, WEBP</p>
            </div>
          ) : (
            <div className="rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3.5 min-w-0">
                  <img
                    src={imagePreview}
                    alt="معاينة المنتج"
                    className="w-16 h-16 rounded-lg object-cover border border-[#E2E5DF] bg-white shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#181B1A] truncate">
                      {geminiIdentity?.commercialNameAr || 'تم إرفاق صورة مرجعية للمنتج'}
                    </p>
                    <p className="text-xs text-[#247C72] bg-[#EAF3F2] border border-[#247C72]/30 px-2 py-0.5 rounded-md mt-1 inline-flex items-center gap-1 font-medium">
                      <Sparkles className="w-3 h-3" />
                      <span>طبقة Gemini: التعرف على المنتج ثم البحث باسمه التجاري على أمازون</span>
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
                      setGeminiIdentity(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-[#E2E5DF] text-red-600 hover:bg-red-50 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>إزالة</span>
                  </button>
                </div>
              </div>

              {isIdentifyingImage && (
                <div className="rounded-lg bg-white border border-[#E2E5DF] px-3.5 py-2.5 flex items-center gap-2.5 text-xs text-[#247C72] font-medium">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>جاري فحص صورة المنتج عبر Gemini (حتى 3 محاولات بمهلة 25 ثانية) وتحديد mustMatch / mustNotBe...</span>
                </div>
              )}

              {/* Item 3 (FAIL CLOSED IDENTITY): Arabic Error Banner + Editable Manual Identity Card Form */}
              {identityFailedErrorAr && !isIdentifyingImage && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs font-bold text-red-800 leading-relaxed">
                      {identityFailedErrorAr}
                    </div>
                  </div>

                  {showManualIdentityForm && (
                    <div className="bg-white rounded-lg border border-red-200 p-3.5 space-y-3">
                      <div className="text-xs font-bold text-[#181B1A]">
                        نموذج بطاقة الهوية البصرية اليدوي (إلزامي عند تعذر التحليل التلقائي):
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-[11px] font-semibold text-[#616764] mb-1">
                            الاسم التجاري بالإنجليزية (Required):
                          </label>
                          <input
                            type="text"
                            dir="ltr"
                            value={productName}
                            onChange={(e) => setProductName(e.target.value)}
                            placeholder="e.g. Photocatalyst Suction Mosquito Killer"
                            className="w-full h-8 px-2.5 text-xs rounded border border-[#E2E5DF] bg-[#FAFBF9]"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-[#616764] mb-1">
                            الشكل الهندسي وآلية العمل:
                          </label>
                          <input
                            type="text"
                            dir="ltr"
                            value={manualFormFactor}
                            onChange={(e) => setManualFormFactor(e.target.value)}
                            placeholder="e.g. Cylindrical USB suction fan trap"
                            className="w-full h-8 px-2.5 text-xs rounded border border-[#E2E5DF] bg-[#FAFBF9]"
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={async () => {
                            if (!productName.trim() || mustMatchChips.length === 0 || mustNotBeChips.length === 0) {
                              setValidationError(
                                'يرجى إدخال الاسم التجاري وإضافة سمة إلزامية (mustMatch) ومستبعد (mustNotBe) واحد على الأقل.'
                              );
                              return;
                            }
                            const res = await apiFetch('/api/gemini/identity-manual', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                nameEn: productName.trim(),
                                nameAr: productName.trim(),
                                formFactorShape: manualFormFactor || productName.trim(),
                                mechanismHowItWorks: manualMechanism || productName.trim(),
                                mustMatch: mustMatchChips,
                                mustNotBe: mustNotBeChips,
                              }),
                            });
                            if (res.ok) {
                              const data = await res.json();
                              setGeminiIdentity({
                                commercialNameEn: data.commercialNameEn,
                                commercialNameAr: data.commercialNameAr,
                                amazonQueries: data.amazonQueries || [data.commercialNameEn],
                                identityCard: data.identityCard,
                              });
                              setIdentityFailedErrorAr(null);
                              setShowManualIdentityForm(false);
                              setValidationError(null);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[#247C72] text-white text-xs font-bold hover:bg-[#1E665E] cursor-pointer"
                        >
                          حفظ الهوية اليدوية وتفعيل البحث
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {(geminiIdentity || showManualIdentityForm) && !isIdentifyingImage && (
                <div className="rounded-lg bg-white border border-[#247C72]/30 p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[#247C72]">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>بطاقة هوية المنتج البصرية (Identity Card v3 — Discriminator Schema):</span>
                    </div>
                    <span
                      dir="ltr"
                      className="text-xs font-bold text-[#181B1A] bg-[#EAF3F2] px-2.5 py-1 rounded-md"
                    >
                      {geminiIdentity?.commercialNameEn || productName || 'Manual Identity'}
                    </span>
                  </div>

                  {geminiIdentity?.identityCard && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-[#FAFBF9] border border-[#E2E5DF] rounded-lg p-2.5">
                      <div>
                        <span className="font-semibold text-[#616764]">الشكل والتصميم (Form Factor): </span>
                        <span className="text-[#181B1A] font-medium" dir="ltr">
                          {geminiIdentity.identityCard.formFactor.shape}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-[#616764]">آلية العمل (Mechanism): </span>
                        <span className="text-[#181B1A] font-medium" dir="ltr">
                          {geminiIdentity.identityCard.mechanism.howItWorks}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Phase 2.4: Identity v3 Discriminators (up to 5 HARD/SOFT with evidencePhrase) */}
                  {geminiIdentity?.identityCard?.discriminators &&
                    geminiIdentity.identityCard.discriminators.length > 0 && (
                      <div
                        data-testid="identity-v3-discriminators"
                        className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-1.5"
                      >
                        <div className="text-[11px] font-bold text-slate-800">
                          السمات التمييزية الدقيقة (Discriminators — بحد أقصى 5 سمات تفصل هذا التصميم عن أشباهه):
                        </div>
                        <div className="grid grid-cols-1 gap-1.5">
                          {geminiIdentity.identityCard.discriminators.slice(0, 5).map((disc) => (
                            <div
                              key={disc.id}
                              dir="ltr"
                              className="flex items-start justify-between gap-2 bg-white px-2.5 py-1.5 rounded border border-slate-200 text-[11px]"
                            >
                              <div className="min-w-0">
                                <span
                                  className={`inline-block text-[9px] font-bold px-1.5 py-0.2 rounded mr-1.5 ${
                                    disc.strength === 'hard'
                                      ? 'bg-red-600 text-white'
                                      : 'bg-teal-600 text-white'
                                  }`}
                                >
                                  {disc.strength}
                                </span>
                                <span className="font-bold text-slate-900">{disc.nameAr || disc.name}: </span>
                                <span className="text-slate-700">{disc.expectedValue}</span>
                                <div className="text-[10px] text-slate-500 mt-0.5">
                                  Evidence: {disc.evidencePhrase}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Editable mustMatch chips with HARD/SOFT/IGNORE toggle */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-1.5 flex-wrap">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-800">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span>مواصفات التصميم (اضغط على HARD/SOFT لتغيير صرامة كل شرط):</span>
                      </div>
                      <span className="text-[10px] text-[#616764]">
                        HARD = شرط قاطع (يرفض المنتج) | SOFT = تفصيل مرن (يخفض الدرجة فقط) | IGNORE = تجاهل
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {mustMatchChips.map((chip, idx) => {
                        const strength = attributeStrengths[chip] || inferDefaultStrength(chip, idx);
                        const nextStrength: 'HARD' | 'SOFT' | 'IGNORE' =
                          strength === 'HARD' ? 'SOFT' : strength === 'SOFT' ? 'IGNORE' : 'HARD';
                        const badgeClass =
                          strength === 'HARD'
                            ? 'bg-red-600 text-white'
                            : strength === 'SOFT'
                            ? 'bg-teal-600 text-white'
                            : 'bg-slate-400 text-white';
                        return (
                          <span
                            key={`mm-${idx}-${chip}`}
                            dir="ltr"
                            className={`inline-flex items-center gap-1 text-[11px] font-medium border px-2 py-0.5 rounded-md ${
                              strength === 'IGNORE'
                                ? 'bg-slate-100 text-slate-400 border-slate-200 line-through'
                                : strength === 'HARD'
                                ? 'bg-emerald-50 text-emerald-950 border-emerald-300'
                                : 'bg-teal-50/60 text-teal-900 border-teal-200'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const updated = { ...attributeStrengths, [chip]: nextStrength };
                                setAttributeStrengths(updated);
                                syncIdentityPatchToServer(
                                  geminiIdentity?.identityCard?.imageHash,
                                  mustMatchChips,
                                  mustNotBeChips,
                                  updated
                                );
                              }}
                              title="اضغط للتبديل بين HARD (صارم) و SOFT (مرن) و IGNORE (تجاهل)"
                              className={`text-[9px] font-bold px-1.5 py-0.2 rounded cursor-pointer ${badgeClass}`}
                            >
                              {strength}
                            </button>
                            <span>{chip}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = mustMatchChips.filter((_, i) => i !== idx);
                                setMustMatchChips(next);
                                syncIdentityPatchToServer(
                                  geminiIdentity?.identityCard?.imageHash,
                                  next,
                                  mustNotBeChips,
                                  attributeStrengths
                                );
                              }}
                              className="text-emerald-700 hover:text-red-600 cursor-pointer"
                              title="حذف السمة"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        );
                      })}
                      <div className="inline-flex items-center gap-1">
                        <input
                          type="text"
                          value={newMustMatchInput}
                          onChange={(e) => setNewMustMatchInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const v = newMustMatchInput.trim();
                              if (v && !mustMatchChips.includes(v)) {
                                const next = [...mustMatchChips, v];
                                const updatedStrengths = { ...attributeStrengths, [v]: 'SOFT' as const };
                                setMustMatchChips(next);
                                setAttributeStrengths(updatedStrengths);
                                setNewMustMatchInput('');
                                syncIdentityPatchToServer(
                                  geminiIdentity?.identityCard?.imageHash,
                                  next,
                                  mustNotBeChips,
                                  updatedStrengths
                                );
                              }
                            }
                          }}
                          placeholder="+ أضف سمة"
                          className="h-6 px-2 text-[11px] rounded border border-[#E2E5DF] bg-[#FAFBF9] focus:bg-white focus:outline-none focus:border-[#247C72] w-32"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const v = newMustMatchInput.trim();
                            if (v && !mustMatchChips.includes(v)) {
                              const next = [...mustMatchChips, v];
                              const updatedStrengths = { ...attributeStrengths, [v]: 'SOFT' as const };
                              setMustMatchChips(next);
                              setAttributeStrengths(updatedStrengths);
                              setNewMustMatchInput('');
                              syncIdentityPatchToServer(
                                geminiIdentity?.identityCard?.imageHash,
                                next,
                                mustNotBeChips,
                                updatedStrengths
                              );
                            }
                          }}
                          className="h-6 px-1.5 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-800 text-[11px] flex items-center cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Editable mustNotBe chips */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-800">
                      <Ban className="w-3.5 h-3.5 text-red-600" />
                      <span>منتجات شبيهة مستبعدة تماماً (Must Not Be — تمنع قبول أنواع أخرى):</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {mustNotBeChips.map((chip, idx) => (
                        <span
                          key={`mnb-${idx}-${chip}`}
                          dir="ltr"
                          className="inline-flex items-center gap-1 text-[11px] font-medium bg-red-50 text-red-900 border border-red-200 px-2 py-0.5 rounded-md"
                        >
                          <span>{chip}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = mustNotBeChips.filter((_, i) => i !== idx);
                              setMustNotBeChips(next);
                              syncIdentityPatchToServer(
                                geminiIdentity?.identityCard?.imageHash,
                                mustMatchChips,
                                next
                              );
                            }}
                            className="text-red-700 hover:text-red-950 cursor-pointer"
                            title="حذف الاستبعاد"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      <div className="inline-flex items-center gap-1">
                        <input
                          type="text"
                          value={newMustNotBeInput}
                          onChange={(e) => setNewMustNotBeInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const v = newMustNotBeInput.trim();
                              if (v && !mustNotBeChips.includes(v)) {
                                const next = [...mustNotBeChips, v];
                                setMustNotBeChips(next);
                                setNewMustNotBeInput('');
                                syncIdentityPatchToServer(
                                  geminiIdentity?.identityCard?.imageHash,
                                  mustMatchChips,
                                  next
                                );
                              }
                            }
                          }}
                          placeholder="+ استبعد نوعاً مشابهاً"
                          className="h-6 px-2 text-[11px] rounded border border-[#E2E5DF] bg-[#FAFBF9] focus:bg-white focus:outline-none focus:border-red-400 w-36"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const v = newMustNotBeInput.trim();
                            if (v && !mustNotBeChips.includes(v)) {
                              const next = [...mustNotBeChips, v];
                              setMustNotBeChips(next);
                              setNewMustNotBeInput('');
                              syncIdentityPatchToServer(
                                geminiIdentity?.identityCard?.imageHash,
                                mustMatchChips,
                                next
                              );
                            }
                          }}
                          className="h-6 px-1.5 rounded bg-red-100 hover:bg-red-200 text-red-800 text-[11px] flex items-center cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {geminiIdentity && geminiIdentity.amazonQueries.length > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-[#F0F2EE]">
                      <span className="text-[11px] text-[#616764]">كلمات البحث التجارية:</span>
                      {Array.from(new Set(geminiIdentity.amazonQueries)).slice(0, 4).map((q, idx) => (
                        <button
                          key={`${q}-${idx}`}
                          type="button"
                          dir="ltr"
                          onClick={() => setProductName(q)}
                          className="text-[11px] px-2 py-0.5 rounded bg-[#FAFBF9] hover:bg-[#EAF3F2] border border-[#E2E5DF] text-[#181B1A] transition-colors cursor-pointer"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 2) Product Name Field */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <label
              htmlFor="product-name-input"
              className="block text-sm font-semibold text-[#181B1A]"
            >
              اسم المنتج (يُحدَّث تلقائياً إذا لم يُعثر على الاسم الأول في أمازون)
            </label>
            {autoResolvedProductName && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#247C72] bg-[#EAF3F2] border border-[#247C72]/30 px-2.5 py-0.5 rounded-md">
                <RefreshCw className="w-3 h-3" />
                <span>الاسم النشط في أمازون: {autoResolvedProductName}</span>
              </span>
            )}
          </div>
          <input
            id="product-name-input"
            type="text"
            value={productName}
            onChange={(e) => {
              setProductName(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder="أدخل اسم المنتج بالعربية أو الإنجليزية أو ارفع صورته بالأعلى..."
            className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
          />
          <p className="text-[11px] text-[#616764] mt-1.5">
            إذا لم يعثر البحث على منتج بالاسم المختار في أمازون، يقوم النظام بتحديث الاسم وتجربة الأسماء التجارية البديلة تلقائياً حتى يعثر على المنتج.
          </p>
        </div>

        {/* 2b) Direct Product Page Link right under Product Name */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <label
              htmlFor="product-url-input"
              className="flex items-center gap-1.5 text-sm font-semibold text-[#181B1A]"
            >
              <LinkIcon className="w-4 h-4 text-[#247C72]" />
              <span>رابط مباشر لصفحة المنتج على أمازون أو فيديو تيك توك (اختياري)</span>
            </label>

            {(productUrl.trim() || productName.trim()) && (
              <a
                href={directPreviewHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#247C72] hover:text-[#1E665E] bg-[#EAF3F2] hover:bg-[#DCECE9] px-2.5 py-1 rounded-lg transition-colors"
              >
                <span>{sourcePlatform === 'tiktok' ? 'فتح على تيك توك' : 'فتح صفحة المنتج'}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

          <input
            id="product-url-input"
            type="text"
            dir="ltr"
            value={productUrl}
            onChange={(e) => {
              setProductUrl(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder={
              sourcePlatform === 'tiktok'
                ? 'https://www.tiktok.com/@username/video/...'
                : 'https://www.amazon.com/dp/... أو رابط تيك توك'
            }
            className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors text-left"
          />
          <p className="text-[11px] text-[#616764] mt-1.5">
            يمكنك وضع رابط صفحة المنتج من أمازون أو رابط فيديو تيك توك، أو الاكتفاء باسم المنتج أو صورته بالأعلى.
          </p>
        </div>

        {/* 2c) Source Platform Selector (أمازون / تيك توك / الاثنين معاً) */}
        <div>
          <label className="block text-sm font-semibold text-[#181B1A] mb-2">
            منصة البحث (المصدر)
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            <button
              type="button"
              onClick={() => setSourcePlatform('amazon')}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                sourcePlatform === 'amazon'
                  ? 'bg-[#EAF3F2] border-[#247C72] text-[#247C72] font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <span>أمازون • Amazon</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSourcePlatform('tiktok');
                if (mediaType === 'photo') setMediaType('video');
              }}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                sourcePlatform === 'tiktok'
                  ? 'bg-[#181B1A] border-[#181B1A] text-white font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <span>تيك توك • TikTok</span>
            </button>
            <button
              type="button"
              onClick={() => setSourcePlatform('all')}
              className={`h-11 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 transition-all cursor-pointer ${
                sourcePlatform === 'all'
                  ? 'bg-[#EAF3F2] border-[#247C72] text-[#247C72] font-semibold'
                  : 'bg-[#FAFBF9] border-[#E2E5DF] text-[#616764] hover:text-[#181B1A] hover:bg-white'
              }`}
            >
              <span>الاثنين معاً (أمازون + تيك توك)</span>
            </button>
          </div>
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

        {/* 4) Independent Video Counts per Platform (Amazon + TikTok) & Photo Counts */}
        <div className="space-y-3">
          {(mediaType === 'video' || mediaType === 'both') &&
            (sourcePlatform === 'all' ? (
              <div className="rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[#181B1A]">
                    تحديد عدد الفيديوهات لكل منصة بشكل مستقل
                  </span>
                  <span className="text-xs font-bold text-[#247C72] bg-[#EAF3F2] border border-[#247C72]/30 px-2.5 py-1 rounded-lg">
                    الإجمالي المطلوب: {clampCount(targetAmazonVideoInput) + clampCount(targetTikTokVideoInput)} فيديو
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Amazon Video Count */}
                  <div className="bg-white rounded-xl border border-[#E2E5DF] p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="target-amazon-video-count"
                        className="text-xs font-bold text-[#247C72] flex items-center gap-1.5"
                      >
                        <Video className="w-3.5 h-3.5" />
                        <span>فيديوهات أمازون • Amazon</span>
                      </label>
                      <div className="flex items-center gap-1">
                        {[5, 10, 20, 50].map((preset) => (
                          <button
                            key={`amz-${preset}`}
                            type="button"
                            onClick={() => setTargetAmazonVideoInput(String(preset))}
                            className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                              clampCount(targetAmazonVideoInput) === preset
                                ? 'bg-[#247C72] text-white border-[#247C72]'
                                : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      id="target-amazon-video-count"
                      type="number"
                      min={1}
                      max={500}
                      value={targetAmazonVideoInput}
                      onChange={(e) => setTargetAmazonVideoInput(e.target.value)}
                      onBlur={() =>
                        setTargetAmazonVideoInput(String(clampCount(targetAmazonVideoInput)))
                      }
                      className="w-full h-10 px-3.5 rounded-lg bg-[#FAFBF9] border border-[#E2E5DF] text-sm font-semibold text-[#181B1A] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
                    />
                  </div>

                  {/* TikTok Video Count */}
                  <div className="bg-white rounded-xl border border-[#E2E5DF] p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor="target-tiktok-video-count"
                        className="text-xs font-bold text-[#181B1A] flex items-center gap-1.5"
                      >
                        <Video className="w-3.5 h-3.5" />
                        <span>فيديوهات تيك توك • TikTok</span>
                      </label>
                      <div className="flex items-center gap-1">
                        {[5, 10, 20, 50].map((preset) => (
                          <button
                            key={`tt-${preset}`}
                            type="button"
                            onClick={() => setTargetTikTokVideoInput(String(preset))}
                            className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                              clampCount(targetTikTokVideoInput) === preset
                                ? 'bg-[#181B1A] text-white border-[#181B1A]'
                                : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      id="target-tiktok-video-count"
                      type="number"
                      min={1}
                      max={500}
                      value={targetTikTokVideoInput}
                      onChange={(e) => setTargetTikTokVideoInput(e.target.value)}
                      onBlur={() =>
                        setTargetTikTokVideoInput(String(clampCount(targetTikTokVideoInput)))
                      }
                      className="w-full h-10 px-3.5 rounded-lg bg-[#FAFBF9] border border-[#E2E5DF] text-sm font-semibold text-[#181B1A] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                  <label
                    htmlFor="target-video-count"
                    className="block text-sm font-semibold text-[#181B1A]"
                  >
                    {sourcePlatform === 'tiktok'
                      ? 'عدد فيديوهات تيك توك (TikTok)'
                      : 'عدد فيديوهات أمازون (Amazon)'}
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      {[5, 10, 20, 50].map((preset) => (
                        <button
                          key={`single-${preset}`}
                          type="button"
                          onClick={() => setTargetVideoInput(String(preset))}
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                            clampCount(targetVideoInput) === preset
                              ? 'bg-[#247C72] text-white border-[#247C72]'
                              : 'bg-[#FAFBF9] text-[#616764] border-[#E2E5DF] hover:text-[#181B1A]'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSourcePlatform('all')}
                      className="text-xs font-semibold text-[#247C72] bg-[#EAF3F2] hover:bg-[#DCECE9] border border-[#247C72]/30 px-2.5 py-0.5 rounded-md transition-colors cursor-pointer"
                    >
                      تحديد فيديوهات لكلتا المنصتين معاً
                    </button>
                  </div>
                </div>
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
            ))}

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

        {/* 4b) Visual Verification Rules (Same Design vs Strict Color + Include Similar) */}
        <div className="rounded-xl border border-[#E2E5DF] bg-[#FAFBF9] p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-[#181B1A]">
              قواعد مطابقة المنتج البصرية (تجاهل اختلاف اللون أو الشعار افتراضياً)
            </span>
            <span className="text-[11px] font-semibold text-[#247C72] bg-[#EAF3F2] px-2 py-0.5 rounded">
              {matchMode === 'strict_color' ? 'وضع تطابق اللون الصارم' : 'وضع نفس التصميم (أي لون أو ماركة)'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#181B1A] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={matchMode === 'strict_color'}
                onChange={(e) => setMatchMode(e.target.checked ? 'strict_color' : 'same_design')}
                className="w-4 h-4 accent-[#247C72] rounded cursor-pointer"
              />
              <span>اللون لازم يتطابق (رفض الألوان الأخرى لنفس المنتج)</span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-[#181B1A] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeSimilar}
                onChange={(e) => setIncludeSimilar(e.target.checked)}
                className="w-4 h-4 accent-[#247C72] rounded cursor-pointer"
              />
              <span>عرض المنتجات الشبيهة (بنفس الفئة عند قلة النتائج)</span>
            </label>
          </div>
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
