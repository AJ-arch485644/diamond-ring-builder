'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { options, main } = require('../scripts/sync-ai-catalog-metafields');

test('CLI defaults to dry-run and a bounded canary-sized write cap', () => {
  assert.deepEqual(options([], {}), { mode: 'incremental', write: false, maxWrites: 5, maxProducts: 250, maxDurationMs: 1200000 });
});
test('both flag and enable variable are required to write', () => {
  assert.throws(() => options(['--write'], {}), /WRITES_DISABLED/);
  assert.equal(options([], { AI_CATALOG_WRITES_ENABLED: 'true' }).write, false);
  assert.equal(options(['--write'], { AI_CATALOG_WRITES_ENABLED: 'true' }).write, true);
});
test('invalid flags, limits and product IDs fail before loading credentials', () => {
  for (const args of [['--delete'], ['--mode', 'any'], ['--max-writes', '0'], ['--max-writes', '501'], ['--mode', 'full', '--max-writes', '1001'], ['--mode', 'full', '--product-ids', '123', '--max-writes', '501'], ['--max-products', '25001'], ['--max-duration-seconds', '7201'], ['--product-ids', '1,1'], ['--product-ids', '1;echo secret'], ['--product-ids', ''], ['--mode', 'full', '--mode', 'incremental']]) {
    assert.throws(() => options(args, {}));
  }
  assert.deepEqual(options(['--product-ids', '123,456'], {}).productIds, ['gid://shopify/Product/123', 'gid://shopify/Product/456']);
});
test('a deliberate full read-only scan can use a longer bounded duration', () => {
  assert.equal(options(['--mode', 'full', '--max-duration-seconds', '7200'], {}).maxDurationMs, 7200000);
});

test('explicit manual full backfill accepts 1000 writes and 45 minutes without enabling writes', () => {
  const args = ['--mode', 'full', '--max-writes', '1000', '--max-products', '25000', '--max-duration-seconds', '2700'];
  assert.deepEqual(options(args, {}), { mode: 'full', write: false, maxWrites: 1000, maxProducts: 25000, maxDurationMs: 2700000 });
  assert.throws(() => options([...args, '--write'], {}), /WRITES_DISABLED/);
  assert.equal(options([...args, '--write'], { AI_CATALOG_WRITES_ENABLED: 'true' }).write, true);
  assert.equal(options(['--mode', 'incremental', '--max-writes', '500'], {}).maxWrites, 500);
  assert.equal(options(['--mode', 'full', '--product-ids', '123', '--max-writes', '500'], {}).maxWrites, 500);
});

test('reviewed revision guard rejects malformed or mismatched heads before write authorization', () => {
  const head = '1'.repeat(40);
  for (const expected of [null, 42, {}, ' ', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${head}\n`]) {
    assert.throws(() => options(['--write'], { INPUT_EXPECTED_HEAD: expected, GITHUB_SHA: head }), /INVALID_EXPECTED_HEAD/);
  }
  for (const actual of [undefined, '', '2'.repeat(40), `${head} `]) {
    const env = new Proxy({ INPUT_EXPECTED_HEAD: head, GITHUB_SHA: actual }, {
      get(target, key) {
        assert.ok(['INPUT_EXPECTED_HEAD', 'GITHUB_SHA'].includes(key), 'revision must be checked before other runtime settings');
        return target[key];
      },
    });
    assert.throws(() => options(['--write'], env), /EXPECTED_HEAD_MISMATCH/);
  }
});

test('matching reviewed revision permits the existing bounded options without enabling writes', () => {
  const head = '1234567890abcdef1234567890abcdef12345678';
  const env = { INPUT_EXPECTED_HEAD: head, GITHUB_SHA: head };
  const args = ['--mode', 'full', '--max-writes', '1000', '--max-duration-seconds', '2700'];
  assert.deepEqual(options(args, env), options(args, {}));
  assert.throws(() => options([...args, '--write'], env), /WRITES_DISABLED/);
  assert.equal(options([...args, '--write'], { ...env, AI_CATALOG_WRITES_ENABLED: 'true' }).write, true);
  assert.deepEqual(options([], { INPUT_EXPECTED_HEAD: '', GITHUB_SHA: 'another revision' }), options([], {}));
});

test('main aborts a revision mismatch before loading clients that access credentials or write data', async () => {
  const Module = require('node:module');
  const load = Module._load;
  const argv = process.argv;
  const oldExpected = process.env.INPUT_EXPECTED_HEAD;
  const oldActual = process.env.GITHUB_SHA;
  const loaded = [];
  try {
    process.argv = ['node', 'sync-ai-catalog-metafields.js', '--write'];
    process.env.INPUT_EXPECTED_HEAD = '1'.repeat(40);
    process.env.GITHUB_SHA = '2'.repeat(40);
    Module._load = function (request, ...rest) {
      if (['@supabase/supabase-js', '../lib/ai-catalog-io', '../lib/ai-catalog-runner'].includes(request)) {
        loaded.push(request);
        throw new Error('Runtime clients must not load');
      }
      return load.call(this, request, ...rest);
    };
    await assert.rejects(main(), /EXPECTED_HEAD_MISMATCH/);
    assert.deepEqual(loaded, []);
  } finally {
    Module._load = load;
    process.argv = argv;
    if (oldExpected === undefined) delete process.env.INPUT_EXPECTED_HEAD;
    else process.env.INPUT_EXPECTED_HEAD = oldExpected;
    if (oldActual === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = oldActual;
  }
});
