'use strict';
// Independent adversarial review: exercise trust boundaries rather than implementation mirrors.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCart, validateSnapshot } = require('../lib/cart-share-contract');
const { createService, createHandler, createCatalog } = require('../lib/cart-share-service');
const copy = value => JSON.parse(JSON.stringify(value));
const baseTime = Date.parse('2026-10-06T18:00:00Z');
function ring() {
  return { currency: 'USD', attributes: {}, items: [
    { variant_id: 111, quantity: 1, sku: 'SETTING', properties: { _ring_builder: 'true', 'Paired Diamond': '1ct round', 'Diamond SKU': 'STONE', '_diy_operation_v1': 'source-a' } },
    { variant_id: 222, quantity: 1, sku: 'STONE', properties: { _ring_builder: 'true', 'Paired Setting': 'Solitaire', _ring_type: 'Ring', _diamond_sku: 'STONE', '_diy_operation_v1': 'source-a' } }
  ] };
}
function ordinary(properties = {}) {
  return { currency: 'USD', attributes: {}, items: [{ variant_id: 333, quantity: 1, sku: 'EARRING', properties }] };
}
test('multiple ring or loose selections cannot exceed the downstream one-diamond order model',()=>{
  const first=ring(),second=ring();
  second.items[0].variant_id=444;second.items[1].variant_id=555;second.items[1].sku='STONE-2';
  second.items[0].properties['Diamond SKU']='STONE-2';second.items[1].properties._diamond_sku='STONE-2';
  second.items.forEach(line=>line.properties._diy_operation_v1='source-b');
  assert.throws(()=>normalizeCart({...first,items:first.items.concat(second.items)}),{code:'MULTIPLE_DIAMONDS_UNSUPPORTED'});
  const loose=ordinary({_ring_type:'Loose',_diamond_sku:'EARRING',_pending_loose:'true'});
  assert.throws(()=>normalizeCart({...first,items:first.items.concat(loose.items)}),{code:'MULTIPLE_DIAMONDS_UNSUPPORTED'});
  assert.equal(normalizeCart({...first,items:first.items.concat(ordinary().items)}).lines.length,3);
});
function supplierRow(sku = 'STONE') {
  return { sku, availability: 'available', carat: 1, shape: 'Round', color: 'E', clarity: 'VS1', lab: 'IGI', certificate_number: '12345' };
}
function catalogVariant(id, sku, product = {}) {
  return { id: 'gid://shopify/ProductVariant/' + id, legacyResourceId: String(id), sku,
    inventoryItem: { tracked: true, harmonizedSystemCode: '711319' }, inventoryPolicy: 'DENY', inventoryQuantity: 5, requiresComponents: false,
    contextualPricing: { price: { amount: '100.00', currencyCode: 'USD' } },
    product: { status: 'ACTIVE', publishedInContext: true, requiresSellingPlan: false, onlineStoreUrl: 'https://diyona.com/products/example', productType: 'Earrings', templateSuffix: 'fashion-earrings', title: 'Example', vendor: 'Diyona', handle: 'example', tags: [], ...product } };
}
function serviceHarness(snapshot, options = {}) {
  const h = { records: new Map(), reads: 0, inserts: 0, supplierReads: 0, catalogReads: 0, now: baseTime, rows: [], variants: snapshot.lines.map(line => {
    const variant = catalogVariant(line.variantId, line.sku);
    if (line.kind === 'setting') Object.assign(variant.product, { productType: 'Engagement Ring', templateSuffix: 'setting' });
    if (['diamond', 'loose'].includes(line.kind)) {
      Object.assign(variant.product, { productType: 'Diamond', templateSuffix: 'diamond', vendor: 'Lab Diamond' });
      variant.inventoryItem.harmonizedSystemCode = line.kind === 'loose' ? '710491' : '711319';
    }
    if (line.kind === 'engraving') Object.assign(variant.product, { productType: 'Diamond', templateSuffix: 'diamond', handle: 'engraving-fee', title: 'Engraving Fee' });
    return variant;
  }) };
  h.store = { async read(key) { h.reads++; return copy(h.records.get(key) || null); }, async insert(record) { h.inserts++; h.records.set(record.token_hash, copy(record)); } };
  h.service = createService({ store: h.store, supplier: { async read() { h.supplierReads++; return copy(h.rows); } }, catalog: { async read() { h.catalogReads++; return copy(h.variants); } }, now: () => h.now, ...options });
  return h;
}
test('authoritative valid ordinary, ring and loose selections prepare successfully without mutating stored recipes', async () => {
  const loose = ordinary({ _diamond_sku: 'EARRING', _ring_type: 'Loose', _pending_loose: 'true' });
  for (const cart of [ordinary(), ring(), loose]) {
    const snapshot = normalizeCart(cart), h = serviceHarness(snapshot);
    h.rows = snapshot.lines.filter(line => ['diamond', 'loose'].includes(line.kind)).map(line => supplierRow(line.sku));
    const saved = await h.service.create(snapshot), before = copy([...h.records.values()]);
    const prepared = await h.service.prepare(saved.token, 'US', 'USD');
    assert.equal(prepared.preparation.lines.length, snapshot.lines.length);
    assert.equal(prepared.preparation.priceLocked, false); assert.equal(h.inserts, 1);
    assert.deepEqual([...h.records.values()], before);
  }
});
test('source group operation conflicts fail before the ownership IDs are omitted', () => {
  const cart = ring();
  assert.equal(normalizeCart(cart).lines.length, 2);
  cart.items[1].properties._diy_operation_v1 = 'source-b';
  assert.throws(() => normalizeCart(cart), error => !!error.code);
});
test('contradictory setting diamond identity cannot create a bundle the live theme treats as orphaned', () => {
  const cart = ring();
  cart.items[0].properties._diamond_sku = 'STONE';
  cart.items[0].properties['Diamond SKU'] = 'OTHER-STONE';
  assert.throws(() => normalizeCart(cart), error => !!error.code);
});
test('a ring diamond cannot carry a contradictory loose-purchase intent', () => {
  const cart = ring(); cart.items[1].properties._ring_type = 'Loose';
  assert.throws(() => normalizeCart(cart), error => !!error.code);
});
test('valid blank sizes and Unicode quarter sizes round-trip exactly without carrying private operation IDs', () => {
  for (const size of [undefined, '', 'US 3', 'US 7.25', 'US 7¼', 'US 10']) {
    const cart = ring();
    if (size !== undefined) cart.items.forEach(item => item.properties['Ring Size'] = size);
    const snapshot = normalizeCart(cart);
    assert.deepEqual(validateSnapshot(copy(snapshot)), snapshot);
    snapshot.lines.forEach(line => { assert.equal(line.properties['Ring Size'], size); assert.equal(Object.hasOwn(line.properties, 'Ring Size'), size !== undefined); assert.equal(Object.hasOwn(line.properties, '_diy_operation_v1'), false); });
  }
});
test('a nonempty invalid size cannot masquerade as a fulfilled checkout size requirement', () => {
  for (const size of ['banana', 'US 999', 'US 2.75', 'US 7.2', 'US 10¼']) {
    assert.throws(() => normalizeCart(ordinary({ 'Ring Size': size, _needs_ring_size: 'true' })), error => !!error.code);
  }
});
test('stale hidden engraving cannot override current matching setting and paid fee text', () => {
  const cart = ring(); cart.items[0].properties['Custom Engraving'] = 'CURRENT'; cart.items[1].properties._engraving = 'OLD';
  cart.items.push({ variant_id: 444, quantity: 1, sku: 'FEE', properties: { _ring_builder: 'true', _diamond_sku: 'STONE', 'Engraving Text': 'CURRENT' } });
  const snapshot = normalizeCart(cart);
  assert.equal(snapshot.lines.find(line => line.kind === 'diamond').properties._engraving, 'CURRENT');
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
});
test('native engraving fee classified as Diamond needs configured exact variant identity, not a matching title', async () => {
  const cart = ring(); cart.items[0].properties['Custom Engraving'] = 'CURRENT';
  cart.items.push({ variant_id: 444, quantity: 1, sku: 'ENGRAVING-FEE', properties: { _ring_builder: 'true', _diamond_sku: 'STONE', 'Engraving Text': 'CURRENT' } });
  const snapshot = normalizeCart(cart), h = serviceHarness(snapshot, { engravingVariantId: '444' }); h.rows = [supplierRow()];
  const saved = await h.service.create(snapshot);
  assert.equal((await h.service.prepare(saved.token, 'US', 'USD')).preparation.lines.length, 3);
  h.variants[2].product.handle = 'unrelated-fee'; h.variants[2].product.productType = 'Service'; h.variants[2].product.templateSuffix = '';
  await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), { code: 'VARIANT_IDENTITY_MISMATCH' });
  const missingConfiguration = serviceHarness(snapshot); missingConfiguration.rows = h.rows;
  const missingSaved = await missingConfiguration.service.create(snapshot);
  await assert.rejects(missingConfiguration.service.prepare(missingSaved.token, 'US', 'USD'), { code: 'ENGRAVING_CONFIGURATION_UNAVAILABLE' });
});
test('unsupported metadata, mail-in identifiers and literal markup never enter a portable snapshot', () => {
  for (const properties of [{ Gift: 'customer secret' }, { _igi_flow: 'true' }, { 'IGI Certificate Number': '123' }, { 'Ring Size': '<img src=x onerror=alert(1)>' }, { 'Chain Length': 'x&#34; onclick=x' }]) {
    assert.throws(() => normalizeCart(ordinary(properties)), error => !!error.code);
  }
});
test('allowed visible properties cannot become javascript upload links in the existing raw Liquid renderer', () => {
  for (const key of ['Chain', 'Chain Length', 'Pendant Chain']) {
    for (const value of ['javascript:alert(1)//uploads/x', 'java\nscript:alert(1)//uploads/x', 'data:text/html;base64,PHNjcmlwdD4=/uploads/x']) {
      assert.throws(() => normalizeCart(ordinary({ [key]: value })), error => !!error.code);
    }
  }
});
test('source pending and half-completed swap cannot be normalized by dropping their sentinel', () => {
  const cart = ring(); cart.items.push({ variant_id: 51975403077948, sku: '', quantity: 1, properties: { _pending_diamond_id: 'creating', _diamond_sku: 'STONE' } });
  assert.throws(() => normalizeCart(cart), { code: 'CART_PENDING' });
});
test('persisted tampering, expiry and revocation fail before upstream preparation reads', async () => {
  const snapshot = normalizeCart(ordinary());
  for (const tamper of [record => record.payload.lines[0].quantity = 2, record => record.expires_at = new Date(baseTime).toISOString(), record => record.revoked_at = new Date(baseTime).toISOString()]) {
    const h = serviceHarness(snapshot), saved = await h.service.create(snapshot), record = [...h.records.values()][0];
    tamper(record); await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), error => !!error.code);
    assert.equal(h.inserts, 1); assert.equal(h.supplierReads, 0); assert.equal(h.catalogReads, 0);
  }
});
test('supplier missing, duplicate or unavailable stones cannot yield a partial prepare', async () => {
  const snapshot = normalizeCart(ring());
  for (const rows of [[], [{ sku: 'STONE', availability: 'unavailable' }], [{ sku: 'STONE', availability: 'available' }, { sku: 'STONE', availability: 'available' }]]) {
    const h = serviceHarness(snapshot); h.rows = rows; const saved = await h.service.create(snapshot);
    await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), { code: 'DIAMOND_UNAVAILABLE' }); assert.equal(h.inserts, 1);
  }
});
test('catalog diamond identity cannot be bypassed by omitting every client diamond property', async () => {
  const snapshot = normalizeCart(ordinary()); const h = serviceHarness(snapshot);
  h.variants[0].product.vendor = 'Lab Diamond'; h.variants[0].product.productType = ''; h.variants[0].product.templateSuffix = '';
  const saved = await h.service.create(snapshot);
  await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), error => !!error.code);
});
test('an ordinary catalog product cannot masquerade as a ring setting through client properties', async () => {
  const snapshot = normalizeCart(ring()), h = serviceHarness(snapshot); h.rows = [{ sku: 'STONE', availability: 'available' }];
  h.variants[0].product.productType = 'Earrings'; h.variants[0].product.templateSuffix = 'fashion-earrings';
  const saved = await h.service.create(snapshot);
  await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), error => !!error.code);
});
test('catalog roles reject omitted mail-in metadata, native bundles and market-hidden items', async () => {
  for (const alter of [v => v.product.templateSuffix = 'setting-igi', v => v.product.templateSuffix = 'setting-tiktok', v => v.requiresComponents = true, v => v.product.requiresSellingPlan = true, v => v.product.publishedInContext = false]) {
    const snapshot = normalizeCart(ordinary()), h = serviceHarness(snapshot); alter(h.variants[0]);
    const saved = await h.service.create(snapshot); await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), error => !!error.code);
  }
});
test('stripped size marker is reinstated from trusted wedding-band catalog data without changing source snapshot', async () => {
  const snapshot = normalizeCart(ordinary()), h = serviceHarness(snapshot); h.variants[0].product.templateSuffix = 'wedding-bands';
  const saved = await h.service.create(snapshot), prepared = await h.service.prepare(saved.token, 'US', 'USD');
  assert.equal(prepared.preparation.lines[0].properties._needs_ring_size, 'true');
  assert.deepEqual((await h.service.read(saved.token)).snapshot, snapshot);
});
test('wrong global diamond purchase classification cannot be silently repaired or shared', async () => {
  const snapshot = normalizeCart(ring()), h = serviceHarness(snapshot); h.rows = [{ sku: 'STONE', availability: 'available' }];
  h.variants[1].inventoryItem.harmonizedSystemCode = '710491';
  const saved = await h.service.create(snapshot);
  await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), { code: 'DIAMOND_INTENT_CHANGED' });
  assert.equal(h.inserts, 1);
});
test('preparation replaces sender stone and paired labels with authoritative facts without rewriting the stored share', async () => {
  const cart = ring();
  cart.items[0].properties['Paired Diamond'] = 'FAKE 99ct diamond';
  Object.assign(cart.items[1].properties, { Diamond: 'FAKE 99ct diamond', Certificate: 'FAKE CERT', 'Paired Setting': 'FAKE Platinum Solitaire' });
  const snapshot = normalizeCart(cart), h = serviceHarness(snapshot); h.rows = [supplierRow()];
  h.variants[0].product.title = 'Native Solitaire';
  const saved = await h.service.create(snapshot), before = copy([...h.records.values()]);
  const prepared = (await h.service.prepare(saved.token, 'US', 'USD')).preparation;
  const setting = prepared.lines.find(line => line.kind === 'setting'), diamond = prepared.lines.find(line => line.kind === 'diamond');
  assert.equal(setting.properties['Paired Diamond'], '1ct E VS1 Round');
  assert.equal(diamond.properties.Diamond, '1ct E VS1 Round');
  assert.equal(diamond.properties.Certificate, 'IGI 12345');
  assert.equal(diamond.properties['Paired Setting'], 'Native Solitaire');
  assert.equal(prepared.snapshotHash, saved.snapshotHash);
  assert.deepEqual((await h.service.read(saved.token)).snapshot, snapshot);
  assert.deepEqual([...h.records.values()], before);
  h.rows[0].certificate_number = null;
  const noCertificate = (await h.service.prepare(saved.token, 'US', 'USD')).preparation.lines.find(line => line.kind === 'diamond');
  assert.equal(Object.hasOwn(noCertificate.properties, 'Certificate'), false);
});
test('rehydration validates upstream strings before they can cross into raw theme rendering', async () => {
  const snapshot = normalizeCart(ring());
  for (const alter of [h => h.rows[0].shape = '<img src=x onerror=alert(1)>', h => h.rows[0].certificate_number = 'javascript:alert(1)//uploads/x', h => h.variants[0].product.title = '<script>alert(1)</script>']) {
    const h = serviceHarness(snapshot); h.rows = [supplierRow()]; alter(h);
    const saved = await h.service.create(snapshot), before = copy([...h.records.values()]);
    await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), { code: 'INVALID_TEXT' });
    assert.deepEqual([...h.records.values()], before); assert.equal(h.inserts, 1);
  }
});
test('catalog inventory is checked against total requested quantity across separately configured lines', async () => {
  const cart = ordinary({ 'Chain Length': '16 in' }); cart.items.push({ ...copy(cart.items[0]), properties: { 'Chain Length': '18 in' } });
  const snapshot = normalizeCart(cart), h = serviceHarness(snapshot); h.variants = [catalogVariant(333, 'EARRING')]; h.variants[0].inventoryQuantity = 1;
  const saved = await h.service.create(snapshot);
  await assert.rejects(h.service.prepare(saved.token, 'US', 'USD'), { code: 'VARIANT_UNAVAILABLE' });
});
test('catalog transport sends only a read query and rejects GraphQL partial errors', async () => {
  let request;
  const catalog = createCatalog({ env: { SHOPIFY_STORE: 'diyona.myshopify.com' }, tokenProvider: async () => 'test-token', fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, async json() { return { data: { nodes: [] }, errors: [{ message: 'partial' }] }; } }; } });
  await assert.rejects(catalog.read(['333'], 'US'), { code: 'CATALOG_UNAVAILABLE' });
  const body = JSON.parse(request.body); assert.match(body.query, /^query /); assert.doesNotMatch(body.query, /mutation\s*[({]/); assert.equal(request.redirect, 'error');
});
function response() { return { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(s) { this.statusCode = s; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; }
test('disabled, rejected origin and rate failures cannot touch snapshot service and remain non-cacheable', async () => {
  const env = { CART_SHARE_ENABLED: 'true', CART_SHARE_ALLOWED_ORIGINS: '["https://diyona.com"]', CART_SHARE_RATE_SECRET: 's'.repeat(32), SHOPIFY_STORE: 'diyona.myshopify.com' };
  let serviceCalls = 0, rateCalls = 0;
  const handler = createHandler({ env, dependencies: () => ({ store: { async consumeRate() { rateCalls++; return false; } }, service: { async read() { serviceCalls++; } } }) });
  for (const [enabled, origin, expected] of [['false', 'https://diyona.com', 404], ['true', 'https://evil.example', 403], ['true', 'https://diyona.com', 429]]) {
    env.CART_SHARE_ENABLED = enabled; const res = response();
    await handler({ method: 'GET', headers: { origin }, query: { token: 'a'.repeat(43) }, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.equal(res.statusCode, expected); assert.match(res.headers['cache-control'], /no-store/); assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store');
  }
  assert.equal(rateCalls, 1); assert.equal(serviceCalls, 0);
});
