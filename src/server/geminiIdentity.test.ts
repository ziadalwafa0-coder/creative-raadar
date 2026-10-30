import {test} from 'node:test';
import assert from 'node:assert/strict';

// Isolated test process. Provider responses below are fixtures, not live Gemini evidence.
process.env.GEMINI_API_KEY = 'qa-fixture-key-no-network';

test('Gemini sends the actual product image AND supplied name, and binds visual decisions to candidates', async () => {
  const {ai, analyzeProductImage, verifyAmazonProductsBatchVisually} = await import('./gemini.ts');
  assert.ok(ai);
  const calls: any[] = [];
  const original = ai.models.generateContent;
  let fixture: object = {suggestedNameEn:'Microfiber Spray Mop Refillable Bottle', confidence:'high', brandOrModelText:[]};
  ai.models.generateContent = (async (request: any) => {
    calls.push(request);
    return {text:JSON.stringify(fixture)};
  }) as typeof original;
  try {
    const signal = new AbortController().signal;
    const profile = await analyzeProductImage('image-bytes-fixture', 'image/jpeg', undefined, undefined, 'مساحة وبخاخة 2 في 1', signal);
    assert.equal(profile.commercialNameEn,'Microfiber Spray Mop Refillable Bottle');
    assert.equal(calls[0].contents.parts[0].inlineData.data,'image-bytes-fixture');
    assert.ok(calls[0].contents.parts.some((part: any) => part.text?.includes('مساحة وبخاخة 2 في 1')));
    assert.ok(calls[0].config.abortSignal instanceof AbortSignal);
    fixture = {decisions:[
      {asin:'B012345678',approved:true,matchScore:96,matchCategory:'exact_design'},
      {asin:'B099999999',approved:true,matchScore:100,matchCategory:'exact_design'},
    ]};
    const decisions = await verifyAmazonProductsBatchVisually('reference-image-fixture','image/jpeg','spray mop',profile,[
      {asin:'B012345678',title:'Spray Mop',imageBase64:'candidate-image-fixture',imageMimeType:'image/jpeg'},
    ], undefined, signal);
    assert.equal(decisions?.get('B012345678')?.approved,true);
    assert.equal(decisions?.has('B099999999'),false);
    assert.equal(calls[1].contents.parts.filter((part: any) => part.inlineData).length,2);
  } finally { ai.models.generateContent = original; }
});
