import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commercialProducts, compareEvidence, selectCommercialName} from './visualIdentity.ts';
import {analyzeCommercialName} from './productVision.ts';
import {evaluateStrictProductTitleMatch} from '../server/queryBuilder.ts';

test('commercial suggestions are physical search terms, never a guessed brand/model', () => {
  const result = selectCommercialName([{index:0, score:0.4}, {index:1, score:0.2}]);
  assert.equal(result.query, 'Microfiber Spray Mop Refillable Bottle');
  assert.equal(result.confidence, 'suggested');
  assert.throws(() => selectCommercialName([{index:commercialProducts.length - 1, score:0.7}]));
  assert.equal(selectCommercialName([{index:0, score:0.3}, {index:1, score:0.299}]).uncertain, true);
  assert.equal(selectCommercialName([{index:27, score:0.33}, {index:0, score:0.32}], 'مساحة وبخاخة').query, 'Microfiber Spray Mop Refillable Bottle');
  assert.throws(() => selectCommercialName([{index:9, score:0.55}, {index:0, score:0.21}], 'مساحة وبخاخة'));
});

test('even the closest image is rejected when evidence is too weak', () => {
  const reference = {embedding:[1,0], hash:Array(64).fill(1), contrast:0.1};
  assert.equal(compareEvidence(reference, reference, 'same').accepted, true);
  assert.equal(compareEvidence(reference, {...reference, embedding:[0,1]}, 'different').accepted, false);
  assert.equal(compareEvidence(reference, {...reference, hash:Array(64).fill(0)}, 'different-shape').accepted, false);
  assert.equal(compareEvidence(reference, {...reference, contrast:0}, 'blank').accepted, false);
});

test('tier conflicts are rejected and lexical matches cannot claim exact visual design', () => {
  assert.equal(evaluateStrictProductTitleMatch('5 Tier Shoe Rack with Cover', '9 Tier Shoe Rack with Cover').approved, false);
  const verdict = evaluateStrictProductTitleMatch('9 Tier Shoe Rack with Cover', '9 Tier Shoe Rack with Cover');
  assert.equal(verdict.approved, true);
  assert.notEqual(verdict.matchCategory, 'exact_design');
  assert.equal(evaluateStrictProductTitleMatch('16 oz Empty Spray Bottle with Microfiber Towels Refillable', 'Microfiber Spray Mop Refillable Bottle').approved, false);
  assert.equal(evaluateStrictProductTitleMatch('440 ML Replacement Bottle for Spray Mop', 'Microfiber Spray Mop Refillable Bottle').approved, false);
});

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminated = false; message: any;
  constructor(..._args: any[]) { super(); FakeWorker.instances.push(this); }
  postMessage(message: any) { this.message = message; }
  terminate() { this.terminated = true; }
  reply(result: any) { this.dispatchEvent(new MessageEvent('message', {data:{id:this.message.id, result}})); }
}
test('replacing a product aborts model inference and ignores late identification', async () => {
  const original = globalThis.Worker;
  Object.assign(globalThis, {Worker:FakeWorker});
  try {
    const controller = new AbortController();
    const old = analyzeCommercialName(new Blob(['old']), controller.signal, () => {});
    const first = FakeWorker.instances.at(-1)!;
    controller.abort();
    await assert.rejects(old);
    assert.equal(first.terminated, true);
    first.reply({query:'wrong old product'});
    const next = analyzeCommercialName(new Blob(['new']), new AbortController().signal, () => {});
    const second = FakeWorker.instances.at(-1)!;
    second.reply({query:'new product', confidence:'suggested'});
    assert.equal((await next).query, 'new product');
  } finally { Object.assign(globalThis, {Worker:original}); }
});
