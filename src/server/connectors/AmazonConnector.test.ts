import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AmazonConnector} from './AmazonConnector.ts';

test('legacy adapter cannot fabricate verified purchases, media or availability from a product URL',async()=>{
 const connector=new AmazonConnector();
 assert.equal(await connector.healthCheck(),false);
 assert.equal(connector.capabilities().state,'unsupported');
 const result=await connector.inspectSource('https://www.amazon.com/dp/B000000001');
 assert.deepEqual(result,{provenance:'unresolved_source'});
 assert.equal(connector.extractAsin('https://evil.test/dp/B000000001'),null);
 assert.equal(connector.extractAsin('https://www.amazon.com/dp/B000000001'),'B000000001');
 assert.equal((await connector.resolveAccessibleMedia({mediaType:'video',thumbnailUrl:'https://m.media-amazon.com/photo.jpg'})).canDownload,false);
 assert.equal((await connector.resolveAccessibleMedia({mediaType:'video',mediaUrl:'https://m.media-amazon.com/photo.jpg'})).canDownload,false);
 assert.equal((await connector.resolveAccessibleMedia({mediaType:'video',mediaUrl:'https://evil.test/video.mp4'})).canDownload,false);
 assert.equal((await connector.resolveAccessibleMedia({mediaType:'video',mediaUrl:'https://m.media-amazon.com/video.mp4'})).canDownload,true);
});
