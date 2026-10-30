import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithScrapling, isScraplingAmazonUrl, validateScraplingResponse } from './scrapling.ts';

test('Scrapling only accepts HTTPS requests to the actual Amazon host', () => {
  assert.equal(isScraplingAmazonUrl('https://www.amazon.com/s?k=mop'), true);
  for (const url of ['http://www.amazon.com/', 'https://amazon.com.evil.test/', 'https://127.0.0.1/', 'https://user:secret@www.amazon.com/', 'https://www.amazon.com:8080/']) {
    assert.equal(isScraplingAmazonUrl(url), false, url);
  }
});

test('malformed scraper output and foreign redirects cannot enter the HTML parser', () => {
  assert.throws(() => validateScraplingResponse('not json'));
  assert.throws(() => validateScraplingResponse(JSON.stringify({ status: 200, url: 'https://example.com/', html: '<html></html>' })));
  assert.throws(() => validateScraplingResponse(JSON.stringify({ status: 200, url: 'https://www.amazon.com/', html: null })));
  assert.deepEqual(validateScraplingResponse(JSON.stringify({ status: 503, url: 'https://www.amazon.com/', html: 'blocked' })), {status: 503, html: 'blocked'});
});

test('cancelled requests never launch a Python scraper', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchWithScrapling('https://www.amazon.com/', {signal: controller.signal}), {name: 'AbortError'});
});

test('missing Python returns promptly and releases its queue slot', async () => {
  const previous = process.env.SCRAPLING_PYTHON;
  process.env.SCRAPLING_PYTHON = 'creative-radaar-missing-python-runtime';
  try {
    await assert.rejects(fetchWithScrapling('https://www.amazon.com/'));
    await assert.rejects(fetchWithScrapling('https://www.amazon.com/'));
  } finally {
    if (previous === undefined) delete process.env.SCRAPLING_PYTHON;
    else process.env.SCRAPLING_PYTHON = previous;
  }
});
