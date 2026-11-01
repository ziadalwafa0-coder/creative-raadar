import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedAmazonListing} from './productScope.ts';

test('image searches require an explicit listing for every product family',()=>{
 for(const productName of ['espresso maker','spray mop','car vacuum','shoe rack','water flosser']){
  assert.throws(()=>selectedAmazonListing({productName,hasReferenceImage:true}));
  assert.throws(()=>selectedAmazonListing({productName,verifiedExpansion:{query:productName}}));
  assert.equal(selectedAmazonListing({productName,productUrl:'https://www.amazon.com/dp/B00VTA9F6U',hasReferenceImage:true}),'https://www.amazon.com/dp/B00VTA9F6U');
 }
});
test('a malformed selected link never falls back to general search',()=>{
 assert.throws(()=>selectedAmazonListing({productUrl:'https://www.amazon.com/s?k=mop',productName:'spray mop'}));
 assert.equal(selectedAmazonListing({productName:'spray mop'}),undefined);
});
