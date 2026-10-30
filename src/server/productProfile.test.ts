import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProductProfile, parseVisualDecisions} from './productProfile.ts';
import {parseReferenceImage} from './productCandidates.ts';

test('commercial name preserves product type without claiming an unknown brand', () => {
  const profile = normalizeProductProfile({suggestedNameEn:'Microfiber Spray Mop Refillable Bottle', commercialNameEn:'InventedBrand Miracle Mop', brandOrModelText:['unknown'], confidence:'certain'});
  assert.equal(profile.commercialNameEn, 'Microfiber Spray Mop Refillable Bottle');
  assert.deepEqual(profile.brandOrModelText, []);
  assert.equal(profile.confidence, 'low');
  assert.throws(() => normalizeProductProfile({suggestedNameEn:'مساحة'}));
  assert.throws(() => normalizeProductProfile({suggestedNameEn:'unknown'}));
  const marked = normalizeProductProfile({suggestedNameEn:'Cordless Water Flosser', commercialNameEn:'ACME Cordless Water Flosser', brandOrModelText:['ACME'], confidence:'high'});
  assert.equal(marked.commercialNameEn,'ACME Cordless Water Flosser');
});

test('visual decisions reject foreign ASINs, missing scores, unknown categories and truthy strings', () => {
  const decision = {asin:'B012345678', approved:true, matchCategory:'exact_design', matchScore:95};
  assert.equal(parseVisualDecisions({decisions:[decision]}, [decision.asin]).get(decision.asin)?.approved, true);
  assert.equal(parseVisualDecisions({decisions:[decision]}, ['B099999999']).size, 0);
  for (const invalid of [{approved:'false'}, {matchScore:undefined}, {matchScore:9}, {matchScore:101}, {matchScore:89}, {matchCategory:'unknown'}, {matchCategory:'mismatched'}]) {
    assert.equal(parseVisualDecisions({decisions:[{...decision,...invalid}]}, [decision.asin]).get(decision.asin)?.approved, false);
  }
  assert.equal(parseVisualDecisions({decisions:[decision,decision]}, [decision.asin]).get(decision.asin)?.approved,false);
});

test('image analysis accepts bounded image data only, never remote URLs or executable SVG', () => {
  assert.equal(parseReferenceImage('https://example.com/product.png'), null);
  assert.equal(parseReferenceImage('data:image/svg+xml;base64,' + 'A'.repeat(100)), null);
  assert.equal(parseReferenceImage('data:image/png;base64,' + 'A'.repeat(100))?.mimeType, 'image/png');
  assert.equal(parseReferenceImage('data:image/jpeg;base64,' + 'A'.repeat(7*1024*1024)), null);
});
