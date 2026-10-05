'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { syncCatalog } = require('../lib/ai-catalog-sync');
const copy = (value) => JSON.parse(JSON.stringify(value));
const id = (n) => `gid://shopify/Product/${n}`;
const hashValue = (value) => createHash('sha256').update(value).digest('hex');
const FIELDS = { ai_catalog_description: 'multi_line_text_field', ai_catalog_category: 'single_line_text_field' };
const metadata = {
  FIELDS, hashValue,
  sourceHash: (p) => hashValue(`${p.id}|${p.title}|${p.status}`),
  renderMetadata(product) {
    if (product.title === 'unknown') return { status: 'blocked', reason: 'unreviewed_product', sourceHash: this.sourceHash(product), fields: [] };
    return { status: 'ready', sourceHash: this.sourceHash(product), fields: [
      { namespace: 'custom', key: 'ai_catalog_description', type: FIELDS.ai_catalog_description, value: `Description for ${product.title}` },
      { namespace: 'custom', key: 'ai_catalog_category', type: FIELDS.ai_catalog_category, value: 'Engagement Rings' },
    ] };
  },
};
const current = (key, value) => ({ type: FIELDS[key], value, compareDigest: hashValue(`digest:${value}`) });
const product = (n) => ({ id: id(n), title: `Ring ${n}`, status: 'ACTIVE', productType: 'Setting',
  templateSuffix: 'setting', aiDescription: null, aiCategory: null, variants: [] });
const ALIAS = { ai_catalog_description: 'aiDescription', ai_catalog_category: 'aiCategory' };

function harness({ count = 2, pages, state = {} } = {}) {
  const products = new Map(Array.from({ length: count }, (_, index) => [id(index + 1), product(index + 1)]));
  const log = [], audits = [], owns = new Map(), queries = [], savedStates = [];
  let durable = copy(state);
  const store = {
    async loadState() { return copy(durable); },
    async saveState(next) { log.push('state'); durable = copy(next); savedStates.push(copy(next)); },
    async getProfileBundle() { return {}; },
    async getOwnership(pid) { return owns.has(pid) ? copy(owns.get(pid)) : null; },
    async saveOwnership(pid, value) { log.push('ownership'); owns.set(pid, copy(value)); },
    async appendAudit(record) { log.push(record.type || record.event); audits.push(copy(record)); return `audit-${audits.length}`; },
    async acquireLease() { log.push('acquire'); return true; },
    async renewLease() { log.push('renew'); return true; },
    async releaseLease() { log.push('release'); return true; },
  };
  const shopify = {
    async listProducts(query) {
      queries.push(copy(query));
      const page = pages ? pages[query.after || 'start'] : { ids: [...products.keys()], next: null };
      if (!page) throw Object.assign(new Error('bad cursor'), { code: 'BAD_CURSOR' });
      return { products: page.ids.map((pid) => ({ id: pid })), pageInfo: { hasNextPage: Boolean(page.next), endCursor: page.next } };
    },
    async readProduct(pid) {
      log.push('read');
      if (!products.has(pid)) throw Object.assign(new Error('missing'), { code: 'PRODUCT_NOT_FOUND' });
      return copy(products.get(pid));
    },
    async setMetafields(fields) {
      log.push('write');
      assert.equal(fields.length, 2);
      const source = products.get(fields[0].ownerId);
      for (const field of fields) {
        assert.deepEqual(Object.keys(field).sort(), ['ownerId', 'namespace', 'key', 'type', 'value', 'compareDigest'].sort());
        assert.equal(field.ownerId, source.id);
        assert.equal(field.namespace, 'custom');
        assert.equal(field.type, FIELDS[field.key]);
        assert.equal(source[ALIAS[field.key]]?.compareDigest ?? null, field.compareDigest, 'CAS must use fresh Shopify digest or null');
      }
      for (const field of fields) source[ALIAS[field.key]] = current(field.key, field.value);
      return fields;
    },
  };
  const run = (options = {}) => syncCatalog({ shopify, store, metadata, profiles: {}, mode: 'full',
    now: () => new Date('2026-10-02T16:00:00.000Z'), ...options });
  return { products, log, audits, owns, queries, savedStates, store, shopify, run, state: () => copy(durable) };
}

test('read-only is the default and never acquires lease, saves state, audits or writes', async () => {
  const h = harness();
  const summary = await h.run();
  assert.equal(summary.dryRun, true);
  assert.equal(summary.planned, 2);
  assert.equal(summary.written, 0);
  assert.equal(summary.checkpointAdvanced, false);
  assert.deepEqual(h.state(), {});
  assert.deepEqual(h.log, ['read', 'read']);
});

test('initial incremental scan requires a full baseline and does not invent a checkpoint', async () => {
  const h = harness();
  const summary = await h.run({ mode: 'incremental', write: true });
  assert.equal(summary.status, 'full_scan_required');
  assert.equal(h.queries.length, 0);
  assert.deepEqual(h.state(), {});
  assert.deepEqual(h.log, ['acquire', 'release']);
});

test('backup precedes every write, then readback and ownership persistence', async () => {
  const h = harness({ count: 1 });
  const summary = await h.run({ write: true });
  assert.equal(summary.verifiedWrites, 1);
  assert.equal(summary.failed, false);
  const backup = h.log.indexOf('prewrite_backup');
  assert.ok(backup >= 0 && backup < h.log.indexOf('write'));
  assert.ok(h.log.indexOf('write') < h.log.lastIndexOf('read'));
  assert.ok(h.log.indexOf('verified_write') < h.log.indexOf('ownership'));
  assert.equal(h.audits[0].source.id, id(1));
  assert.equal(h.audits[0].source.aiDescription, null);
  assert.ok(h.audits[0].proposedMetafields.every((field) => field.compareDigest === null));
  assert.equal(h.owns.get(id(1)).fields.ai_catalog_description.compareDigest, h.products.get(id(1)).aiDescription.compareDigest);
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
});

test('matching unowned output is a no-op without adoption', async () => {
  const h = harness({ count: 1 });
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Description for Ring 1');
  h.products.get(id(1)).aiCategory = current('ai_catalog_category', 'Engagement Rings');
  const summary = await h.run({ write: true });
  assert.equal(summary.noops, 1);
  assert.equal(summary.written, 0);
  assert.equal(h.owns.size, 0);
});

test('unchanged unowned member of an atomic pair is not adopted', async () => {
  const h = harness({ count: 1 });
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Description for Ring 1');
  const summary = await h.run({ write: true });
  assert.equal(summary.written, 1);
  assert.deepEqual(Object.keys(h.owns.get(id(1)).fields), ['ai_catalog_category']);
});

test('maxWrites stops mid-page and restart resumes only the remaining IDs', async () => {
  const h = harness({ count: 3 });
  const first = await h.run({ write: true, maxWrites: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(first.verifiedWrites, 1);
  assert.equal(h.state().scans.full.after, null);
  assert.deepEqual(h.state().scans.full.pendingPage.products, [{ id: id(2) }, { id: id(3) }]);
  assert.equal(h.state().incrementalWatermark, undefined);
  const second = await h.run({ write: true, maxWrites: 1 });
  assert.equal(second.resumed, true);
  assert.equal(second.noops, 0);
  assert.equal(second.verifiedWrites, 1);
  assert.equal(h.state().scans.full.after, null);
  const third = await h.run({ write: true, maxWrites: 1 });
  assert.equal(third.complete, true);
  assert.equal(third.noops, 0);
  assert.equal(third.verifiedWrites, 1);
  assert.equal(h.state().scans.full, null);
  assert.equal(h.owns.size, 3);
  assert.equal(h.queries.length, 1);
});

test('completed pages persist cursor and restart resumes only after those pages', async () => {
  const h = harness({ count: 3, pages: { start: { ids: [id(1)], next: 'page-2' }, 'page-2': { ids: [id(2), id(3)], next: null } } });
  const first = await h.run({ write: true, maxWrites: 1 });
  assert.equal(first.pagesCompleted, 1);
  assert.equal(h.state().scans.full.after, 'page-2');
  const second = await h.run({ write: true, maxWrites: 2 });
  assert.equal(second.complete, true);
  assert.equal(h.queries.length, 2, 'saved partial page resumes without relisting');
  assert.equal(h.queries[1].after, 'page-2');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
});

test('incremental work uses a pinned full baseline and preserves the unfinished full cursor', async () => {
  const h = harness({ count: 2 });
  await h.run({ write: true, maxWrites: 1 });
  const pinned = copy(h.state().scans.full);
  h.shopify.listProducts = async query => {
    h.queries.push(copy(query));
    return { products: [{ id: id(2) }], pageInfo: { hasNextPage: false, endCursor: null } };
  };
  const result = await h.run({ mode: 'incremental', write: true, maxWrites: 1,
    now: () => new Date('2026-10-02T16:15:00.000Z') });
  assert.equal(result.requestedMode, 'incremental');
  assert.equal(result.mode, 'incremental');
  assert.equal(result.resumed, false);
  assert.equal(result.complete, true);
  assert.deepEqual(h.state().scans.full, pinned);
  assert.equal(h.state().lastFullScanStartedAt, undefined);
  assert.equal(h.state().lastFullCompletedAt, undefined);
  assert.equal(h.state().lastIncrementalCompletedAt, '2026-10-02T16:15:00.000Z');
  assert.equal(h.queries.at(-1).updatedSince, '2026-10-02T15:55:00.000Z');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:15:00.000Z');
});

test('duration cap pauses without advancing incomplete page and release occurs', async () => {
  const h = harness({ count: 2 });
  let ticks = 0;
  const result = await h.run({ write: true, maxDurationMs: 10,
    now: () => new Date(Date.parse('2026-10-02T16:00:00Z') + (++ticks > 4 ? 20 : 0)) });
  assert.equal(result.status, 'paused');
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(h.state().incrementalWatermark, undefined);
  assert.equal(h.log.at(-1), 'release');
});

test('incremental query overlaps previous watermark and bounds at start, never end', async () => {
  const h = harness({ count: 0, state: { incrementalWatermark: '2026-10-02T15:00:00.000Z' } });
  const result = await h.run({ mode: 'incremental', write: true, overlapMs: 600000 });
  assert.equal(result.complete, true);
  assert.equal(h.queries[0].updatedSince, '2026-10-02T14:50:00.000Z');
  assert.equal(h.queries[0].before, '2026-10-02T16:00:00.000Z');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
});

test('unowned/manual drift is quarantined durably while later products continue', async () => {
  const h = harness();
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Manual wording');
  const result = await h.run({ write: true });
  assert.equal(result.failed, false);
  assert.equal(result.status, 'completed_with_blocks');
  assert.equal(result.blocked, 1);
  assert.equal(result.verifiedWrites, 1);
  assert.equal(h.products.get(id(1)).aiDescription.value, 'Manual wording');
  assert.equal(h.audits[0].event, 'blocked');
  assert.equal(h.state().health.currentBlocked, 1);
  assert.equal(h.state().quarantinedProducts[id(1)].reason, 'UNOWNED_OUTPUT');
});

test('owned output requires BOTH saved value hash and saved Shopify digest', async () => {
  const h = harness({ count: 1 });
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Old generated wording');
  h.owns.set(id(1), { fields: { ai_catalog_description: { valueHash: hashValue('Old generated wording'), compareDigest: '0'.repeat(64) } } });
  const result = await h.run({ write: true });
  assert.equal(result.blockedReasons.MANUAL_OUTPUT_DRIFT, 1);
  assert.equal(result.written, 0);
});

test('owned output with confirmed hash and digest can update while unrelated data stays untouched', async () => {
  const h = harness({ count: 1 });
  const p = h.products.get(id(1));
  p.price = '1120.00'; p.inventory = 7; p.handle = 'existing-stable-link';
  p.aiDescription = current('ai_catalog_description', 'Old generated wording');
  h.owns.set(id(1), { fields: { ai_catalog_description: {
    valueHash: hashValue(p.aiDescription.value), compareDigest: p.aiDescription.compareDigest,
  } } });
  const result = await h.run({ write: true });
  assert.equal(result.verifiedWrites, 1);
  assert.equal(p.aiDescription.value, 'Description for Ring 1');
  assert.deepEqual([p.price, p.inventory, p.handle], ['1120.00', 7, 'existing-stable-link']);
});

test('deleted previously-owned output is quarantined instead of recreated', async () => {
  const h = harness({ count: 1 });
  h.owns.set(id(1), { fields: { ai_catalog_description: { valueHash: hashValue('old'), compareDigest: hashValue('old digest') } } });
  const result = await h.run({ write: true });
  assert.equal(result.blockedReasons.OWNED_OUTPUT_DELETED, 1);
  assert.equal(result.written, 0);
});

test('incremental health retains untouched quarantines and later full scan clears deleted records', async () => {
  const h = harness({ count: 0, state: { incrementalWatermark: '2026-10-01T16:00:00.000Z',
    quarantinedProducts: { [id(1)]: { reason: 'UNOWNED_OUTPUT', scanStartedAt: '2026-10-01T16:00:00.000Z' } } } });
  assert.equal((await h.run({ mode: 'incremental', write: true })).currentBlocked, 1);
  assert.equal(h.state().health.currentBlocked, 1);
  assert.equal((await h.run({ mode: 'full', write: true })).currentBlocked, 0);
});

test('backup failure prevents Shopify mutation and checkpoint advancement', async () => {
  const h = harness({ count: 1 });
  h.store.appendAudit = async () => { throw Object.assign(new Error('private contents must not leak'), { code: 'STORE_FAILURE' }); };
  const result = await h.run({ write: true });
  assert.equal(result.failed, true);
  assert.equal(result.errors[0].code, 'STORE_FAILURE');
  assert.equal(result.written, 0);
  assert.equal(h.state().scans.full.after, null);
  assert.equal(h.state().incrementalWatermark, undefined);
  assert.ok(!JSON.stringify(result).includes('private contents'));
});

test('CAS/API failure retains last checkpoint and saves no ownership', async () => {
  const h = harness({ count: 1 });
  h.shopify.setMetafields = async () => { throw Object.assign(new Error('CAS'), { code: 'CAS_FAILED' }); };
  const result = await h.run({ write: true });
  assert.equal(result.failed, true);
  assert.equal(result.errors[0].code, 'CAS_FAILED');
  assert.equal(h.owns.size, 0);
  assert.equal(h.state().incrementalWatermark, undefined);
  assert.equal(h.audits[0].type, 'prewrite_backup');
});

test('read failure on later page retains only the completed-page cursor', async () => {
  const h = harness({ pages: { start: { ids: [id(1)], next: 'page-2' }, 'page-2': { ids: [id(2)], next: null } } });
  const original = h.shopify.readProduct;
  h.shopify.readProduct = async (pid) => {
    if (pid === id(2)) throw Object.assign(new Error('API unavailable'), { code: 'READ_FAILED' });
    return original(pid);
  };
  const result = await h.run({ write: true });
  assert.equal(result.failed, true);
  assert.equal(h.state().scans.full.after, 'page-2');
  assert.equal(h.state().incrementalWatermark, undefined);
  h.shopify.readProduct = original;
  const resumed = await h.run({ write: true });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.verifiedWrites, 1);
});

test('prewrite source race fails before mutation', async () => {
  const h = harness({ count: 1 });
  const original = h.shopify.readProduct;
  let reads = 0;
  h.shopify.readProduct = async (pid) => {
    if (++reads === 2) h.products.get(pid).title = 'Edited source';
    return original(pid);
  };
  const result = await h.run({ write: true });
  assert.equal(result.sourceRaces, 1);
  assert.equal(result.written, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('postwrite source race fails closed without claiming ownership or checkpoint', async () => {
  const h = harness({ count: 1 });
  const original = h.shopify.setMetafields;
  h.shopify.setMetafields = async (fields) => { await original(fields); h.products.get(id(1)).title = 'Changed during write'; };
  const result = await h.run({ write: true });
  assert.equal(result.sourceRaces, 1);
  assert.equal(result.written, 1);
  assert.equal(result.verifiedWrites, 0);
  assert.equal(h.owns.size, 0);
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('readback mismatch never saves ownership', async () => {
  const h = harness({ count: 1 });
  h.shopify.setMetafields = async () => undefined;
  const result = await h.run({ write: true });
  assert.equal(result.errors[0].code, 'WRITE_READBACK_MISMATCH');
  assert.equal(h.owns.size, 0);
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('canary product IDs are deduplicated and never alter global scan or watermark', async () => {
  const original = { incrementalWatermark: '2026-10-01T00:00:00Z', arbitraryState: 'keep' };
  const h = harness({ state: original });
  const result = await h.run({ write: true, productIds: [id(1), id(1)] });
  assert.equal(result.mode, 'canary');
  assert.equal(result.verifiedWrites, 1);
  assert.equal(result.checkpointAdvanced, false);
  assert.deepEqual(h.state(), original);
  assert.equal(h.queries.length, 0);
  assert.equal(h.savedStates.length, 0);
});

test('quarantine audit failure prevents cursor and watermark advancing', async () => {
  const h = harness({ count: 1 });
  h.products.get(id(1)).title = 'unknown';
  h.store.appendAudit = async () => null;
  const result = await h.run({ write: true });
  assert.equal(result.failed, true);
  assert.equal(result.errors[0].code, 'QUARANTINE_NOT_CONFIRMED');
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('malformed pagination and repeated cursor fail rather than loop or mark coverage complete', async () => {
  const h = harness();
  h.shopify.listProducts = async () => ({ products: [], pageInfo: { hasNextPage: true, endCursor: 'same' } });
  const result = await h.run({ write: true });
  assert.equal(result.errors[0].code, 'INVALID_PAGE');
  assert.equal(result.complete, false);
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('deleted-between-listing-and-read product is skipped, without preventing later rows', async () => {
  const h = harness({ pages: { start: { ids: [id(1), id(2)], next: null } } });
  h.products.delete(id(1));
  const result = await h.run({ write: true });
  assert.equal(result.failed, false);
  assert.equal(result.deleted, 1);
  assert.equal(result.verifiedWrites, 1);
  assert.equal(result.complete, true);
});

test('expired lease immediately before Shopify mutation prevents the mutation', async () => {
  const h = harness({ count: 1 });
  const originalAudit = h.store.appendAudit;
  let expired = false;
  h.store.appendAudit = async (record) => { const result = await originalAudit(record); if (record.type === 'prewrite_backup') expired = true; return result; };
  h.store.renewLease = async () => { if (expired) throw Object.assign(new Error('expired'), { code: 'LEASE_LOST' }); return true; };
  const result = await h.run({ write: true });
  assert.equal(result.errors[0].code, 'LEASE_LOST');
  assert.equal(result.written, 0);
  assert.equal(h.state().incrementalWatermark, undefined);
  assert.ok(!h.log.includes('write'));
});

test('fenced checkpoint failure is fatal and cannot advance the durable watermark', async () => {
  const h = harness({ count: 0 });
  const originalSave = h.store.saveState;
  h.store.saveState = async (state) => {
    if (state.scans.full === null) throw Object.assign(new Error('fenced'), { code: 'LEASE_LOST' });
    return originalSave(state);
  };
  const result = await h.run({ write: true });
  assert.equal(result.failed, true);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(h.state().incrementalWatermark, undefined);
});

test('invalid diamond SKU is left to formatter quarantine without calling supplier lookup', async () => {
  const h = harness({ count: 1 });
  Object.assign(h.products.get(id(1)), { productType: 'Diamond', templateSuffix: 'diamond', variants: [{ sku: '' }] });
  const diamondMetadata = { ...metadata, renderMetadata(p, { supplier }) {
    assert.equal(supplier, undefined);
    return { status: 'blocked', reason: 'diamond_sku_missing_or_invalid', sourceHash: this.sourceHash(p), fields: [] };
  } };
  const result = await h.run({ write: true, metadata: diamondMetadata, getSupplier: async () => { throw new Error('must not call'); } });
  assert.equal(result.failed, false);
  assert.equal(result.blocked, 1);
  assert.equal(result.complete, true);
});

test('full reconciliation rechecks an old quarantine absent from timestamp-filtered pages', async () => {
  const h = harness({ count: 1, pages: { start: { ids: [], next: null } }, state: {
    quarantinedProducts: { [id(1)]: { reason: 'UNOWNED_OUTPUT', scanStartedAt: '2026-10-01T00:00:00Z' } },
  } });
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Still manual');
  const result = await h.run({ write: true });
  assert.equal(result.currentBlocked, 1);
  assert.equal(h.state().health.currentBlocked, 1);
  assert.equal(result.readRequests, 1);
});

test('legacy full cursor migrates durably without losing installed state or delaying incremental products', async () => {
  const legacy = { version: 1, scan: { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: 'historical-page-17', updatedSince: null },
    quarantinedProducts: {}, arbitraryState: { keep: 'installed value' } };
  const h = harness({ count: 0, state: legacy });
  const result = await h.run({ mode: 'incremental', write: true });
  assert.equal(result.failed, false);
  assert.equal(result.mode, 'incremental');
  assert.equal(result.complete, true);
  assert.equal(h.state().version, 2);
  assert.equal(Object.hasOwn(h.state(), 'scan'), false);
  assert.deepEqual(h.state().scans.full, { ...legacy.scan, updatedAt: legacy.scan.startedAt });
  assert.deepEqual(h.state().arbitraryState, legacy.arbitraryState);
  assert.equal(h.state().lastFullCompletedAt, undefined);
  assert.equal(h.queries[0].after, null);
  assert.equal(h.queries[0].updatedSince, '2026-09-30T23:55:00.000Z');
  assert.equal(h.audits[0].type, 'state_migration');
  assert.deepEqual(h.audits[0].previousState, legacy);
  assert.deepEqual(legacy.scan.after, 'historical-page-17');
});

test('read-only legacy migration is an in-memory preview with no state or audit writes', async () => {
  const legacy = { version: 1, scan: { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: 'old-page', updatedSince: null } };
  const h = harness({ count: 0, state: legacy });
  const result = await h.run({ mode: 'incremental' });
  assert.equal(result.complete, true);
  assert.deepEqual(h.state(), legacy);
  assert.equal(h.audits.length, 0);
  assert.equal(h.savedStates.length, 0);
  assert.deepEqual(h.log, []);
});

test('unconfirmed migration backup prevents migration, scan requests and product writes', async () => {
  const legacy = { version: 1, scan: null, incrementalWatermark: '2026-10-01T00:00:00.000Z' };
  const h = harness({ state: legacy });
  h.store.appendAudit = async () => null;
  const result = await h.run({ mode: 'incremental', write: true });
  assert.equal(result.failed, true);
  assert.equal(result.error.code, 'MIGRATION_BACKUP_NOT_CONFIRMED');
  assert.deepEqual(h.state(), legacy);
  assert.equal(h.queries.length, 0);
  assert.equal(result.written, 0);
  assert.equal(h.log.at(-1), 'release');
});

test('invalid or ambiguous scan state fails closed instead of silently discarding a cursor', async () => {
  const full = { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: null, updatedSince: null };
  for (const state of [
    { version: 3 }, { version: 1, scan: { ...full, after: '' } },
    { version: 1, scan: { ...full, before: '2026-10-02T00:00:00Z' } },
    { version: 1, scans: { full, incremental: null } },
    { version: 2, scans: { full, incremental: null }, scan: full },
    { version: 2, scans: { full } },
    { version: 2, scans: { full: null, incremental: { ...full, mode: 'incremental' } } },
    { version: 2, scans: { full: { ...full, updatedAt: 'bad' }, incremental: null } },
    { incrementalWatermark: 'not-a-date' },
  ]) {
    const h = harness({ state });
    const result = await h.run({ write: true });
    assert.equal(result.failed, true);
    assert.equal(result.written, 0);
    assert.equal(h.queries.length, 0);
    assert.deepEqual(h.state(), state);
  }
});

test('older full completion cannot rewind incremental watermark or erase another pending lane', async () => {
  const full = { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: 'full-page-2', updatedSince: null, updatedAt: '2026-10-02T15:00:00.000Z' };
  const incremental = { mode: 'incremental', startedAt: '2026-10-02T15:45:00.000Z',
    before: '2026-10-02T15:45:00.000Z', after: 'new-page-2', updatedSince: '2026-10-02T15:25:00.000Z', updatedAt: '2026-10-02T15:46:00.000Z' };
  const h = harness({ count: 0, state: { version: 2, scans: { full, incremental },
    incrementalWatermark: '2026-10-02T15:30:00.000Z', lastIncrementalCompletedAt: '2026-10-02T15:31:00.000Z' },
    pages: { 'full-page-2': { ids: [], next: null }, 'new-page-2': { ids: [], next: null } } });
  const first = await h.run({ write: true });
  assert.equal(first.resumed, true);
  assert.equal(first.complete, true);
  assert.equal(h.queries[0].after, 'full-page-2');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T15:30:00.000Z');
  assert.deepEqual(h.state().scans.incremental, incremental);
  assert.equal(h.state().lastIncrementalCompletedAt, '2026-10-02T15:31:00.000Z');
  assert.equal(h.state().lastFullScanStartedAt, full.startedAt);
  assert.equal(h.state().lastFullCompletedAt, '2026-10-02T16:00:00.000Z');
  const second = await h.run({ mode: 'incremental', write: true });
  assert.equal(second.resumed, true);
  assert.equal(h.queries[1].after, 'new-page-2');
  assert.equal(h.state().incrementalWatermark, incremental.startedAt);
  assert.deepEqual(h.state().scans, { full: null, incremental: null });
});

test('legacy incremental cursor survives a full pass and later completion never rewinds that full watermark', async () => {
  const legacyScan = { mode: 'incremental', startedAt: '2026-10-01T12:00:00.000Z',
    before: '2026-10-01T12:00:00.000Z', after: 'delta-page-2', updatedSince: '2026-10-01T00:00:00.000Z' };
  const h = harness({ count: 0, state: { version: 1, scan: legacyScan, incrementalWatermark: '2026-10-01T00:05:00.000Z' },
    pages: { start: { ids: [], next: null }, 'delta-page-2': { ids: [], next: null } } });
  await h.run({ mode: 'full', write: true });
  assert.deepEqual(h.state().scans.incremental, { ...legacyScan, updatedAt: legacyScan.startedAt });
  const fullWatermark = h.state().incrementalWatermark;
  const result = await h.run({ mode: 'incremental', write: true });
  assert.equal(result.resumed, true);
  assert.equal(h.queries.at(-1).after, 'delta-page-2');
  assert.equal(h.state().incrementalWatermark, fullWatermark);
});

test('partial incremental restart resumes its own completed page without moving the full cursor', async () => {
  const full = { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: 'full-page-20', updatedSince: null, updatedAt: '2026-10-01T10:00:00.000Z' };
  const h = harness({ count: 3, state: { version: 2, scans: { full, incremental: null } },
    pages: { start: { ids: [id(1)], next: 'delta-page-2' }, 'delta-page-2': { ids: [id(2), id(3)], next: null } } });
  const first = await h.run({ mode: 'incremental', write: true, maxProducts: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(first.examined, 1);
  assert.equal(h.state().scans.incremental.after, 'delta-page-2');
  assert.equal(h.state().scans.incremental.updatedAt, '2026-10-02T16:00:00.000Z');
  assert.deepEqual(h.state().scans.full, full);
  assert.equal(h.state().incrementalWatermark, undefined);
  h.products.delete(id(2));
  const second = await h.run({ mode: 'incremental', write: true, maxWrites: 1,
    now: () => new Date('2026-10-02T16:15:00.000Z') });
  assert.equal(second.resumed, true);
  assert.equal(second.deleted, 1);
  assert.equal(second.verifiedWrites, 1);
  assert.equal(second.complete, true);
  assert.equal(h.queries.at(-1).after, 'delta-page-2');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
  assert.equal(h.state().lastIncrementalCompletedAt, '2026-10-02T16:15:00.000Z');
  assert.deepEqual(h.state().scans.full, full);
});

test('source-only metadata never fetches supplier inventory but legacy injected renderers retain that contract', async () => {
  for (const sourceOnly of [true, false]) {
    const h = harness({ count: 1 });
    Object.assign(h.products.get(id(1)), { productType: 'Diamond', templateSuffix: 'diamond', variants: [{ sku: 'EXACT-SKU' }] });
    let calls = 0;
    const renderer = { ...metadata, ...(sourceOnly ? { requiresSupplier: false } : {}) };
    const result = await h.run({ write: true, metadata: renderer, getSupplier: async sku => {
      assert.equal(sku, 'EXACT-SKU'); calls++; return { sku };
    } });
    assert.equal(result.verifiedWrites, 1);
    assert.equal(calls, sourceOnly ? 0 : 3);
    assert.equal(h.audits.find(row => row.type === 'prewrite_backup').supplier === null, sourceOnly);
  }
});

test('zero-overlap startup uses a nonempty bounded delta range and future checkpoints fail closed', async () => {
  const full = { mode: 'full', startedAt: '2026-10-02T16:00:00.000Z',
    before: '2026-10-02T16:00:00.000Z', after: null, updatedSince: null, updatedAt: '2026-10-02T16:00:00.000Z' };
  const h = harness({ count: 0, state: { version: 2, scans: { full, incremental: null } } });
  assert.equal((await h.run({ mode: 'incremental', write: true, overlapMs: 0 })).complete, true);
  assert.equal(h.queries[0].updatedSince, '2026-10-02T15:59:59.999Z');
  assert.deepEqual(h.state().scans.full, full);
  const future = harness({ count: 0, state: { version: 2, scans: { full: null, incremental: null },
    incrementalWatermark: '2026-10-03T16:00:00.000Z' } });
  assert.equal((await future.run({ mode: 'incremental', write: true })).error.code, 'INVALID_SCAN_CLOCK');
  assert.equal(future.queries.length, 0);
});

test('completed-lane health keeps previous blocked count and does not pretend an initial full was incremental', async () => {
  const h = harness({ count: 0, state: { version: 2, scans: { full: null, incremental: null },
    health: { currentBlocked: 2, privateSetting: 'keep' } } });
  await h.run({ write: true });
  assert.equal(h.state().health.previousBlocked, 2);
  assert.equal(h.state().health.currentBlocked, 0);
  assert.equal(h.state().health.privateSetting, 'keep');
  assert.equal(h.state().lastIncrementalCompletedAt, undefined);
  assert.equal(h.state().lastFullCompletedAt, '2026-10-02T16:00:00.000Z');
});

test('a product cap smaller than a page makes durable progress and rereads each remaining ID', async () => {
  const h = harness({ count: 3 });
  const first = await h.run({ write: true, maxProducts: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(first.examined, 1);
  assert.equal(first.pagesCompleted, 0);
  assert.deepEqual(h.state().scans.full.pendingPage.products, [{ id: id(2) }, { id: id(3) }]);
  h.products.get(id(2)).title = 'Changed after page was saved';
  const second = await h.run({ write: true, maxProducts: 1, now: () => new Date('2026-10-02T16:15:00Z') });
  assert.equal(second.status, 'paused');
  assert.equal(second.examined, 1);
  assert.equal(second.noops, 0);
  assert.equal(h.products.get(id(2)).aiDescription.value, 'Description for Changed after page was saved');
  assert.deepEqual(h.state().scans.full.pendingPage.products, [{ id: id(3) }]);
  assert.equal(h.state().scans.full.updatedAt, '2026-10-02T16:15:00.000Z');
  h.products.delete(id(3));
  const third = await h.run({ write: true, maxProducts: 1, now: () => new Date('2026-10-02T16:30:00Z') });
  assert.equal(third.complete, true);
  assert.equal(third.deleted, 1);
  assert.equal(third.examined, 1);
  assert.equal(h.queries.length, 1);
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
});

test('saved partial page keeps its original next cursor until every remaining ID is processed', async () => {
  const h = harness({ count: 3, pages: {
    start: { ids: [id(1), id(2)], next: 'last-page' }, 'last-page': { ids: [id(3)], next: null },
  } });
  await h.run({ write: true, maxProducts: 1 });
  assert.equal(h.state().scans.full.after, null);
  assert.equal(h.state().scans.full.pendingPage.pageInfo.endCursor, 'last-page');
  const second = await h.run({ write: true, maxProducts: 1 });
  assert.equal(second.pagesCompleted, 1);
  assert.equal(h.state().scans.full.after, 'last-page');
  assert.equal(Object.hasOwn(h.state().scans.full, 'pendingPage'), false);
  assert.equal(h.queries.length, 1);
  assert.equal((await h.run({ write: true, maxProducts: 1 })).complete, true);
  assert.equal(h.queries[1].after, 'last-page');
});

test('bounded terminal quarantine rechecks persist their progress instead of replaying indefinitely', async () => {
  const quarantinedProducts = Object.fromEntries([1, 2, 3].map(n => [id(n), {
    reason: 'UNOWNED_OUTPUT', scanStartedAt: '2026-10-01T00:00:00Z',
  }]));
  const h = harness({ count: 3, pages: { start: { ids: [], next: null } }, state: {
    version: 2, scans: { full: null, incremental: null }, quarantinedProducts, health: { currentBlocked: 3 },
  } });
  h.products.get(id(1)).aiDescription = current('ai_catalog_description', 'Still manual');
  const first = await h.run({ write: true, maxProducts: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(first.currentBlocked, 3);
  assert.equal(h.state().health.currentBlocked, 3);
  assert.deepEqual(h.state().scans.full.pendingPage.products, []);
  assert.equal(h.state().quarantinedProducts[id(1)].scanStartedAt, '2026-10-02T16:00:00.000Z');
  h.products.delete(id(2));
  const second = await h.run({ write: true, maxProducts: 1 });
  assert.equal(second.status, 'paused');
  assert.equal(second.deleted, 1);
  assert.equal(h.state().health.currentBlocked, 2);
  assert.equal(h.state().health.previousBlocked, 3);
  const third = await h.run({ write: true, maxProducts: 1 });
  assert.equal(third.complete, true);
  assert.equal(third.verifiedWrites, 1);
  assert.equal(third.currentBlocked, 1);
  assert.equal(h.state().health.currentBlocked, 1);
  assert.equal(h.state().health.previousBlocked, 2);
  assert.equal(h.queries.length, 1);
});

test('partial saves publish current blocked count and retain the prior run observation', async () => {
  const h = harness({ count: 3, state: { version: 2, scans: { full: null, incremental: null },
    health: { currentBlocked: 0 } }, pages: {
    start: { ids: [id(1)], next: 'last-page' }, 'last-page': { ids: [id(2), id(3)], next: null },
  } });
  h.products.get(id(1)).title = 'unknown';
  h.products.get(id(2)).title = 'unknown';
  const first = await h.run({ write: true, maxProducts: 2 });
  assert.equal(first.status, 'paused');
  assert.equal(h.state().health.currentBlocked, 2);
  assert.equal(h.state().health.previousBlocked, 0);
  assert.deepEqual(h.state().scans.full.pendingPage.products, [{ id: id(3) }]);
  const second = await h.run({ write: true, maxProducts: 1 });
  assert.equal(second.complete, true);
  assert.equal(h.state().health.currentBlocked, 2);
  assert.equal(h.state().health.previousBlocked, 2);
});

test('malformed durable pending pages fail closed before reads or writes', async () => {
  const full = { mode: 'full', startedAt: '2026-10-01T00:00:00.000Z',
    before: '2026-10-01T00:00:00.000Z', after: 'page-2', updatedSince: null };
  for (const pendingPage of [
    { products: [{ id: id(1) }, { id: id(1) }], pageInfo: { hasNextPage: false, endCursor: null } },
    { products: [{ id: 'other-resource' }], pageInfo: { hasNextPage: false, endCursor: null } },
    { products: [{ id: id(1) }], pageInfo: { hasNextPage: false, endCursor: { unexpected: 'source' } } },
    { products: [], pageInfo: { hasNextPage: true, endCursor: 'page-3' } },
    { products: [{ id: id(1) }], pageInfo: { hasNextPage: true, endCursor: 'page-2' } },
  ]) {
    const h = harness({ state: { version: 2, scans: { full: { ...full, pendingPage }, incremental: null } } });
    const result = await h.run({ write: true });
    assert.equal(result.error.code, 'INVALID_SCAN');
    assert.equal(result.readRequests, 0);
    assert.equal(result.written, 0);
    assert.equal(h.savedStates.length, 0);
    assert.equal(h.queries.length, 0);
  }
});
