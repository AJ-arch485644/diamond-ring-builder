'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, FACT_KEYS, sourceHash, renderMetadata, hashValue, requiresSupplier } = require('../lib/ai-catalog-metadata');

const copy = (object) => JSON.parse(JSON.stringify(object));
function jewelry() {
  return {
    id: 'gid://shopify/Product/100', status: 'ACTIVE', title: 'Example Solitaire',
    description: 'A plain band with claw prongs.', descriptionHtml: '<p>A plain band with claw prongs.</p>',
    productType: 'Engagement Ring', templateSuffix: 'ring', tags: ['jewelry'],
    category: { id: 'gid://shopify/TaxonomyCategory/example', name: 'Rings', fullName: 'Jewelry > Rings' },
    options: [{ id: 'gid://shopify/ProductOption/10', name: 'Metal', values: ['14K White Gold', '14K Yellow Gold'] }],
    variants: [
      { id: 'gid://shopify/ProductVariant/101', title: '14K White Gold', sku: 'SETTING-W', selectedOptions: [{ name: 'Metal', value: '14K White Gold' }], metafields: {} },
      { id: 'gid://shopify/ProductVariant/102', title: '14K Yellow Gold', sku: 'SETTING-Y', selectedOptions: [{ name: 'Metal', value: '14K Yellow Gold' }], metafields: {} },
    ], metafields: { 'custom.band_width': { type: 'number_decimal', value: '2.0' } },
    aiDescription: null, aiCategory: null,
  };
}
function profile(product, overrides = {}) {
  return { [product.id]: { sourceHash: sourceHash(product), description: "A reviewed solitaire setting.\nThe setting component price excludes the center diamond.", category: 'Engagement settings', ...overrides } };
}
function diamond() {
  const product = jewelry();
  Object.assign(product, { id: 'gid://shopify/Product/200', title: '2.5ct Marquise D VVS1 Lab Diamond', productType: 'Loose', templateSuffix: 'diamond', description: '', descriptionHtml: '', category: null, metafields: {}, tags: ['lab-grown'], options: [{ id: 'gid://shopify/ProductOption/20', name: 'Title', values: ['Default Title'] }] });
  product.variants = [{ id: 'gid://shopify/ProductVariant/201', title: 'Default Title', sku: 'SUPPLIER-SKU', selectedOptions: [{ name: 'Title', value: 'Default Title' }], metafields: {} }];
  return product;
}
function readyDiamond(product = diamond()) {
  return renderMetadata(product);
}

test('exports only the two authorized fields and immutable factual key allowlist', () => {
  assert.deepEqual(FIELDS, { ai_catalog_description: 'multi_line_text_field', ai_catalog_category: 'single_line_text_field' });
  assert.ok(Object.isFrozen(FIELDS));
  assert.ok(Object.isFrozen(FACT_KEYS));
  assert.ok(!FACT_KEYS.includes('custom.ai_catalog_description'));
  assert.equal(requiresSupplier, false);
  assert.equal(hashValue('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => hashValue({}), TypeError);
});

test('reviewed exact-ID profile preserves description/category bytes and inputs', () => {
  const p = jewelry(); const before = copy(p); const profiles = profile(p);
  const result = renderMetadata(p, { profiles });
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceHash, sourceHash(p));
  assert.deepEqual(result.fields, [
    { namespace: 'custom', key: 'ai_catalog_description', type: 'multi_line_text_field', value: profiles[p.id].description },
    { namespace: 'custom', key: 'ai_catalog_category', type: 'single_line_text_field', value: profiles[p.id].category },
  ]);
  assert.deepEqual(p, before);
});

test('same names or inherited profiles cannot transfer exact-ID review approval', () => {
  const p = jewelry(); const profiles = profile(p);
  p.id = 'gid://shopify/Product/999';
  assert.equal(renderMetadata(p, { profiles }).reason, 'unreviewed_product');
  assert.equal(renderMetadata(p, { profiles: Object.create(profile(p)) }).reason, 'unreviewed_product');
  assert.equal(renderMetadata(p).reason, 'unreviewed_product');
});

test('reviewed source changes block jewelry until reviewed again', () => {
  for (const change of [
    (p) => { p.description += ' With a halo.'; },
    (p) => { p.descriptionHtml += '<p>With a halo.</p>'; },
    (p) => { p.title = 'Different Setting'; },
    (p) => { p.variants[0].sku = 'DIFFERENT'; },
    (p) => { p.variants[0].selectedOptions[0].value = 'Platinum'; },
    (p) => { p.metafields['custom.band_width'].value = '3'; },
    (p) => { delete p.metafields['custom.band_width']; },
    (p) => { p.variants[0].metafields['custom.prong_type'] = { type: 'single_line_text_field', value: 'Rounded' }; },
    (p) => { p.category.name = 'Earrings'; },
    (p) => { p.variants.push({ ...copy(p.variants[0]), id: 'gid://shopify/ProductVariant/103' }); },
  ]) {
    const p = jewelry(); const profiles = profile(p); change(p);
    assert.equal(renderMetadata(p, { profiles }).reason, 'reviewed_source_changed');
  }
});

test('source hash ignores price, inventory, timestamps, output and unrelated metafields', () => {
  const p = jewelry(); const before = sourceHash(p);
  Object.assign(p, { updatedAt: '2030-01-01', price: 9000, totalInventory: 0, aiDescription: { value: 'Changed' }, aiCategory: { value: 'Other' } });
  p.variants[0].price = '9999.99'; p.variants[0].inventoryQuantity = 0;
  p.variants[0].inventoryItem = { tracked: false }; p.variants[0].updatedAt = '2030-01-01';
  p.metafields['custom.ai_catalog_description'] = { type: 'multi_line_text_field', value: 'Changed' };
  p.metafields['custom.shipping_days'] = { type: 'number_integer', value: '8' };
  assert.equal(sourceHash(p), before);
  assert.equal(renderMetadata(p, { profiles: profile(jewelry()) }).status, 'ready');
});

test('source hash is stable under field and set ordering', () => {
  const p = jewelry(); p.tags.push('engagement');
  p.variants[0].selectedOptions.push({ name: 'Shape', value: 'Round' });
  const other = copy(p); other.variants.reverse(); other.tags.reverse(); other.options[0].values.reverse();
  other.variants[1].selectedOptions.reverse(); other.category = { fullName: p.category.fullName, name: p.category.name, id: p.category.id };
  assert.equal(sourceHash(p), sourceHash(other));
});

test('rejects empty, oversized and invalid private profiles without trimming approved bytes', () => {
  const p = jewelry();
  for (const override of [{ description: '' }, { description: ' '.repeat(10) }, { description: 'a'.repeat(20001) }, { category: '' }, { category: 'a'.repeat(256) }, { category: 'Rings\nEarrings' }, { description: 'text\u0000text' }]) {
    assert.equal(renderMetadata(p, { profiles: profile(p, override) }).reason, 'invalid_reviewed_profile');
  }
  const result = renderMetadata(p, { profiles: profile(p, { description: '  Approved prose.\n', category: ' Rings ' }) });
  assert.equal(result.fields[0].value, '  Approved prose.\n');
  assert.equal(result.fields[1].value, ' Rings ');
});

test('inactive products and internal fee/test products never produce fields', () => {
  for (const status of ['DRAFT', 'ARCHIVED']) {
    const p = jewelry(); p.status = status;
    const result = renderMetadata(p, { profiles: profile(p) });
    assert.equal(result.status, 'skipped'); assert.deepEqual(result.fields, []);
  }
  for (const change of [
    (p) => { p.title = 'Engraving Fee'; }, (p) => { p.title = 'Diamond'; },
    (p) => { p.description = "Don't Buy"; }, (p) => { p.productType = 'Internal Test'; },
    (p) => { p.templateSuffix = 'labtest'; }, (p) => { p.tags.push('test-product'); },
  ]) {
    const p = jewelry(); change(p);
    assert.equal(renderMetadata(p, { profiles: profile(p) }).reason, 'internal_or_fee_product');
  }
});

test('all partial source connections fail closed, even with an approved partial hash', () => {
  for (const change of [
    (p) => { p.complete = false; }, (p) => { p.connectionsComplete = false; },
    (p) => { p.pageInfo = { hasNextPage: true }; },
    (p) => { p.variants = { nodes: p.variants, pageInfo: { hasNextPage: false } }; },
    (p) => { p.metafields = { nodes: [] }; }, (p) => { p.variants[0].metafields = { edges: [] }; },
    (p) => { p.variants[0].metafieldsComplete = false; },
    (p) => { p.variants[0].pageInfo = { hasNextPage: true }; },
    (p) => { delete p.options; }, (p) => { delete p.descriptionHtml; },
    (p) => { p.variants[0].selectedOptions = []; }, (p) => { p.variants = []; },
    (p) => { p.variants.push(copy(p.variants[0])); },
  ]) {
    const p = jewelry(); change(p);
    assert.equal(renderMetadata(p, { profiles: profile(p) }).reason, 'incomplete_or_invalid_source');
  }
});

test('malformed input fails closed without throwing or emitting fields', () => {
  for (const p of [null, {}, { ...jewelry(), variants: [null] }, { ...jewelry(), options: [null] }, { ...jewelry(), tags: {} }, { ...jewelry(), id: '100' }]) {
    const result = renderMetadata(p);
    assert.notEqual(result.status, 'ready'); assert.deepEqual(result.fields, []);
  }
});

test('Shopify source alone produces only the exact loose-stone core facts', () => {
  const result = readyDiamond();
  assert.equal(result.status, 'ready');
  assert.equal(result.fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond. Color: D. Clarity: VVS1.');
  assert.equal(result.fields[1].value, 'Loose diamonds');
  assert.doesNotMatch(result.fields[0].value, /in stock|price|certif|shipping|setting|carat total/i);
});

test('supplier absence, availability and conflicting supplier facts have no description dependency', () => {
  const p = diamond(); const expected = readyDiamond(p);
  for (const supplier of [undefined, null, {}, { sku: 'different', carat: 6, shape: 'Oval', color: 'E', clarity: 'VS1', is_lab_grown: false, availability: 'sold', supplier_name: 'PRIVATE COMPANY', certificate_url: 'https://private.example/report' }]) {
    assert.deepEqual(renderMetadata(p, { supplier }), expected);
  }
});

test('one exact variant is required and malformed nonempty SKUs remain blocked', () => {
  const p = diamond(); p.variants.push({ ...copy(p.variants[0]), id: 'gid://shopify/ProductVariant/202' });
  assert.equal(readyDiamond(p).reason, 'diamond_variant_identity_ambiguous');
  for (const sku of [' ', 42, {}, ' SUPPLIER-SKU', 'x\n', 'x'.repeat(256)]) {
    const d = diamond(); d.variants[0].sku = sku;
    assert.equal(readyDiamond(d).reason, 'diamond_sku_missing_or_invalid');
  }
});

test('null, undefined and empty legacy SKUs do not prevent exact-product factual descriptions', () => {
  const expected = readyDiamond().fields;
  for (const sku of [null, undefined, '']) {
    const p = diamond(); p.variants[0].sku = sku;
    assert.equal(readyDiamond(p).status, 'ready');
    assert.deepEqual(readyDiamond(p).fields, expected);
  }
  const incomplete = diamond(); delete incomplete.variants[0].sku;
  assert.equal(readyDiamond(incomplete).reason, 'incomplete_or_invalid_source');
});

test('diamond profiles cannot bypass same-product source validation', () => {
  const p = diamond();
  p.title = 'A mystery diamond';
  assert.equal(renderMetadata(p, { profiles: profile(p) }).reason, 'diamond_title_unparsed');
});

test('natural/lab origins remain distinct and price/certification/dimensions are omitted', () => {
  const p = diamond();
  p.title = '0.70ct Emerald Natural Diamond (Colour G, Clarity VS1, GIA Certified)';
  p.description = 'Type: Natural Diamond Shape: Emerald Carat: 0.70 Colour: G Clarity: VS1 Polish: Excellent Measurements: 5.69x4.17x2.89mm Certificate: GIA';
  assert.equal(readyDiamond(p).fields[0].value, 'A 0.7-carat emerald natural loose diamond. Color: G. Clarity: VS1.');
});

test('expanded and compact supported titles yield identical factual prose', () => {
  for (const title of ['2.50ct Marquise Lab Grown Diamond (Colour D, Clarity VVS1, IGI Certified)', '2.5 Carat Marquise Lab-Grown Diamond (Color D, Clarity VVS1, Cut EX)', '2.5ct Marquise D VVS1 Lab Diamond']) {
    const p = diamond(); p.title = title;
    assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond. Color: D. Clarity: VVS1.');
  }
});

test('unknown, incomplete, conflicting, malformed, and out-of-range title facts are blocked', () => {
  for (const title of [
    '2.5ct Marquise Fancy Yellow VVS1 Lab Diamond', '2.5ct Marquise D SI3 Lab Diamond',
    '2.5ct Marquise D VVS1 Diamond', '2.5ct Mystery D VVS1 Lab Diamond',
    '0ct Marquise D VVS1 Lab Diamond', '-2.5ct Marquise D VVS1 Lab Diamond',
    '101ct Marquise D VVS1 Lab Diamond', '2.12345ct Marquise D VVS1 Lab Diamond',
    '2.5ct Marquise D VVS1 Lab Diamond Natural Diamond', '2.5ct Marquise D VVS1 Lab Diamond and 6ct Diamond',
    '2.5ct Marquise Lab Grown Diamond (Colour D, Colour E, Clarity VVS1)',
    '2.5ct Marquise Lab Grown Diamond (Colour D, Clarity VVS1, Clarity VS1)',
    '2.5ct Marquise Lab Grown Diamond (Colour D, Clarity VVS1, Price $200)',
  ]) {
    const p = diamond(); p.title = title;
    assert.equal(readyDiamond(p).reason, 'diamond_title_unparsed', title);
  }
});

test('structured descriptions cannot contradict the title or contain duplicate core labels', () => {
  const p = diamond();
  p.description = 'Type: Lab Grown Diamond Shape: Marquise Carat: 2.50 Colour: D Clarity: VVS1';
  assert.equal(readyDiamond(p).status, 'ready');
  for (const body of [
    p.description.replace('2.50', '6.00'), p.description.replace('Marquise', 'Oval'),
    p.description.replace('Lab Grown', 'Natural'), p.description.replace('D Clarity', 'E Clarity'),
    p.description.replace('VVS1', 'VS1'), 'Type: Lab Grown Diamond Shape: Marquise',
    `${p.description} Colour: E`, `${p.description} Clarity: VVS1`,
    `${p.description} Type: Natural Diamond`, `${p.description} Carat: 2.50`,
    p.description.replace('VVS1', 'SI3'), p.description.replace('Marquise', 'Marquise-ish'),
    p.description.replace('Marquise', 'Marquise modified'),
    p.description.replace('Lab Grown Diamond', 'Lab Grown Diamond Natural Diamond'),
    `${p.description} This is a natural six-carat oval diamond.`,
  ]) {
    const d = diamond(); d.description = body;
    assert.equal(readyDiamond(d).reason, 'diamond_description_conflict');
  }
});

test('distinct shape descriptions are preserved and conflicting body shapes are blocked', () => {
  const p = diamond(); p.title = '2.5ct Cushion Modified D VVS1 Lab Diamond';
  assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat cushion modified lab-grown loose diamond. Color: D. Clarity: VVS1.');
  p.description = 'Type: Lab Grown Diamond Shape: Cushion Carat: 2.5 Colour: D Clarity: VVS1';
  assert.equal(readyDiamond(p).reason, 'diamond_description_conflict');
});

test('stock and price changes cannot add availability claims or change factual descriptions', () => {
  const p = diamond(); const before = sourceHash(p);
  const expected = readyDiamond(p);
  p.variants[0].availableForSale = false;
  p.variants[0].inventoryQuantity = 0;
  p.variants[0].price = '999.99';
  assert.equal(sourceHash(p), before);
  assert.deepEqual(readyDiamond(p), expected);
});

test('recognized legacy titles omit missing grades and discard laboratory suffixes', () => {
  for (const title of ['2.5 Carat Marquise IGI Certified Lab Grown Diamond', '2.5ct Marquise Lab Grown Diamond']) {
    const p = diamond(); p.title = title; p.description = title;
    assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond.');
  }
  for (const title of ['2.5ct Marquise D VVS1 Lab Diamond | IGI LG123456789', '2.5ct Marquise D VVS1 Lab Diamond IGI LG123456789']) {
    const p = diamond(); p.title = title;
    assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond. Color: D. Clarity: VVS1.');
  }
  const p = diamond(); p.title += ' | Price $200';
  assert.equal(readyDiamond(p).reason, 'diamond_title_unparsed');
});

test('optional grades come only from this product labeled body and are never inferred from tags', () => {
  const p = diamond(); p.title = '2.5ct Marquise Lab Grown Diamond';
  p.tags.push('D', 'VVS1');
  assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond.');
  p.description = 'Type: Lab Grown Diamond Shape: Marquise Carat: 2.5 Colour: E Clarity: VS2';
  assert.equal(readyDiamond(p).fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond. Color: E. Clarity: VS2.');
});

test('known structured bodies discard certificates and links; unknown claims block without leaking text', () => {
  const p = diamond();
  p.description = 'Type: Lab Grown Diamond Shape: Marquise Carat: 2.50 Colour: D Clarity: VVS1 Certificate: IGI Certificate Number: LG123456789 Certificate PDF: https://private.example/report';
  const result = readyDiamond(p);
  assert.equal(result.fields[0].value, 'A 2.5-carat marquise lab-grown loose diamond. Color: D. Clarity: VVS1.');
  assert.doesNotMatch(result.fields[0].value, /private|https|supplier|price|stock|shipping|delivery|certif|IGI|123/);
  for (const extra of [' Supplier: PRIVATE COMPANY', ' Price: $123', ' In stock. Free shipping. Delivery tomorrow.']) {
    const other = copy(p); other.description += extra;
    assert.equal(readyDiamond(other).reason, 'diamond_description_conflict');
    assert.deepEqual(readyDiamond(other).fields, []);
  }
});

test('unrecognized nonempty diamond prose is blocked rather than silently discarded', () => {
  const p = diamond(); p.description = 'A six-carat natural oval diamond.';
  assert.equal(readyDiamond(p).reason, 'diamond_description_unparsed');
});

test('suitable source categories are preserved and neutral missing categories use the confirmed class', () => {
  const p = diamond();
  for (const name of ['Diamonds', 'Loose Diamonds', 'Gemstones', 'Loose gemstones']) {
    p.category = { id: 'gid://shopify/TaxonomyCategory/source', name, fullName: `Jewelry > ${name}` };
    assert.equal(readyDiamond(p).fields[1].value, name);
  }
  for (const category of [null, { name: 'Uncategorized' }, { name: 'Jewelry' }]) {
    p.category = category;
    assert.equal(readyDiamond(p).fields[1].value, 'Loose diamonds');
  }
  for (const category of [{ name: 'Rings' }, { name: 'Charms & Pendants' }, {}, { name: '' }, { name: 'Diamonds\n' }, 'Diamonds']) {
    p.category = category;
    assert.equal(readyDiamond(p).reason, 'diamond_category_conflict');
  }
  p.productType = ''; p.templateSuffix = ''; p.category = null;
  assert.equal(renderMetadata(p).reason, 'unreviewed_product');
});
