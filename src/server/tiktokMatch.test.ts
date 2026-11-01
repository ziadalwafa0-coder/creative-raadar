import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTikTokProducts} from './tiktokMatch.ts';
import {parseFreeTikTokVideos} from './tiktokFreeSearch.ts';

test('selected image or ASIN cannot fall back to an unverified text-only video',async()=>{
 const pool=[{title:'Wacaco Minipresso GR',thumbnailUrl:'https://example.com/not-a-tiktok-cover.jpg'}];
 const ref='data:image/jpeg;base64,'+'A'.repeat(100);
 assert.deepEqual(await filterTikTokProducts(pool,{productName:pool[0].title,matchImage:ref},1,new AbortController().signal),[]);
});
test('a real clip retains its individual poster',()=>{
 const cover='https://p16.tiktokcdn.com/cover.jpg';
 const [item]=parseFreeTikTokVideos({code:0,data:{videos:[{video_id:'1234567890123456789',author:{unique_id:'reviewer'},origin_cover:cover,play:'https://v19.tiktokcdn.com/file.mp4'}]}},1);
 assert.equal(item.thumbnailUrl,cover);
});
