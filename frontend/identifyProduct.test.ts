import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import {findIdentityCandidates,loadAmazonImage} from './identifyProduct';
Object.assign(globalThis,{DOMParser});
const identity={query:'Portable Iron',family:'custom' as const,conflict:false,uncertain:true,alternatives:[]};
const html=(asin:string)=>`<html><body><div data-component-type="s-search-result" data-asin="${asin}"><h2>Portable Iron</h2><img class="s-image" src="https://m.media-amazon.com/${asin}.jpg"></div></body></html>`;
test('matching titles cannot approve different pictures and never change iron into dryer',async()=>{
 const queries:string[]=[];let compared=0;
 const result=await findIdentityCandidates(new Blob(['reference']),identity,'amazon.com',new AbortController().signal,()=>{},{
  request:async(_operation,payload)=>{queries.push(payload.query);return{html:html('B00000000'+payload.page),page:Number(payload.page)};},
  loadImage:async()=>new Blob(['different picture']),
  compare:async(_image,candidates)=>{compared+=candidates.length;return candidates.map(c=>({id:c.id,cosine:0.7,structure:0.6,accepted:false}));},
 });
 assert.deepEqual(queries,['Portable Iron','Portable Iron']);assert.equal(compared,2);assert.equal(result.products.length,0);
});
test('unreadable images fail closed instead of falling back to a title match',async()=>{
 await assert.rejects(findIdentityCandidates(new Blob(),identity,'amazon.com',new AbortController().signal,()=>{},{request:async(_op,p)=>({html:html('B00000000'+p.page)}),loadImage:async()=>{throw Error('CORS');},compare:async()=>{throw Error('must not run');}}),/تعذر قراءة صورها/);
 await assert.rejects(loadAmazonImage('https://evil.test/image.jpg',new AbortController().signal));
});
