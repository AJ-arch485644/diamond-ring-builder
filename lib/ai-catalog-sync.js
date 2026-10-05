'use strict';

// A bounded worker. No scheduler or endpoint is activated by importing this file.
const defaultMetadata = require('./ai-catalog-metadata');
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const error = (code) => Object.assign(new Error(code), { code });
const safeCode = (err) => /^[A-Z][A-Z0-9_]{0,80}$/.test(err?.code || '') ? err.code : 'SYNC_FAILED';
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validatePage(page, after, code = 'INVALID_PAGE') {
  if (!Array.isArray(page?.products) || !object(page.pageInfo) || typeof page.pageInfo.hasNextPage !== 'boolean' ||
      (page.pageInfo.endCursor !== null && page.pageInfo.endCursor !== undefined && typeof page.pageInfo.endCursor !== 'string') ||
      page.products.some(product => !PRODUCT_ID.test(product?.id || '')) ||
      new Set(page.products.map(product => product.id)).size !== page.products.length ||
      (page.pageInfo.hasNextPage && (!page.products.length || typeof page.pageInfo.endCursor !== 'string' ||
       !page.pageInfo.endCursor || page.pageInfo.endCursor === after))) throw error(code);
  // A saved partial page contains IDs and pagination only, never product source.
  return { products: page.products.map(product => ({ id: product.id })), pageInfo: {
    hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor ?? null,
  } };
}

function normalizeState(original) {
  if (!object(original) || (original.version !== undefined && ![1, 2].includes(original.version)) ||
      (original.quarantinedProducts !== undefined && !object(original.quarantinedProducts)) ||
      (original.health !== undefined && !object(original.health)) ||
      (original.incrementalWatermark !== undefined && !validInstant(original.incrementalWatermark))) throw error('INVALID_SYNC_STATE');
  const state = clone(original);
  const slots = { full: null, incremental: null };
  const validateScan = (scan, lane) => {
    if (!object(scan) || scan.mode !== lane || !validInstant(scan.startedAt) || scan.before !== scan.startedAt ||
        (scan.after !== null && (typeof scan.after !== 'string' || !scan.after)) ||
        (lane === 'full' && scan.updatedSince !== null) ||
        (lane === 'incremental' && (!validInstant(scan.updatedSince) || Date.parse(scan.updatedSince) >= Date.parse(scan.before))) ||
        (scan.updatedAt !== undefined && !validInstant(scan.updatedAt))) throw error('INVALID_SCAN');
    return { ...scan, updatedAt: scan.updatedAt ?? scan.startedAt,
      ...(scan.pendingPage === undefined ? {} : { pendingPage: validatePage(scan.pendingPage, scan.after, 'INVALID_SCAN') }) };
  };
  if (state.version === 2) {
    if (!object(state.scans) || Object.keys(state.scans).some(key => !['full', 'incremental'].includes(key)) ||
        (state.scan !== undefined && state.scan !== null)) throw error('INVALID_SYNC_STATE');
    for (const lane of ['full', 'incremental']) {
      if (state.scans[lane] !== null) slots[lane] = validateScan(state.scans[lane], lane);
    }
  } else {
    if (state.scans !== undefined) throw error('INVALID_SYNC_STATE');
    if (state.scan !== undefined && state.scan !== null) {
      if (!object(state.scan) || !['full', 'incremental'].includes(state.scan.mode)) throw error('INVALID_SCAN');
      slots[state.scan.mode] = validateScan(state.scan, state.scan.mode);
    }
  }
  delete state.scan;
  return { ...state, version: 2, scans: slots };
}

function laterInstant(existing, candidate) {
  return validInstant(existing) && Date.parse(existing) >= Date.parse(candidate) ? existing : candidate;
}

function currentFields(product) {
  if (!Object.prototype.hasOwnProperty.call(product, 'aiDescription') ||
      !Object.prototype.hasOwnProperty.call(product, 'aiCategory')) throw error('MISSING_OUTPUT_READBACK');
  return { ai_catalog_description: product.aiDescription, ai_catalog_category: product.aiCategory };
}

function validateDesired(rendered, product, metadata) {
  if (rendered?.status === 'skipped') return null;
  if (rendered?.status !== 'ready') throw Object.assign(error('METADATA_NOT_READY'), { reason: rendered?.reason });
  if (rendered.sourceHash !== metadata.sourceHash(product)) throw error('RENDER_SOURCE_MISMATCH');
  const fields = rendered.fields;
  if (!Array.isArray(fields) || fields.length !== 2) throw error('INVALID_METADATA_PAIR');
  const keys = new Set();
  for (const field of fields) {
    if (!object(field) || Object.keys(field).some((key) => !['namespace', 'key', 'type', 'value'].includes(key)) ||
        field.namespace !== 'custom' || !Object.prototype.hasOwnProperty.call(metadata.FIELDS, field.key) ||
        metadata.FIELDS[field.key] !== field.type || typeof field.value !== 'string' || !field.value.trim() ||
        keys.has(field.key)) throw error('INVALID_METADATA_PAIR');
    if (field.key === 'ai_catalog_category' && /[\r\n]/.test(field.value)) throw error('INVALID_METADATA_PAIR');
    keys.add(field.key);
  }
  if (!keys.has('ai_catalog_description') || !keys.has('ai_catalog_category')) throw error('INVALID_METADATA_PAIR');
  return fields;
}

function planFields(product, fields, ownership, metadata) {
  const current = currentFields(product);
  const inputs = [];
  const ownedKeys = new Set();
  let changed = false;
  if (ownership !== null && ownership !== undefined && !object(ownership)) throw error('INVALID_OWNERSHIP');
  for (const field of fields) {
    const previous = current[field.key];
    const owned = ownership?.fields?.[field.key];
    if (previous !== null && previous !== undefined && (!object(previous) || previous.type !== field.type ||
        typeof previous.value !== 'string' || !DIGEST.test(previous.compareDigest || ''))) throw error('INVALID_OUTPUT_READBACK');
    const differs = !previous || previous.value !== field.value;
    changed ||= differs;
    const ownershipMatches = Boolean(owned && previous &&
      DIGEST.test(owned.valueHash || '') && DIGEST.test(owned.compareDigest || '') &&
      owned.valueHash === metadata.hashValue(previous.value) && owned.compareDigest === previous.compareDigest);
    if (ownershipMatches) ownedKeys.add(field.key);
    if (differs) {
      if (previous && !ownershipMatches) throw error(owned ? 'MANUAL_OUTPUT_DRIFT' : 'UNOWNED_OUTPUT');
      if (!previous && owned) throw error('OWNED_OUTPUT_DELETED');
      // Only values actually created/changed here are newly claimed as owned.
      ownedKeys.add(field.key);
    }
    inputs.push({ ownerId: product.id, ...field, compareDigest: previous?.compareDigest ?? null });
  }
  return { changed, inputs, ownedKeys };
}

function equalFields(left, right) {
  const map = (fields) => Object.fromEntries(fields.map((field) => [field.key, `${field.type}\u0000${field.value}`]));
  const a = map(left), b = map(right);
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
}

async function syncCatalog({ shopify, store, getSupplier, profiles, mode = 'incremental', write = false,
  maxWrites = 5, productIds, now = () => new Date(), overlapMs = 5 * 60 * 1000,
  maxProducts = 1000, maxDurationMs = 20 * 60 * 1000, metadata = defaultMetadata } = {}) {
  const summary = { mode: productIds === undefined ? mode : 'canary', requestedMode: mode, dryRun: !write,
    activated: false, status: 'running', complete: false, examined: 0, readRequests: 0,
    planned: 0, noops: 0, skipped: 0, written: 0, verifiedWrites: 0, blocked: 0,
    pagesCompleted: 0, checkpointAdvanced: false, resumed: false,
    failed: false, errors: [], sourceRaces: 0, blockedReasons: {}, currentBlocked: null, deleted: 0 };
  let leased = false;
  const instant = () => {
    const date = new Date(typeof now === 'function' ? now() : now);
    if (!Number.isFinite(date.getTime())) throw error('INVALID_CLOCK');
    return date;
  };
  let startMs;
  const timedOut = () => instant().getTime() - startMs >= maxDurationMs;
  const read = async (id) => {
    summary.readRequests++;
    const product = await shopify.readProduct(id);
    if (write) await store.renewLease();
    if (!product || product.id !== id) throw error('PRODUCT_DISAPPEARED_OR_MISMATCHED');
    return product;
  };
  const supplierFor = async (product) => {
    // Explicit source-only renderers do not depend on supplier inventory.
    // An injected legacy renderer without this declaration keeps its old contract.
    if (metadata.requiresSupplier === false) return undefined;
    const diamond = ['diamond', 'loose'].includes(String(product.productType || '').toLowerCase()) ||
      String(product.templateSuffix || '').toLowerCase() === 'diamond';
    if (!diamond) return undefined;
    const sku = product.variants?.[0]?.sku;
    const validSku = product.variants?.length === 1 && typeof sku === 'string' && sku.trim() &&
      sku === sku.trim() && sku.length <= 200 && !/[\u0000-\u001f\u007f]/.test(sku);
    return typeof getSupplier === 'function' && validSku ? getSupplier(sku) : undefined;
  };
  const render = (product, supplier) => metadata.renderMetadata(product, { profiles, supplier });
  const renew = async () => { if (write) await store.renewLease(); };
  const audit = async (record) => { await renew(); return store.appendAudit(record); };
  const saveState = async (state) => { await renew(); return store.saveState(state); };

  try {
    if (!shopify || !store || !['full', 'incremental'].includes(mode) || typeof write !== 'boolean' ||
        !Number.isInteger(maxWrites) || maxWrites < 0 || maxWrites > 500 ||
        !Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 100000 ||
        !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 ||
        !Number.isFinite(overlapMs) || overlapMs < 0) throw error('INVALID_SYNC_ARGUMENTS');
    if (productIds !== undefined && (!Array.isArray(productIds) || !productIds.length || productIds.length > 500 ||
        productIds.some((id) => typeof id !== 'string' || !PRODUCT_ID.test(id)))) throw error('INVALID_PRODUCT_IDS');
    const scanStart = instant().toISOString();
    startMs = new Date(scanStart).getTime();
    if (write) { await store.acquireLease(); leased = true; }
    if (profiles === undefined) {
      const bundle = await store.getProfileBundle();
      profiles = bundle?.profiles ?? bundle;
    }
    if (!object(profiles)) throw error('INVALID_PROFILE_BUNDLE');

    let state;
    let scan;
    let quarantined = {};
    const processOne = async (id) => {
      if (summary.examined >= maxProducts || timedOut()) return false;
      await renew();
      summary.examined++;
      let product;
      try { product = await read(id); }
      catch (err) {
        if (err?.code !== 'PRODUCT_NOT_FOUND') throw err;
        summary.skipped++;
        summary.deleted++;
        return true;
      }
      if (product.status !== 'ACTIVE') { summary.skipped++; return true; }
      const supplier = await supplierFor(product);
      const rendered = render(product, supplier);
      const fields = validateDesired(rendered, product, metadata);
      if (!fields) { summary.skipped++; return true; }
      const ownership = await store.getOwnership(id);
      const planned = planFields(product, fields, ownership, metadata);
      if (!planned.changed) { summary.noops++; return true; }
      summary.planned++;
      if (!write) return true;
      if (summary.written >= maxWrites || timedOut()) return false;
      await renew();
      // Event/list snapshots are hints. Read the entire current product before each write.
      const live = await read(id).catch((err) => {
        if (err?.code === 'PRODUCT_NOT_FOUND') throw error('SOURCE_CHANGED_BEFORE_WRITE');
        throw err;
      });
      if (metadata.sourceHash(live) !== rendered.sourceHash) throw error('SOURCE_CHANGED_BEFORE_WRITE');
      const liveSupplier = await supplierFor(live);
      const liveRendered = render(live, liveSupplier);
      if (liveRendered?.status !== 'ready') throw error('SOURCE_CHANGED_BEFORE_WRITE');
      const liveFields = validateDesired(liveRendered, live, metadata);
      if (!liveFields || !equalFields(fields, liveFields)) throw error('SOURCE_CHANGED_BEFORE_WRITE');
      const liveOwnership = await store.getOwnership(id);
      const livePlan = planFields(live, liveFields, liveOwnership, metadata);
      if (!livePlan.changed) { summary.noops++; return true; }
      const backupId = await audit({ type: 'prewrite_backup', productId: id,
        at: instant().toISOString(), sourceHash: liveRendered.sourceHash, source: clone(live),
        supplier: liveSupplier === undefined ? null : clone(liveSupplier),
        previousOwnership: liveOwnership === undefined ? null : clone(liveOwnership),
        proposedMetafields: clone(livePlan.inputs) });
      if (!backupId) throw error('BACKUP_NOT_CONFIRMED');
      // Only the two allowlisted fields are passed to the adapter, atomically.
      await renew();
      await shopify.setMetafields(livePlan.inputs);
      summary.written++;
      const after = await read(id).catch((err) => {
        if (err?.code === 'PRODUCT_NOT_FOUND') throw error('SOURCE_CHANGED_AFTER_WRITE');
        throw err;
      });
      if (metadata.sourceHash(after) !== liveRendered.sourceHash) throw error('SOURCE_CHANGED_AFTER_WRITE');
      const afterSupplier = await supplierFor(after);
      const afterRendered = render(after, afterSupplier);
      if (afterRendered?.status !== 'ready') throw error('SOURCE_CHANGED_AFTER_WRITE');
      const afterFields = validateDesired(afterRendered, after, metadata);
      if (!afterFields || !equalFields(liveFields, afterFields)) throw error('SOURCE_CHANGED_AFTER_WRITE');
      const confirmed = currentFields(after);
      for (const field of liveFields) {
        const actual = confirmed[field.key];
        if (!actual || actual.type !== field.type || actual.value !== field.value || !DIGEST.test(actual.compareDigest || '')) {
          throw error('WRITE_READBACK_MISMATCH');
        }
      }
      const nextOwnership = { version: 1, productId: id, sourceHash: liveRendered.sourceHash,
        confirmedAt: instant().toISOString(), backupId, fields: {} };
      // Never silently adopt a pre-existing matching unowned field.
      for (const key of livePlan.ownedKeys) {
        nextOwnership.fields[key] = { valueHash: metadata.hashValue(confirmed[key].value), compareDigest: confirmed[key].compareDigest };
      }
      await audit({ type: 'verified_write', productId: id, backupId,
        at: instant().toISOString(), sourceHash: nextOwnership.sourceHash,
        confirmedOutput: clone(confirmed), ownedFields: clone(nextOwnership.fields) });
      await renew();
      await store.saveOwnership(id, nextOwnership);
      summary.verifiedWrites++;
      return true;
    };
    const nonfatal = new Set(['METADATA_NOT_READY', 'UNOWNED_OUTPUT', 'MANUAL_OUTPUT_DRIFT',
      'OWNED_OUTPUT_DELETED', 'INVALID_OWNERSHIP', 'INVALID_OUTPUT_READBACK']);
    const processProduct = async (id) => {
      try {
        const completed = await processOne(id);
        if (completed) delete quarantined[id];
        summary.currentBlocked = Object.keys(quarantined).length;
        return completed;
      } catch (err) {
        if (!nonfatal.has(err?.code)) throw err;
        const reason = /^[a-z][a-z0-9_]{0,80}$/.test(err.reason || '') ? err.reason : safeCode(err);
        summary.blocked++;
        summary.blockedReasons[reason] = (summary.blockedReasons[reason] || 0) + 1;
        const record = { event: 'blocked', productId: id, reason, at: instant().toISOString(),
          scanStartedAt: scan?.startedAt ?? scanStart, scope: summary.mode };
        if (write && !await audit(record)) throw error('QUARANTINE_NOT_CONFIRMED');
        quarantined[id] = { reason, at: record.at, scanStartedAt: record.scanStartedAt };
        summary.currentBlocked = Object.keys(quarantined).length;
        return true;
      }
    };

    if (productIds !== undefined) {
      for (const id of [...new Set(productIds)]) {
        if (!await processProduct(id)) { summary.status = 'paused'; return summary; }
      }
      summary.complete = true;
      summary.status = summary.blocked ? 'completed_with_blocks' : 'completed';
      summary.currentBlocked = summary.blocked;
      return summary;
    }

    const originalState = await store.loadState();
    state = normalizeState(originalState);
    quarantined = clone(state.quarantinedProducts || {});
    summary.currentBlocked = Object.keys(quarantined).length;
    const previousBlocked = Number.isInteger(state.health?.currentBlocked) ? state.health.currentBlocked : null;
    const healthAt = (at, fullReconciliation = false) => ({ ...state.health, previousBlocked,
      currentBlocked: Object.keys(quarantined).length, at, fullReconciliation });
    const migrating = originalState.version !== 2 && Object.keys(originalState).length > 0;
    if (write && migrating) {
      if (!await audit({ type: 'state_migration', fromVersion: originalState.version ?? 1,
        toVersion: 2, at: instant().toISOString(), previousState: clone(originalState) })) throw error('MIGRATION_BACKUP_NOT_CONFIRMED');
      await saveState(state);
    }
    // Each mode resumes its own cursor. A historical full snapshot must not take
    // precedence over a requested pass for newly created/changed products.
    scan = state.scans[mode];
    if (scan) {
      if (Date.parse(scan.startedAt) > Date.parse(scanStart)) throw error('INVALID_SCAN_CLOCK');
      summary.resumed = true;
    } else {
      // A pinned full scan covers history before its start. Changes since that
      // start can be processed now without claiming the historical scan finished.
      const floor = state.incrementalWatermark ?? state.scans.full?.startedAt;
      if (mode === 'incremental' && !validInstant(floor)) {
        summary.status = 'full_scan_required'; return summary;
      }
      if (mode === 'incremental' && Date.parse(floor) > Date.parse(scanStart)) throw error('INVALID_SCAN_CLOCK');
      scan = { mode, startedAt: scanStart, before: scanStart, after: null, updatedAt: scanStart,
        updatedSince: mode === 'incremental'
          ? new Date(Math.min(Date.parse(floor) - overlapMs, Date.parse(scanStart) - 1)).toISOString() : null };
      // A scan-start record is durable; it does not move a cursor or watermark.
      if (write) { state = { ...state, scans: { ...state.scans, [mode]: scan } }; await saveState(state); }
    }
    const saveProgress = async (pendingPage, progressed) => {
      scan = { ...scan, ...(progressed ? { updatedAt: instant().toISOString() } : {}) };
      if (pendingPage === undefined) delete scan.pendingPage;
      else scan.pendingPage = validatePage(pendingPage, scan.after);
      if (write) {
        state = { ...state, scans: { ...state.scans, [mode]: scan },
          ...(progressed ? { lastProgressAt: scan.updatedAt } : {}),
          quarantinedProducts: quarantined, health: healthAt(instant().toISOString()) };
        await saveState(state);
      }
    };
    while (true) {
      if (summary.examined >= maxProducts || timedOut()) { summary.status = 'paused'; return summary; }
      await renew();
      const page = validatePage(scan.pendingPage ?? await shopify.listProducts({
        updatedSince: scan.updatedSince, after: scan.after, before: scan.before,
      }), scan.after);
      for (let index = 0; index < page.products.length; index++) {
        if (!await processProduct(page.products[index].id)) {
          // Short bounded runs must not replay an entire page indefinitely.
          // Every resumed ID is still freshly read before metadata is considered.
          await saveProgress({ products: page.products.slice(index), pageInfo: page.pageInfo }, index > 0);
          summary.status = 'paused'; return summary;
        }
      }
      if (!page.pageInfo.hasNextPage) {
        // A timestamp-bounded full scan can omit a product edited after its start.
        // Read old exceptions individually; absence from a scan is not deletion.
        if (mode === 'full') {
          let rechecked = false;
          for (const [pid, record] of Object.entries(quarantined)) {
            if (record.scanStartedAt !== scan.startedAt) {
              if (!await processProduct(pid)) {
                await saveProgress({ products: [], pageInfo: page.pageInfo }, page.products.length > 0 || rechecked);
                summary.status = 'paused'; return summary;
              }
              rechecked = true;
            }
          }
        }
        summary.pagesCompleted++;
        summary.currentBlocked = Object.keys(quarantined).length;
        if (write) {
          const completedAt = instant().toISOString();
          state = { ...state, scans: { ...state.scans, [mode]: null },
            incrementalWatermark: laterInstant(state.incrementalWatermark, scan.startedAt),
            lastCompletedAt: completedAt, lastCompletedMode: mode, lastProgressAt: completedAt,
            quarantinedProducts: quarantined, health: healthAt(completedAt, mode === 'full') };
          if (mode === 'full') {
            state.lastFullScanStartedAt = scan.startedAt;
            state.lastFullCompletedAt = completedAt;
          } else state.lastIncrementalCompletedAt = completedAt;
          await saveState(state);
          summary.checkpointAdvanced = true;
        }
        summary.complete = true;
        summary.status = summary.currentBlocked ? 'completed_with_blocks' : 'completed';
        return summary;
      }
      summary.pagesCompleted++;
      scan = { ...scan, after: page.pageInfo.endCursor };
      await saveProgress(undefined, true);
    }
  } catch (err) {
    summary.blocked++;
    summary.status = 'blocked';
    summary.failed = true;
    summary.error = { code: safeCode(err) };
    summary.errors.push(summary.error);
    if (/^SOURCE_CHANGED_/.test(summary.error.code)) summary.sourceRaces++;
    return summary;
  } finally {
    if (leased) {
      try { await store.releaseLease(); }
      catch (err) {
        summary.leaseReleaseError = safeCode(err);
        summary.failed = true;
        summary.errors.push({ code: summary.leaseReleaseError });
        summary.complete = false;
        summary.status = 'blocked';
      }
    }
  }
}

module.exports = { syncCatalog };
