export const commercialProducts = [
  ['Microfiber Spray Mop Refillable Bottle', 'a flat floor cleaning mop with a spray trigger and refillable water bottle attached to its handle'],
  ['Spin Mop Bucket Set', 'a round string spin mop with a wringer bucket'],
  ['Electric Spin Scrubber', 'an electric handheld cleaning scrubber with a round rotating brush'],
  ['Window Squeegee Spray Bottle', 'a handheld window glass squeegee with a built in spray bottle'],
  ['Cordless Stick Vacuum Cleaner', 'an upright cordless stick vacuum cleaner with a dust tank and floor head'],
  ['Handheld Car Vacuum Cleaner', 'a small handheld car vacuum cleaner with a suction nozzle and dust container'],
  ['Fabric Shoe Rack With Cover', 'a tall shoe storage cabinet with many fabric shelves and a zipper cover'],
  ['Bamboo Folding Shoe Rack', 'a wooden folding shoe rack with slatted shelves and crossed side supports'],
  ['Double Rod Clothes Rack Wheels', 'a freestanding metal clothes rack with two hanging rails and wheels'],
  ['Cordless Water Flosser', 'a handheld dental water flosser with a water tank and thin jet nozzle'],
  ['Foldable Portable Washing Machine', 'a small collapsible electric washing machine with a bucket and lid'],
  ['Washing Machine Anti Vibration Pads', 'a set of rubber anti vibration feet pads for a washing machine'],
  ['Dual Cylinder Tire Air Compressor', 'a portable car tire air compressor with two metal piston cylinders and a hose'],
  ['Mini Cordless Chainsaw', 'a small handheld battery powered chainsaw with an exposed cutting chain'],
  ['Hammer Drill Tool Kit', 'an electric drill with bits pliers and hand tools in a carrying case'],
  ['Retractable Cable Door Closer', 'a small square automatic door closer with a retractable steel wire cable'],
  ['Window Mosquito Screen Mesh', 'a roll or sheet of fine insect window screen mesh with adhesive tape'],
  ['UV Toothbrush Sanitizer Holder', 'a wall mounted toothbrush holder with ultraviolet lights and toothpaste dispenser'],
  ['Portable Clothes Dryer', 'a hanging electric clothes drying appliance with a drying bag'],
  ['Satin Pillowcase', 'a shiny smooth satin pillowcase on a bed pillow'],
  ['Electric Charcoal Burner', 'an electric hot plate with a round metal bowl for heating charcoal'],
  ['Countertop Blender Grinder', 'a countertop blender motor with a large clear jug and separate small grinder cup'],
  ['Cervical Neck Traction Pillow', 'a curved blue foam neck traction stretcher pillow with massage bumps'],
  ['Nasal Dilator Anti Snoring', 'a small silicone nasal dilator inserted into nostrils to reduce snoring'],
  ['Dental Night Guard', 'a clear plastic dental mouth guard for teeth grinding'],
  ['Bathroom Corner Shelf', 'a wall mounted triangular bathroom corner shelf for toiletries'],
  ['Portable Ceramic Space Heater', 'a portable electric space heater with a front grille and controls'],
  ['Handheld Garment Steamer', 'a handheld clothes iron or garment steamer with a water reservoir'],
  ['Kneeling Support Knee Seat', 'a wearable kneeling support seat attached around the knees for gardening work'],
  ['Car Lumbar Support Cushion', 'a curved foam lower back support cushion for a car seat'],
  ['Kids Folding Play Mat', 'a large soft colorful padded folding play mat for children'],
  ['', 'an unrelated object, food, book, animal or empty scene rather than the requested household product'],
] as const;

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  const score = dot / Math.sqrt(aa * bb);
  return Number.isFinite(score) ? score : 0;
}

export type ImageEvidence = { embedding: number[]; hash: number[]; contrast: number };
export function imageShape(rgb: Uint8Array | Uint8ClampedArray, channels: number) {
  const gray = Array.from({length: 72}, (_, i) => (rgb[i * channels] + rgb[i * channels + 1] + rgb[i * channels + 2]) / 765);
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const contrast = Math.sqrt(gray.reduce((total, x) => total + (x - mean) ** 2, 0) / gray.length);
  const hash: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash.push(Number(gray[y * 9 + x] > gray[y * 9 + x + 1]));
  return { hash, contrast };
}

export function compareEvidence(reference: ImageEvidence, candidate: ImageEvidence, id: string) {
  const similarity = cosine(reference.embedding, candidate.embedding);
  const structure = reference.hash.length === 64 && candidate.hash.length === 64
    ? reference.hash.filter((value, i) => value === candidate.hash[i]).length / 64 : 0;
  // Conservative heuristics, not a guarantee of an exact model or SKU.
  return { id, similarity, structure, accepted: similarity >= 0.92 && structure >= 0.875 && reference.contrast >= 0.025 && candidate.contrast >= 0.025 };
}

export type CategoryScore = {index: number; score: number};
export function selectCommercialName(scores: CategoryScore[], nameHint = '') {
  const ranked = scores.filter(x => Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
  let best = ranked[0];
  const hint = nameHint.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه');
  const families: Array<[RegExp, number[]]> = [
    [/مساح|ممسح|\bmops?\b/, /بخاخ|spray/.test(hint) ? [0] : [0,1]],
    [/مكنس|\bvacuum\b/, [4,5]], [/جزام|\bshoe\b/, /خشب|bamboo|wood/.test(hint) ? [7] : [6,7]],
    [/ستاند.*ملابس|حامل.*ملابس|clothes rack|garment rack/, [8]],
    [/خيط.*اسنان|water flosser|oral irrigator/, [9]], [/غسال|washing machine/, /اهتزاز|انزلاق|pads/.test(hint) ? [11] : [10]],
    [/كمبرو|compressor|inflator/, [12]], [/منشار|chainsaw/, [13]], [/شنيور|drill/, [14]],
    [/غالق.*باب|door closer/, [15]], [/ناموس|mosquito|window screen/, [16]],
    [/معقم.*فرش|toothbrush/, [17]], [/مجفف.*ملابس|clothes dryer/, [18]],
    [/خلاط|blender/, [21]], [/دعام.*رقب|neck.*(?:pillow|traction)/, [22]],
    [/دفاي|heater/, [26]], [/مكوا|مكوه|steamer/, [27]],
  ];
  const family = families.find(([pattern]) => pattern.test(hint))?.[1];
  if (family) {
    const supported = ranked.find(score => family.includes(score.index));
    if (!supported || supported.score < 0.20 || (best?.score || 0) - supported.score > 0.10) {
      throw new Error('اسم المنتج والصورة غير متوافقين بما يكفي. راجع الاسم أو استخدم صورة أوضح؛ لن نبدّل المنتج تلقائيًا.');
    }
    best = supported;
  }
  if (!best || !commercialProducts[best.index]?.[0] || best.score < 0.24) {
    throw new Error('الصورة غير كافية لتحديد اسم البحث بثقة. اكتب الاسم التجاري بالإنجليزية؛ لن نخمن ماركة أو موديل.');
  }
  return { query: commercialProducts[best.index][0], confidence: 'suggested' as const,
    uncertain: best.index !== ranked[0].index || best.score - (ranked.find(x => x.index !== best.index)?.score || 0) < 0.015,
    scores };
}
