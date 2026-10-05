'use strict';

const { syncCatalog } = require('./ai-catalog-sync');
const COUNTS = ['examined', 'readRequests', 'planned', 'noops', 'skipped', 'written', 'verifiedWrites', 'pagesCompleted', 'blocked', 'sourceRaces', 'deleted'];
const pendingFull = state => Boolean(state?.scans?.full || state?.scan?.mode === 'full');

// Spend a bounded part of a scheduled slice on recent changes before resuming
// a full reconciliation. Both passes share the caller's total caps.
async function runCatalog(options, sync = syncCatalog) {
  if (options.mode !== 'incremental' || options.productIds !== undefined) return sync(options);
  const initial = await options.store.loadState();
  if (!pendingFull(initial)) return sync(options);
  const now = options.now || (() => new Date());
  const milliseconds = () => new Date(typeof now === 'function' ? now() : now).getTime();
  const start = milliseconds();
  const maxProducts = options.maxProducts ?? 1000;
  const maxWrites = options.maxWrites ?? 5;
  const maxDurationMs = options.maxDurationMs ?? 20 * 60 * 1000;
  const recent = await sync({ ...options,
    maxProducts: Math.max(1, Math.min(200, Math.floor(maxProducts * 0.4))),
    maxWrites: Math.min(maxWrites, Math.max(1, Math.min(40, Math.floor(maxWrites * 0.4)))),
    maxDurationMs: Math.max(1, Math.floor(maxDurationMs * 0.4)),
  });
  if (recent.failed || recent.errors?.length || recent.sourceRaces || recent.status === 'full_scan_required') return recent;
  const productsLeft = maxProducts - recent.examined;
  const writesLeft = maxWrites - recent.written;
  if (productsLeft < 1 || (options.write && writesLeft < 1)) return recent;
  if (!pendingFull(await options.store.loadState())) return recent;
  const timeLeft = maxDurationMs - (milliseconds() - start);
  if (timeLeft <= 0 || !Number.isFinite(timeLeft)) return recent;
  const full = await sync({ ...options, mode: 'full', maxProducts: productsLeft,
    maxWrites: writesLeft, maxDurationMs: timeLeft });
  const result = { ...full, mode: 'incremental_then_full', requestedMode: 'incremental',
    complete: recent.complete && full.complete, failed: recent.failed || full.failed,
    checkpointAdvanced: recent.checkpointAdvanced || full.checkpointAdvanced,
    errors: [...(recent.errors || []), ...(full.errors || [])],
    passes: [recent, full].map(({ mode, status, complete, examined, written, checkpointAdvanced }) =>
      ({ mode, status, complete, examined, written, checkpointAdvanced })),
    blockedReasons: { ...(recent.blockedReasons || {}) },
  };
  for (const key of COUNTS) result[key] = (recent[key] || 0) + (full[key] || 0);
  for (const [key, count] of Object.entries(full.blockedReasons || {})) {
    result.blockedReasons[key] = (result.blockedReasons[key] || 0) + count;
  }
  if (!result.failed && !result.complete) result.status = 'paused';
  return result;
}

module.exports = { runCatalog };
