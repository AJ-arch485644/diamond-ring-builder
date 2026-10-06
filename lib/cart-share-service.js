'use strict';
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { validateSnapshot, stableStringify, ShareCartError } = require('./cart-share-contract');
const API_VERSION = '2026-07';
const MAX_BYTES = 65536;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 400) => { throw new ShareCartError(code, status); };
const tokenHash = token => { if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('SHARE_NOT_FOUND', 404); return hash(token); };
function createService({ store, supplier, catalog, now = Date.now, random = randomBytes, allowedAttributes = [], ttlSeconds = 604800, engravingVariantId = null }) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 3600 || ttlSeconds > 2592000) fail('SHARE_CONFIGURATION_UNAVAILABLE', 503);
  async function read(token) {
    const record = await store.read(tokenHash(token));
    if (!record || record.revoked_at || !Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= now()) fail('SHARE_NOT_FOUND', 404);
    const snapshot = validateSnapshot(record.payload, { allowedAttributes });
    if (hash(stableStringify(snapshot)) !== record.snapshot_hash) fail('SHARE_STORAGE_UNAVAILABLE', 503);
    return { snapshot, expiresAt: record.expires_at, snapshotHash: record.snapshot_hash };
  }
  return {
    read,
    async create(input) {
      const snapshot = validateSnapshot(input, { allowedAttributes });
      const serialized = stableStringify(snapshot);
      if (Buffer.byteLength(serialized) > MAX_BYTES) fail('REQUEST_TOO_LARGE', 413);
      const createdMs = now(), token = random(32).toString('base64url'), createdAt = new Date(createdMs).toISOString(), expiresAt = new Date(createdMs + ttlSeconds * 1000).toISOString();
      const snapshotHash = hash(serialized);
      await store.insert({ token_hash: tokenHash(token), snapshot_hash: snapshotHash, payload: snapshot, created_at: createdAt, expires_at: expiresAt });
      return { token, expiresAt, snapshotHash, snapshot };
    },
    async prepare(token, country, currency) {
      if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail('INVALID_CONTEXT');
      const saved = await read(token);
      const skus = saved.snapshot.lines.filter(line => ['diamond', 'loose'].includes(line.kind)).map(line => line.sku);
      const [rows, variants] = await Promise.all([supplier.read(skus), catalog.read(saved.snapshot.lines.map(line => line.variantId), country)]);
      if (!Array.isArray(rows) || !Array.isArray(variants)) fail('PREPARE_UNAVAILABLE', 503);
      skus.forEach(sku => {
        const matches = rows.filter(row => row && row.sku === sku);
        if (matches.length !== 1 || matches[0].availability !== 'available') fail('DIAMOND_UNAVAILABLE', 409);
      });
      const prices = [], quantityByVariant = new Map();
      saved.snapshot.lines.forEach(line => quantityByVariant.set(line.variantId, (quantityByVariant.get(line.variantId) || 0) + line.quantity));
      saved.snapshot.lines.forEach((line, index) => {
        const matches = variants.filter(v => v && String(v.legacyResourceId) === line.variantId);
        if (matches.length !== 1) fail('VARIANT_UNAVAILABLE', 409);
        const v = matches[0], p = v.product;
        if (v.id !== 'gid://shopify/ProductVariant/' + line.variantId || v.sku !== line.sku) fail('VARIANT_IDENTITY_MISMATCH', 409);
        if (!p || p.status !== 'ACTIVE' || p.publishedInContext !== true || typeof p.onlineStoreUrl !== 'string' || !p.onlineStoreUrl) fail('VARIANT_UNAVAILABLE', 409);
        if (typeof v.requiresComponents !== 'boolean' || typeof p.requiresSellingPlan !== 'boolean') fail('INCOMPLETE_CATALOG', 503);
        const nativeFee = p.handle === 'engraving-fee' && v.sku === 'ENGRAVING-FEE';
        const template = String(p.templateSuffix || '').toLowerCase();
        const nativeDiamond = !nativeFee && (['diamond', 'loose'].includes(String(p.productType || '').toLowerCase()) || template === 'diamond' || String(p.vendor || '').toLowerCase() === 'lab diamond');
        const intendedDiamond = ['diamond', 'loose'].includes(line.kind);
        if (nativeDiamond !== intendedDiamond) fail('VARIANT_IDENTITY_MISMATCH', 409);
        if (line.kind === 'engraving') {
          if (!engravingVariantId) fail('ENGRAVING_CONFIGURATION_UNAVAILABLE', 503);
          if (!nativeFee || line.variantId !== engravingVariantId) fail('VARIANT_IDENTITY_MISMATCH', 409);
        } else if (nativeFee) fail('UNSUPPORTED_BUNDLE', 409);
        const nativeSetting = ['setting', 'tt-setting'].includes(template);
        if (/(?:igi|tiktok|labtest)/i.test(template) || (/^engagement rings?$/i.test(p.productType || '') && !nativeSetting) || v.requiresComponents === true || p.requiresSellingPlan === true) fail('UNSUPPORTED_PRODUCT_ROLE', 409);
        if ((line.kind === 'setting') !== nativeSetting) fail('UNSUPPORTED_PRODUCT_ROLE', 409);
        if (line.kind === 'product' && (['fashion-rings', 'wedding-bands', 'band-drafts'].includes(template) || /^(?:fashion rings?|wedding bands?)$/i.test(p.productType || ''))) line.properties._needs_ring_size = 'true';
        if (intendedDiamond && String(v.inventoryItem?.harmonizedSystemCode || '').replace(/\./g, '') !== (line.kind === 'loose' ? '710491' : '711319')) fail('DIAMOND_INTENT_CHANGED', 409);
        if (typeof v.inventoryItem?.tracked !== 'boolean' || !['DENY', 'CONTINUE'].includes(v.inventoryPolicy)) fail('INCOMPLETE_CATALOG', 503);
        if (v.inventoryItem.tracked && (v.inventoryPolicy !== 'CONTINUE' || intendedDiamond) && (!Number.isInteger(v.inventoryQuantity) || v.inventoryQuantity < quantityByVariant.get(line.variantId))) fail('VARIANT_UNAVAILABLE', 409);
        const price = v.contextualPricing?.price;
        if (!price || typeof price.amount !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(price.amount) || !Number.isFinite(Number(price.amount)) || Number(price.amount) <= 0 || price.currencyCode !== currency) fail('PRICE_CONTEXT_UNAVAILABLE', 409);
        prices.push({ lineIndex: index, variantId: line.variantId, quantity: line.quantity, unitPrice: { amount: price.amount, currencyCode: currency } });
      });
      // Shared descriptions are untrusted input. Rebuild factual stone labels and
      // paired setting titles from the same current identities used above.
      saved.snapshot.lines.filter(line => ['diamond', 'loose'].includes(line.kind)).forEach(line => {
        const row = rows.find(row => row.sku === line.sku);
        if (!Number.isFinite(Number(row.carat)) || Number(row.carat) <= 0 || ['shape', 'color', 'clarity'].some(key => typeof row[key] !== 'string' || !row[key])) fail('INCOMPLETE_SUPPLIER_DATA', 503);
        const summary = `${row.carat}ct ${row.color} ${row.clarity} ${row.shape}`;
        line.properties.Diamond = summary;
        delete line.properties.Certificate;
        if (row.certificate_number != null && row.certificate_number !== '') line.properties.Certificate = [row.lab || '', String(row.certificate_number)].filter(Boolean).join(' ');
        if (line.kind === 'diamond') {
          const setting = saved.snapshot.lines.find(candidate => candidate.groupId === line.groupId && candidate.kind === 'setting');
          const settingVariant = variants.find(v => v && String(v.legacyResourceId) === setting.variantId);
          line.properties['Paired Setting'] = settingVariant.product.title;
          setting.properties['Paired Diamond'] = summary;
        }
      });
      // Revalidate canonicalized labels through the exact browser-safe contract.
      validateSnapshot(saved.snapshot, { allowedAttributes });
      if (Date.parse(saved.expiresAt) <= now()) fail('SHARE_NOT_FOUND', 404);
      const preparation = { version: 1, snapshotHash: saved.snapshotHash, expiresAt: new Date(Math.min(now() + 120000, Date.parse(saved.expiresAt))).toISOString(), country, currency, lines: saved.snapshot.lines, attributes: saved.snapshot.attributes, prices, priceLocked: false, availabilityConfirmed: false };
      preparation.id = hash(stableStringify(preparation));
      return { preparation };
    }
  };
}
const CATALOG_QUERY = `query SharedCartVariants($ids:[ID!]!,$country:CountryCode!){nodes(ids:$ids){... on ProductVariant{id legacyResourceId sku requiresComponents inventoryQuantity inventoryPolicy inventoryItem{tracked harmonizedSystemCode} product{status onlineStoreUrl publishedInContext(context:{country:$country}) productType templateSuffix title handle vendor requiresSellingPlan} contextualPricing(context:{country:$country}){price{amount currencyCode}}}}}`;
function createCatalog({ env, fetchImpl = globalThis.fetch, tokenProvider }) {
  return { async read(ids, country) {
    const token = await tokenProvider();
    const response = await fetchImpl(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: CATALOG_QUERY, variables: { ids: [...new Set(ids)].map(id => 'gid://shopify/ProductVariant/' + id), country } }), signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) fail('CATALOG_UNAVAILABLE', 503);
    const body = await response.json();
    if (body.errors?.length || !Array.isArray(body.data?.nodes)) fail('CATALOG_UNAVAILABLE', 503);
    return body.data.nodes;
  } };
}
function configuration(env) {
  let origins, allowedAttributes;
  try {
    origins = JSON.parse(env.CART_SHARE_ALLOWED_ORIGINS || '[]');
    allowedAttributes = JSON.parse(env.CART_SHARE_ALLOWED_ATTRIBUTES || '[]');
  } catch { fail('SHARE_CONFIGURATION_UNAVAILABLE', 503); }
  if (!Array.isArray(origins) || !origins.length || origins.length > 10 || origins.some(origin => typeof origin !== 'string' || !/^https:\/\/[^/?#]+$/.test(origin) || new URL(origin).origin !== origin) || !Array.isArray(allowedAttributes) || allowedAttributes.some(k => typeof k !== 'string' || !/^[A-Za-z0-9 _-]{1,80}$/.test(k))) fail('SHARE_CONFIGURATION_UNAVAILABLE', 503);
  if (typeof env.CART_SHARE_RATE_SECRET !== 'string' || env.CART_SHARE_RATE_SECRET.length < 32 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(env.SHOPIFY_STORE || '')) fail('SHARE_CONFIGURATION_UNAVAILABLE', 503);
  if (env.CART_SHARE_ENGRAVING_VARIANT_ID && !/^[1-9]\d{0,15}$/.test(env.CART_SHARE_ENGRAVING_VARIANT_ID)) fail('SHARE_CONFIGURATION_UNAVAILABLE', 503);
  return { origins, allowedAttributes, engravingVariantId: env.CART_SHARE_ENGRAVING_VARIANT_ID || null, ttlSeconds: env.CART_SHARE_TTL_SECONDS ? Number(env.CART_SHARE_TTL_SECONDS) : 604800 };
}
function defaultDependencies(env, config) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) fail('SHARE_CONFIGURATION_UNAVAILABLE', 503);
  const { createClient } = require('@supabase/supabase-js');
  const { createStore, createSupplier } = require('./cart-share-store');
  const { getShopifyToken } = require('./ai-catalog-io');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const store = createStore(db), supplier = createSupplier(db), catalog = createCatalog({ env, tokenProvider: () => getShopifyToken(db, env.SHOPIFY_STORE) });
  return { store, service: createService({ store, supplier, catalog, ...config }) };
}
function createHandler({ env = process.env, dependencies = defaultDependencies } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store'); res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (env.CART_SHARE_ENABLED !== 'true') fail('SHARE_DISABLED', 404);
      const config = configuration(env), origin = req.headers?.origin;
      if (typeof origin !== 'string' || !config.origins.includes(origin)) fail('ORIGIN_NOT_ALLOWED', 403);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.status(204).end();
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST, OPTIONS'); fail('METHOD_NOT_ALLOWED', 405); }
      const bytes = Number(req.headers?.['content-length']);
      if (Number.isFinite(bytes) && bytes > MAX_BYTES) fail('REQUEST_TOO_LARGE', 413);
      let body = req.body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) fail('JSON_REQUIRED', 415);
        if (typeof body === 'string') { if (Buffer.byteLength(body) > MAX_BYTES) fail('REQUEST_TOO_LARGE', 413); try { body = JSON.parse(body); } catch { fail('INVALID_JSON'); } }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST');
        if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) fail('REQUEST_TOO_LARGE', 413);
      }
      const action = req.method === 'GET' ? 'read' : body.action;
      if (!['read', 'create', 'prepare'].includes(action) || (req.method === 'POST' && action === 'read')) fail('INVALID_ACTION');
      const { store, service } = dependencies(env, config);
      // Use Vercel's platform-controlled client address; never trust arbitrary forwarded headers outside Vercel.
      const ip = env.VERCEL === '1' ? req.headers?.['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
      if (typeof ip !== 'string' || !ip || ip.length > 200) fail('RATE_IDENTITY_UNAVAILABLE', 503);
      const scope = hash(env.SHOPIFY_STORE + ':cart-share');
      // A global durable cap bounds distributed abuse independently of the supplied IP count.
      const globalKey = createHmac('sha256', env.CART_SHARE_RATE_SECRET).update(scope + ':global:' + action).digest('hex');
      if (!await store.consumeRate(globalKey, action === 'create' ? 300 : 1000, 60)) { res.setHeader('Retry-After', '60'); fail('RATE_LIMITED', 429); }
      const key = createHmac('sha256', env.CART_SHARE_RATE_SECRET).update(scope + ':' + action + ':' + ip).digest('hex');
      if (!await store.consumeRate(key, action === 'create' ? 10 : 60, 60)) { res.setHeader('Retry-After', '60'); fail('RATE_LIMITED', 429); }
      let result;
      if (action === 'create') { if (Object.keys(body).some(k => !['action', 'snapshot'].includes(k))) fail('INVALID_REQUEST'); result = await service.create(body.snapshot); }
      else if (action === 'prepare') { if (Object.keys(body).some(k => !['action', 'token', 'country', 'currency'].includes(k))) fail('INVALID_REQUEST'); result = await service.prepare(body.token, body.country, body.currency); }
      else { if (Object.keys(req.query || {}).some(k => k !== 'token')) fail('INVALID_REQUEST'); result = await service.read(req.query?.token); }
      return res.status(action === 'create' ? 201 : 200).json(result);
    } catch (error) {
      // Never include credentials, raw tokens, payloads, upstream bodies or stack traces.
      return res.status(error instanceof ShareCartError ? error.status : 503).json({ error: error instanceof ShareCartError ? error.code : 'SHARE_TEMPORARILY_UNAVAILABLE' });
    }
  };
}
module.exports = { createService, createHandler, createCatalog, configuration, hash, tokenHash, API_VERSION };
