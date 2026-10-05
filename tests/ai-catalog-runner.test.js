'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCatalog } = require('../lib/ai-catalog-runner');
const result = (overrides = {}) => ({ mode: 'incremental', requestedMode: 'incremental', dryRun: false,
  status: 'completed', complete: true, failed: false, errors: [], examined: 50, written: 10,
  verifiedWrites: 10, readRequests: 70, noops: 40, planned: 10, blocked: 0, sourceRaces: 0,
  checkpointAdvanced: true, currentBlocked: 0, blockedReasons: {}, ...overrides });

test('recent changes precede pending full scan and total caps are shared', async () => {
  const calls = []; let time = 0;
  const options = { mode: 'incremental', write: true, maxProducts: 500, maxWrites: 100,
    maxDurationMs: 1200000, now: () => time, store: { loadState: async () => ({ scans: { full: {} } }) } };
  const actual = await runCatalog(options, async args => {
    calls.push(args); time += 10000;
    return calls.length === 1 ? result() : result({ mode: 'full', complete: false, status: 'paused', examined: 450, written: 90 });
  });
  assert.equal(calls[0].mode, 'incremental'); assert.equal(calls[0].maxProducts, 200);
  assert.equal(calls[0].maxWrites, 40); assert.equal(calls[0].maxDurationMs, 480000);
  assert.equal(calls[1].mode, 'full'); assert.equal(calls[1].maxProducts, 450);
  assert.equal(calls[1].maxWrites, 90); assert.equal(calls[1].maxDurationMs, 1190000);
  assert.equal(actual.examined, 500); assert.equal(actual.written, 100);
  assert.equal(actual.complete, false); assert.equal(actual.status, 'paused');
});

test('failed, raced or exhausted recent pass never starts full writes', async () => {
  for (const first of [result({ failed: true }), result({ sourceRaces: 1 }), result({ errors: [{ code: 'LEASE_LOST' }] }), result({ written: 100 }), result({ examined: 500 })]) {
    let calls = 0;
    await runCatalog({ mode: 'incremental', write: true, maxProducts: 500, maxWrites: 100,
      store: { loadState: async () => ({ scan: { mode: 'full' } }) } }, async () => { calls++; return first; });
    assert.equal(calls, 1);
  }
});

test('canaries and manual full runs pass through unchanged', async () => {
  for (const opts of [{ mode: 'full' }, { mode: 'incremental', productIds: ['gid://shopify/Product/1'] }]) {
    const returned = await runCatalog(opts, async args => { assert.equal(args, opts); return 'sentinel'; });
    assert.equal(returned, 'sentinel');
  }
});

test('no pending full scan preserves the full incremental budget', async () => {
  const opts = { mode: 'incremental', maxProducts: 500, store: { loadState: async () => ({ scans: { full: null } }) } };
  await runCatalog(opts, async args => { assert.equal(args, opts); return result(); });
});

test('an incomplete incremental pass is never reported as complete after full finishes', async () => {
  let calls = 0;
  const actual = await runCatalog({ mode: 'incremental', write: false, maxProducts: 500,
    store: { loadState: async () => ({ scans: { full: {} } }) } }, async () => ++calls === 1
    ? result({ complete: false, status: 'paused', blocked: 2, blockedReasons: { source_conflict: 2 } })
    : result({ mode: 'full', blocked: 1, blockedReasons: { source_conflict: 1 } }));
  assert.equal(actual.complete, false); assert.equal(actual.blockedReasons.source_conflict, 3);
});

test('slow state reload cannot start full work after the shared time budget expires', async () => {
  let time = 0, loads = 0, calls = 0;
  const actual = await runCatalog({ mode: 'incremental', write: true, maxDurationMs: 100,
    maxProducts: 500, maxWrites: 100, now: () => time,
    store: { loadState: async () => { if (++loads === 2) time = 200; return { scans: { full: {} } }; } },
  }, async () => { calls++; time = 20; return result(); });
  assert.equal(calls, 1); assert.equal(actual.mode, 'incremental');
});
