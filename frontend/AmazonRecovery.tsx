import React,{useState} from 'react';
import {browserRequest} from './browserCollector';
import type {Marketplace} from '../backend/src/types';
type OpenProduct={id:number;asin:string;market:Marketplace;url:string;title:string};
export function AmazonRecovery({market,query,onRead}:{market:Marketplace;query:string;onRead:(tab:OpenProduct)=>void}){
 const [tabs,setTabs]=useState<OpenProduct[]>([]);const [message,setMessage]=useState('');const [loading,setLoading]=useState(false);
 const resume=async()=>{setLoading(true);setMessage('');try{await browserRequest('resume_browser',{},new AbortController().signal,30000);setMessage('صفحة العمل قابلة للقراءة الآن. اضغط ابحث لبدء عملية جديدة.');}catch(e){setMessage(e instanceof Error?e.message:'صفحة العمل لم تكتمل');}finally{setLoading(false);}};
 const list=async()=>{
  setLoading(true);setMessage('');setTabs([]);const abort=new AbortController();
  try{
   const result=await browserRequest('list_open_products',{},abort.signal,5000);
   setTabs(result.tabs||[]);if(!result.tabs?.length)setMessage('لم نجد صفحة منتج مفتوحة. افتح المنتج نفسه من نتائج أمازون ثم اضغط عرض الصفحات مرة أخرى.');
  }catch(e){setMessage('قارئ الصفحة لم يرد. تأكد أن نسخة Creative Radaar 1.3.2 هي المفعّلة، ثم أعد تحميل صفحة أمازون والموقع. '+(e instanceof Error?e.message:''));}finally{setLoading(false);}
 };
 return <aside aria-label="استكمال من صفحة أمازون المفتوحة" className="border border-amber-200 bg-amber-50 rounded-xl p-5 space-y-3">
  <h2 className="font-bold">قراءة من صفحة أمازون المفتوحة</h2>
  <p className="text-sm">لو الجلب الآلي متوقف أو صفحة المنتج مفتوحة بالفعل، يمكنك استيراد ريفيوهاتها من Chrome دون طلب جلب جديد. لا توجد إعادة محاولة آلية بعد الرفض.</p>
  <ol className="list-decimal list-inside text-sm space-y-2"><li><a className="underline text-[#247c72]" href={`https://www.${market}/s?k=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer">افتح أمازون واختر نفس المنتج</a></li><li>إذا ظهرت صفحة تحقق، أكملها بنفسك إن رغبت. افتح قسم مراجعات العملاء والفيديوهات في صفحة المنتج.</li><li>ارجع هنا واعرض الصفحات المفتوحة، ثم اختر الصفحة الصحيحة.</li></ol>
  <button type="button" disabled={loading} onClick={list} className="bg-[#247c72] text-white rounded-xl px-4 py-2">{loading?'جاري قراءة قائمة الصفحات…':'عرض صفحات منتجات أمازون المفتوحة'}</button>
  <button type="button" disabled={loading} onClick={resume} className="border rounded-xl px-4 py-2">راجعت تبويب العمل — افحصه بدون إعادة تحميل</button>
  {message&&<p role="status" className="text-sm">{message}</p>}
  {message.includes('1.3.2')&&<p><a className="underline" href="/creative-radaar-extension.zip" download>تنزيل الإضافة المحدّثة</a> · <a className="underline" href="/extension-install.html" target="_blank" rel="noreferrer">طريقة التحديث</a></p>}
  {tabs.map(tab=><article key={tab.id} className="bg-white border rounded-xl p-3 space-y-2"><p dir="auto">{tab.title}</p><p dir="ltr" className="text-sm">{tab.market} — {tab.asin}</p><button type="button" className="underline text-[#247c72]" onClick={()=>onRead(tab)}>ده المنتج اللي اخترته — اقرأ ريفيوهات الصفحة</button></article>)}
  <p className="text-xs">الاختيار هنا يدوي؛ لا يعني تأكيد مطابقة الصورة آليًا. لا نقرأ كلمات سر أو كوكيز، ولا نتجاوز صفحات التحقق.</p>
 </aside>;
}
