'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCatalogHealth, DEFAULT_THRESHOLDS } = require('../lib/ai-catalog-health');
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (age) => new Date(NOW - age).toISOString();
const baseline = () => ({
  version: 2, scans: { full: null, incremental: null },
  incrementalWatermark: at(20 * MINUTE),
  lastIncrementalCompletedAt: at(15 * MINUTE),
  lastFullCompletedAt: at(24 * 60 * MINUTE),
  lastFullScanStartedAt: at(25 * 60 * MINUTE),
  health: { currentBlocked: 0, previousBlocked: 0, at: at(15 * MINUTE) },
});
const scan = (mode, age, progressAge = age) => ({
  mode, startedAt: at(age), before: at(age), after: null,
  updatedSince: mode === 'full' ? null : at(age + MINUTE), updatedAt: at(progressAge),
});
const evaluate = (state = baseline(), options = {}) => evaluateCatalogHealth(state, { now: NOW, ...options });

test('healthy state reports zero counts and explicit unavailable measurements without mutating state', () => {
  const state = baseline(), before = JSON.stringify(state);
  const result = evaluate(state);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.counts, { currentBlocked: 0, previousBlocked: 0, blockedGrowth: 0 });
  assert.equal(result.ages.incrementalCompletionMs, 15 * MINUTE);
  assert.equal(result.ages.fullReconciliationMs, 25 * 60 * MINUTE);
  assert.deepEqual(result.unavailable, ['newProductAge', 'sourceCoverage']);
  assert.equal(JSON.stringify(state), before);
});

test('disabled updater is distinguishable and never healthy even with fresh state', () => {
  const result = evaluate(baseline(), { enabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.issues, ['UPDATER_DISABLED']);
});

test('zero-age timestamps and the epoch clock are real values, not missing evidence', () => {
  const epoch = '1970-01-01T00:00:00.000Z';
  const state = { version: 2, scans: { full: null, incremental: null },
    incrementalWatermark: epoch, lastIncrementalCompletedAt: epoch,
    lastFullCompletedAt: epoch, lastFullScanStartedAt: epoch,
    health: { currentBlocked: 0, previousBlocked: 0, at: epoch } };
  for (const now of [0, epoch, new Date(0)]) {
    const result = evaluateCatalogHealth(state, { now });
    assert.equal(result.ok, true);
    assert.equal(result.ages.incrementalCompletionMs, 0);
    assert.equal(result.ages.fullReconciliationMs, 0);
  }
});

test('missing baseline/counts and incomplete initial backfill do not claim health', () => {
  for (const state of [{}, { version: 2, scans: { full: scan('full', MINUTE) }, health: { currentBlocked: 0 } }]) {
    const result = evaluate(state);
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes('NO_BASELINE'));
    assert.equal(result.ages.fullCompletionMs, null);
  }
  const result = evaluate({});
  assert.equal(result.counts.currentBlocked, null);
  assert.equal(result.counts.blockedGrowth, null);
  assert.ok(result.issues.includes('BLOCKED_COUNT_UNAVAILABLE'));
});

test('recent progress in both lanes is healthy but never substitutes for completed incremental freshness', () => {
  const state = baseline();
  state.scans = { full: scan('full', 120 * MINUTE, MINUTE), incremental: scan('incremental', 10 * MINUTE, MINUTE) };
  assert.equal(evaluate(state).ok, true);
  state.lastIncrementalCompletedAt = at(61 * MINUTE);
  const result = evaluate(state);
  assert.ok(result.issues.includes('INCREMENTAL_COMPLETION_OVERDUE'));
  assert.ok(!result.issues.includes('FULL_SCAN_STALLED'));
});

test('stalled independent scans, stale watermark and overdue full reconciliation are detected', () => {
  const state = baseline();
  state.scans = { full: scan('full', 120 * MINUTE, 61 * MINUTE), incremental: scan('incremental', 61 * MINUTE) };
  state.incrementalWatermark = at(61 * MINUTE);
  state.lastFullScanStartedAt = at(49 * 60 * MINUTE);
  const result = evaluate(state);
  for (const code of ['FULL_SCAN_STALLED', 'INCREMENTAL_SCAN_STALLED', 'INCREMENTAL_WATERMARK_OVERDUE', 'FULL_RECONCILIATION_OVERDUE']) {
    assert.ok(result.issues.includes(code), code);
  }
});

test('threshold boundaries are inclusive and validated overrides take effect', () => {
  const state = baseline();
  state.incrementalWatermark = state.lastIncrementalCompletedAt = at(DEFAULT_THRESHOLDS.maxIncrementalAgeMs);
  state.lastFullScanStartedAt = state.lastFullCompletedAt = at(DEFAULT_THRESHOLDS.maxFullAgeMs);
  state.scans.full = scan('full', DEFAULT_THRESHOLDS.maxScanProgressAgeMs);
  assert.equal(evaluate(state).ok, true);
  const strict = evaluate(state, { maxIncrementalAgeMs: MINUTE, maxScanProgressAgeMs: MINUTE, maxFullAgeMs: MINUTE });
  assert.equal(strict.ok, false);
  assert.ok(strict.issues.includes('FULL_SCAN_STALLED'));
});

test('initial completed full scan gives limited first-incremental grace without inventing an incremental completion', () => {
  const state = baseline();
  delete state.lastIncrementalCompletedAt;
  state.incrementalWatermark = state.lastFullScanStartedAt = at(20 * MINUTE);
  state.lastFullCompletedAt = at(15 * MINUTE);
  let result = evaluate(state);
  assert.equal(result.ok, true);
  assert.equal(result.ages.incrementalCompletionMs, null);
  assert.equal(result.ages.incrementalFreshnessMs, 15 * MINUTE);
  assert.ok(result.unavailable.includes('incrementalCompletion'));
  state.lastFullCompletedAt = at(61 * MINUTE);
  state.lastFullScanStartedAt = state.incrementalWatermark = at(65 * MINUTE);
  result = evaluate(state);
  assert.ok(result.issues.includes('INCREMENTAL_COMPLETION_OVERDUE'));
});

test('legacy completion and scan state are supported conservatively without inventing full completion time', () => {
  const state = {
    version: 1, incrementalWatermark: at(20 * MINUTE), lastCompletedAt: at(15 * MINUTE),
    lastCompletedMode: 'incremental', lastFullScanStartedAt: at(24 * 60 * MINUTE),
    scan: scan('full', 20 * MINUTE), health: { currentBlocked: 0 },
  };
  delete state.scan.updatedAt;
  const result = evaluate(state);
  assert.equal(result.ok, true);
  assert.equal(result.ages.fullCompletionMs, null);
  assert.equal(result.ages.scanProgressMs.full, 20 * MINUTE);
  assert.ok(result.unavailable.includes('fullScanProgressTimestamp'));
  state.scan.startedAt = state.scan.before = at(61 * MINUTE);
  assert.ok(evaluate(state).issues.includes('FULL_SCAN_STALLED'));
});

test('legacy full completion can establish initial grace and full baseline', () => {
  const result = evaluate({ version: 1, scan: null, incrementalWatermark: at(20 * MINUTE),
    lastCompletedAt: at(15 * MINUTE), lastCompletedMode: 'full', lastFullScanStartedAt: at(20 * MINUTE),
    health: { currentBlocked: 0 } });
  assert.equal(result.ok, true);
  assert.equal(result.ages.incrementalCompletionMs, null);
});

test('blocked counts retain real zero/missing semantics and flag existing blocks and growth', () => {
  const state = baseline();
  state.health = { currentBlocked: 3, previousBlocked: 0 };
  let result = evaluate(state);
  assert.equal(result.counts.blockedGrowth, 3);
  assert.ok(result.issues.includes('BLOCKED_COUNT_GREW'));
  assert.ok(result.issues.includes('BLOCKED_PRODUCTS_PRESENT'));
  result = evaluate(state, { previousBlockedCount: 5 });
  assert.equal(result.counts.blockedGrowth, -2);
  assert.ok(!result.issues.includes('BLOCKED_COUNT_GREW'));
  delete state.health.previousBlocked;
  result = evaluate(state);
  assert.equal(result.counts.previousBlocked, null);
  assert.equal(result.counts.blockedGrowth, null);
  assert.ok(result.unavailable.includes('blockedGrowth'));
});

test('malformed/future timestamps fail closed, including shadowed legacy fields', () => {
  for (const field of ['incrementalWatermark', 'lastCompletedAt', 'lastIncrementalCompletedAt', 'lastFullCompletedAt', 'lastFullScanStartedAt']) {
    for (const value of ['not-a-date', '2026-02-30T00:00:00Z', '2026-10-05', 0, at(-1)]) {
      const state = baseline(); state[field] = value;
      assert.equal(evaluate(state).ok, false, `${field}: ${value}`);
    }
  }
  const state = baseline();
  state.scans.full = scan('full', MINUTE, -1);
  const result = evaluate(state);
  assert.ok(result.issues.includes('FULL_SCAN_PROGRESS_FUTURE'));
  assert.equal(result.ages.scanProgressMs.full, null);
});

test('malformed lane structure and contradictory timestamps fail closed', () => {
  const changes = [
    state => { state.scans = []; },
    state => { state.scans.full = 'secret'; },
    state => { state.scans.incremental = scan('full', MINUTE); },
    state => { state.scans.full = scan('full', MINUTE); delete state.scans.full.updatedAt; },
    state => { state.scans.full = scan('full', MINUTE); state.scans.full.after = {}; },
    state => { state.scans.full = scan('full', MINUTE, 2 * MINUTE); },
    state => { state.scans.full = scan('full', MINUTE); state.scans.full.before = at(2 * MINUTE); },
    state => { state.scans.incremental = scan('incremental', MINUTE); state.scans.incremental.updatedSince = at(0); },
    state => { state.lastFullScanStartedAt = at(0); },
  ];
  for (const change of changes) { const state = baseline(); change(state); assert.equal(evaluate(state).ok, false); }
});

test('invalid clocks, thresholds, counts, flags and state structures cannot report healthy', () => {
  for (const now of [null, NaN, Infinity, 'invalid', new Date(NaN)]) assert.equal(evaluate(baseline(), { now }).ok, false);
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    for (const value of [0, -1, NaN, Infinity, '60000', null]) assert.equal(evaluate(baseline(), { [key]: value }).ok, false);
  }
  for (const currentBlocked of [-1, 0.1, NaN, Infinity, '0']) {
    const state = baseline(); state.health.currentBlocked = currentBlocked;
    const result = evaluate(state);
    assert.equal(result.ok, false); assert.equal(result.counts.currentBlocked, null);
  }
  assert.equal(evaluate(baseline(), { previousBlockedCount: -1 }).ok, false);
  assert.equal(evaluate(baseline(), { enabled: 'true' }).enabled, null);
  for (const state of [null, [], 'private']) assert.equal(evaluate(state).ok, false);
  assert.equal(evaluateCatalogHealth(baseline(), null).ok, false);
});

test('result never contains private payload, product IDs, cursors, source text or arbitrary error strings', () => {
  const state = baseline();
  state.quarantinedProducts = { 'gid://shopify/Product/123': { reason: 'PRIVATE_REASON' } };
  state.source = 'SECRET_SOURCE';
  state.health.details = { token: 'SECRET_TOKEN' };
  state.scans.full = scan('full', MINUTE);
  state.scans.full.after = 'PRIVATE_CURSOR';
  state.lastCompletedAt = 'SECRET_INVALID_TIMESTAMP';
  const output = JSON.stringify(evaluate(state));
  for (const value of ['gid://shopify', 'PRIVATE', 'SECRET']) assert.ok(!output.includes(value));
});
