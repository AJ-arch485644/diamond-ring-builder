'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { options } = require('../scripts/sync-ai-catalog-metafields');

test('CLI defaults to dry-run and a bounded canary-sized write cap', () => {
  assert.deepEqual(options([], {}), { mode: 'incremental', write: false, maxWrites: 5, maxProducts: 250, maxDurationMs: 1200000 });
});
test('both flag and enable variable are required to write', () => {
  assert.throws(() => options(['--write'], {}), /WRITES_DISABLED/);
  assert.equal(options([], { AI_CATALOG_WRITES_ENABLED: 'true' }).write, false);
  assert.equal(options(['--write'], { AI_CATALOG_WRITES_ENABLED: 'true' }).write, true);
});
test('invalid flags, limits and product IDs fail before loading credentials', () => {
  for (const args of [['--delete'], ['--mode', 'any'], ['--max-writes', '0'], ['--max-writes', '501'], ['--max-products', '25001'], ['--max-duration-seconds', '7201'], ['--product-ids', '1,1'], ['--product-ids', '1;echo secret'], ['--product-ids', ''], ['--mode', 'full', '--mode', 'incremental']]) {
    assert.throws(() => options(args, {}));
  }
  assert.deepEqual(options(['--product-ids', '123,456'], {}).productIds, ['gid://shopify/Product/123', 'gid://shopify/Product/456']);
});
test('a deliberate full read-only scan can use a longer bounded duration', () => {
  assert.equal(options(['--mode', 'full', '--max-duration-seconds', '7200'], {}).maxDurationMs, 7200000);
});
