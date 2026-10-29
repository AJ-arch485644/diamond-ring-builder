'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const merchant = require('../scripts/generate-merchant-feed');
const openai = require('../scripts/generate-openai-feed');
const { selectMetadataForFeed } = require('../lib/feed-select-metadata');
const { checkVendor } = require('../scripts/vendor-select-metadata');
const fs = require('node:fs');
const path = require('node:path');

const supplier = {
  sku: 'SUPPLIER-123', inventory_source: 'supplier', is_diyona_select: false,
  shape: 'Emerald', carat: 2.02, color: 'F', clarity: 'SI1', cut: null,
  polish: 'VG', symmetry: 'EX', lab: 'IGI', certificate_number: 'LG741542314',
  price_usd: 295.38, image_url: 'https://example.com/diamond.jpg',
  video_url: 'https://example.com/diamond.html', length: 9.27, width: 6.06,
  depth_mm: 3.76, ratio: 1.53,
};

const owned = {
  ...supplier,
  sku: 'OWNED-MB25-74', inventory_source: 'owned', is_diyona_select: true,
  is_lab_grown: true, shape: 'Radiant', carat: 3.05, color: 'G', clarity: 'VVS2',
  lab: 'IGI', certificate_number: 'LG704200001',
  certificate_url: 'https://example.com/reports/LG704200001.pdf',
  length: 10.3, width: 7.36, depth_mm: 4.87, ratio: 1.4,
  table_percent: 68, depth_percent: 66.2, polish: 'EX', symmetry: 'EX',
  fluorescence: 'NON', growth_method: 'CVD', price_usd: 759,
  shopify_product_id: '1029384756', shopify_variant_id: '5647382910',
  product_handle: '3-05ct-radiant-g-vvs2-lab-diamond',
};

test('supplier copy, links and commercial fields retain the existing feed contracts', () => {
  const google = merchant.mapDiamond(supplier);
  const ai = openai.mapDiamond(supplier);
  assert.equal(google.title, '2.02ct Emerald F SI1 Lab Grown Diamond');
  assert.equal(google.description, '2.02 carat Emerald lab grown diamond with F color and SI1 clarity. Very Good polish. Excellent symmetry. Certified by IGI (LG741542314). Dimensions: 9.27 × 6.06 × 3.76 mm. Free shipping and 30-day returns.');
  assert.equal(ai.description, '2.02 carat Emerald lab grown diamond with F color and SI1 clarity. Very Good polish. Excellent symmetry. Certified by IGI (LG741542314). Dimensions: 9.27 × 6.06 × 3.76 mm. Length-to-width ratio 1.53. Buy loose or pair with an engagement ring setting at Diyona. Free insured shipping and 30-day returns.');
  assert.equal(google.link, 'https://diyona.com/pages/diamond-detail?sku=SUPPLIER-123');
  assert.equal(ai.url, 'https://diyona.com/a/lab-diamonds/2.02ct-emerald-f-si1-igi-LG741542314-SUPPLIER-123');
  assert.equal(google.price, '295.38 USD');
  assert.equal(ai.price, google.price);
  assert.equal(ai.is_eligible_checkout, 'false');
});

test('grading-report numbers remain report information, never manufacturer part numbers', () => {
  assert.equal(openai.COLUMNS.includes('mpn'), false);
  for (const certificate_number of ['LG741542314', '836690182', null]) {
    const row = openai.mapDiamond({ ...supplier, certificate_number });
    assert.equal(Object.hasOwn(row, 'mpn'), false);
    if (certificate_number) assert.ok(row.description.includes(certificate_number));
  }
  const ownRow = openai.mapDiamond({ ...owned, certificate_number: '836690182' });
  assert.equal(Object.hasOwn(ownRow, 'mpn'), false);
  assert.match(ownRow.description, /IGI report 836690182\./);
  assert.doesNotMatch(ownRow.description, /LG836690182/);
});

test('existing price and image eligibility guards remain in place', () => {
  assert.equal(merchant.mapDiamond({ ...supplier, price_usd: 0 }), null);
  assert.equal(openai.mapDiamond({ ...supplier, price_usd: null }), null);
  assert.equal(openai.mapDiamond({ ...supplier, image_url: '' }), null);
  assert.equal(merchant.mapDiamond({ ...supplier, image_url: '' }).image_link, '');
});

test('both feeds use the shared factual Select copy and keep product links and prices', () => {
  const google = merchant.mapDiamond(owned);
  const ai = openai.mapDiamond(owned);
  assert.equal(google.description, ai.description);
  assert.equal(google.description, selectMetadataForFeed(owned).plainText);
  for (const fact of [
    'Diyona Select 3.05-carat radiant lab-grown loose diamond',
    'G color and VVS2 clarity', 'IGI report LG704200001',
    'Measures 10.3 × 7.36 × 4.87 mm', 'Length-to-width ratio: 1.4',
    'Table: 68%', 'Depth: 66.2%', 'Excellent polish and symmetry',
    'Fluorescence: None', 'Growth method: CVD',
  ]) assert.ok(google.description.includes(fact), fact);
  assert.doesNotMatch(google.description, /cut grade|ideal|in stock|dispatch|ship|return|\$|USD|<p>/i);
  assert.equal(google.link, 'https://diyona.com/products/3-05ct-radiant-g-vvs2-lab-diamond');
  assert.equal(ai.url, google.link);
  assert.equal(google.price, '759.00 USD');
  assert.equal(ai.price, google.price);
  assert.equal(Object.hasOwn(ai, 'mpn'), false);
});

test('missing or unsupported optional facts do not invent grading or measurement claims', () => {
  const sparse = {
    ...owned, cut: '-', polish: 'UNKNOWN', symmetry: null, fluorescence: 'UNKNOWN',
    growth_method: null, length: 10.3, width: 7.36, depth_mm: null,
    ratio: null, table_percent: null, depth_percent: null, certificate_url: null,
  };
  for (const feed of [merchant, openai]) {
    const row = feed.mapDiamond(sparse);
    assert.ok(row);
    assert.doesNotMatch(row.description, /cut|polish|symmetry|fluorescence|growth|measures|ratio|table|depth|unknown|undefined|null/i);
    assert.match(row.description, /IGI report LG704200001/);
    assert.match(feed.mapDiamond({ ...sparse, cut: 'EX' }).description, /Cut grade: Excellent/);
    assert.doesNotMatch(feed.mapDiamond({ ...sparse, cut: 'UNKNOWN' }).title, /unknown/i);
  }
});

test('invalid required facts and contradictory origin or ownership are skipped with diagnostics', () => {
  const invalid = [
    { lab: null }, { certificate_number: null }, { color: 'Fancy' }, { carat: '3ct' },
    { is_lab_grown: undefined }, { origin: 'Natural' }, { is_lab_grown: false },
    { origin: 'Lab grown', is_lab_grown: false }, { origin: 'unknown' },
    { inventory_source: 'supplier' }, { is_diyona_select: false },
    { depth_mm: '-' }, { table_percent: 150 }, { shopify_variant_id: 'not-an-id' },
  ];
  for (const feed of [merchant, openai]) {
    for (const patch of invalid) {
      const diagnostics = [];
      assert.equal(feed.mapDiamond({ ...owned, ...patch }, {
        onInvalidMetadata: (stone, error) => diagnostics.push({ sku: stone.sku, code: error.code }),
      }), null, JSON.stringify(patch));
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].sku, owned.sku);
      assert.match(diagnostics[0].code, /^SELECT_[A-Z_]+$/);
    }
    assert.ok(feed.mapDiamond(supplier));
  }
});

test('owned factual prose is stable across commerce changes and numeric source representations', () => {
  const canonical = merchant.mapDiamond(owned).description;
  for (const patch of [
    { price_usd: 1599, availability: 'in_stock', min_delivery_days: 1, max_delivery_days: 1 },
    { price_usd: 599, stock_quantity: 0, min_delivery_days: 20, max_delivery_days: 30 },
    { carat: '3.05', length: '10.30', width: '7.36', depth_mm: '4.87', table_percent: '68' },
  ]) {
    assert.equal(merchant.mapDiamond({ ...owned, ...patch }).description, canonical);
    assert.equal(openai.mapDiamond({ ...owned, ...patch }).description, canonical);
  }
});

test('the vendored renderer matches its pinned version/hash and local authoritative copy', () => {
  const source = path.resolve(__dirname, '../../../../outputs/dio-select-sync/lib/select-metadata.cjs');
  const result = checkVendor(fs.existsSync(source) ? source : undefined);
  assert.equal(result.version, 'diyona-select-metadata-v1');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});
