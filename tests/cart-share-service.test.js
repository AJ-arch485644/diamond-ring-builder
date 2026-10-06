'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCart, validateSnapshot, stableStringify, NON_TRANSFERABLE_ATTRIBUTES } = require('../lib/cart-share-contract');
const { createService, createHandler, createCatalog, hash } = require('../lib/cart-share-service');
const { createStore, createSupplier } = require('../lib/cart-share-store');
const clone = v => JSON.parse(JSON.stringify(v));
const clock = Date.parse('2026-10-06T20:00:00Z');
function cart(props = {}) { return { currency: 'USD', attributes: {}, items: [{ variant_id: 123, sku: 'ORDINARY', quantity: 1, properties: props }] }; }
function ring(size) {
  const c = cart();
  c.items = [
    { variant_id: 123, sku: 'SETTING', quantity: 1, properties: { _ring_builder: 'true', 'Paired Diamond': '1ct Round E VS1', 'Diamond SKU': 'STONE' } },
    { variant_id: 456, sku: 'STONE', quantity: 1, properties: { _ring_builder: 'true', _ring_type: 'Ring', 'Paired Setting': 'Solitaire', _diamond_sku: 'STONE', Diamond: '1ct Round E VS1', Certificate: 'IGI 12345' } }
  ];
  if (size !== undefined) c.items.forEach(item => item.properties['Ring Size'] = size);
  return c;
}
function variant(line) {
  const isDiamond = ['loose', 'diamond'].includes(line.kind), fee = line.kind === 'engraving';
  return { id: 'gid://shopify/ProductVariant/' + line.variantId, legacyResourceId: line.variantId, sku: line.sku, requiresComponents: false, inventoryQuantity: 10, inventoryPolicy: 'DENY', inventoryItem: { tracked: true, harmonizedSystemCode: line.kind === 'loose' ? '710491' : '711319' },
    product: { status: 'ACTIVE', onlineStoreUrl: 'https://diyona.com/products/example', publishedInContext: true, productType: isDiamond || fee ? 'Diamond' : '', templateSuffix: isDiamond || fee ? 'diamond' : line.kind === 'setting' ? 'setting' : 'earrings', title: fee ? 'Engraving Fee' : 'Example', handle: fee ? 'engraving-fee' : 'example', vendor: isDiamond ? 'Lab Diamond' : 'Diyona', requiresSellingPlan: false }, contextualPricing: { price: { amount: '199.00', currencyCode: 'USD' } } };
}
function harness(snapshot = normalizeCart(cart()), extra = {}) {
  const h = { records: new Map(), writes: 0, supplierReads: 0, catalogReads: 0, time: clock, rows: snapshot.lines.filter(l => ['diamond', 'loose'].includes(l.kind)).map(l => ({ sku: l.sku, availability: 'available', carat: 1, shape: 'Round', color: 'E', clarity: 'VS1', lab: 'IGI', certificate_number: '12345' })), variants: snapshot.lines.map(variant) };
  h.store = { async insert(record) { h.writes++; h.records.set(record.token_hash, clone(record)); }, async read(key) { return clone(h.records.get(key) || null); }, async consumeRate() { return true; } };
  h.supplier = { async read() { h.supplierReads++; return clone(h.rows); } };
  h.catalog = { async read() { h.catalogReads++; return clone(h.variants); } };
  h.service = createService({ store: h.store, supplier: h.supplier, catalog: h.catalog, now: () => h.time, engravingVariantId: '789', ...extra });
  return h;
}
test('blank and omitted ring sizes survive separately, including mixed blank/absent group', () => {
  for (const size of [undefined, '', 'US 7¼', 'US 7.25']) {
    const s = normalizeCart(ring(size)); assert.deepEqual(validateSnapshot(s), s);
    for (const l of s.lines) { assert.equal(Object.hasOwn(l.properties, 'Ring Size'), size !== undefined); assert.equal(l.properties['Ring Size'], size); }
  }
  const c = ring(); c.items[0].properties['Ring Size'] = ''; assert.equal(normalizeCart(c).lines[1].properties['Ring Size'], undefined);
});
test('all known nonportable cart tracking attributes are stripped even if configured', () => {
  const c = cart(); c.attributes = Object.fromEntries(NON_TRANSFERABLE_ATTRIBUTES.map(k => [k, 'private-example']));
  assert.deepEqual(normalizeCart(c, { allowedAttributes: NON_TRANSFERABLE_ATTRIBUTES }).attributes, {});
  c.attributes.unknown = 'x'; assert.throws(() => normalizeCart(c), { code: 'UNSUPPORTED_ATTRIBUTE' });
});
test('explicitly allowed semantic attributes preserve empty value', () => {
  const c = cart(); c.attributes['Gift wrap'] = '';
  assert.equal(normalizeCart(c, { allowedAttributes: ['Gift wrap'] }).attributes['Gift wrap'], '');
});
test('pending sentinel or pending property blocks whole cart', () => {
  const c = ring(); c.items.push({ variant_id: 51975403077948, quantity: 1, sku: 'X', properties: {} });
  assert.throws(() => normalizeCart(c), { code: 'CART_PENDING' });
  const d = ring(); d.items[1].properties._pending_diamond_id = 'pending'; assert.throws(() => normalizeCart(d), { code: 'CART_PENDING' });
});
test('settled loose retains compatibility marker and strips stale dates/price/ownership', () => {
  const c = cart({ _pending_loose: 'true', _diamond_sku: 'ORDINARY', _real_price: '20', 'Ship By': '2025-01-01', _diy_operation_v1: 'old', _diy_share_import_v1: 'old', _diy_share_line_v1: 'old' });
  const s = normalizeCart(c); assert.equal(s.lines[0].kind, 'loose'); assert.equal(s.lines[0].properties._pending_loose, 'true');
  assert.deepEqual(Object.keys(s.lines[0].properties).sort(), ['_diamond_sku', '_pending_loose', '_ring_type']); assert.deepEqual(validateSnapshot(s), s);
});
test('unknown, HTML, upload-link and customer supplied metadata fail closed', () => {
  for (const props of [{ Email: 'person@example.test' }, { _igi_flow: 'true' }, { _tiktok_flow: 'true' }, { 'Chain Length': '<b>18</b>' }, { 'Chain': 'javascript:alert(1)//uploads/x' }]) assert.throws(() => normalizeCart(cart(props)));
  const c = cart(); c.note = 'customer note'; assert.throws(() => normalizeCart(c), { code: 'UNSUPPORTED_NOTE' });
});
test('source operation conflict, duplicate diamond, orphan setting and inconsistent size fail', () => {
  const a = ring(); a.items[0].properties._diy_operation_v1 = 'a'; a.items[1].properties._diy_operation_v1 = 'b'; assert.throws(() => normalizeCart(a), { code: 'AMBIGUOUS_BUNDLE' });
  const b = ring(); b.items.push(clone(b.items[1])); assert.throws(() => normalizeCart(b));
  const c = ring(); c.items.pop(); assert.throws(() => normalizeCart(c), { code: 'INCOMPLETE_BUNDLE' });
  const d = ring('US 7'); d.items[1].properties['Ring Size'] = 'US 8'; assert.throws(() => normalizeCart(d), { code: 'BUNDLE_SIZE_MISMATCH' });
});
test('engraving owner and fee must agree; stale diamond text rebuilt canonically', () => {
  const c = ring(); c.items[0].properties['Custom Engraving'] = 'Love'; c.items[1].properties._engraving = 'Old';
  c.items.push({ variant_id: 789, sku: 'ENGRAVING-FEE', quantity: 1, properties: { _ring_builder: 'true', _diamond_sku: 'STONE', 'Engraving Text': 'Love' } });
  const s = normalizeCart(c); assert.equal(s.lines[1].properties._engraving, 'Love'); assert.deepEqual(validateSnapshot(s), s);
  c.items[2].properties['Engraving Text'] = 'Other'; assert.throws(() => normalizeCart(c), { code: 'BUNDLE_ENGRAVING_MISMATCH' });
});
test('unsupported selling plan and native bundle metadata cannot disappear at capture', () => {
  for (const field of ['selling_plan_allocation', 'selling_plan', 'parent_relationship']) { const c = cart(); c.items[0][field] = { id: 1 }; assert.throws(() => normalizeCart(c), { code: 'UNSUPPORTED_LINE' }); }
  const c = cart(); c.items[0].item_components = [{ id: 1 }]; assert.throws(() => normalizeCart(c), { code: 'UNSUPPORTED_LINE' });
});
test('snapshot rejects forged kind/group and extra fields', () => {
  for (const change of [s => s.lines[0].kind = 'diamond', s => s.lines[0].groupId = 'bad', s => s.note = 'private']) { const s = normalizeCart(cart()); change(s); assert.throws(() => validateSnapshot(s)); }
});
test('create stores hashed token only and no upstream materialization; read is immutable', async () => {
  const s = normalizeCart(cart()), h = harness(s), created = await h.service.create(s);
  assert.match(created.token, /^[\w-]{43}$/); assert.equal(h.records.has(hash(created.token)), true); assert.equal(JSON.stringify([...h.records.values()]).includes(created.token), false);
  assert.equal(h.supplierReads + h.catalogReads, 0); const read = await h.service.read(created.token); assert.deepEqual(read.snapshot, s); assert.equal(h.writes, 1);
});
test('expired, revoked, malformed and unknown tokens return indistinguishable not found', async () => {
  const h = harness(), made = await h.service.create(normalizeCart(cart()));
  for (const token of ['bad', 'z'.repeat(43)]) await assert.rejects(h.service.read(token), { code: 'SHARE_NOT_FOUND' });
  h.time += 604800000; await assert.rejects(h.service.read(made.token), { code: 'SHARE_NOT_FOUND' });
  h.time = clock; h.records.get(hash(made.token)).revoked_at = new Date(clock).toISOString(); await assert.rejects(h.service.read(made.token), { code: 'SHARE_NOT_FOUND' });
});
test('prepare valid ring/loose/generic returns current native prices and short immutable hash', async () => {
  for (const c of [ring(), cart(), cart({ _diamond_sku: 'ORDINARY', _ring_type: 'Loose', _pending_loose: 'true' })]) {
    const s = normalizeCart(c), h = harness(s), made = await h.service.create(s), { preparation: p } = await h.service.prepare(made.token, 'US', 'USD');
    assert.equal(Date.parse(p.expiresAt), clock + 120000); assert.equal(p.prices.length, s.lines.length); assert.equal(p.priceLocked, false); assert.equal(h.writes, 1);
    const withoutId = { ...p }; delete withoutId.id; assert.equal(p.id, hash(stableStringify(withoutId)));
  }
});
test('engraved ring uses exact configured fee identity although fee catalog type is Diamond', async () => {
  const c = ring(); c.items[0].properties['Custom Engraving'] = 'Love'; c.items.push({ variant_id: 789, sku: 'ENGRAVING-FEE', quantity: 1, properties: { _ring_builder: 'true', _diamond_sku: 'STONE', 'Engraving Text': 'Love' } });
  const s = normalizeCart(c), h = harness(s), made = await h.service.create(s); assert.equal((await h.service.prepare(made.token, 'US', 'USD')).preparation.lines.length, 3);
  const wrong = harness(s, { engravingVariantId: '999' }), m = await wrong.service.create(s); await assert.rejects(wrong.service.prepare(m.token, 'US', 'USD'), { code: 'VARIANT_IDENTITY_MISMATCH' });
});
test('supplier absence/reservation/duplicates block all restore lines without writes', async () => {
  for (const rows of [[], [{ sku: 'STONE', availability: 'reserved' }], [{ sku: 'STONE', availability: 'available' }, { sku: 'STONE', availability: 'available' }]]) { const s = normalizeCart(ring()), h = harness(s); h.rows = rows; const m = await h.service.create(s); await assert.rejects(h.service.prepare(m.token, 'US', 'USD'), { code: 'DIAMOND_UNAVAILABLE' }); assert.equal(h.writes, 1); }
});
test('catalog deletion, duplicate identity, changed SKU, unpublished market or stock failure block', async () => {
  for (const change of [h => h.variants = [], h => h.variants.push(clone(h.variants[0])), h => h.variants[0].sku = 'WRONG', h => h.variants[0].product.status = 'DRAFT', h => h.variants[0].product.publishedInContext = false, h => h.variants[0].inventoryQuantity = 0]) { const s = normalizeCart(cart()), h = harness(s); change(h); const m = await h.service.create(s); await assert.rejects(h.service.prepare(m.token, 'US', 'USD')); assert.equal(h.writes, 1); }
});
test('changed native currency, invalid price and purchase HS context are not silently accepted', async () => {
  for (const change of [h => h.variants[0].contextualPricing.price.currencyCode = 'CAD', h => h.variants[0].contextualPricing.price.amount = '-10', h => h.variants[1].inventoryItem.harmonizedSystemCode = '710491']) { const s = normalizeCart(ring()), h = harness(s); change(h); const m = await h.service.create(s); await assert.rejects(h.service.prepare(m.token, 'US', 'USD')); }
});
test('native ring-size requirement is restored even if untrusted snapshot omitted marker', async () => {
  const s = normalizeCart(cart()), h = harness(s); h.variants[0].product.templateSuffix = 'fashion-rings'; const m = await h.service.create(s), p = (await h.service.prepare(m.token, 'US', 'USD')).preparation;
  assert.equal(p.lines[0].properties._needs_ring_size, 'true'); assert.equal((await h.service.read(m.token)).snapshot.lines[0].properties._needs_ring_size, undefined);
});
test('authoritative mail-in/custom bundle/subscription roles cannot be forged as ordinary', async () => {
  for (const change of [h => h.variants[0].product.templateSuffix = 'setting-igi-grid', h => h.variants[0].product.templateSuffix = 'setting-tiktok', h => h.variants[0].requiresComponents = true, h => h.variants[0].product.requiresSellingPlan = true, h => h.variants[0].product.productType = 'Engagement Ring']) { const s = normalizeCart(cart()), h = harness(s); change(h); const m = await h.service.create(s); await assert.rejects(h.service.prepare(m.token, 'US', 'USD')); }
});
function response() { return { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; }
function handlerHarness(extra = {}) { const h = harness(), env = { CART_SHARE_ENABLED: 'true', CART_SHARE_ALLOWED_ORIGINS: '["https://diyona.com"]', CART_SHARE_RATE_SECRET: 's'.repeat(32), SHOPIFY_STORE: 'example.myshopify.com', ...extra }; let dependencies = 0; const handler = createHandler({ env, dependencies: () => { dependencies++; return { store: h.store, service: h.service }; } }); return { ...h, handler, env, dependencyCount: () => dependencies }; }
function req(body, more = {}) { return { method: 'POST', headers: { origin: 'https://diyona.com', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, body, ...more }; }
test('disabled feature, rejected origin and OPTIONS never instantiate DB dependencies', async () => {
  for (const [env, request, status] of [[{ CART_SHARE_ENABLED: 'false' }, req({}), 404], [{}, req({}, { headers: { origin: 'https://evil.test' } }), 403], [{}, req({}, { method: 'OPTIONS' }), 204]]) { const h = handlerHarness(env), res = response(); await h.handler(request, res); assert.equal(res.statusCode, status); assert.equal(h.dependencyCount(), 0); assert.match(res.headers['cache-control'], /no-store/); }
});
test('HTTP limits/malformed bodies and MIME reject before snapshot access', async () => {
  for (const [request, expected] of [[req('x', { headers: { origin: 'https://diyona.com', 'content-type': 'text/plain' } }), 415], [req('{'), 400], [req('x'.repeat(65537)), 413], [req([], {}), 400], [req({}, { method: 'DELETE' }), 405]]) { const h = handlerHarness(), res = response(); await h.handler(request, res); assert.equal(res.statusCode, expected); assert.equal(h.dependencyCount(), 0); }
});
test('public API create/read/prepare uses configured origin, no cache and no raw internals', async () => {
  const h = handlerHarness(), res = response(); await h.handler(req({ action: 'create', snapshot: normalizeCart(cart()) }), res); assert.equal(res.statusCode, 201); assert.equal(res.headers['access-control-allow-origin'], 'https://diyona.com');
  const read = response(); await h.handler(req(null, { method: 'GET', query: { token: res.body.token } }), read); assert.equal(read.statusCode, 200);
  const prepared = response(); await h.handler(req({ action: 'prepare', token: res.body.token, country: 'US', currency: 'USD' }), prepared); assert.equal(prepared.statusCode, 200); assert.equal(prepared.body.preparation.lines.length, 1);
});
test('durable rate rejection prevents create and never discloses caller address', async () => {
  const h = handlerHarness(); h.store.consumeRate = async () => false; const res = response(); await h.handler(req({ action: 'create', snapshot: normalizeCart(cart()) }), res); assert.equal(res.statusCode, 429); assert.equal(res.headers['retry-after'], '60'); assert.equal(h.records.size, 0); assert.deepEqual(res.body, { error: 'RATE_LIMITED' });
});
test('untrusted forwarding header cannot change local deployment rate identity', async () => {
  const h = handlerHarness(), keys = []; h.store.consumeRate = async key => { keys.push(key); return true; };
  for (const ip of ['1.2.3.4', '8.8.8.8']) { const request = req({ action: 'create', snapshot: normalizeCart(cart()) }); request.headers['x-vercel-forwarded-for'] = ip; await h.handler(request, response()); }
  assert.equal(keys[0], keys[2]); assert.equal(keys[1], keys[3]);
});
test('upstream errors are sanitized and GraphQL partial results rejected', async () => {
  const catalog = createCatalog({ env: { SHOPIFY_STORE: 'example.myshopify.com' }, tokenProvider: async () => 'PRIVATE', fetchImpl: async (_, options) => { assert.match(JSON.parse(options.body).query, /^query /); return { ok: true, json: async () => ({ data: { nodes: [] }, errors: [{ message: 'PRIVATE' }] }) }; } });
  await assert.rejects(catalog.read(['123'], 'US'), { code: 'CATALOG_UNAVAILABLE' });
  const h = handlerHarness(); h.store.consumeRate = async () => { throw new Error('PRIVATE'); }; const res = response(); await h.handler(req({ action: 'create', snapshot: normalizeCart(cart()) }), res); assert.deepEqual(res.body, { error: 'SHARE_TEMPORARILY_UNAVAILABLE' });
});
test('Supabase adapters propagate read/rate/insert failures as safe unavailable errors', async () => {
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, limit: async () => ({ error: { message: 'private' } }), insert: async () => ({ error: { message: 'private' } }) };
  const db = { from() { return query; }, rpc: async () => ({ error: { message: 'private' } }) }, store = createStore(db);
  for (const operation of [() => store.consumeRate('a'.repeat(64), 10, 60), () => store.insert({}), () => store.read('b'.repeat(64))]) await assert.rejects(operation(), { code: 'SHARE_STORAGE_UNAVAILABLE' });
  await assert.rejects(createSupplier(db).read(['STONE']), { code: 'SUPPLIER_UNAVAILABLE' });
});
test('global rate limit bounds per-client counter creation under distributed abuse', async () => {
  const h = handlerHarness(), keys = []; h.store.consumeRate = async key => { keys.push(key); return false; };
  for (const address of ['1.2.3.4', '2.3.4.5']) await h.handler(req({ action: 'create', snapshot: normalizeCart(cart()) }, { socket: { remoteAddress: address } }), response());
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});
test('native and supplier descriptions replace untrusted source labels without changing custom size', async () => {
  const c = ring('US 7'); c.items[1].properties.Diamond = 'False claim'; c.items[1].properties.Certificate = 'False certificate'; c.items[1].properties['Paired Setting'] = 'False setting';
  const s = normalizeCart(c), h = harness(s), made = await h.service.create(s), { preparation: p } = await h.service.prepare(made.token, 'US', 'USD');
  assert.equal(p.lines[1].properties.Diamond, '1ct E VS1 Round'); assert.equal(p.lines[1].properties.Certificate, 'IGI 12345'); assert.equal(p.lines[1].properties['Paired Setting'], 'Example'); assert.equal(p.lines[0].properties['Ring Size'], 'US 7');
});
test('snapshot expiring during upstream reads cannot produce an already expired preparation', async () => {
  const s = normalizeCart(cart()), h = harness(s, { ttlSeconds: 3600 });
  const made = await h.service.create(s); h.time = Date.parse(made.expiresAt) - 1;
  h.catalog.read = async () => { h.time += 2; return clone(h.variants); };
  await assert.rejects(h.service.prepare(made.token, 'US', 'USD'), { code: 'SHARE_NOT_FOUND' });
});
