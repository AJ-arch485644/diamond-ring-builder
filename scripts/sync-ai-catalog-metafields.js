#!/usr/bin/env node
'use strict';

// This entry point is a background job only. No storefront route imports it.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function options(args, env = process.env, now = Date.now) {
  if (args.includes('--approved-canary')) {
    return require('../lib/ai-catalog-canary').approvedCanaryOptions(args, env, now);
  }
  const values = {};
  const allowed = new Set(['mode', 'max-writes', 'max-products', 'max-duration-seconds', 'product-ids']);
  let write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') { write = true; continue; }
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('INVALID_ARGUMENT');
    }
    if (Object.hasOwn(values, key)) throw new Error('DUPLICATE_ARGUMENT');
    values[key] = args[++i];
  }
  const mode = values.mode || 'incremental';
  if (!['incremental', 'full'].includes(mode)) throw new Error('INVALID_MODE');
  const integer = (input, fallback, limit) => {
    if (input === undefined) return fallback;
    if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > limit) throw new Error('INVALID_LIMIT');
    return Number(input);
  };
  const maxWrites = integer(values['max-writes'], 5, 500);
  const maxProducts = integer(values['max-products'], 250, 25000);
  const maxDurationMs = integer(values['max-duration-seconds'], 1200, 7200) * 1000;
  const productIds = values['product-ids']?.split(',').filter(Boolean).map(id => {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('INVALID_PRODUCT_ID');
    return `gid://shopify/Product/${id}`;
  });
  if (values['product-ids'] !== undefined && (!productIds.length || productIds.length > 10 || new Set(productIds).size !== productIds.length)) throw new Error('INVALID_PRODUCT_IDS');
  if (write && env.AI_CATALOG_WRITES_ENABLED !== 'true') throw new Error('WRITES_DISABLED');
  return { mode, write, maxWrites, maxProducts, maxDurationMs, ...(productIds ? { productIds } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  const opts = options(args);
  const { createClient } = require('@supabase/supabase-js');
  const { createShopifyClient, createPrivateStore } = require('../lib/ai-catalog-io');
  const { syncCatalog } = require('../lib/ai-catalog-sync');
  const shop = process.env.SHOPIFY_STORE;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || '')) throw new Error('INVALID_SHOP_DOMAIN');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('MISSING_PRIVATE_RUNTIME_CREDENTIALS');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) },
  });
  let store = createPrivateStore(supabase, { shop, owner: randomUUID() });
  const profiles = await store.getProfileBundle();
  if (!profiles || !Object.keys(profiles).length) throw new Error('REVIEWED_PROFILES_NOT_INSTALLED');
  const token = await store.getShopifyToken(shop);
  let shopify = createShopifyClient({ shop, token });
  if (args.includes('--approved-canary')) {
    ({ shopify, store } = require('../lib/ai-catalog-canary').scopeApprovedCanary({ shopify, store }));
  }
  const summary = await syncCatalog({ ...opts, shopify, store, profiles, getSupplier: sku => store.getSupplier(sku) });
  // Counts/status only: this repository and its Actions logs are public.
  const output = JSON.stringify(summary);
  process.stdout.write(output + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `AI Catalog updater aggregate result\n\n\`\`\`json\n${output}\n\`\`\`\n`);
  if (args.includes('--approved-canary')) require('../lib/ai-catalog-canary').assertApprovedCanaryResult(summary);
  if (summary.failed || summary.errors?.length || summary.sourceRaces) process.exitCode = 1;
}

if (require.main === module) main().catch(() => {
  // Never print GraphQL bodies, supplier rows, token errors, or private source.
  console.error('AI_CATALOG_RUN_FAILED: inspect private audit records; no automatic retry of an ambiguous write.');
  process.exitCode = 1;
});
module.exports = { options, main };
