/** Commerce names for familiar Arabic/Egyptian catalogue labels, not claimed exact listing titles. */
export function amazonProductName(raw:string):string|undefined {
 const text=raw.normalize('NFKC').toLowerCase().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[\u064b-\u065f\u0670ـ]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه');
 const words:Record<string,string>={'خمسه':'5','خمس':'5','سته':'6','ست':'6','سبعه':'7','سبع':'7','ثمانيه':'8','ثمان':'8','تسعه':'9','تسع':'9','عشره':'10','عشر':'10'};
 const numbered=text.replace(/خمسه|خمس|سته|ست|سبعه|سبع|ثمانيه|ثمان|تسعه|تسع|عشره|عشر/g,word=>words[word]);
 const tier=numbered.match(/(\d+)\s*(?:ادوار|ادور|دور|طوابق|طابق|رفوف|ارفف)/)?.[1];
 const watt=text.match(/(\d+)\s*(?:وات|watt|w\b)/)?.[1];const volt=text.match(/(\d+)\s*(?:فولت|volt|v\b)/)?.[1];
 const pieces=text.match(/(\d+)\s*(?:قطعه|قطع|pieces?)/)?.[1];
 const dims=text.match(/(\d+(?:[.,]\d+)?)\s*[×x*]\s*(\d+(?:[.,]\d+)?)(?:\s*(سم|cm))?/);
 const wheels=/بعجل|عجلات|بالعجل/.test(text);const cover=/بغطاء|مع غطاء|بالغطاء/.test(text);
 const cordless=/لاسلكي|بدون سلك/.test(text);const foldable=/قابل.*طي|بتتطبق|قابل.*تطبيق/.test(text);
 let query:string|undefined;
 if(/جزامه|منظم.*احذيه|رف.*احذيه/.test(text)){
  query=[tier?`${tier} Tier`:undefined,/خشب/.test(text)?'Wooden':/بامبو|خيزران/.test(text)?'Bamboo':undefined,'Shoe Rack',cover?'with Cover':undefined].filter(Boolean).join(' ');
 }else if(/(?:ستاند|حامل|منظم).*ملابس/.test(text)){
  query=[/زوجي|مزدوج|دبل|عمودين/.test(text)?'Double Rod':undefined,'Clothes Rack',wheels?'with Wheels':undefined].filter(Boolean).join(' ');
 }else if(/خيط.*اسنان.*ما|خيط.*ما.*اسنان/.test(text)){
  query=[cordless||/محمول/.test(text)?'Cordless':undefined,'Water Flosser'].filter(Boolean).join(' ');
 }else if(/غساله/.test(text)&&/حوامل|قواعد|مانع.*انزلاق|مانع.*اهتزاز/.test(text)){
  query='Washing Machine Anti Vibration Pads';
 }else if(/غساله/.test(text)&&/محمول|صغيره|طي/.test(text)){
  query=[foldable?'Foldable':undefined,'Portable Washing Machine'].filter(Boolean).join(' ');
 }else if(/مكنسه/.test(text)&&/عربيه|سياره|سيارات/.test(text)){
  query=[cordless?'Cordless':undefined,'Car Vacuum Cleaner'].filter(Boolean).join(' ');
 }else if(/كمبروسر|منفاخ.*اطار|منفاخ.*كفر/.test(text)){
  query=[volt?`${volt}V`:undefined,/2\s*بستم|بستمين|اتنين.*بستم|مزدوج/.test(text)?'Dual Cylinder':undefined,'Tire Inflator Air Compressor'].filter(Boolean).join(' ');
 }else if(/شنيور|مثقاب/.test(text)){
  query=[watt?`${watt}W`:undefined,/دقاق|طرقي/.test(text)?'Hammer':cordless?'Cordless':undefined,'Drill',/شنطه|عده|طقم/.test(text)?'with Tool Kit':undefined,pieces?`${pieces} Pieces`:undefined].filter(Boolean).join(' ');
 }else if(/منشار/.test(text)){
  query=[cordless?'Cordless':undefined,/صغير|محمول|ميني/.test(text)?'Mini':undefined,/جنزير|سلسله|محمول/.test(text)?'Chainsaw':'Electric Saw'].filter(Boolean).join(' ');
 }else if(/(?:غالق|قافل|قفل).*باب/.test(text)){
  query=[/سلك|حبل|شداد/.test(text)?'Retractable Pull String':undefined,'Automatic Door Closer'].filter(Boolean).join(' ');
 }else if(/ناموس|حشرات/.test(text)&&/شباك|شبابيك|نافذه/.test(text)){
  query=['Window Mosquito Screen Mesh',/لزق|لاصق|فيلكرو/.test(text)?'with Hook and Loop Tape':undefined].filter(Boolean).join(' ');
 }else if(/معقم.*فرش.*اسنان|فرش.*اسنان.*معقم/.test(text)){
  query='Toothbrush Sanitizer Holder';
 }else if(/فرشاه|فرشه/.test(text)&&/شعر|مساج/.test(text)&&/بخار|رش/.test(text)){
  query=/فرد/.test(text)?'Steam Hair Straightening Brush':'Hair Spray Massage Brush';
 }else if(/مجفف.*ملابس/.test(text)){
  query='Portable Clothes Dryer';
 }else if(/كيس.*مخده|غطاء.*وساده/.test(text)&&/ستان|ساتان/.test(text)){
  query='Satin Pillowcase';
 }else if(/شعله.*فحم|ولاعه.*فحم|سخان.*فحم/.test(text)){
  query='Electric Charcoal Burner';
 }else if(/خلاط/.test(text)){
  query=['Blender',/مطحنه/.test(text)?'with Grinder':undefined].filter(Boolean).join(' ');
 }else if(/ماده.*حمراء.*صيد|جاذب.*سمك|بخاخ.*سمك/.test(text)){
  query='Fishing Bait Attractant Spray';
 }else if(/ركبه.*شغل|كرسي.*ركب/.test(text)){
  query='Kneeling Support Knee Seat';
 }else if(/ركنه.*حمام|زاويه.*حمام/.test(text)){
  query='Bathroom Corner Shelf';
 }else if(/سجاده.*اطفال/.test(text)){
  query=/رسم/.test(text)?'Kids Drawing Mat':'Kids Play Mat';
 }else if(/دفايه|مدفاه/.test(text)){
  query=/كهربا/.test(text)?'Electric Space Heater':'Space Heater';
 }
 if(!query)return;
 if(dims)query+=` ${dims[1]} x ${dims[2]}${dims[3]?' cm':''}`;
 // Keep explicit model/brand tokens; do not invent a brand or silently drop a model.
 const models=raw.match(/\b[A-Za-z]{1,6}-\d{2,6}\b/g)||[];
 const silverCrest=/silver\s*crest|silvers?\s*crvist|سيلفر\s*كريست/i.test(raw);
 if(silverCrest)query='Silver Crest '+query;
 for(const model of models)if(!query.toLowerCase().includes(model.toLowerCase()))query+=' '+model;
 for(const token of raw.match(/\b[A-Za-z][A-Za-z0-9_-]{1,30}\b/g)||[]){
  if(/^(new|with|and|model|watts?|volts?|cm|inches?)$/i.test(token))continue;
  if(silverCrest&&/^(silvers?|crest|crvist)$/i.test(token))continue;
  if(!query.toLowerCase().includes(token.toLowerCase()))query+=' '+token;
 }
 return query;
}
