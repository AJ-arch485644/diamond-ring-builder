'use strict';

// Pure transformation only. This module must never call Shopify, Supabase, or
// the ring builder. Reviewed jewelry profiles are supplied privately at runtime.
const { createHash } = require('node:crypto');

const FIELDS = Object.freeze({
  ai_catalog_description: 'multi_line_text_field',
  ai_catalog_category: 'single_line_text_field',
});
const FACT_KEYS = Object.freeze([
  'style', 'band_style', 'band_width', 'band_width_approximate', 'prong_type',
  'setting_style', 'backing_type', 'diamond_shape', 'accent_shape',
  'accent_stone_count', 'fashion_stone_details', 'fashion_pricing_pending',
  'product_title_on_product_page', 'product_title_on_collection_page',
  'diamondcolor', 'diamondclarity', 'diamond_color', 'diamond_clarity',
  'certification', 'average_total_carat_weight', 'avg_carat_weight',
  'accent_total_carat_weight', 'band_width_details',
].map((key) => `custom.${key}`));
const HASH_CONTRACT = 'diyona.ai-catalog-source.v1';
const SHAPES = Object.freeze([
  'cushion modified', 'cushion brilliant', 'square emerald', 'square radiant',
  'round brilliant', 'round', 'oval', 'emerald', 'radiant', 'marquise',
  'cushion', 'pear', 'asscher', 'princess', 'heart',
]);
const SHAPE_PATTERN = SHAPES.join('|');
const GRADE_PATTERN = 'FL|IF|VVS[12]|VS[12]|SI[12]|I[123]';
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value) => typeof value === 'string' ? value : '';
const lower = (value) => str(value).trim().toLowerCase();
const sorted = (values) => [...values].sort((a, b) => {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hashValue(value) {
  if (typeof value !== 'string') throw new TypeError('hashValue requires a string');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function facts(metafields) {
  return Object.fromEntries(FACT_KEYS.map((key) => {
    const field = plain(metafields) && own(metafields, key) ? metafields[key] : null;
    return [key, field ? { type: field.type ?? null, value: field.value ?? null } : null];
  }));
}

function selectedOptions(options) {
  return Array.isArray(options) ? sorted(options.map((option) => ({ name: option?.name ?? null, value: option?.value ?? null }))) : null;
}

// Output digests, prices, stock, timestamps, and unrelated metafields cannot
// trigger a rewrite. Source text, exact variant identity and factual options can.
function sourceHash(product) {
  const p = plain(product) ? product : {};
  const source = {
    contract: HASH_CONTRACT,
    id: p.id ?? null, status: p.status ?? null, title: p.title ?? null,
    description: p.description ?? null, descriptionHtml: p.descriptionHtml ?? null,
    productType: p.productType ?? null, templateSuffix: p.templateSuffix ?? null,
    category: p.category ? { id: p.category.id ?? null, name: p.category.name ?? null, fullName: p.category.fullName ?? null } : null,
    tags: Array.isArray(p.tags) ? sorted(p.tags) : null,
    options: Array.isArray(p.options) ? sorted(p.options.map((option) => ({
      id: option?.id ?? null, name: option?.name ?? null,
      values: Array.isArray(option?.values) ? sorted(option.values) : null,
    }))) : null,
    variants: Array.isArray(p.variants) ? sorted(p.variants.map((variant) => ({
      id: variant?.id ?? null, title: variant?.title ?? null, sku: variant?.sku ?? null,
      selectedOptions: selectedOptions(variant?.selectedOptions), metafields: facts(variant?.metafields),
    }))) : null,
    metafields: facts(p.metafields),
  };
  return hashValue(JSON.stringify(canonical(source)));
}

function hasIncompleteConnection(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (value.pageInfo?.hasNextPage === true || value.pageInfo?.hasPreviousPage === true) return true;
  for (const flag of ['complete', '_complete', 'connectionsComplete', 'variantsComplete', 'metafieldsComplete', 'optionsComplete']) {
    if (value[flag] === false) return true;
  }
  return Object.values(value).some((child) => hasIncompleteConnection(child, seen));
}

function validMetafields(value) {
  return plain(value) && !own(value, 'nodes') && !own(value, 'edges') &&
    Object.entries(value).every(([key, field]) => key.includes('.') && plain(field) && typeof field.value === 'string' && typeof field.type === 'string');
}

function validProduct(p) {
  if (!plain(p) || !/^gid:\/\/shopify\/Product\/\d+$/.test(str(p.id))) return false;
  if (hasIncompleteConnection(p)) return false;
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 1024) return false;
  if (typeof p.description !== 'string' || typeof p.descriptionHtml !== 'string') return false;
  if (!own(p, 'category') || !own(p, 'productType') || !own(p, 'templateSuffix')) return false;
  if (!Array.isArray(p.tags) || !p.tags.every((tag) => typeof tag === 'string')) return false;
  if (!Array.isArray(p.options) || !p.options.length || !validMetafields(p.metafields)) return false;
  if (!p.options.every((option) => plain(option) && typeof option.name === 'string' && Array.isArray(option.values) && option.values.every((v) => typeof v === 'string'))) return false;
  if (!Array.isArray(p.variants) || !p.variants.length) return false;
  const ids = new Set();
  return p.variants.every((v) => {
    if (!plain(v) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(str(v.id)) || ids.has(v.id)) return false;
    ids.add(v.id);
    return own(v, 'sku') && Array.isArray(v.selectedOptions) && v.selectedOptions.length > 0 &&
      v.selectedOptions.every((o) => plain(o) && typeof o.name === 'string' && typeof o.value === 'string') && validMetafields(v.metafields);
  });
}

function internalProduct(product) {
  const title = lower(product.title);
  const type = lower(product.productType);
  return ['engraving fee', 'diamond'].includes(title) ||
    /\b(?:internal test|do not buy|don't buy)\b/.test(`${title} ${lower(product.description)}`) ||
    ['internal test', 'fee', 'fees', 'test'].includes(type) || lower(product.templateSuffix) === 'labtest' ||
    (product.tags || []).some((tag) => ['internal-test', 'internal test', 'do-not-buy', 'test-product'].includes(lower(tag)));
}

function fields(description, category) {
  return Object.entries({ ai_catalog_description: description, ai_catalog_category: category })
    .map(([key, value]) => ({ namespace: 'custom', key, type: FIELDS[key], value }));
}

function validProfile(profile, hash) {
  return plain(profile) && profile.sourceHash === hash &&
    (!own(profile, 'reviewedInternal') || typeof profile.reviewedInternal === 'boolean') &&
    typeof profile.description === 'string' && profile.description.trim().length > 0 && profile.description.length <= 20000 &&
    typeof profile.category === 'string' && profile.category.trim().length > 0 && profile.category.length <= 255 &&
    !/[\r\n\u0000-\u001f\u007f]/.test(profile.category) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(profile.description);
}

function normalizeShape(value) {
  const normalized = lower(value).replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
  // Do not collapse distinct cushion, radiant or step-cut descriptions.
  return SHAPES.includes(normalized) ? normalized : null;
}

function validCarat(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,4})?$/.test(String(value))) return null;
  const carat = Number(value);
  return Number.isFinite(carat) && carat >= 0.01 && carat <= 100 ? carat : null;
}

function parseTitle(title) {
  // Old source titles sometimes append a laboratory and report identifier.
  // Recognize only that decoration; it never becomes a certification claim.
  title = title.replace(/\s+(?:\|\s*)?(?:IGI|GIA|IGML|HRD|GCAL)\s+[A-Z]{0,4}\d{4,20}$/i, '');
  const originPattern = '(Lab(?:[ -]Grown)?|Natural) Diamond';
  const prefix = `(\\d+(?:\\.\\d{1,4})?)\\s*(?:ct|carat)\\s+(${SHAPE_PATTERN})`;
  const compact = title.match(new RegExp(`^${prefix}\\s+([D-Z])\\s+(${GRADE_PATTERN})\\s+${originPattern}$`, 'i'));
  if (compact) {
    const carat = validCarat(compact[1]);
    return carat ? { carat, shape: normalizeShape(compact[2]), color: compact[3].toUpperCase(), clarity: compact[4].toUpperCase(), lab: !/^natural$/i.test(compact[5]) } : null;
  }
  const core = title.match(new RegExp(`^${prefix}\\s+(?:(?:IGI|GIA|IGML|HRD|GCAL) Certified\\s+)?${originPattern}$`, 'i'));
  if (core) {
    const carat = validCarat(core[1]);
    return carat ? { carat, shape: normalizeShape(core[2]), color: null, clarity: null, lab: !/^natural$/i.test(core[3]) } : null;
  }
  const expanded = title.match(new RegExp(`^${prefix}\\s+${originPattern}\\s+\\(([^()]+)\\)$`, 'i'));
  if (!expanded || !validCarat(expanded[1])) return null;
  const labels = expanded[4].split(',').map((label) => label.trim());
  let color, clarity;
  for (const label of labels) {
    const colorLabel = label.match(/^Colou?r ([D-Z])$/i);
    const clarityLabel = label.match(new RegExp(`^Clarity (${GRADE_PATTERN})$`, 'i'));
    if (colorLabel && color === undefined) color = colorLabel[1].toUpperCase();
    else if (clarityLabel && clarity === undefined) clarity = clarityLabel[1].toUpperCase();
    // These title decorations are ignored; they never become certificate or cut claims.
    else if (!/^(?:(?:IGI|GIA|IGML|HRD|GCAL) Certified|Cut (?:ID|EX|VG|G|Ideal|Excellent|Very Good|Good|Fair|Poor))$/i.test(label)) return null;
  }
  return color && clarity ? { carat: validCarat(expanded[1]), shape: normalizeShape(expanded[2]), color, clarity, lab: !/^natural$/i.test(expanded[3]) } : null;
}

function structuredBodyFacts(body) {
  // Match whole labeled values, never just a factual prefix followed by unknown
  // prose. Non-core source labels are recognized only so they can be discarded.
  const patterns = {
    type: /^(?:Lab(?:[ -]Grown)?|Natural) Diamond$/i,
    shape: new RegExp(`^(?:${SHAPE_PATTERN})$`, 'i'),
    carat: /^\d+(?:\.\d{1,4})?$/,
    color: /^[D-Z]$/i,
    clarity: new RegExp(`^(?:${GRADE_PATTERN})$`, 'i'),
    cut: /^(?:ID|EX|VG|G|Ideal|Excellent|Very Good|Good|Fair|Poor)$/i,
    polish: /^(?:EX|VG|G|Excellent|Very Good|Good|Fair|Poor)$/i,
    symmetry: /^(?:EX|VG|G|Excellent|Very Good|Good|Fair|Poor)$/i,
    fluorescence: /^(?:None|Faint|Very Slight|Slight|Medium|Strong|Very Strong|Negligible)$/i,
    measurements: /^\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*mm$/i,
    'l/w ratio': /^\d+(?:\.\d+)?$/,
    table: /^\d+(?:\.\d+)?%$/,
    depth: /^\d+(?:\.\d+)?%$/,
    certificate: /^(?:IGI|GIA|IGML|HRD|GCAL)$/i,
    'certificate number': /^(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,40}$/i,
    'certificate pdf': /^(?:View|https?:\/\/\S+)$/i,
  };
  const labels = [...body.matchAll(/\b(Type|Shape|Carat|Colou?r|Clarity|Cut|Polish|Symmetry|Fluorescence|Measurements|L\/W Ratio|Table|Depth|Certificate Number|Certificate PDF|Certificate)\s*:/ig)];
  if (!labels.length || labels[0].index !== 0) return null;
  const values = {};
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    const key = label[1].toLowerCase().replace('colour', 'color');
    const value = body.slice(label.index + label[0].length, labels[index + 1]?.index ?? body.length).trim();
    if (own(values, key) || !patterns[key].test(value)) return null;
    values[key] = value;
  }
  const { type: origin, shape, carat, color = null, clarity = null } = values;
  if (!origin || !shape || !validCarat(carat)) return null;
  return { carat: validCarat(carat), shape: normalizeShape(shape), color: color?.toUpperCase() ?? null,
    clarity: clarity?.toUpperCase() ?? null, lab: !/^natural /i.test(origin) };
}

function diamondFacts(product) {
  const stone = parseTitle(product.title);
  if (!stone) return { reason: 'diamond_title_unparsed' };
  const body = product.description.trim();
  if (!body || body === product.title.trim()) return { stone };
  // Unrecognized prose is not silently discarded: it may contradict the title.
  if (!/^Type\s*:/i.test(body)) return { reason: 'diamond_description_unparsed' };
  const bodyFacts = structuredBodyFacts(body);
  if (!bodyFacts) return { reason: 'diamond_description_conflict' };
  for (const key of ['carat', 'shape', 'lab', 'color', 'clarity']) {
    if (stone[key] !== null && bodyFacts[key] !== null && stone[key] !== bodyFacts[key]) return { reason: 'diamond_description_conflict' };
  }
  // Optional grades can be filled only by this same product's labeled body.
  return { stone: { ...stone, color: stone.color ?? bodyFacts.color, clarity: stone.clarity ?? bodyFacts.clarity } };
}

function diamondCategory(category) {
  if (category === null) return 'Loose diamonds';
  if (!plain(category) || typeof category.name !== 'string' || !category.name.trim() ||
      category.name.length > 255 || /[\u0000-\u001f\u007f]/.test(category.name)) return null;
  const name = category.name.trim();
  // Keep a suitable source label verbatim; never invent a taxonomy identifier.
  if (/^(?:loose )?(?:diamonds|gemstones)$/i.test(name)) return category.name;
  if (/^(?:uncategorized|jewelry)$/i.test(name)) return 'Loose diamonds';
  return null;
}

function renderMetadata(product, { profiles = {} } = {}) {
  const hash = sourceHash(product);
  const result = (status, reason, values = []) => ({ status, ...(reason ? { reason } : {}), sourceHash: hash, fields: values });
  if (!plain(product)) return result('blocked', 'invalid_product');
  if (product.status !== 'ACTIVE') return result('skipped', 'inactive_product');
  if (!validProduct(product)) return result('blocked', 'incomplete_or_invalid_source');
  const profile = plain(profiles) && own(profiles, product.id) ? profiles[product.id] : null;
  if (plain(profile) && own(profile, 'reviewedInternal') && typeof profile.reviewedInternal !== 'boolean') return result('blocked', 'invalid_reviewed_profile');
  const internal = internalProduct(product);
  const reviewedInternal = plain(profile) && own(profile, 'reviewedInternal') && profile.reviewedInternal === true;
  // An ordinary product review never authorizes an internal cart item or fee.
  // These rare exceptions remain private, exact-ID and source-hash bound.
  if (internal && !reviewedInternal) return result('skipped', 'internal_or_fee_product');

  const diamond = ['diamond', 'loose'].includes(lower(product.productType)) || lower(product.templateSuffix) === 'diamond';
  if (!diamond || reviewedInternal) {
    if (!profile) return result('blocked', 'unreviewed_product');
    if (profile.sourceHash !== hash) return result('blocked', 'reviewed_source_changed');
    if (!validProfile(profile, hash) || (reviewedInternal && !internal)) return result('blocked', 'invalid_reviewed_profile');
    return result('ready', null, fields(profile.description, profile.category));
  }

  if (product.variants.length !== 1) return result('blocked', 'diamond_variant_identity_ambiguous');
  const sku = product.variants[0].sku;
  // Descriptive identity is the exact Shopify product and single variant, not a
  // supplier SKU. Missing legacy SKUs are allowed; malformed supplied ones fail.
  if (sku !== null && sku !== undefined && sku !== '' &&
      (typeof sku !== 'string' || !sku.trim() || sku !== sku.trim() || sku.length > 255 || /[\u0000-\u001f\u007f]/.test(sku))) return result('blocked', 'diamond_sku_missing_or_invalid');
  const { stone, reason } = diamondFacts(product);
  if (reason) return result('blocked', reason);
  const category = diamondCategory(product.category);
  if (!category) return result('blocked', 'diamond_category_conflict');
  const description = [`A ${stone.carat}-carat ${stone.shape} ${stone.lab ? 'lab-grown' : 'natural'} loose diamond.`,
    ...(stone.color ? [`Color: ${stone.color}.`] : []), ...(stone.clarity ? [`Clarity: ${stone.clarity}.`] : [])].join(' ');
  return result('ready', null, fields(description, category));
}

module.exports = { FIELDS, FACT_KEYS, sourceHash, renderMetadata, hashValue, requiresSupplier: false };
