import React from 'react';
import type {IdentityProposal} from './identifyProduct';
import {hasArabic} from './translateProduct';
export function IdentityReview({proposal,query,onQuery,onConfirm,onAlternative,loading}:{proposal:IdentityProposal;query:string;onQuery:(text:string)=>void;onConfirm:(asin:string)=>void;onAlternative:(query:string)=>void;loading:boolean}){
 return <section aria-label="تأكيد هوية المنتج" className="bg-[#eef7f3] border border-[#bad8ca] rounded-2xl p-5 space-y-4">
  <h2 className="font-bold">تأكد من المنتج قبل جمع الريفيوهات</h2>
  <p className="text-sm">تم تحليل الصورة لاقتراح نوع المنتج. اختر أقرب نتيجة من أمازون بعد تحميل الترشيحات؛ التشابه البصري لا يؤكد الماركة أو المقاس.</p>
  {proposal.conflict&&<p role="alert" className="text-amber-900">نوع المنتج في الصورة مختلف عن الاسم المكتوب؛ راجع الاقتراح قبل المتابعة.</p>}
  {proposal.uncertain&&<p className="text-amber-900">نتيجة الصورة غير حاسمة. راجع النوع والمواصفات بنفسك.</p>}
  {(proposal.conflict||proposal.uncertain)&&<div className="space-y-2"><p className="text-sm">لو النوع مش صحيح، اختَر البديل الأقرب للصورة والاسم:</p><div className="flex flex-wrap gap-2">{proposal.alternatives.filter(a=>a!==proposal.query).map(a=><button key={a} type="button" dir="ltr" onClick={()=>onAlternative(a)} className="border rounded-lg px-3 py-2 bg-white text-sm">{a}</button>)}</div></div>}
  <label className="block">عبارة البحث المقترحة (يمكن تعديلها)<input dir="ltr" className="w-full p-3 rounded-xl border bg-white" value={query} maxLength={200} onChange={e=>onQuery(e.target.value)}/></label>
  {!proposal.products.length&&<p role="status" className="text-sm">{loading?'جاري تحميل وترتيب ترشيحات أمازون…':'لم تصل ترشيحات من أمازون. جرّب بديلًا من الأنواع المقترحة أو أعد البحث.'}</p>}
  <div className="space-y-3">{proposal.products.map(p=><article key={p.asin} className="bg-white border rounded-xl p-4 space-y-3">
   {p.imageUrl&&<img src={p.imageUrl} alt="صورة المنتج على أمازون" loading="lazy" className="h-28 w-full object-contain"/>}
   <p dir="auto" className="text-sm">{p.title}</p><div className="flex flex-wrap gap-4 items-center"><a className="underline text-sm" href={p.url} target="_blank" rel="noreferrer">شاهد المنتج على أمازون ↗</a><button type="button" disabled={query.trim().length<3||hasArabic(query)} onClick={()=>onConfirm(p.asin)} className="bg-[#247c72] text-white rounded-xl px-4 py-2 disabled:opacity-50">ده الأقرب — اجمع الريفيوهات</button></div>
  </article>)}</div>
 </section>;
}
