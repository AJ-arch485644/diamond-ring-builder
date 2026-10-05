'use strict';

// This module has no catalog, inventory, cart or database write capability.
const CONTRACT = 'diyona-price-v1';
const API_VERSION = '2026-07';
const FIELDS = `id legacyResourceId sku price compareAtPrice
  product { id legacyResourceId title handle status onlineStoreUrl }
  contextualPricing(context: { country: $country }) {
    price { amount currencyCode } compareAtPrice { amount currencyCode }
  }`;
const BY_ID = `query StorefrontPrice($id: ID!, $country: CountryCode!) {
  shop { currencyCode } productVariant(id: $id) { ${FIELDS} }
}`;
const BY_SKU = `query StorefrontPrice($query: String!, $country: CountryCode!) {
  shop { currencyCode }
  productVariants(first: 50, query: $query) {
    nodes { ${FIELDS} } pageInfo { hasNextPage }
  }
}`;
function problem(code, status = 502) { const error = new Error(code); error.code = code; error.status = status; return error; }
function string(value) { return typeof value === 'string' ? value.trim() : null; }
function parseInput(query = {}) {
  const country = string(query.country);
  const currency = query.currency === undefined ? null : string(query.currency);
  const sku = query.sku === undefined ? null : string(query.sku);
  const rawId = query.variant_id === undefined ? null : string(query.variant_id);
  if (!country || !/^[A-Z]{2}$/.test(country) || (query.currency !== undefined && (!currency || !/^[A-Z]{3}$/.test(currency)))) throw problem('INVALID_CONTEXT', 400);
  if (query.sku !== undefined && (!sku || sku.length > 200 || /[\x00-\x1f\x7f]/.test(sku))) throw problem('INVALID_SKU', 400);
  if (query.variant_id !== undefined && (!rawId || !/^(?:gid:\/\/shopify\/ProductVariant\/)?\d+$/.test(rawId))) throw problem('INVALID_VARIANT', 400);
  const variantId = rawId ? rawId.replace('gid://shopify/ProductVariant/', '') : null;
  if (variantId && (!Number.isSafeInteger(Number(variantId)) || Number(variantId) <= 0)) throw problem('INVALID_VARIANT', 400);
  if (!sku && !variantId) throw problem('IDENTITY_REQUIRED', 400);
  return { country, currency, sku, variantId };
}
function money(value, expectedCurrency) {
  if (!value || typeof value.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.amount) || !Number.isFinite(Number(value.amount)) || Number(value.amount) <= 0 || !/^[A-Z]{3}$/.test(value.currencyCode || '') || (expectedCurrency && value.currencyCode !== expectedCurrency)) throw problem('INVALID_NATIVE_PRICE');
  return { amount: value.amount, currencyCode: value.currencyCode };
}
function readQuote(data, input, { now = () => new Date(), build = null, effectiveApiVersion = null } = {}) {
  if (!data || !/^[A-Z]{3}$/.test(data.shop?.currencyCode || '')) throw problem('INCOMPLETE_QUOTE');
  let variants;
  if (input.variantId) variants = data.productVariant ? [data.productVariant] : [];
  else {
    const connection = data.productVariants;
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw problem('INCOMPLETE_QUOTE');
    if (connection.pageInfo.hasNextPage) throw problem('AMBIGUOUS_IDENTITY', 409);
    variants = connection.nodes;
  }
  const matches = variants.filter(v => v && (!input.sku || v.sku === input.sku) && v.product?.status === 'ACTIVE' && v.product.onlineStoreUrl);
  if (!matches.length) throw problem('NATIVE_VARIANT_NOT_FOUND', 404);
  if (matches.length !== 1) throw problem('AMBIGUOUS_IDENTITY', 409);
  const variant = matches[0];
  const id = String(variant.legacyResourceId || '');
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || variant.id !== 'gid://shopify/ProductVariant/' + id || (input.variantId && input.variantId !== id)) throw problem('IDENTITY_MISMATCH', 409);
  const productId = String(variant.product.legacyResourceId || '');
  if (!/^\d+$/.test(productId) || !Number.isSafeInteger(Number(productId)) || variant.product.id !== 'gid://shopify/Product/' + productId) throw problem('INVALID_PRODUCT_IDENTITY');
  if (typeof variant.product.handle !== 'string' || !variant.product.handle) throw problem('INCOMPLETE_QUOTE');
  const price = money(variant.contextualPricing?.price);
  if (input.currency && price.currencyCode !== input.currency) throw problem('CURRENCY_CONTEXT_MISMATCH', 409);
  const compareAtPrice = variant.contextualPricing.compareAtPrice == null ? null : money(variant.contextualPricing.compareAtPrice, price.currencyCode);
  const basePrice = money({amount: variant.price, currencyCode: data.shop.currencyCode});
  return {
    contract: CONTRACT, kind: 'native_quote', sku: variant.sku, country: input.country,
    variant_id: Number(id), shopify_id: Number(productId), handle: variant.product.handle,
    price, compareAtPrice, basePrice, quotedAt: now().toISOString(), priceLocked: false,
    // Native cart/checkout still determine inventory, market availability, discounts and payable totals.
    availabilityConfirmed: false, build, effectiveApiVersion
  };
}
function headers(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Diyona-Price-Contract', CONTRACT);
}
async function defaultTokenProvider(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw problem('QUOTE_CONFIGURATION_UNAVAILABLE', 503);
  const { createClient } = require('@supabase/supabase-js');
  const { getShopifyToken } = require('./ai-catalog-io');
  return getShopifyToken(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY), env.SHOPIFY_STORE);
}
function createHandler({ env = process.env, fetchImpl = globalThis.fetch, tokenProvider = defaultTokenProvider, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    headers(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); return res.status(405).json({contract:CONTRACT,error:'METHOD_NOT_ALLOWED'}); }
    try {
      const input = parseInput(req.query);
      const shop = env.SHOPIFY_STORE;
      if (typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw problem('QUOTE_CONFIGURATION_UNAVAILABLE', 503);
      const token = await tokenProvider(env);
      if (typeof token !== 'string' || !token) throw problem('QUOTE_CONFIGURATION_UNAVAILABLE', 503);
      const query = input.variantId ? BY_ID : BY_SKU;
      const variables = input.variantId ? {id:'gid://shopify/ProductVariant/'+input.variantId,country:input.country} : {query:'sku:"'+input.sku.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"',country:input.country};
      const response = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
        body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000)
      });
      if (!response.ok) throw problem(response.status === 429 ? 'QUOTE_TEMPORARILY_UNAVAILABLE' : 'QUOTE_UPSTREAM_FAILED', 503);
      const body = await response.json();
      if (body.errors?.length || !body.data) throw problem('QUOTE_UPSTREAM_FAILED', 503);
      const effectiveApiVersion = response.headers?.get('x-shopify-api-version') || null;
      return res.status(200).json(readQuote(body.data,input,{now,build:env.VERCEL_GIT_COMMIT_SHA || null,effectiveApiVersion}));
    } catch (error) {
      // No credentials, upstream bodies or stack traces in a public response.
      return res.status(error.status || 503).json({contract:CONTRACT,error:error.code || 'QUOTE_TEMPORARILY_UNAVAILABLE'});
    }
  };
}
module.exports={CONTRACT,API_VERSION,parseInput,readQuote,createHandler};
