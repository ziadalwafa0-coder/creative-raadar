import React from 'react';
import type {IdentityProposal} from './identifyProduct';
export function IdentityReview({proposal,onConfirm,loading,referenceImage,failed}:{proposal:IdentityProposal;onConfirm:(asin:string)=>void;loading:boolean;referenceImage:string;failed:boolean}){
 return <section aria-label="تأكيد هوية المنتج" className="bg-[#eef7f3] border border-[#bad8ca] rounded-2xl p-5 space-y-4">
  <h2 className="font-bold">مطابقة صورة المنتج</h2>
  <p className="text-sm">المقارنة بين صورتك وصور أمازون الفعلية، مع فحص الاسم والمواصفات. النتائج المعروضة اجتازت حدود تشابه صارمة؛ هذا لا يثبت الماركة أو رقم الموديل وحده.</p>
  <p className="text-sm">عبارة البحث: <span dir="ltr">{proposal.query}</span></p>
  {proposal.inspected!==undefined&&<p className="text-sm">منتجات وافقت الاسم والمواصفات: {proposal.inspected} · صور تمت مقارنتها: {proposal.compared??0}</p>}
  {!proposal.products.length&&<p role="status" className="text-sm">{loading?'جاري فحص صور النتائج؛ لن نعرض اقتراحات بعيدة…':failed?'لم يكتمل فحص المطابقة بسبب خطأ في قراءة المصدر أو تحليل الصور. لم نعتمد أي منتج بديل.':'لم نجد تطابقًا بصريًا موثوقًا. جرّب صورة واضحة للمنتج وحده واذكر الماركة أو رقم الموديل إن وجد. لن نجمع ريفيوهات منتج بديل.'}</p>}
  <div className="space-y-3">{proposal.products.map(p=><article key={p.asin} className="bg-white border rounded-xl p-4 space-y-3">
   <div className="grid grid-cols-2 gap-3"><figure><img src={referenceImage} alt="الصورة الأصلية المرفوعة" className="h-32 w-full object-contain"/><figcaption className="text-xs text-center">صورتك</figcaption></figure><figure>{p.imageUrl&&<img src={p.imageUrl} alt="صورة المنتج على أمازون" loading="lazy" className="h-32 w-full object-contain"/>}<figcaption className="text-xs text-center">صورة أمازون</figcaption></figure></div>
   <p dir="auto" className="text-sm">{p.title}</p><div className="flex flex-wrap gap-4 items-center"><a className="underline text-sm" href={p.url} target="_blank" rel="noreferrer">شاهد المنتج على أمازون ↗</a><button type="button" onClick={()=>onConfirm(p.asin)} className="bg-[#247c72] text-white rounded-xl px-4 py-2 disabled:opacity-50">ده نفس المنتج — اجمع ريفيوهاته فقط</button></div>
  </article>)}</div>
 </section>;
}
