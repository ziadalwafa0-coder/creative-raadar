import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Upload, X, RefreshCw, Video, Image as ImageIcon, Layers, Link as LinkIcon, ExternalLink } from 'lucide-react';
import { Project } from '../types/index.ts';
import { analyzeCommercialName, compareCandidateImages, type IdentityCandidate } from '../utils/productVision.ts';
import { analyzeImageWithGemini, prepareIdentityImage } from '../utils/geminiIdentity.ts';
import type { VisualAttribute } from '../types/index.ts';

export const HomeSearchCard: React.FC = () => {
  const {
    setCurrentProject,
    setActiveTab,
    apiFetch,
    droppedFile,
    setDroppedFile,
    startStreamingSearch,
    cancelStreamingSearch,
  } = useApp();

  const [productName, setProductName] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [mediaType, setMediaType] = useState<Project['mediaTypeRequested']>('video');
  const [platform,setPlatform]=useState<'amazon'|'tiktok'|'all'>('amazon');
  const [amazonInput,setAmazonInput]=useState('5');
  const [tiktokInput,setTiktokInput]=useState('5');
  const [targetVideoInput, setTargetVideoInput] = useState<string>('10');
  const [targetPhotoInput, setTargetPhotoInput] = useState<string>('10');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageRevision, setImageRevision] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [commercialName, setCommercialName] = useState('');
  const [autoListing,setAutoListing]=useState<IdentityCandidate|null>(null);
  const [allowSimilar,setAllowSimilar]=useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidate[]>([]);
  const visionController = useRef<AbortController | null>(null);
  const identityRequestRef = useRef<AbortController | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageReaderRef = useRef<FileReader | null>(null);
  const nameHintRef = useRef(productName);
  nameHintRef.current = productName;
  const commercialEditedRef = useRef(false);
  const cloudProfileRef = useRef<VisualAttribute | null>(null);
  const preparedImageRef = useRef('');
  const analyzedNameRef = useRef('');
  useEffect(() => () => imageReaderRef.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    visionController.current = controller;
    setAutoListing(null);setCommercialName(''); setIdentityCandidates([]); setScanProgress('');
    commercialEditedRef.current = false;
    cloudProfileRef.current = null; preparedImageRef.current = ''; analyzedNameRef.current = '';
    if (!imagePreview) { setIsScanning(false); return () => controller.abort(); }
    setIsScanning(true);
    setScanProgress('جاري تحديد الاسم التجاري من صورة المنتج والاسم المكتوب…');
    (async () => {
      try {
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(resolve,450);
          controller.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(controller.signal.reason);},{once:true});
        });
        controller.signal.throwIfAborted();
        const preparedImage = await prepareIdentityImage(imagePreview);
        controller.signal.throwIfAborted();
        preparedImageRef.current = preparedImage;
        const nameHint = nameHintRef.current;
        let query:string;
        try {
          const result=await analyzeImageWithGemini(preparedImage,nameHint,controller.signal,apiFetch);
          controller.signal.throwIfAborted();
          cloudProfileRef.current=result.profile;analyzedNameRef.current=nameHint;
          query=result.query;
        }catch{
          controller.signal.throwIfAborted();
          setScanProgress('جاري قراءة صورة المنتج على الجهاز…');
          const identity=await analyzeCommercialName(await (await fetch(imagePreview)).blob(),controller.signal,
            text=>{if(!controller.signal.aborted)setScanProgress(text);},nameHint);
          query=identity.query;
        }
        controller.signal.throwIfAborted();
        if(commercialEditedRef.current)return;
        setScanProgress('جاري البحث عن المنتج على أمازون ومقارنة صور القوائم…');
        const response=await apiFetch('/api/product-identity/candidates',{method:'POST',signal:controller.signal,
          headers:{'Content-Type':'application/json'},body:JSON.stringify({query,productName:nameHint,
            referenceImage:preparedImage,profile:cloudProfileRef.current,allowSimilar:false})});
        const data=await response.json();
        controller.signal.throwIfAborted();
        if(!response.ok)throw Error(data.error||'تعذّر الوصول إلى قوائم أمازون.');
        const products:IdentityCandidate[]=data.products||[];
        let matches=products.filter(row=>data.verification==='gemini'&&data.approvedAsins?.includes(row.asin));
        if(data.verification==='not-requested'&&products.length){
          const scores=await compareCandidateImages(await (await fetch(imagePreview)).blob(),products,controller.signal,setScanProgress);
          matches=products.filter(row=>scores.some(score=>score.id===row.asin&&score.accepted));
        }
        controller.signal.throwIfAborted();
        if(commercialEditedRef.current)return;
        if(matches.length===1){
          setAutoListing(matches[0]);setCommercialName(matches[0].title);
          setScanProgress('تمت مطابقة صورة المنتج تلقائيًا. الاسم الظاهر هو عنوان صفحته على أمازون.');
        }else{
          setIdentityCandidates(matches.length?matches:products);
          setScanProgress(products.length?'ظهرت عدة احتمالات. اختَر صفحة المنتج الصحيحة.':'لم تتأكد مطابقة على أمازون. عدّل عبارة البحث أو أضف رابط المنتج.');
        }
      } catch (error) {
        if (!controller.signal.aborted) setScanProgress(error instanceof Error ? error.message : 'تعذر تحليل الصورة؛ اكتب اسم البحث التجاري بالإنجليزية.');
      } finally { if (!controller.signal.aborted) setIsScanning(false); }
    })();
    return () => { controller.abort(); identityRequestRef.current?.abort(); };
  }, [imagePreview, imageRevision, productName]);

  const handleImageFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setValidationError('يرجى اختيار ملف صورة صالح');
      return;
    }
    if (file.size > 8 * 1024 * 1024) { setValidationError('اختَر صورة أصغر من 8 ميجابايت.'); return; }
    visionController.current?.abort();
    identityRequestRef.current?.abort();
    imageReaderRef.current?.abort();
    setIdentityCandidates([]);
    setValidationError(null);
    const reader = new FileReader();
    imageReaderRef.current = reader;
    reader.onload = () => {
      if (imageReaderRef.current === reader && typeof reader.result === 'string') {
        setImagePreview(reader.result);
        setImageRevision(revision => revision + 1);
      }
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

  const sourceVideoCounts=platform==='all'&&mediaType!=='photo'
    ? {amazon:clampCount(amazonInput),tiktok:clampCount(tiktokInput)} : undefined;
  const videoTarget=sourceVideoCounts?sourceVideoCounts.amazon+sourceVideoCounts.tiktok:clampCount(targetVideoInput);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = productName.trim();
    const trimmedUrl = productUrl.trim() || autoListing?.url || '';

    if (!trimmedName && !trimmedUrl && !imagePreview) {
      setValidationError('يرجى كتابة اسم المنتج أو رفع صورته أو إدخال رابط مباشر لصفحة المنتج لبدء البحث');
      return;
    }

    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl) && !/\bB0[A-Z0-9]{8}\b/i.test(trimmedUrl)) {
      setValidationError('يرجى إدخال رابط صفحة منتج صحيح يبدأ بـ https://');
      return;
    }

    setValidationError(null);
    setIsSubmitting(true);
    cancelStreamingSearch();

    const safeVideoCount = videoTarget;
    const safePhotoCount = clampCount(targetPhotoInput);
    if(!sourceVideoCounts)setTargetVideoInput(String(safeVideoCount));
    setTargetPhotoInput(String(safePhotoCount));

    const effectiveName = trimmedName || trimmedUrl || (imagePreview ? 'بحث بالصورة' : '');

    try {
      let selectedUrl = trimmedUrl;
      let selectedImage=imagePreview;
      let selectedTitle=(!productUrl.trim() && autoListing?.title)||effectiveName;
      if(platform==='tiktok'){
        if(isScanning)throw Error('انتظر اكتمال قراءة الصورة.');
        const query=commercialName.trim()||trimmedName;
        if(!query)throw Error('اكتب اسم المنتج للبحث على TikTok.');
        await startStreamingSearch({referenceImage:imagePreview,productUrl:trimmedUrl||undefined,productName:query,mediaType:'video',sourcePlatform:'tiktok',targetVideoCount:safeVideoCount,targetPhotoCount:0});
        return;
      }
      let expansionQuery = commercialName.trim();
      if (imagePreview && !trimmedUrl) {
        if (isScanning) throw new Error('انتظر اكتمال تحليل الصورة أولًا.');
        let query = commercialName.trim() || (!/[\u0600-\u06ff]/.test(trimmedName) ? trimmedName : '');
        if (!query) throw new Error('اكتب اسم البحث التجاري بالإنجليزية لتحديد المنتج من الصورة.');
        const controller = new AbortController();
        identityRequestRef.current?.abort(); identityRequestRef.current = controller;
        if (cloudProfileRef.current && analyzedNameRef.current !== trimmedName) {
          setScanProgress('جاري تحديث الاسم التجاري باستخدام الاسم والصورة معًا…');
          const refined = await analyzeImageWithGemini(preparedImageRef.current, trimmedName, controller.signal, apiFetch);
          controller.signal.throwIfAborted();
          cloudProfileRef.current = refined.profile; analyzedNameRef.current = trimmedName;
          if (!commercialEditedRef.current) { query = refined.query; }
        }
        setScanProgress(`البحث على أمازون عن: ${query} ثم مقارنة صور المنتجات…`);
        const response = await apiFetch('/api/product-identity/candidates', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
          body: JSON.stringify({query, productName: trimmedName, allowSimilar, referenceImage:cloudProfileRef.current ? preparedImageRef.current : undefined, profile:cloudProfileRef.current || undefined}),
        });
        const data = await response.json();
        controller.signal.throwIfAborted();
        if (!response.ok) throw new Error(data.error || 'تعذر قراءة صور نتائج أمازون.');
        const products: IdentityCandidate[] = data.products || [];
        if(!products.length && data.diagnostics?.reason==='SEARCH_BLOCKED'){
          if(platform==='all' && sourceVideoCounts){
            await startStreamingSearch({productName:query,mediaType,sourcePlatform:'all',sourceVideoCounts,
              amazonDiscoveryBlocked:true,targetVideoCount:safeVideoCount,targetPhotoCount:safePhotoCount,
              referenceImage:imagePreview});
            return;
          }
          document.getElementById('product-url-input')?.focus();
          throw new Error('تعذّر العثور على صفحة مؤكدة من البحث. الصق رابط نفس المنتج من أمازون في خانة الرابط المباشر واضغط ابدأ البحث.');
        }
        if (!products.length) throw new Error(data.diagnostics?.reason === 'REFERENCE_UNCERTAIN'
          ? 'تحليل الصورة غير حاسم. جرّب لقطة أوضح للمنتج أو أضف رابط صفحته للتأكيد.'
          : data.diagnostics?.sourceIncomplete
          ? 'تعذر قراءة صور بعض النتائج؛ لم نتمكن من تأكيد المطابقة. أعد المحاولة أو أضف رابط نفس المنتج.'
          : data.diagnostics?.reason === 'NO_READABLE_PRODUCTS'
          ? 'لم تظهر نتائج منتجات قابلة للفحص بالأسماء المستخدمة. عدّل اسم البحث التجاري أو أضف رابط نفس المنتج.'
          : `لم نؤكد تطابقًا ضمن ${data.diagnostics?.checkedCount || 0} صورة تم فحصها. جرّب اسمًا أدق أو أضف رابط نفس المنتج؛ هذا لا يعني أنه غير موجود على أمازون.`);
        setIdentityCandidates(products.slice(0,8));
        setScanProgress('اختَر صفحة المنتج الصحيحة لتثبيت البحث عليها.');
        return;
      }
      await startStreamingSearch({
        productName: selectedTitle,
        productUrl: selectedUrl || undefined,
        mediaType,
        sourcePlatform: platform, sourceVideoCounts,
        targetVideoCount: safeVideoCount,
        targetPhotoCount: safePhotoCount,
        referenceImage: selectedImage,
        imageConfirmedLocally: Boolean(imagePreview && selectedUrl),
        verifiedExpansion: cloudProfileRef.current && preparedImageRef.current ? {referenceImage:preparedImageRef.current,query:expansionQuery,profile:cloudProfileRef.current} : undefined,
      });
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        const message = error.message || 'حدث خطأ أثناء بدء البحث';
        setValidationError(message); setScanProgress('توقّف البحث قبل اختيار المنتج؛ لم نستخدم نتائج غير مؤكدة.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const directPreviewHref =
    productUrl.trim() && /^https?:\/\//i.test(productUrl.trim())
      ? productUrl.trim()
      : productName.trim() && /^https?:\/\//i.test(productName.trim())
      ? productName.trim()
      : (commercialName.trim() || productName.trim())
      ? `https://www.amazon.com/s?k=${encodeURIComponent(commercialName.trim() || productName.trim())}`
      : 'https://www.amazon.com';

  return (
    <div className="w-full max-w-[760px] mx-auto">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl border border-[#E2E5DF] shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5 sm:p-7 space-y-5"
      >
        {/* 1) Large Drag/Drop Product Image Box */}
        <div>
          <label className="block text-sm font-semibold text-[#181B1A] mb-2">
            صورة المنتج (مرجع اختياري)
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
                اسحب وأفلت صورة المنتج هنا كمرجع، أو اضغط للاختيار
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
                    تم إرفاق صورة مرجعية للمنتج
                  </p>
                  <p className="text-xs text-[#247C72] bg-[#EAF3F2] border border-[#247C72]/30 px-2 py-0.5 rounded-md mt-1 inline-block font-medium">
                    تحديد اسم المنتج التجاري من الصورة
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
                    imageReaderRef.current?.abort();
                    imageReaderRef.current = null;
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
        {imagePreview && (
          <div className="space-y-2 rounded-xl bg-[#EAF3F2] p-4">
            <label htmlFor="commercial-query" className="block text-sm font-semibold text-[#181B1A]">الاسم التجاري للبحث على أمازون</label>
            <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={allowSimilar} onChange={e=>{identityRequestRef.current?.abort();setIdentityCandidates([]);setAllowSimilar(e.target.checked);}}/>عرض المنتجات الرائجة من نفس النوع ولو اختلف التصميم</label>
            <input id="commercial-query" value={commercialName} onChange={event => { identityRequestRef.current?.abort(); commercialEditedRef.current = true;setAutoListing(null); setCommercialName(event.target.value); setIdentityCandidates([]); }} dir="ltr" placeholder="مثال: Microfiber Spray Mop Refillable Bottle" className="w-full h-11 px-3 rounded-lg border border-[#D5D9D2] bg-white text-sm" />
            {autoListing && <a href={autoListing.url} target="_blank" rel="noopener noreferrer" className="text-xs underline text-[#247C72]">عرض صفحة المنتج المطابق على أمازون</a>}
            <p role="status"  className="text-xs text-[#247C72]">{scanProgress}</p>

            <p className="text-xs text-[#616764]">Gemini يستقبل نسخة مصغرة للتحليل عند تفعيله. الموقع لا يحفظ صورة التحليل على السيرفر. البديل المحلي المجاني ينزّل نموذجًا أول مرة؛ الاسم المقترح لا يثبت الماركة أو الموديل.</p>
          </div>
        )}
        {identityCandidates.length > 0 && (
          <section aria-label="تأكيد نفس المنتج" className="space-y-3">
            <p className="text-sm font-semibold">اختَر نفس المنتج؛ لو مش موجود عدّل اسم البحث.</p>
            <div className="grid grid-cols-2 gap-3">
              {identityCandidates.map(candidate => <div key={candidate.asin} className="rounded-xl border border-[#D5D9D2] p-3 space-y-2">
                <img src={candidate.image} alt={candidate.title} className="w-full h-28 object-contain bg-white" />
                <p className="text-xs line-clamp-3">{candidate.title}</p>
                <button type="button" disabled={isSubmitting} className="w-full rounded-lg py-2 text-sm bg-[#247C72] text-white" onClick={async () => {
                  setIsSubmitting(true); setValidationError(null);
                  try {
                    await startStreamingSearch({ productName: candidate.title, productUrl: candidate.url,
                      mediaType, sourcePlatform: platform, sourceVideoCounts, targetVideoCount: videoTarget, targetPhotoCount: clampCount(targetPhotoInput),
                      referenceImage: candidate.image, imageConfirmedLocally: true,
                      verifiedExpansion: cloudProfileRef.current && preparedImageRef.current ? {referenceImage:preparedImageRef.current,query:commercialName.trim(),profile:cloudProfileRef.current} : undefined });
                  } catch (error) { setValidationError(error instanceof Error ? error.message : 'تعذر بدء البحث.'); }
                  finally { setIsSubmitting(false); }
                }}>{allowSimilar?'اختَر هذا المنتج':'ده نفس المنتج'}</button>
              </div>)}
            </div>
          </section>
        )}
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
              identityRequestRef.current?.abort();
              setProductName(e.target.value);
              setIdentityCandidates([]);
              visionController.current?.abort();
              cloudProfileRef.current=null;
              setCommercialName('');
              setAutoListing(null);
              if (validationError) setValidationError(null);
            }}
            placeholder="أدخل اسم المنتج (مثال: جزامة 9 دور بغطاء)..."
            className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
          />
        </div>

        {/* 2b) Direct Product Page Link right under Product Name */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <label
              htmlFor="product-url-input"
              className="flex items-center gap-1.5 text-sm font-semibold text-[#181B1A]"
            >
              <LinkIcon className="w-4 h-4 text-[#247C72]" />
              <span>رابط مباشر لصفحة المنتج على أمازون (اختياري)</span>
            </label>

            {(productUrl.trim() || productName.trim()) && (
              <a
                href={directPreviewHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#247C72] hover:text-[#1E665E] bg-[#EAF3F2] hover:bg-[#DCECE9] px-2.5 py-1 rounded-lg transition-colors"
              >
                <span>فتح صفحة المنتج</span>
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
              setProductUrl(e.target.value);setAutoListing(null);commercialEditedRef.current=true;
              identityRequestRef.current?.abort(); setIdentityCandidates([]);
              if (validationError) setValidationError(null);
            }}
            placeholder="https://www.amazon.com/dp/..."
            className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors text-left"
          />
          <p className="text-[11px] text-[#616764] mt-1.5">
            عند تحديد رابط، نجمع مراجعات أمازون من صفحة المنتج المحددة فقط.
          </p>
        </div>

        {/* 3) Media Type Selector (فيديوهات / صور / الاثنين) */}
        <label className="block text-sm font-semibold">المصدر
          <select value={platform} className="block mt-2 p-2 border rounded-lg" onChange={e=>{
            const next=e.target.value==='tiktok'?'tiktok':e.target.value==='all'?'all':'amazon';setPlatform(next);setIdentityCandidates([]);
            if(next==='tiktok')setMediaType('video');
          }}><option value="amazon">أمازون · ريفيوهات العملاء فقط</option><option value="tiktok">تيك توك · كل فيديوهات المنتج</option><option value="all">Amazon + TikTok</option></select>
        </label>
        {platform!=='amazon' && <p className="text-xs text-[#616764]">{platform==='all'?'أمازون: مراجعات العملاء فقط. ':''}تيك توك: مراجعات وعروض وشرح استخدام لنفس المنتج.</p>}
        {platform==='amazon' && <p className="text-xs text-[#616764]">العدد المطلوب هدف للبحث. لو المراجعات أقل، هنعرض المتاح من العملاء فقط.</p>}
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
              disabled={platform==='tiktok'} onClick={() => setMediaType('photo')}
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
              disabled={platform==='tiktok'} onClick={() => setMediaType('both')}
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
          {sourceVideoCounts && (['amazon','tiktok'] as const).map(source=>{
            const amazon=source==='amazon';
            const value=amazon?amazonInput:tiktokInput;
            const update=amazon?setAmazonInput:setTiktokInput;
            return <label key={source} className="block text-sm font-semibold">
              {amazon?'عدد فيديوهات أمازون':'عدد فيديوهات تيك توك'}
              <input type="number" min={1} max={500} value={value} onChange={e=>update(e.target.value)}
                onBlur={()=>update(String(clampCount(value)))} className="mt-2 w-full h-11 px-4 rounded-xl border bg-[#FAFBF9]" />
            </label>;
          })}
          {!sourceVideoCounts && (mediaType === 'video' || mediaType === 'both') && (
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
          disabled={isSubmitting || isScanning}
          className="w-full h-12 rounded-xl bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white font-semibold text-sm transition-colors flex items-center justify-center cursor-pointer"
        >
          {isScanning ? 'جاري تحليل الصورة…' : isSubmitting ? 'جاري تحديد نفس المنتج…' : 'ابدأ البحث'}
        </button>
      </form>
    </div>
  );
};
