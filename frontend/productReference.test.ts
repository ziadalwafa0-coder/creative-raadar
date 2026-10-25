import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productReference} from './productReference';
test('a direct Amazon reference binds the actual marketplace and ASIN without a text search',()=>{
 assert.deepEqual(productReference('https://www.amazon.eg/example/dp/B0B6ZSSWRL?ref=test','amazon.com'),{asin:'B0B6ZSSWRL',market:'amazon.eg'});
 assert.deepEqual(productReference('b0b6zsswrl','amazon.com'),{asin:'B0B6ZSSWRL',market:'amazon.com'});
 assert.equal(productReference('المكواة المحمولة','amazon.com'),undefined);
 for(const link of ['https://amazon.com.evil.test/dp/B0B6ZSSWRL','http://amazon.com/dp/B0B6ZSSWRL','https://www.amazon.com/s?k=iron','https://secret@amazon.com/dp/B0B6ZSSWRL','https://amzn.to/example'])assert.throws(()=>productReference(link,'amazon.com'));
});
