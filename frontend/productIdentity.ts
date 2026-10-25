/** CLIP similarities rank candidates; they are not probabilities of an exact product match. */
export type VisualScore={label:string;score:number};
export const productFamilies=[
 ['fabric-shoes','Fabric Shoe Rack with Cover',/shoe (?:rack|organizer|storage)/i],
 ['wood-shoes','Wooden Bamboo Shoe Rack',/shoe (?:rack|organizer|storage)/i],
 ['clothes','Double Rod Clothes Rack with Wheels',/(?:clothes|clothing|garment) (?:rack|rail)/i],
 ['flosser','Cordless Water Flosser',/water flosser|oral irrigator/i],
 ['washer','Foldable Portable Washing Machine',/washing machine|portable washer/i],
 ['pads','Washing Machine Anti Vibration Pads',/vibration|washer.*pads|washing machine.*feet/i],
 ['vacuum','Handheld Car Vacuum Cleaner',/vacuum/i],
 ['compressor','Dual Cylinder Tire Inflator Air Compressor',/inflator|air compressor/i],
 ['drill','Electric Hammer Drill Tool Kit',/drill/i],
 ['chainsaw','Mini Cordless Chainsaw',/chain\s?saw/i],
 ['door','Retractable Pull String Automatic Door Closer',/door closer/i],
 ['screen','Window Mosquito Screen Mesh',/window.*(?:screen|mesh)|mosquito.*(?:net|mesh)/i],
 ['toothbrush','UV Toothbrush Sanitizer Holder',/toothbrush.*(?:holder|sanitizer)/i],
 ['hairbrush','Hair Spray Massage Brush',/hair.*brush/i],
 ['dryer','Portable Clothes Dryer',/clothes dryer|drying machine/i],
 ['pillow','Satin Pillowcase',/pillowcase|pillow case/i],
 ['burner','Electric Charcoal Burner',/charcoal.*(?:burner|starter|lighter|heater)/i],
 ['blender','Countertop Blender with Grinder',/blender/i],
 ['bait','Fishing Bait Attractant Spray',/bait|fish.*attractant/i],
 ['knee','Kneeling Support Knee Seat',/kneel|knee.*(?:seat|support)/i],
 ['shelf','Bathroom Corner Shelf',/corner.*(?:shelf|shelves|caddy)|shower caddy/i],
 ['mat','Kids Play Mat',/play.*mat|mat.*kids/i],
 ['heater','Electric Space Heater',/space heater|fan heater/i],
 ['neck','Cervical Neck Stretcher Foam Pillow',/neck.*(?:stretcher|pillow)|cervical.*(?:traction|pillow)/i],
 ['snore','Nasal Dilator Anti Snoring Device',/nasal dilator|anti.?snor/i],
 ['mouth','Dental Night Guard for Teeth Grinding',/night guard|mouth guard|mouthguard/i],
 ['lumbar','Car Seat Lumbar Support Cushion',/lumbar|seat.*cushion/i],
 ['mop','Floor Cleaning Mop',/mop/i],
 ['storage','Plastic Storage Box Organizer',/storage.*(?:box|container)|organizer/i],
 ['fan','Portable Electric Fan',/fan/i],
 ['light','Rechargeable LED Lamp',/lamp|light/i],
 ['iron','Handheld Garment Steamer',/steamer/i],
 ['scale','Digital Kitchen Scale',/scale/i],
 ['custom','Product described by the supplied name',/$a/],
 ['other','A different object, unrelated to household products',/$a/],
] as const;
export type ProductFamily=typeof productFamilies[number][0];
const descriptions:Partial<Record<ProductFamily,string>>={
 'fabric-shoes':'a tall fabric shoe storage cabinet with shelves and a zipper cover',
 'wood-shoes':'a wooden bamboo shoe storage rack with open slatted shelves',
 clothes:'a freestanding metal garment rack with two hanging rails, clothes hangers and wheels',
 flosser:'a handheld dental water flosser oral irrigator with a water tank and a thin jet nozzle',
 washer:'a small collapsible electric washing machine with a lid and a bucket',
 pads:'rubber anti vibration support feet pads for a washing machine',
 dryer:'an electric portable laundry drying machine appliance',
 toothbrush:'a wall mounted ultraviolet toothbrush holder and sanitizer dispenser',
 neck:'a curved blue foam cervical neck traction pillow with massage bumps',
 snore:'a small nasal dilator clip inserted in the nose for snoring',
 chainsaw:'a handheld battery powered chainsaw with an exposed metal cutting chain bar',
 burner:'an electric hot plate charcoal burner with a round bowl of burning charcoal',
 fan:'an electric fan with propeller blades inside a circular safety grille',
 vacuum:'a handheld car vacuum cleaner with a suction nozzle and a dust container',
};
const visualFamilies=productFamilies.filter(f=>f[0]!=='custom');
export const visualLabels=visualFamilies.map(f=>descriptions[f[0]]||f[1]);
export function canonicalScores(scores:VisualScore[]):VisualScore[]{return scores.map(s=>({...s,label:visualFamilies[visualLabels.indexOf(s.label)]?.[1]||s.label}));}
export function familyFor(id:string){return productFamilies.find(f=>f[0]===id);}
export function chooseVisualIdentity(scores:VisualScore[],englishHint:string){
 const ranked=scores.filter(s=>Number.isFinite(s.score)&&s.score>=0&&(s.label===englishHint||productFamilies.some(f=>f[1]===s.label))).sort((a,b)=>b.score-a.score);
 const first=ranked[0];if(!first)throw Error('لم يمكن فهم الصورة؛ جرّب صورة أوضح للمنتج');
 const family=productFamilies.find(f=>f[1]===first.label)||productFamilies.find(f=>f[2].test(englishHint))||familyFor('custom')!;
 const agrees=first.label===englishHint||family[2].test(englishHint);
 const uncertain=family[0]==='other'||first.score<0.28||first.score-(ranked[1]?.score||0)<0.08;
 return {family:family[0],query:agrees?englishHint:family[1],conflict:!agrees,uncertain,
  alternatives:ranked.filter(s=>s.label!==productFamilies.at(-1)![1]).slice(0,3).map(s=>s.label)};
}
/** Never let an explicit conflicting tier count leak into the collected media. Missing tiers are allowed. */
export function matchesIdentity(title:string,query:string,family:ProductFamily){
 const category=familyFor(family);if(!category||family==='other')return false;
 if(family==='custom'){
  // Unknown families must still share meaningful terms with the current approved name.
  const words=[...new Set((query.toLowerCase().match(/[a-z]+/g)||[]).filter(w=>w.length>2&&!/^(the|and|with|for|new|mini|micro|portable|electric|rechargeable|wireless|cordless|inch|black|white|pack|pcs)$/.test(w)))];
  const titleWords=new Set(title.toLowerCase().match(/[a-z]+/g)||[]);
  if(!words.length||words.filter(w=>titleWords.has(w)).length<Math.min(2,words.length))return false;
 }else if(!category[2].test(title))return false;
 const wanted=query.match(/\b(\d+)\s*[- ]?tier\b/i)?.[1];
 const actual=title.match(/\b(\d+)\s*[- ]?tier\b/i)?.[1];
 if(wanted&&wanted!==actual)return false;
 const model=query.match(/\b[A-Z]{1,6}-\d{2,6}\b/i)?.[0];
 if(model&&!title.toLowerCase().includes(model.toLowerCase()))return false;
 if(/double rod|dual rail|double rail/i.test(query)&&!/(?:double|dual|two|2)[ -]?(?:rod|rail|bar)/i.test(title))return false;
 if(/with wheels/i.test(query)&&!/wheel|rolling|caster/i.test(title))return false;
 if(/with cover|covered/i.test(query)&&/shoe/i.test(query)&&!/cover|enclos|zipper|closet/i.test(title))return false;
 if(/wood|bamboo/i.test(query)&&/shoe/i.test(query)&&!/wood|bamboo/i.test(title))return false;
 return true;
}
