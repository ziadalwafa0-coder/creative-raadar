import fs from 'node:fs';
process.env.GEMINI_API_KEY ||= 'offline-simulation-not-a-real-key';
const { searchAmazonUsProductPages, evaluateStrictProductTitleMatch, buildAmazonUsQuery } = await import('./src/server/amazonUs.ts');
const queries: string[]=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (input:any) => {const u=new URL(String(input));if(u.hostname==='www.amazon.com')queries.push(u.searchParams.get('k')||'');return new Response('',{status:503});};
try {
  await searchAmazonUsProductPages('Double Rail Clothes Garment Rack with Wheels',4);
  const result={
    garmentSearchQueries:[...new Set(queries)],
    shoeAcceptedForGarment:evaluateStrictProductTitleMatch('9 Tier Shoe Rack Organizer with Dustproof Cover','Double Rail Clothes Garment Rack with Wheels','ستاند ملابس زوجي بعجل'),
    sixTierAcceptedForNine:evaluateStrictProductTitleMatch('6 Tier Shoe Rack with Dustproof Cover','9 Tier Shoe Rack with Cover','جزامة 9 دور بغطاء'),
    staleProfileOverridesNewName:await buildAmazonUsQuery('ستاند ملابس زوجي بعجل','9 Tier Shoe Rack with Dustproof Cover'),
  };
  fs.writeFileSync('simulation-after.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {globalThis.fetch=originalFetch;}
