'use strict';

// Read-only, aggregate liveness checks. Even a healthy worker does not establish
// Catalog ingestion, complete source coverage, or the age of new products.
const DEFAULT_THRESHOLDS = Object.freeze({
  maxIncrementalAgeMs: 60 * 60 * 1000,
  maxScanProgressAgeMs: 60 * 60 * 1000,
  maxFullAgeMs: 48 * 60 * 60 * 1000,
});
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const missing = (value) => value === undefined || value === null;

function timestamp(value) {
  // Avoid Date.parse's coercion of numbers, date-only strings and invalid dates
  // such as February 30. Persisted worker timestamps must identify an instant.
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function evaluateCatalogHealth(state, options = {}) {
  const issues = new Set();
  const unavailable = new Set(['sourceCoverage', 'newProductAge']);
  const input = object(state) ? state : {};
  const config = object(options) ? options : {};
  if (!object(state)) issues.add('INVALID_STATE');
  if (!object(options)) issues.add('INVALID_OPTIONS');
  const enabled = config.enabled === undefined ? true : config.enabled;
  if (typeof enabled !== 'boolean') issues.add('INVALID_ENABLED');
  if (enabled === false) issues.add('UPDATER_DISABLED');
  const clock = config.now === undefined ? Date.now() : config.now;
  const now = clock instanceof Date ? clock.getTime() : typeof clock === 'string' ? timestamp(clock) : clock;
  const validClock = typeof now === 'number' && Number.isFinite(now) && Math.abs(now) <= 8640000000000000;
  if (!validClock) issues.add('INVALID_CLOCK');
  const thresholds = {};
  for (const [key, fallback] of Object.entries(DEFAULT_THRESHOLDS)) {
    const value = config[key] === undefined ? fallback : config[key];
    if (!Number.isSafeInteger(value) || value <= 0) issues.add('INVALID_THRESHOLDS');
    thresholds[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  const readTime = (value, code) => {
    if (missing(value)) return null;
    const parsed = timestamp(value);
    if (parsed === null) { issues.add(`${code}_INVALID`); return null; }
    if (!validClock) return null;
    if (parsed > now) { issues.add(`${code}_FUTURE`); return null; }
    return parsed;
  };
  const age = (value) => value === null || !validClock ? null : now - value;
  const health = object(input.health) ? input.health : {};
  if (!missing(input.health) && !object(input.health)) issues.add('INVALID_HEALTH');
  if (!missing(input.version) && ![1, 2].includes(input.version)) issues.add('INVALID_STATE_VERSION');
  if (!missing(input.lastCompletedMode) && !['full', 'incremental'].includes(input.lastCompletedMode)) {
    issues.add('INVALID_COMPLETION_MODE');
  }
  const watermark = readTime(input.incrementalWatermark, 'INCREMENTAL_WATERMARK');
  const lastCompleted = readTime(input.lastCompletedAt, 'LAST_COMPLETION');
  const incrementalCompleted = readTime(input.lastIncrementalCompletedAt, 'INCREMENTAL_COMPLETION');
  const fullCompleted = readTime(input.lastFullCompletedAt, 'FULL_COMPLETION');
  const fullStarted = readTime(input.lastFullScanStartedAt, 'FULL_SCAN_START');
  readTime(health.at, 'HEALTH_TIMESTAMP');
  // Missing lane timestamps may use legacy evidence, but a malformed explicit
  // timestamp is never replaced by another timestamp to claim health.
  const incremental = missing(input.lastIncrementalCompletedAt) && input.lastCompletedMode === 'incremental'
    ? lastCompleted : incrementalCompleted;
  const full = missing(input.lastFullCompletedAt) && input.lastCompletedMode === 'full'
    ? lastCompleted : fullCompleted;
  if (full !== null && fullStarted !== null && fullStarted > full) issues.add('FULL_COMPLETION_BEFORE_START');
  // A legacy completed full scan records its start even after a later
  // incremental completes. Use that conservatively, without calling it a
  // completion time. A long full scan must not conceal an old coverage bound.
  const fullEvidence = full === null ? fullStarted : fullStarted === null ? full : Math.min(full, fullStarted);
  const incrementalFreshness = incremental === null ? full : incremental;
  const ages = {
    incrementalCompletionMs: age(incremental),
    incrementalFreshnessMs: age(incrementalFreshness),
    fullCompletionMs: age(full),
    fullReconciliationMs: age(fullEvidence),
    incrementalWatermarkMs: age(watermark),
    scanProgressMs: { full: null, incremental: null },
  };
  if (watermark === null || fullEvidence === null) issues.add('NO_BASELINE');
  if (incremental === null) unavailable.add('incrementalCompletion');
  if (full === null) unavailable.add('fullCompletion');
  if (incrementalFreshness === null) issues.add('INCREMENTAL_COMPLETION_UNAVAILABLE');
  else if (ages.incrementalFreshnessMs > thresholds.maxIncrementalAgeMs) issues.add('INCREMENTAL_COMPLETION_OVERDUE');
  if (watermark !== null && ages.incrementalWatermarkMs > thresholds.maxIncrementalAgeMs) {
    issues.add('INCREMENTAL_WATERMARK_OVERDUE');
  }
  if (fullEvidence === null) issues.add('FULL_RECONCILIATION_UNAVAILABLE');
  else if (ages.fullReconciliationMs > thresholds.maxFullAgeMs) issues.add('FULL_RECONCILIATION_OVERDUE');

  let scans = {};
  const v2 = input.version === 2 || !missing(input.scans);
  if (v2) {
    if (!object(input.scans)) issues.add('INVALID_SCANS');
    else scans = input.scans;
  } else if (!missing(input.scan)) {
    if (!object(input.scan) || !['full', 'incremental'].includes(input.scan.mode)) issues.add('INVALID_LEGACY_SCAN');
    else scans = { [input.scan.mode]: input.scan };
  }
  for (const mode of ['full', 'incremental']) {
    const scan = scans[mode];
    if (missing(scan)) continue;
    const prefix = mode.toUpperCase();
    if (!object(scan) || scan.mode !== mode) { issues.add(`${prefix}_SCAN_INVALID`); continue; }
    const start = readTime(scan.startedAt, `${prefix}_SCAN_STARTED`);
    const before = readTime(scan.before, `${prefix}_SCAN_BEFORE`);
    const progress = missing(scan.updatedAt) && !v2 ? start : readTime(scan.updatedAt, `${prefix}_SCAN_PROGRESS`);
    if (!v2 && missing(scan.updatedAt)) unavailable.add(`${mode}ScanProgressTimestamp`);
    if (start === null || before === null || start !== before || progress === null || progress < start ||
        (scan.after !== null && (typeof scan.after !== 'string' || !scan.after)) ||
        (mode === 'full' && scan.updatedSince !== null)) issues.add(`${prefix}_SCAN_INVALID`);
    if (mode === 'incremental') {
      const since = readTime(scan.updatedSince, 'INCREMENTAL_SCAN_UPDATED_SINCE');
      if (since === null || before === null || since > before) issues.add('INCREMENTAL_SCAN_INVALID');
    }
    ages.scanProgressMs[mode] = age(progress);
    if (progress !== null && ages.scanProgressMs[mode] > thresholds.maxScanProgressAgeMs) issues.add(`${prefix}_SCAN_STALLED`);
  }

  const currentBlocked = count(health.currentBlocked) ? health.currentBlocked : null;
  const previousValue = config.previousBlockedCount === undefined ? health.previousBlocked : config.previousBlockedCount;
  const previousBlocked = count(previousValue) ? previousValue : null;
  if (currentBlocked === null) {
    unavailable.add('currentBlocked');
    issues.add(missing(health.currentBlocked) ? 'BLOCKED_COUNT_UNAVAILABLE' : 'BLOCKED_COUNT_INVALID');
  } else if (currentBlocked > 0) issues.add('BLOCKED_PRODUCTS_PRESENT');
  if (previousBlocked === null) {
    unavailable.add('blockedGrowth');
    if (!missing(previousValue)) issues.add('PREVIOUS_BLOCKED_COUNT_INVALID');
  }
  const blockedGrowth = currentBlocked === null || previousBlocked === null ? null : currentBlocked - previousBlocked;
  if (blockedGrowth !== null && blockedGrowth > 0) issues.add('BLOCKED_COUNT_GREW');
  const ok = enabled === true && issues.size === 0;
  return {
    ok,
    status: enabled === false ? 'disabled' : ok ? 'healthy' : 'unhealthy',
    enabled: typeof enabled === 'boolean' ? enabled : null,
    issues: [...issues].sort(),
    counts: { currentBlocked, previousBlocked, blockedGrowth },
    ages,
    unavailable: [...unavailable].sort(),
  };
}

module.exports = { evaluateCatalogHealth, DEFAULT_THRESHOLDS };
