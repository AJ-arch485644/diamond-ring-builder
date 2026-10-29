'use strict';

const { renderSelectMetadata } = require('./select-metadata.cjs');

const PUBLIC_FACT_FIELDS = [
  'shape', 'color', 'clarity', 'cut', 'polish', 'symmetry', 'fluorescence',
  'lab', 'certificate_number', 'certificate_url', 'growth_method',
];
const NUMERIC_FACT_FIELDS = [
  'carat', 'length', 'width', 'depth_mm', 'ratio', 'table_percent', 'depth_percent',
];

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function shopifyGid(value, kind) {
  if (value == null || value === '') return undefined;
  const raw = String(value);
  if (new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`).test(raw)) return raw;
  if (/^[1-9][0-9]*$/.test(raw) && (typeof value !== 'number' || Number.isSafeInteger(value))) {
    return `gid://shopify/${kind}/${raw}`;
  }
  throw invalid('SELECT_FEED_IDENTITY_INVALID');
}

// public_diamonds is the feed's eligibility boundary. Its owned rows expose an
// explicit is_lab_grown boolean, not the sync record's origin string. Never infer
// origin from ownership, a title, an image, or the grading-report prefix.
function selectMetadataForFeed(stone) {
  const owned = stone.inventory_source === 'owned';
  const select = stone.is_diyona_select === true;
  if (!owned && !select) return null;
  if (!owned || !select) throw invalid('SELECT_FEED_OWNERSHIP_CONFLICT');

  const hasOrigin = stone.origin != null && stone.origin !== '';
  const hasLabFlag = typeof stone.is_lab_grown === 'boolean';
  const explicitOrigin = hasLabFlag ? (stone.is_lab_grown ? 'Lab grown' : 'Natural') : undefined;
  if (hasOrigin && hasLabFlag && stone.origin !== explicitOrigin) {
    throw invalid('SELECT_FEED_ORIGIN_CONFLICT');
  }
  const attributes = { origin: hasOrigin ? stone.origin : explicitOrigin };
  for (const key of PUBLIC_FACT_FIELDS) attributes[key] = stone[key];
  for (const key of NUMERIC_FACT_FIELDS) {
    const value = stone[key];
    // A complete numeric string is safe to normalize; units/placeholders and
    // partially numeric values are retained so the renderer rejects them.
    attributes[key] = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) : value;
  }
  return renderSelectMetadata({
    identity: {
      sku: stone.sku,
      productId: shopifyGid(stone.shopify_product_id, 'Product'),
      variantId: shopifyGid(stone.shopify_variant_id, 'ProductVariant'),
    },
    attributes,
  });
}

function reportInvalidSelectMetadata(stone, error) {
  console.warn('Skipping invalid owned Select feed metadata: %s', JSON.stringify({
    sku: typeof stone.sku === 'string' ? stone.sku.slice(0, 150) : null,
    code: /^SELECT_[A-Z_]+$/.test(error.code || '') ? error.code : 'SELECT_FEED_METADATA_INVALID',
  }));
}

module.exports = { selectMetadataForFeed, reportInvalidSelectMetadata };
