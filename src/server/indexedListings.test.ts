import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverIndexedListings} from './indexedListings.ts';
import {parseAmazonSearchResultsHtml} from './amazonSearch.ts';

test('a plain heading and an image with src before class are readable',()=>{
 const [row]=parseAmazonSearchResultsHtml('<div data-asin="B000000001"><h2>Microfiber Spray Mop</h2><img src="https://m.media-amazon.com/images/I/mop.jpg" class="s-image"></div>');
 assert.equal(row.title,'Microfiber Spray Mop');
 assert.ok(row.imageUrl?.endsWith('/mop.jpg'));
});

test('discovery only resolves Amazon product links and discards unrelated listings',async()=>{
 const html='<a href="https://www.amazon.com/product/dp/B000000001">Mop</a><a href="https://example.com/dp/B000000002">Other</a><a href="https://amazon.com/dp/B000000003">Other</a>';
 const candidates=await discoverIndexedListings('Spray Mop',undefined,async()=>new Response(html),async url=>{
   assert.ok(url.startsWith('https://www.amazon.com/dp/'));
   const title=url.endsWith('1')?'Spray Mop':'HDMI Switch';
   return {extractedTitle:title,canonicalSearchQuery:title,mustMatchAttributes:[],imageUrl:'https://m.media-amazon.com/images/I/product.jpg'};
 });
 assert.deepEqual(candidates.map(row=>row.asin),['B000000001']);
});
