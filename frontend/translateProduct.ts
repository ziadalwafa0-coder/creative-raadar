import {decodeHtml} from '../backend/src/utils';
import {amazonProductName} from './amazonProductName';
const arabic=/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]/;
const cache=new Map<string,string>();
type NativeTranslator={translate:(text:string,options?:{signal:AbortSignal})=>Promise<string>;destroy:()=>void};
type TranslationRuntime={availability:(options:{sourceLanguage:string;targetLanguage:string})=>Promise<string>;create:(options:{sourceLanguage:string;targetLanguage:string;signal:AbortSignal})=>Promise<NativeTranslator>};
export const hasArabic=(text:string)=>arabic.test(text);
function cleanTranslation(value:unknown){
 if(typeof value!=='string')throw Error('ترجمة غير صالحة');
 const text=decodeHtml(value).normalize('NFKC').trim().replace(/\s+/g,' ');
 if(!/[a-z]/i.test(text)||hasArabic(text)||text.length>200||/MYMEMORY WARNING|DAILY LIMIT|INVALID LANGUAGE|FREE TRANSLATIONS/i.test(text))throw Error('ترجمة غير صالحة');
 return text;
}
/** No paid API/key. On-device Chrome translation when available; anonymous MyMemory fallback. */
export async function translateProductName(raw:string,signal:AbortSignal,options:{runtime?:TranslationRuntime|null;fetcher?:typeof fetch;cache?:Map<string,string>}={}){
 signal.throwIfAborted();const name=raw.normalize('NFKC').trim().replace(/\s+/g,' ');
 if(!hasArabic(name))return name;
 if(new TextEncoder().encode(name).length>500)throw Error('اسم المنتج طويل؛ اختصره قبل الترجمة');
 const commerceName=amazonProductName(name);if(commerceName)return commerceName;
 const memory=options.cache||cache;const cached=memory.get(name);if(cached)return cached;
 const runtime=options.runtime===undefined?(globalThis as any).Translator as TranslationRuntime|undefined:options.runtime;
 let translated:string|undefined;
 if(runtime){
  let translator:NativeTranslator|undefined;
  const nativeSignal=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
  try{
   const availability=await Promise.race([runtime.availability({sourceLanguage:'ar',targetLanguage:'en'}),new Promise<never>((_,reject)=>nativeSignal.addEventListener('abort',()=>reject(nativeSignal.reason),{once:true}))]);
   if(availability!=='unavailable'){
    nativeSignal.throwIfAborted();translator=await runtime.create({sourceLanguage:'ar',targetLanguage:'en',signal:nativeSignal});
    translated=cleanTranslation(await translator.translate(name,{signal:nativeSignal}));
   }
  }catch{signal.throwIfAborted();}finally{translator?.destroy();}
 }
 if(!translated){
  signal.throwIfAborted();
  const response=await(options.fetcher||fetch)('https://api.mymemory.translated.net/get?'+new URLSearchParams({q:name,langpair:'ar|en'}),{credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
  if(!response.ok)throw Error('تعذرت ترجمة الاسم؛ اكتب اسم المنتج بالإنجليزية أو أعد المحاولة');
  const data=await response.json();signal.throwIfAborted();
  if(data.quotaFinished||Number(data.responseStatus)!==200)throw Error('الترجمة المجانية غير متاحة الآن؛ اكتب الاسم بالإنجليزية أو جرّب لاحقًا');
  try{translated=cleanTranslation(data.responseData?.translatedText);}catch{throw Error('تعذرت ترجمة الاسم بدقة؛ اكتب اسم المنتج بالإنجليزية');}
 }
 signal.throwIfAborted();if(memory.size>=100)memory.delete(memory.keys().next().value!);memory.set(name,translated);return translated;
}
