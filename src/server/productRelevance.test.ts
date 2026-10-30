import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAmazonUsQueries, evaluateStrictProductTitleMatch } from './queryBuilder.ts';
import { parseAmazonUsVideosFromHtml } from './amazonVideos.ts';

const target = 'B012345678';
const foreign = 'B098765432';
const url = `https://www.amazon.com/dp/${target}`;
const media = (id: string) => `https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact/${id}/default.jobtemplate.hls.m3u8`;
const items = (entries: object[]) => `<div data-video-items="${JSON.stringify(entries).replace(/"/g, '&quot;')}"></div>`;

test('Arabic spray mop identity survives without Gemini, including Egyptian spelling and numerals', async () => {
  for (const name of ['مساحة وبخاخة 2 في 1', 'مساحه وبخاخه ٢ ف ١', 'ممسحة بخاخ 2 in 1']) {
    const queries = await buildAmazonUsQueries(name);
    assert.equal(queries.primaryQuery, 'spray mop');
    assert.ok(queries.variants.every(q => q.includes('mop')));
  }
});

test('unknown Arabic and numeric-only names cannot silently turn into a broad product search', async () => {
  for (const name of ['منتج غير معروف 2 في 1', '2 in 1', '2 1']) {
    await assert.rejects(buildAmazonUsQueries(name), /تعذر تحديد اسم المنتج/);
  }
});

test('mop matching rejects the reported HDMI/book products and spray bottles', () => {
  for (const title of ['GANA 2 in 1 HDMI Switch', 'Summer Quest Workbook Grades 1 & 2', 'Spray Bottle for Plants', 'Mop Replacement Pads']) {
    assert.equal(evaluateStrictProductTitleMatch(title, 'spray mop').approved, false, title);
  }
  assert.equal(evaluateStrictProductTitleMatch('Microfiber Floor Spray Mop with Refillable Water Tank', 'spray mop').approved, true);
  assert.equal(evaluateStrictProductTitleMatch('HDMI switch', '2 in 1').approved, false);
  assert.equal(evaluateStrictProductTitleMatch('HDMI switch', '').approved, false);
});

test('recommendations with a foreign related ASIN and no productAsin cannot masquerade as target reviews', () => {
  const parsed = parseAmazonUsVideosFromHtml(items([
    { videoURL: media('foreign-review'), creatorType: 'Customer', relatedProductsAsins: foreign, fullReviewLink: '/gp/customer-reviews/RFOREIGN' },
    { videoURL: media('correct-review'), creatorType: 'Customer', relatedProductsAsins: target, fullReviewLink: '/gp/customer-reviews/RCORRECT' },
  ]), url);
  assert.deepEqual(parsed.map(v => v.reviewId), ['RCORRECT']);
});

test('foreign parents cannot poison the allowlist, and unbound items are excluded', () => {
  const parsed = parseAmazonUsVideosFromHtml(items([
    { videoURL: media('foreign-parent'), creatorType: 'Customer', productAsin: foreign, parentAsin: foreign },
    { videoURL: media('foreign-child'), creatorType: 'Customer', productAsin: foreign, parentAsin: target },
    { videoURL: media('unbound-review'), creatorType: 'Customer', fullReviewLink: '/gp/customer-reviews/RUNBOUND' },
    { videoURL: media('seller-review'), creatorType: 'Seller', productAsin: target, fullReviewLink: '/gp/customer-reviews/RSELLER' },
  ]), url);
  assert.equal(parsed.length, 0);
});

test('the last review block cannot consume unrelated footer videos', () => {
  const html = `<div id="customer_review-RCORRECT"><div><span class="a-profile-name">Buyer</span></div><video src="${media('correct-review')}"></video></div><footer><video src="${media('foreign-review')}"></video></footer>`;
  const parsed = parseAmazonUsVideosFromHtml(html, url);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].mediaUrl.includes('correct-review'));
});
