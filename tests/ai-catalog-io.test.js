'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShopifyClient, createPrivateStore, getSupplier, getShopifyToken } = require('../lib/ai-catalog-io');

const SHOP = 'example-test.myshopify.com';
const ID = 'gid://shopify/Product/1';
const VID = 'gid://shopify/ProductVariant/11';
const PAGE = { hasNextPage: false, endCursor: null };
const conn = (nodes, pageInfo = PAGE) => ({ nodes, pageInfo });
const field = (key, value = 'Verified description', digest = 'digest-a') => ({ id: `gid://shopify/Metafield/${key}`, namespace: 'custom', key, type: key === 'ai_catalog_description' ? 'multi_line_text_field' : 'single_line_text_field', value, compareDigest: digest });
const pair = () => ['ai_catalog_description', 'ai_catalog_category'].map(key => ({ ownerId: ID, namespace: 'custom', key, type: key === 'ai_catalog_description' ? 'multi_line_text_field' : 'single_line_text_field', value: key === 'ai_catalog_category' ? 'Loose diamonds' : 'Verified own facts', compareDigest: null }));
function product(overrides = {}) {
  return { id: ID, title: 'Own product', status: 'ACTIVE', updatedAt: '2026-10-02T00:00:00Z', description: 'Own details', descriptionHtml: '<p>Own details</p>', productType: 'Diamond', templateSuffix: 'diamond', tags: [], options: [{ name: 'Title', values: ['Default Title'] }], category: null,
    aiDescription: null, aiCategory: null, metafields: conn([]), variants: conn([{ id: VID, title: 'Default Title', sku: 'SKU1', selectedOptions: [{ name: 'Title', value: 'Default Title' }], metafields: conn([]) }]), ...overrides };
}
function mockShopify(responses, options = {}) {
  const calls = []; const sleeps = []; let time = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body), headers: init.headers, signal: init.signal, redirect: init.redirect });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected mock call');
    return { ok: next.status === undefined || next.status === 200, status: next.status || 200, headers: { get: () => next.retryAfter || null }, json: async () => next.body || { data: next } };
  };
  return { calls, sleeps, client: createShopifyClient({ shop: SHOP, token: 'test-secret', fetchImpl, sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time, ...options }) };
}

test('product list uses bounded fixed query, safe time filters and read-only fields', async () => {
  const mock = mockShopify([{ products: conn([{ id: ID, updatedAt: '2026-10-02T10:00:00Z' }]) }]);
  const result = await mock.client.listProducts({ updatedSince: '2026-10-01T00:00:00Z', before: '2026-10-03T00:00:00Z' });
  assert.deepEqual(result.products, [{ id: ID, updatedAt: '2026-10-02T10:00:00Z' }]);
  assert.equal(mock.calls[0].url, `https://${SHOP}/admin/api/2026-07/graphql.json`);
  assert.equal(mock.calls[0].redirect, 'error');
  assert.match(mock.calls[0].variables.query, /updated_at:>='2026-10-01T00:00:00.000Z'/);
  await assert.rejects(mock.client.listProducts({ updatedSince: "') OR status:ACTIVE" }), { code: 'INVALID_DATE_FILTER' });
  await assert.rejects(mock.client.listProducts({ updatedSince: '2026-10-03T00:00:00Z', before: '2026-10-01T00:00:00Z' }), { code: 'INVALID_DATE_RANGE' });
});

test('complete read paginates variants and both product and variant custom fields', async () => {
  const first = product();
  first.variants.pageInfo = { hasNextPage: true, endCursor: 'v1' };
  first.variants.nodes[0].metafields = conn([field('shape', 'Round')], { hasNextPage: true, endCursor: 'f1' });
  first.metafields = conn([field('style', 'Solitaire')], { hasNextPage: true, endCursor: 'p1' });
  const secondVariant = { id: 'gid://shopify/ProductVariant/12', title: 'Second', sku: 'SKU2', selectedOptions: [], metafields: conn([]) };
  const mock = mockShopify([
    { product: first },
    { product: { id: ID, variants: conn([secondVariant]) } },
    { productVariant: { id: VID, metafields: conn([field('carat', '2')]) } },
    { product: { id: ID, metafields: conn([field('metal', '14K Gold')]) } }
  ]);
  const result = await mock.client.readProduct(ID);
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants[0].metafields['custom.carat'].value, '2');
  assert.equal(result.metafields['custom.metal'].value, '14K Gold');
  assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every(call => call.query.startsWith('query ')));
});

test('incomplete or repeating connections, disappeared owner and target races fail closed', async () => {
  const incomplete = mockShopify([{ product: product({ variants: { nodes: [] } }) }]);
  await assert.rejects(incomplete.client.readProduct(ID), { code: 'INCOMPLETE_CONNECTION' });
  const p = product(); p.variants = conn([], { hasNextPage: true, endCursor: 'same' });
  const repeat = mockShopify([{ product: p }, { product: { id: ID, variants: conn([], { hasNextPage: true, endCursor: 'same' }) } }]);
  await assert.rejects(repeat.client.readProduct(ID), { code: 'PAGINATION_DID_NOT_ADVANCE' });
  const disappeared = mockShopify([{ product: null }]);
  await assert.rejects(disappeared.client.readProduct(ID), { code: 'PRODUCT_NOT_FOUND' });
  const raced = mockShopify([{ product: product({ aiDescription: field('ai_catalog_description'), metafields: conn([field('ai_catalog_description', 'A different value', 'digest-b')]) }) }]);
  await assert.rejects(raced.client.readProduct(ID), { code: 'TARGET_CHANGED_DURING_READ' });
});

test('existing aliases preserve compareDigest and absent aliases stay null', async () => {
  const description = field('ai_catalog_description');
  const mock = mockShopify([{ product: product({ aiDescription: description, metafields: conn([description]) }) }]);
  const result = await mock.client.readProduct(ID);
  assert.equal(result.aiDescription.compareDigest, 'digest-a');
  assert.equal(result.aiCategory, null);
  const missing = { ...description }; delete missing.compareDigest;
  const invalid = mockShopify([{ product: product({ aiDescription: missing, metafields: conn([missing]) }) }]);
  await assert.rejects(invalid.client.readProduct(ID), { code: 'INCOMPLETE_TARGET_DIGEST' });
});

test('jewelry variants may have null SKU but missing SKU fields are incomplete', async () => {
  const source = product(); source.variants.nodes[0].sku = null;
  const mock = mockShopify([{ product: source }]);
  assert.equal((await mock.client.readProduct(ID)).variants[0].sku, null);
  const missing = product(); delete missing.variants.nodes[0].sku;
  const invalid = mockShopify([{ product: missing }]);
  await assert.rejects(invalid.client.readProduct(ID), { code: 'INCOMPLETE_VARIANT' });
});

test('only an exact atomic allowlisted pair may be written with explicit CAS digests', async () => {
  const desired = pair();
  const mock = mockShopify([{ metafieldsSet: { metafields: desired.map(item => ({ ...item, compareDigest: 'new-digest' })), userErrors: [] } }]);
  const result = await mock.client.setMetafields(desired);
  assert.equal(result.length, 2);
  assert.match(mock.calls[0].query, /^mutation CatalogMetadata/);
  assert.deepEqual(mock.calls[0].variables.metafields, desired);
  const bad = [pair().slice(0, 1), pair().map(item => ({ ...item, compareDigest: undefined })), pair().map(item => ({ ...item, namespace: 'other' })), pair().map(item => ({ ...item, key: 'shipping_days' })), pair().map(item => ({ ...item, key: 'unknown', type: undefined })), pair().map(item => ({ ...item, id: 'unexpected' })), [pair()[0], { ...pair()[1], ownerId: 'gid://shopify/Product/2' }], [pair()[0], pair()[0]], [pair()[0], { ...pair()[1], value: 'Two\nlines' }]];
  for (const fields of bad) await assert.rejects(mock.client.setMetafields(fields));
  assert.equal(mock.calls.length, 1);
});

test('ambiguous mutation transport and response failures are never retried', async () => {
  for (const response of [new Error('secret payload must not escape'), { status: 503 }, { body: { errors: [{ message: 'secret data', extensions: { code: 'THROTTLED' } }] } }, { metafieldsSet: { userErrors: [], metafields: [] } }]) {
    const mock = mockShopify([response, { unused: true }]);
    await assert.rejects(mock.client.setMetafields(pair()), { code: 'SHOPIFY_MUTATION_UNCONFIRMED', message: 'SHOPIFY_MUTATION_UNCONFIRMED' });
    assert.equal(mock.calls.length, 1);
  }
});

test('explicit CAS conflicts and rejected mutations are surfaced without retries', async () => {
  const mock = mockShopify([{ metafieldsSet: { metafields: null, userErrors: [{ code: 'INVALID_COMPARE_DIGEST' }] } }]);
  await assert.rejects(mock.client.setMetafields(pair()), { code: 'SHOPIFY_COMPARE_CONFLICT' });
  assert.equal(mock.calls.length, 1);
});

test('read retries are bounded and protect API headroom', async () => {
  const throttleStatus = { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 };
  const mock = mockShopify([{ status: 429, retryAfter: '1' }, { body: { data: { products: conn([]) }, extensions: { cost: { throttleStatus } } } }, { products: conn([]) }]);
  await mock.client.listProducts(); await mock.client.listProducts();
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.sleeps.some(ms => ms >= 3600));
  const fail = mockShopify([new Error('secret'), new Error('secret'), new Error('secret')]);
  await assert.rejects(fail.client.listProducts(), { code: 'SHOPIFY_READ_TRANSPORT_FAILED', message: 'SHOPIFY_READ_TRANSPORT_FAILED' });
  assert.equal(fail.calls.length, 3);
});

test('unsafe hosts and malformed settings fail before requests', () => {
  for (const shop of ['https://example.myshopify.com', 'example.myshopify.com.attacker.test', 'localhost', 'example.myshopify.com/path']) assert.throws(() => createShopifyClient({ shop, token: 'x' }), { code: 'INVALID_SHOP' });
  assert.throws(() => createShopifyClient({ shop: SHOP, token: 'x', maxReadAttempts: 100 }), { code: 'INVALID_CLIENT_CONFIG' });
});

function mockSupabase() {
  const records = new Map(); const calls = []; let failure = null; let leaseValue = true;
  let heldOwner = null;
  const suppliers = []; const tokens = [];
  const client = {
    from(table) {
      const filters = {}; let action = 'select'; let row;
      const query = {
        select(columns) { calls.push({ table, action: 'select', columns }); return query; },
        eq(key, value) { filters[key] = value; return query; },
        limit() { return query; },
        insert(value) { action = 'insert'; row = value; return query; },
        upsert(value) { action = 'upsert'; row = value; return query; },
        then(resolve, reject) {
          if (failure) return Promise.resolve({ error: { message: failure } }).then(resolve, reject);
          let data = [];
          if (action === 'select') {
            const source = table === 'diamonds' ? suppliers : table === 'shopify_tokens' ? tokens : [...records.values()];
            data = source.filter(value => Object.entries(filters).every(([key, expected]) => value[key] === expected));
          } else {
            calls.push({ table, action, row });
            if (action === 'insert' && records.has(row.key)) return Promise.resolve({ error: { message: 'duplicate' } }).then(resolve, reject);
            records.set(row.key, row);
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (failure) return { error: { message: failure } };
      if (name === 'ai_catalog_write_state') {
        if (!leaseValue || heldOwner !== args.p_owner) return { error: { message: 'AI_CATALOG_LEASE_LOST' } };
        if (args.p_insert_only && records.has(args.p_key)) return { error: { message: 'duplicate' } };
        records.set(args.p_key, { key: args.p_key, payload: args.p_payload });
        return { data: true, error: null };
      }
      if (name === 'ai_catalog_acquire_lease' && leaseValue) heldOwner = args.p_owner;
      if (name === 'ai_catalog_release_lease' && leaseValue) heldOwner = null;
      return { data: leaseValue, error: null };
    }
  };
  return { client, records, calls, suppliers, tokens, setFailure(value) { failure = value; }, setLease(value) { leaseValue = value; } };
}

test('private state is scoped by shop; snapshots use insert-only unique records', async () => {
  const mock = mockSupabase(); const store = createPrivateStore(mock.client, { shop: SHOP, owner: 'run-1' });
  assert.deepEqual(await store.loadState(), {});
  assert.equal(await store.getOwnership(ID), null);
  await store.acquireLease();
  await store.saveState({ cursor: 'next' });
  await store.saveOwnership(ID, { digest: 'owned' });
  assert.deepEqual(await store.loadState(), { cursor: 'next' });
  assert.deepEqual(await store.getOwnership(ID), { digest: 'owned' });
  await store.appendAudit('first', { before: {} });
  await assert.rejects(store.appendAudit('first', { before: { overwrite: true } }), { code: 'STORE_WRITE_FAILED' });
  assert.deepEqual(mock.records.get(`${SHOP}:audit:first`).payload, { before: {} });
  assert.ok(await store.appendAudit({ after: true }));
  const other = createPrivateStore(mock.client, { shop: 'other.myshopify.com' });
  assert.deepEqual(await other.loadState(), {});
  assert.ok(mock.calls.filter(call => call.rpc === 'ai_catalog_write_state' && call.args.p_insert_only).every(call => call.args.p_key.startsWith(`${SHOP}:audit:`)));
});

test('profiles require explicit installation; malformed profiles and DB errors fail closed', async () => {
  const mock = mockSupabase(); const store = createPrivateStore(mock.client, { shop: SHOP });
  await assert.rejects(store.getProfileBundle(), { code: 'STORE_PROFILES_MISSING' });
  await assert.rejects(store.installProfileBundle({ [ID]: { sourceHash: 'bad', description: 'text', category: 'Ring' } }), { code: 'STORE_INVALID_PROFILES' });
  const bundle = { [ID]: { sourceHash: 'a'.repeat(64), description: 'Verified copy', category: 'Rings' } };
  await store.acquireLease();
  await store.installProfileBundle(bundle);
  assert.deepEqual(await store.getProfileBundle(), bundle);
  mock.setFailure('raw sensitive backend error');
  await assert.rejects(store.loadState(), { code: 'STORE_READ_FAILED', message: 'STORE_READ_FAILED' });
  await assert.rejects(store.saveState({}), { code: 'STORE_WRITE_FAILED', message: 'STORE_WRITE_FAILED' });
});

test('private profile installation strictly validates and preserves internal-review flags', async () => {
  const mock = mockSupabase(); const store = createPrivateStore(mock.client, { shop: SHOP });
  const base = { sourceHash: 'a'.repeat(64), description: 'Reviewed add-on copy', category: 'Add-on' };
  await store.acquireLease();
  for (const flag of ['true', 1, null, {}, [], undefined]) {
    await assert.rejects(store.installProfileBundle({ [ID]: { ...base, reviewedInternal: flag } }), { code: 'STORE_INVALID_PROFILES' });
  }
  await assert.rejects(store.getProfileBundle(), { code: 'STORE_PROFILES_MISSING' });
  for (const flag of [true, false]) {
    const bundle = { [ID]: { ...base, reviewedInternal: flag } };
    await store.installProfileBundle(bundle);
    assert.deepEqual(await store.getProfileBundle(), bundle);
  }
});

test('every private write is fenced by the current lease owner', async () => {
  const mock = mockSupabase();
  const stale = createPrivateStore(mock.client, { shop: SHOP, owner: 'old-run' });
  const current = createPrivateStore(mock.client, { shop: SHOP, owner: 'new-run' });
  await assert.rejects(stale.saveState({ cursor: 'unleased' }), { code: 'STORE_WRITE_FAILED' });
  await stale.acquireLease(); await stale.saveState({ cursor: 'before-takeover' });
  await current.acquireLease();
  for (const write of [() => stale.saveState({ cursor: 'stale' }), () => stale.saveOwnership(ID, { stale: true }), () => stale.appendAudit({ stale: true }), () => stale.installProfileBundle({ [ID]: { sourceHash: 'a'.repeat(64), description: 'Text', category: 'Ring' } })]) await assert.rejects(write(), { code: 'STORE_WRITE_FAILED' });
  assert.deepEqual(await current.loadState(), { cursor: 'before-takeover' });
  assert.equal(await current.getOwnership(ID), null);
  assert.ok(mock.calls.filter(call => call.rpc === 'ai_catalog_write_state').every(call => call.args.p_shop === SHOP && call.args.p_owner));
});

test('lease contention, expiry and RPC errors stop the writer', async () => {
  const mock = mockSupabase(); const store = createPrivateStore(mock.client, { shop: SHOP, owner: 'unique-run', leaseSeconds: 180 });
  assert.equal(await store.acquireLease(), true); assert.equal(await store.renewLease(), true); assert.equal(await store.releaseLease(), true);
  assert.deepEqual(mock.calls[0], { rpc: 'ai_catalog_acquire_lease', args: { p_shop: SHOP, p_owner: 'unique-run', p_ttl_seconds: 180 } });
  mock.setLease(false);
  await assert.rejects(store.acquireLease(), { code: 'LEASE_BUSY' });
  await assert.rejects(store.renewLease(), { code: 'LEASE_LOST' });
  mock.setFailure('sensitive details');
  await assert.rejects(store.acquireLease(), { code: 'STORE_LEASE_FAILED' });
});

test('supplier lookup accepts only exact unique available rows; token lookup requires exactly one', async () => {
  const mock = mockSupabase();
  assert.equal(await getSupplier(mock.client, 'SKU1'), null);
  const supplier = { sku: 'SKU1', availability: 'available', is_lab_grown: true, carat: 2, shape: 'ROUND', color: 'D', clarity: 'VVS1' };
  mock.suppliers.push(supplier, { ...supplier, availability: 'unavailable' });
  assert.deepEqual(await getSupplier(mock.client, 'SKU1'), supplier);
  mock.suppliers.push(supplier);
  await assert.rejects(getSupplier(mock.client, 'SKU1'), { code: 'SUPPLIER_AMBIGUOUS' });
  await assert.rejects(getShopifyToken(mock.client, SHOP), { code: 'TOKEN_UNAVAILABLE' });
  mock.tokens.push({ shop: SHOP, access_token: 'secret-token' });
  assert.equal(await getShopifyToken(mock.client, SHOP), 'secret-token');
  const store = createPrivateStore(mock.client, { shop: SHOP });
  assert.equal(await store.getShopifyToken(), 'secret-token');
  assert.throws(() => store.getShopifyToken('other.myshopify.com'), { code: 'INVALID_SHOP' });
  mock.tokens.push({ shop: SHOP, access_token: 'second-token' });
  await assert.rejects(getShopifyToken(mock.client, SHOP), { code: 'TOKEN_UNAVAILABLE' });
});
