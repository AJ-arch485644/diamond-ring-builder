'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PRODUCT_IDS, REPOSITORY, SHOP, SUPABASE_ORIGIN, EXPIRES_AT, RECEIPT_ID,
  approvedCanaryOptions, assertApprovedCanaryResult, scopeApprovedCanary } = require('../lib/ai-catalog-canary');
const { options } = require('../scripts/sync-ai-catalog-metafields');
const { syncCatalog } = require('../lib/ai-catalog-sync');
const copy = value => JSON.parse(JSON.stringify(value));
const instant = () => new Date('2026-10-02T20:00:00.000Z');
const hashValue = value => createHash('sha256').update(value).digest('hex');
const FIELDS = { ai_catalog_description: 'multi_line_text_field', ai_catalog_category: 'single_line_text_field' };
const env = (overrides = {}) => ({
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '37050000001', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ai-catalog-canary.yml@refs/heads/main`,
  SHOPIFY_STORE: SHOP, SUPABASE_URL: SUPABASE_ORIGIN,
  AI_CATALOG_WRITES_ENABLED: 'false', AI_CATALOG_SCHEDULE_ENABLED: 'false', ...overrides,
});
const pair = ownerId => Object.entries(FIELDS).map(([key, type]) => ({ ownerId,
  namespace: 'custom', key, type, value: key === 'ai_catalog_description' ? 'Reviewed description' : 'Rings', compareDigest: null }));

function harness({ receipts = new Set(), context = env(), now = instant, claimError = false, releaseError = false } = {}) {
  const events = [], writes = [], ownership = new Map();
  const products = new Map(PRODUCT_IDS.map(id => [id, { id, title: `Product ${id.split('/').pop()}`,
    status: 'ACTIVE', productType: 'Setting', templateSuffix: 'setting', variants: [],
    aiDescription: null, aiCategory: null }]));
  const rawStore = {
    async acquireLease() { events.push('acquire'); return true; },
    async renewLease() { events.push('renew'); return true; },
    async releaseLease() { events.push('release'); if (releaseError) throw new Error('release failed'); return true; },
    async appendAudit(id, payload) {
      if (payload !== undefined) {
        events.push('claim');
        if (claimError || receipts.has(id)) throw Object.assign(new Error('insert rejected'), { code: 'STORE_WRITE_FAILED' });
        receipts.add(id); return id;
      }
      events.push(id.type || id.event); return `audit-${events.length}`;
    },
    async getOwnership(id) { return copy(ownership.get(id) || null); },
    async saveOwnership(id, value) { events.push('ownership'); ownership.set(id, copy(value)); },
    async loadState() { throw new Error('Canary must not read a global checkpoint'); },
    async saveState() { throw new Error('Canary must not write a global checkpoint'); },
    async getProfileBundle() { return {}; },
  };
  const rawShopify = {
    async listProducts() { throw new Error('Unscoped listing reached'); },
    async readProduct(id) { events.push(`read:${id}`); return copy(products.get(id) || null); },
    async setMetafields(fields) {
      events.push('write'); writes.push(copy(fields));
      for (const field of fields) {
        const alias = field.key === 'ai_catalog_description' ? 'aiDescription' : 'aiCategory';
        products.get(field.ownerId)[alias] = { ...field, compareDigest: hashValue(field.value) };
      }
      return fields;
    },
  };
  const scoped = scopeApprovedCanary({ shopify: rawShopify, store: rawStore, env: context, now });
  return { ...scoped, context, products, rawStore, rawShopify, events, writes, receipts };
}

test('approved mode fixes all four IDs and caps without changing the ordinary global write gate', () => {
  const result = options(['--approved-canary'], env(), instant);
  assert.deepEqual(result, { mode: 'full', write: true, maxWrites: 4, maxProducts: 4,
    maxDurationMs: 600000, productIds: PRODUCT_IDS });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.productIds), true);
  assert.throws(() => result.productIds.push('gid://shopify/Product/1'), TypeError);
  assert.throws(() => options(['--write'], env(), instant), /WRITES_DISABLED/);
  assert.equal(options([], env(), instant).write, false);
});

test('arbitrary IDs, additional arguments and repeated flags cannot expand the canary', () => {
  for (const args of [[], ['--approved-canary', '--write'], ['--approved-canary', '--product-ids', '1'],
    ['--approved-canary', '--max-writes', '500'], ['--mode', 'full', '--approved-canary'],
    ['--approved-canary', '--approved-canary']]) {
    assert.throws(() => approvedCanaryOptions(args, env(), instant), /CANARY_ARGUMENTS_DENIED/);
  }
});

test('wrong repository, branch, event, workflow, run attempt, store or database is denied before adapters', () => {
  const changes = [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ai-catalog-metafields.yml@refs/heads/main` },
    { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '2' }, { SHOPIFY_STORE: 'another.myshopify.com' },
    { SUPABASE_URL: 'https://another-project.supabase.co' }, { SUPABASE_URL: SUPABASE_ORIGIN + '/rest/v1' },
    { SUPABASE_URL: SUPABASE_ORIGIN + '?target=another' }, { SUPABASE_URL: SUPABASE_ORIGIN.replace('https://', 'http://') },
    { SUPABASE_URL: SUPABASE_ORIGIN.replace('https://', 'https://user:pass@') },
  ];
  for (const change of changes) assert.throws(() => approvedCanaryOptions(['--approved-canary'], env(change), instant), /CANARY_/);
});

test('both broad gates must remain off and the authorization expires at the fixed instant', () => {
  for (const key of ['AI_CATALOG_WRITES_ENABLED', 'AI_CATALOG_SCHEDULE_ENABLED']) {
    for (const value of ['true', 'TRUE', '1', 'unexpected']) {
      assert.throws(() => approvedCanaryOptions(['--approved-canary'], env({ [key]: value }), instant), /CANARY_BROAD_GATE_ENABLED/);
    }
    assert.doesNotThrow(() => approvedCanaryOptions(['--approved-canary'], env({ [key]: undefined }), instant));
  }
  for (const value of [EXPIRES_AT, '2026-10-03T00:00:00.001Z', 'invalid']) {
    assert.throws(() => approvedCanaryOptions(['--approved-canary'], env(), () => value), /CANARY_EXPIRED/);
  }
});

test('scoped adapter blocks listing and outside IDs without reaching the original client', async () => {
  const h = harness();
  await assert.rejects(h.shopify.listProducts({}), /CANARY_LISTING_DENIED/);
  await assert.rejects(h.shopify.readProduct('gid://shopify/Product/1'), /CANARY_PRODUCT_DENIED/);
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_RECEIPT_REQUIRED/);
  assert.deepEqual(h.events, []);
  assert.equal((await h.shopify.readProduct(PRODUCT_IDS[0])).id, PRODUCT_IDS[0]);
});

test('receipt must be durably claimed before any of the maximum four write attempts', async () => {
  const h = harness();
  await h.store.acquireLease();
  assert.deepEqual(h.events, ['acquire', 'claim']);
  assert.equal(h.receipts.has(RECEIPT_ID), true);
  for (const id of PRODUCT_IDS) await h.shopify.setMetafields(pair(id));
  assert.equal(h.writes.length, 4);
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_WRITE_LIMIT/);
  await assert.rejects(h.shopify.setMetafields(pair('gid://shopify/Product/1')), /CANARY_PRODUCT_DENIED/);
  await h.store.releaseLease();
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[1])), /CANARY_RECEIPT_REQUIRED/);
});

test('invalid field pairs cannot target other owners, fields, types or nonmetadata attributes', async () => {
  const h = harness(); await h.store.acquireLease();
  const changes = [
    fields => { fields[1].ownerId = PRODUCT_IDS[1]; },
    fields => { fields[0].namespace = 'anything_else'; },
    fields => { fields[0].key = 'shipping_days'; },
    fields => { fields[0].type = 'json'; },
    fields => { fields[0].price = '1'; },
    fields => { fields[0].compareDigest = 'missing'; },
    fields => { delete fields[0].compareDigest; },
    fields => { fields[0].value = ''; },
    fields => { fields[1].value = 'Rings\nOther'; },
    fields => { fields[1] = { ...fields[0] }; },
  ];
  for (const change of changes) {
    const fields = pair(PRODUCT_IDS[0]); change(fields);
    await assert.rejects(h.shopify.setMetafields(fields), /CANARY_FIELDS_DENIED/);
  }
  assert.equal(h.writes.length, 0);
  await h.store.releaseLease();
});

test('ambiguous Shopify failure consumes that product attempt and cannot be blindly retried', async () => {
  const h = harness(); let attempts = 0;
  h.rawShopify.setMetafields = async () => { attempts++; throw new Error('ambiguous transport failure'); };
  await h.store.acquireLease();
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[0])), /ambiguous/);
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_WRITE_LIMIT/);
  assert.equal(attempts, 1);
  await h.store.releaseLease();
});

test('receipt replay is rejected across runs and releases the newly acquired lease', async () => {
  const receipts = new Set(); const first = harness({ receipts });
  await first.store.acquireLease(); await first.store.releaseLease();
  const replay = harness({ receipts, context: env({ GITHUB_RUN_ID: '37050000002' }) });
  await assert.rejects(replay.store.acquireLease(), /insert rejected/);
  assert.deepEqual(replay.events, ['acquire', 'claim', 'release']);
  await assert.rejects(replay.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_RECEIPT_REQUIRED/);
  assert.equal(replay.writes.length, 0);
});

test('failed or unconfirmed receipt claim cleans up before syncCatalog can mark the lease held', async () => {
  for (const unconfirmed of [false, true]) {
    const h = harness({ claimError: !unconfirmed });
    if (unconfirmed) h.rawStore.appendAudit = async () => { h.events.push('claim'); return undefined; };
    const result = await syncCatalog({ ...approvedCanaryOptions(['--approved-canary'], env(), instant),
      shopify: h.shopify, store: h.store, profiles: {}, now: instant });
    assert.equal(result.failed, true); assert.equal(result.written, 0);
    assert.deepEqual(h.events, ['acquire', 'claim', 'release']);
  }
  const h = harness({ claimError: true, releaseError: true });
  await assert.rejects(h.store.acquireLease(), /CANARY_RECEIPT_RELEASE_FAILED/);
  assert.equal(h.writes.length, 0);
});

test('expiry or changed context during a run blocks further reads/writes while cleanup remains available', async () => {
  let time = instant(); const h = harness({ now: () => time });
  await h.store.acquireLease(); time = new Date(EXPIRES_AT);
  await assert.rejects(h.shopify.readProduct(PRODUCT_IDS[0]), /CANARY_EXPIRED/);
  await assert.rejects(h.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_EXPIRED/);
  await h.store.releaseLease();
  const changed = harness(); await changed.store.acquireLease();
  changed.context.AI_CATALOG_WRITES_ENABLED = 'true';
  await assert.rejects(changed.shopify.setMetafields(pair(PRODUCT_IDS[0])), /CANARY_BROAD_GATE_ENABLED/);
  await changed.store.releaseLease();
  assert.equal(changed.writes.length, 0);
});

test('full engine integration writes only four paired products with backup/readback and no global checkpoint', async () => {
  const h = harness();
  const metadata = { FIELDS, hashValue, sourceHash: product => hashValue(product.id + product.title),
    renderMetadata(product) { return { status: 'ready', sourceHash: this.sourceHash(product),
      fields: pair(product.id).map(({ ownerId, compareDigest, ...field }) => field) }; } };
  const result = await syncCatalog({ ...approvedCanaryOptions(['--approved-canary'], env(), instant),
    shopify: h.shopify, store: h.store, profiles: {}, metadata, now: instant });
  assert.equal(result.failed, false);
  assert.equal(result.complete, true);
  assert.equal(result.examined, 4);
  assert.equal(result.written, 4);
  assert.equal(result.verifiedWrites, 4);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.mode, 'canary');
  assert.deepEqual(h.writes.map(fields => fields[0].ownerId), PRODUCT_IDS);
  assert.ok(h.events.indexOf('claim') < h.events.indexOf('prewrite_backup'));
  assert.ok(h.events.indexOf('prewrite_backup') < h.events.indexOf('write'));
  assert.equal(h.events.at(-1), 'release');
  assert.equal(assertApprovedCanaryResult(result), true);
  for (const change of [{ written: 3 }, { verifiedWrites: 3 }, { blocked: 1 }, { noops: 1 },
    { skipped: 1 }, { complete: false }, { checkpointAdvanced: true }, { sourceRaces: 1 },
    { failed: true }, { errors: [{ code: 'FAILURE' }] }]) {
    assert.throws(() => assertApprovedCanaryResult({ ...result, ...change }), /CANARY_RESULT_INCOMPLETE/);
  }
});

test('manual canary workflow has no inputs or schedule and shares the standard concurrency group', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/ai-catalog-canary.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\binputs:|\bschedule:|\bpush:|\bpull_request:/);
  assert.match(workflow, /group: ai-catalog-metadata/);
  assert.match(workflow, /node scripts\/sync-ai-catalog-metafields\.js --approved-canary/);
  assert.doesNotMatch(workflow, /--product-ids|--max-writes|--write\b/);
});
