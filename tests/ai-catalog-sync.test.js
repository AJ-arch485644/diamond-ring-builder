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

test('maxWrites stops mid-page without skipping; restart replays no-ops then progresses', async () => {
  const h = harness({ count: 3 });
  const first = await h.run({ write: true, maxWrites: 1 });
  assert.equal(first.status, 'paused');
  assert.equal(first.verifiedWrites, 1);
  assert.equal(h.state().scan.after, null);
  assert.equal(h.state().incrementalWatermark, undefined);
  const second = await h.run({ write: true, maxWrites: 1 });
  assert.equal(second.resumed, true);
  assert.equal(second.noops, 1);
  assert.equal(second.verifiedWrites, 1);
  assert.equal(h.state().scan.after, null);
  const third = await h.run({ write: true, maxWrites: 1 });
  assert.equal(third.complete, true);
  assert.equal(third.noops, 2);
  assert.equal(third.verifiedWrites, 1);
  assert.equal(h.state().scan, null);
  assert.equal(h.owns.size, 3);
});

test('completed pages persist cursor and restart resumes only after those pages', async () => {
  const h = harness({ count: 3, pages: { start: { ids: [id(1)], next: 'page-2' }, 'page-2': { ids: [id(2), id(3)], next: null } } });
  const first = await h.run({ write: true, maxWrites: 1 });
  assert.equal(first.pagesCompleted, 1);
  assert.equal(h.state().scan.after, 'page-2');
  const second = await h.run({ write: true, maxWrites: 2 });
  assert.equal(second.complete, true);
  assert.equal(h.queries[2].after, 'page-2');
  assert.equal(h.state().incrementalWatermark, '2026-10-02T16:00:00.000Z');
});

test('an incremental invocation resumes an unfinished full scan instead of starving it', async () => {
  const h = harness({ count: 2 });
  await h.run({ write: true, maxWrites: 1 });
  const result = await h.run({ mode: 'incremental', write: true, maxWrites: 1 });
  assert.equal(result.requestedMode, 'incremental');
  assert.equal(result.mode, 'full');
  assert.equal(result.resumed, true);
  assert.equal(result.complete, true);
  assert.equal(h.state().lastCompletedMode, 'full');
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
  assert.equal(h.state().scan.after, null);
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
  assert.equal(h.state().scan.after, 'page-2');
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
    if (state.scan === null) throw Object.assign(new Error('fenced'), { code: 'LEASE_LOST' });
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
