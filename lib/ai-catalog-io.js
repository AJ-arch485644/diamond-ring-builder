'use strict';

// These adapters deliberately expose no product, inventory, price or checkout writes.
const { randomUUID } = require('node:crypto');
const TYPES = Object.freeze({ ai_catalog_description: 'multi_line_text_field', ai_catalog_category: 'single_line_text_field' });
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/\d+$/;
const METAFIELD = 'id namespace key type value compareDigest';
const PAGE = 'pageInfo { hasNextPage endCursor }';
const VARIANT = `id title sku selectedOptions { name value } metafields(namespace: "custom", first: 10) { nodes { ${METAFIELD} } ${PAGE} }`;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function shopDomain(shop) {
  if (typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) fail('INVALID_SHOP');
  return shop;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function assertId(id) { if (!PRODUCT_ID.test(id)) fail('INVALID_PRODUCT_ID'); }
function connection(value) {
  if (!object(value) || !Array.isArray(value.nodes) || !object(value.pageInfo) || typeof value.pageInfo.hasNextPage !== 'boolean') fail('INCOMPLETE_CONNECTION');
  if (value.pageInfo.hasNextPage && !nonempty(value.pageInfo.endCursor)) fail('INCOMPLETE_CONNECTION');
  return value;
}
function mapMetafields(nodes) {
  const result = {};
  for (const field of nodes) {
    if (!object(field) || field.namespace !== 'custom' || !nonempty(field.key) || typeof field.value !== 'string' || !nonempty(field.type)) fail('INVALID_METAFIELD_RESULT');
    const key = `${field.namespace}.${field.key}`;
    if (Object.hasOwn(result, key)) fail('DUPLICATE_METAFIELD_RESULT');
    result[key] = field;
  }
  return result;
}
function validDate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_DATE_FILTER');
  return new Date(value).toISOString();
}

function createShopifyClient({ shop, token, apiVersion = '2026-07', fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  timeoutMs = 20000, maxReadAttempts = 3, minIntervalMs = 250, reservePoints = 300 } = {}) {
  shop = shopDomain(shop);
  if (!nonempty(token) || typeof fetchImpl !== 'function' || !/^\d{4}-(01|04|07|10)$/.test(apiVersion)) fail('INVALID_CLIENT_CONFIG');
  if (!Number.isInteger(maxReadAttempts) || maxReadAttempts < 1 || maxReadAttempts > 5 || timeoutMs < 1 || timeoutMs > 60000 || minIntervalMs < 0 || reservePoints < 0) fail('INVALID_CLIENT_CONFIG');
  let throttle = null;
  let lastRequestAt = null;
  // Serialize this client, even if a caller accidentally starts multiple operations.
  let tail = Promise.resolve();
  async function headroom(cost) {
    let wait = lastRequestAt === null ? 0 : Math.max(0, minIntervalMs - (now() - lastRequestAt));
    if (throttle) {
      const reserve = Math.min(reservePoints, throttle.maximumAvailable / 2);
      if (cost + reserve > throttle.maximumAvailable) fail('SHOPIFY_HEADROOM_UNAVAILABLE');
      const available = Math.min(throttle.maximumAvailable, throttle.currentlyAvailable + (now() - throttle.at) / 1000 * throttle.restoreRate);
      wait = Math.max(wait, Math.ceil((cost + reserve - available) / throttle.restoreRate * 1000));
    }
    if (wait > 60000) fail('SHOPIFY_HEADROOM_UNAVAILABLE');
    if (wait > 0) await sleep(wait);
  }
  async function execute(query, variables, mutation, cost) {
    const attempts = mutation ? 1 : maxReadAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await headroom(cost);
      lastRequestAt = now();
      let response;
      try {
        response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
          method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (_) {
        if (mutation) fail('SHOPIFY_MUTATION_UNCONFIRMED');
        if (attempt + 1 === attempts) fail('SHOPIFY_READ_TRANSPORT_FAILED');
        await sleep(1000 * 2 ** attempt); continue;
      }
      if (!response.ok) {
        if (mutation) fail('SHOPIFY_MUTATION_UNCONFIRMED');
        if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          await sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0))); continue;
        }
        fail(response.status === 401 || response.status === 403 ? 'SHOPIFY_ACCESS_DENIED' : 'SHOPIFY_READ_HTTP_FAILED');
      }
      let body;
      try { body = await response.json(); } catch (_) { fail(mutation ? 'SHOPIFY_MUTATION_UNCONFIRMED' : 'SHOPIFY_INVALID_RESPONSE'); }
      const status = body?.extensions?.cost?.throttleStatus;
      if (status && [status.maximumAvailable, status.currentlyAvailable, status.restoreRate].every(Number.isFinite) && status.maximumAvailable > 0 && status.restoreRate > 0) throttle = { ...status, at: now() };
      if (Array.isArray(body?.errors) && body.errors.length) {
        if (mutation) fail('SHOPIFY_MUTATION_UNCONFIRMED');
        if (body.errors.every(error => error.extensions?.code === 'THROTTLED') && attempt + 1 < attempts) { await sleep(1000 * 2 ** attempt); continue; }
        fail('SHOPIFY_GRAPHQL_FAILED');
      }
      if (!object(body?.data)) fail(mutation ? 'SHOPIFY_MUTATION_UNCONFIRMED' : 'SHOPIFY_INCOMPLETE_RESPONSE');
      return body.data;
    }
    fail('SHOPIFY_READ_FAILED');
  }
  function request(query, variables, { mutation = false, cost = 100 } = {}) {
    const promise = tail.then(() => execute(query, variables, mutation, cost));
    tail = promise.catch(() => {});
    return promise;
  }
  async function allMetafields(ownerId, firstConnection, kind) {
    let page = connection(firstConnection);
    const nodes = [...page.nodes];
    const cursors = new Set();
    while (page.pageInfo.hasNextPage) {
      const after = page.pageInfo.endCursor;
      if (cursors.has(after)) fail('PAGINATION_DID_NOT_ADVANCE');
      cursors.add(after);
      const data = await request(`query CatalogFacts($id: ID!, $after: String) { ${kind}(id: $id) { id metafields(namespace: "custom", first: 100, after: $after) { nodes { ${METAFIELD} } ${PAGE} } } }`, { id: ownerId, after }, { cost: 110 });
      if (data[kind]?.id !== ownerId) fail('OWNER_DISAPPEARED');
      page = connection(data[kind].metafields); nodes.push(...page.nodes);
    }
    return mapMetafields(nodes);
  }
  return {
    async listProducts({ updatedSince, after, before } = {}) {
      const start = validDate(updatedSince); const end = validDate(before);
      if (start && end && start >= end) fail('INVALID_DATE_RANGE');
      if (after !== undefined && after !== null && !nonempty(after)) fail('INVALID_CURSOR');
      const filter = [start && `updated_at:>='${start}'`, end && `updated_at:<'${end}'`].filter(Boolean).join(' AND ');
      const data = await request(`query CatalogProductList($after: String, $query: String!) { products(first: 50, after: $after, sortKey: UPDATED_AT, query: $query) { nodes { id updatedAt } ${PAGE} } }`, { after: after || null, query: filter }, { cost: 60 });
      const page = connection(data.products);
      const seen = new Set();
      for (const product of page.nodes) { assertId(product?.id); if (!validDate(product.updatedAt) || seen.has(product.id)) fail('INVALID_PRODUCT_LIST'); seen.add(product.id); }
      return { products: page.nodes, pageInfo: page.pageInfo };
    },
    async readProduct(id) {
      assertId(id);
      const data = await request(`query CatalogProduct($id: ID!) { product(id: $id) { id title status updatedAt description descriptionHtml productType templateSuffix tags category { id name fullName } options { id name values } aiDescription: metafield(namespace: "custom", key: "ai_catalog_description") { ${METAFIELD} } aiCategory: metafield(namespace: "custom", key: "ai_catalog_category") { ${METAFIELD} } metafields(namespace: "custom", first: 50) { nodes { ${METAFIELD} } ${PAGE} } variants(first: 20) { nodes { ${VARIANT} } ${PAGE} } } }`, { id }, { cost: 500 });
      const product = data.product;
      if (!product || product.id !== id) fail('PRODUCT_NOT_FOUND');
      for (const key of ['title', 'status', 'description', 'descriptionHtml', 'productType']) if (typeof product[key] !== 'string') fail('INCOMPLETE_PRODUCT');
      if (!validDate(product.updatedAt) || !Object.hasOwn(product, 'templateSuffix') || (product.templateSuffix !== null && typeof product.templateSuffix !== 'string') || !Object.hasOwn(product, 'category') || (product.category !== null && (!object(product.category) || !nonempty(product.category.id) || !nonempty(product.category.name) || !nonempty(product.category.fullName)))) fail('INCOMPLETE_PRODUCT');
      if (!Array.isArray(product.tags) || product.tags.some(tag => typeof tag !== 'string') || !Array.isArray(product.options) || product.options.some(option => !object(option) || !nonempty(option.name) || !Array.isArray(option.values) || option.values.some(value => typeof value !== 'string')) || !Object.hasOwn(product, 'aiDescription') || !Object.hasOwn(product, 'aiCategory')) fail('INCOMPLETE_PRODUCT');
      let page = connection(product.variants);
      const variants = [...page.nodes]; const cursors = new Set();
      while (page.pageInfo.hasNextPage) {
        const after = page.pageInfo.endCursor;
        if (cursors.has(after)) fail('PAGINATION_DID_NOT_ADVANCE');
        cursors.add(after);
        const next = await request(`query CatalogVariants($id: ID!, $after: String) { product(id: $id) { id variants(first: 20, after: $after) { nodes { ${VARIANT} } ${PAGE} } } }`, { id, after }, { cost: 350 });
        if (next.product?.id !== id) fail('PRODUCT_NOT_FOUND');
        page = connection(next.product.variants); variants.push(...page.nodes);
      }
      const seen = new Set();
      for (const variant of variants) {
        if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant?.id) || seen.has(variant.id) || typeof variant.title !== 'string' || !Array.isArray(variant.selectedOptions) || variant.selectedOptions.some(option => !object(option) || !nonempty(option.name) || typeof option.value !== 'string') || !Object.hasOwn(variant, 'sku') || (variant.sku !== null && typeof variant.sku !== 'string')) fail('INCOMPLETE_VARIANT');
        seen.add(variant.id);
        variant.metafields = await allMetafields(variant.id, variant.metafields, 'productVariant');
      }
      const metafields = await allMetafields(id, product.metafields, 'product');
      for (const [alias, key] of [['aiDescription', 'ai_catalog_description'], ['aiCategory', 'ai_catalog_category']]) {
        const field = product[alias];
        if (field !== null && (!object(field) || field.key !== key || field.namespace !== 'custom' || !nonempty(field.compareDigest))) fail('INCOMPLETE_TARGET_DIGEST');
        const listed = metafields[`custom.${key}`] || null;
        if (JSON.stringify(field) !== JSON.stringify(listed)) {
          if (field?.compareDigest !== listed?.compareDigest || field?.value !== listed?.value || field?.type !== listed?.type) fail('TARGET_CHANGED_DURING_READ');
        }
      }
      return { ...product, variants, metafields };
    },
    async setMetafields(fields) {
      if (!Array.isArray(fields) || fields.length !== 2) fail('INVALID_METADATA_PAIR');
      const keys = new Set(); let owner;
      for (const field of fields) {
        if (!object(field) || Object.keys(field).some(key => !['ownerId', 'namespace', 'key', 'type', 'value', 'compareDigest'].includes(key))) fail('INVALID_METADATA_FIELD');
        assertId(field.ownerId); owner ||= field.ownerId;
        if (field.ownerId !== owner || field.namespace !== 'custom' || !Object.hasOwn(TYPES, field.key) || TYPES[field.key] !== field.type || keys.has(field.key) || !nonempty(field.value) || !Object.hasOwn(field, 'compareDigest') || (field.compareDigest !== null && !nonempty(field.compareDigest))) fail('INVALID_METADATA_FIELD');
        if (field.key === 'ai_catalog_category' && /[\r\n]/.test(field.value)) fail('INVALID_METADATA_FIELD');
        keys.add(field.key);
      }
      const data = await request(`mutation CatalogMetadata($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { ${METAFIELD} } userErrors { code } } }`, { metafields: fields }, { mutation: true, cost: 20 });
      const result = data.metafieldsSet;
      if (!object(result) || !Array.isArray(result.userErrors)) fail('SHOPIFY_MUTATION_UNCONFIRMED');
      if (result.userErrors.length) fail(result.userErrors.some(error => error.code === 'INVALID_COMPARE_DIGEST') ? 'SHOPIFY_COMPARE_CONFLICT' : 'SHOPIFY_METADATA_REJECTED');
      if (!Array.isArray(result.metafields) || result.metafields.length !== 2) fail('SHOPIFY_MUTATION_UNCONFIRMED');
      for (const desired of fields) {
        const actual = result.metafields.filter(field => field.namespace === 'custom' && field.key === desired.key);
        if (actual.length !== 1 || actual[0].value !== desired.value || actual[0].type !== desired.type || !nonempty(actual[0].compareDigest)) fail('SHOPIFY_MUTATION_UNCONFIRMED');
      }
      return result.metafields;
    }
  };
}

async function supabaseResult(operation, code) {
  let result;
  try { result = await operation(); } catch (_) { fail(code); }
  if (!result || result.error) fail(code);
  return result.data;
}
function createPrivateStore(supabase, { shop, owner = randomUUID(), leaseSeconds = 180 } = {}) {
  shop = shopDomain(shop);
  if (!supabase || !nonempty(owner) || owner.length > 200 || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) fail('INVALID_STORE_CONFIG');
  const prefix = `${shop}:`;
  const keyFor = (type, id = '') => `${prefix}${type}${id ? `:${id}` : ''}`;
  async function read(key) {
    const data = await supabaseResult(() => supabase.from('ai_catalog_state').select('payload').eq('key', key).limit(2), 'STORE_READ_FAILED');
    if (!Array.isArray(data) || data.length > 1 || (data.length && !object(data[0].payload))) fail('STORE_INVALID_RECORD');
    return data.length ? data[0].payload : null;
  }
  async function write(key, payload, insertOnly = false) {
    if (!object(payload)) fail('STORE_INVALID_PAYLOAD');
    const data = await supabaseResult(() => supabase.rpc('ai_catalog_write_state', {
      p_shop: shop, p_owner: owner, p_key: key, p_payload: payload, p_insert_only: insertOnly
    }), 'STORE_WRITE_FAILED');
    if (data !== true) fail('STORE_WRITE_FAILED');
  }
  async function lease(action) {
    const args = { p_shop: shop, p_owner: owner };
    if (action !== 'release') args.p_ttl_seconds = leaseSeconds;
    const data = await supabaseResult(() => supabase.rpc(`ai_catalog_${action}_lease`, args), 'STORE_LEASE_FAILED');
    if (data !== true) fail(action === 'acquire' ? 'LEASE_BUSY' : 'LEASE_LOST');
    return true;
  }
  return {
    async loadState() { return await read(keyFor('state')) || {}; },
    async saveState(state) { await write(keyFor('state'), state); },
    async getProfileBundle() { const value = await read(keyFor('profiles')); if (!value) fail('STORE_PROFILES_MISSING'); return value; },
    async installProfileBundle(profiles) {
      if (!object(profiles) || !Object.keys(profiles).length) fail('STORE_INVALID_PROFILES');
      for (const [id, profile] of Object.entries(profiles)) {
        assertId(id);
        if (!object(profile) || !/^[a-f0-9]{64}$/.test(profile.sourceHash) || !nonempty(profile.description) || !nonempty(profile.category) || /[\r\n]/.test(profile.category)) fail('STORE_INVALID_PROFILES');
      }
      await write(keyFor('profiles'), profiles);
    },
    async getOwnership(id) { assertId(id); return read(keyFor('ownership', id)); },
    async saveOwnership(id, value) { assertId(id); await write(keyFor('ownership', id), value); },
    async appendAudit(id, value) {
      if (value === undefined) { value = id; id = randomUUID(); }
      if (!nonempty(id) || id.length > 200 || /[\r\n]/.test(id)) fail('STORE_INVALID_AUDIT_ID');
      await write(keyFor('audit', id), value, true); return id;
    },
    getShopifyToken: (requestedShop = shop) => { if (requestedShop !== shop) fail('INVALID_SHOP'); return getShopifyToken(supabase, shop); },
    getSupplier: sku => getSupplier(supabase, sku),
    acquireLease: () => lease('acquire'), renewLease: () => lease('renew'), releaseLease: () => lease('release')
  };
}
async function getSupplier(supabase, sku) {
  if (!nonempty(sku) || sku.length > 200) fail('INVALID_SKU');
  const data = await supabaseResult(() => supabase.from('diamonds').select('sku,carat,shape,color,clarity,is_lab_grown,availability').eq('sku', sku).eq('availability', 'available').limit(2), 'SUPPLIER_READ_FAILED');
  if (!Array.isArray(data)) fail('SUPPLIER_INVALID_RESULT');
  if (!data.length) return null;
  if (data.length !== 1 || data[0].sku !== sku || data[0].availability !== 'available') fail('SUPPLIER_AMBIGUOUS');
  return data[0];
}
async function getShopifyToken(supabase, shop) {
  shop = shopDomain(shop);
  const data = await supabaseResult(() => supabase.from('shopify_tokens').select('access_token').eq('shop', shop).limit(2), 'TOKEN_READ_FAILED');
  if (!Array.isArray(data) || data.length !== 1 || !nonempty(data[0].access_token)) fail('TOKEN_UNAVAILABLE');
  return data[0].access_token;
}

module.exports = { createShopifyClient, createPrivateStore, getSupplier, getShopifyToken };
