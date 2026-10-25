import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseVisualIdentity,matchesIdentity} from './productIdentity';
import {selectImageMatches} from './identifyProduct';
test('conflicting image never inherits the old product name or attributes',()=>{
 const result=chooseVisualIdentity([{label:'Double Rod Clothes Rack with Wheels',score:0.8},{label:'Fabric Shoe Rack with Cover',score:0.1}],'9 Tier Shoe Rack with Cover');
 assert.equal(result.query,'Double Rod Clothes Rack with Wheels');assert.equal(result.conflict,true);assert(!result.query.includes('9'));
});
test('compatible image preserves explicitly supplied tier and cover; low margins request review',()=>{
 const result=chooseVisualIdentity([{label:'Fabric Shoe Rack with Cover',score:0.4},{label:'Wooden Bamboo Shoe Rack',score:0.38}],'9 Tier Shoe Rack with Cover');
 assert.equal(result.query,'9 Tier Shoe Rack with Cover');assert.equal(result.uncertain,true);
 assert.throws(()=>chooseVisualIdentity([{label:'invented brand',score:NaN}],'rack'));
});
test('identity filter rejects conflicting types, explicit tiers and construction',()=>{
 assert(!matchesIdentity('Double Rod Clothes Rack','9 Tier Shoe Rack with Cover','fabric-shoes'));
 assert(!matchesIdentity('5-Tier Shoe Rack with Cover','9 Tier Shoe Rack with Cover','fabric-shoes'));
 assert(!matchesIdentity('Shoe Rack with Cover','9 Tier Shoe Rack with Cover','fabric-shoes'));
 assert(!matchesIdentity('SC-1588 Blender','Blender SC-1589','blender'));
 assert(!matchesIdentity('9 Tier Open Shoe Rack','9 Tier Shoe Rack with Cover','fabric-shoes'));
 assert(matchesIdentity('9 Tier Shoe Rack with Zipper Cover','9 Tier Shoe Rack with Cover','fabric-shoes'));
 assert(!matchesIdentity('Plastic Shoe Rack','Wooden Bamboo Shoe Rack','wood-shoes'));
});
test('image matches cannot be invented from titles or filled up with the least bad results',()=>{
 const hits=[{asin:'B000000001',title:'Same title',url:'https://www.amazon.com/dp/B000000001',ratingsCount:100,imageUrl:'https://m.media-amazon.com/a.jpg'}];
 assert.equal(selectImageMatches(hits,[{id:'B000000001',cosine:0.99,structure:0.5,accepted:true}]).length,0);
 assert.equal(selectImageMatches(hits,[{id:'fake',cosine:1,structure:1,accepted:true}]).length,0);
 assert.equal(selectImageMatches(hits,[{id:'B000000001',cosine:0.95,structure:0.94,accepted:true}]).length,1);
 assert.equal(selectImageMatches(hits,[]).length,0);
});
test('unlisted product families can be compared against the supplied English name without accepting unrelated listings',()=>{
 const identity=chooseVisualIdentity([{label:'Micro Mini 1080p Camera',score:0.7},{label:'Rechargeable LED Lamp',score:0.1}],'Micro Mini 1080p Camera');
 assert.equal(identity.family,'custom');assert.equal(identity.query,'Micro Mini 1080p Camera');
 assert(matchesIdentity('Mini Camera 1080p','Micro Mini 1080p Camera',identity.family));
 assert(!matchesIdentity('Mini LED Lamp','Micro Mini 1080p Camera',identity.family));
});
