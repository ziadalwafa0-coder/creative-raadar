import test from 'node:test';
import assert from 'node:assert/strict';
import {videoKeys} from './videoIdentity.ts';
test('signed URLs and encodings cannot duplicate an Amazon stream',()=>{
 const media='https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-test/abcdef123/';
 const a=videoKeys({mediaType:'video',mediaUrl:media+'hls.m3u8?sig=1'});
 const b=videoKeys({mediaType:'video',mediaUrl:media+'hi.mp4?sig=2'});
 assert.ok(a.some(key=>b.includes(key)));
});
test('TikTok post remains identical across handle and CDN changes',()=>{
 const keys=(author:string)=>videoKeys({mediaType:'video',sourceUrl:'https://www.tiktok.com/@'+author+'/video/12345678901234',mediaUrl:'https://cdn.test/'+author});
 assert.ok(keys('old').some(key=>keys('new').includes(key)));
});
