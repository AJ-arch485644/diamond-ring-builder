'use strict';

// One reviewed, expiring exception for four exact products. This never enables
// the ordinary updater's write/schedule switches or accepts caller-selected IDs.
const PRODUCT_IDS = Object.freeze([
  'gid://shopify/Product/9901307396412',
  'gid://shopify/Product/9979207221564',
  'gid://shopify/Product/15402163142972',
  'gid://shopify/Product/15402165829948',
]);
const REPOSITORY = 'AJ-arch485644/diamond-ring-builder';
const SHOP = '060481-3.myshopify.com';
const SUPABASE_ORIGIN = 'https://ofjwrrqzzbcnmkkmlawl.supabase.co';
const EXPIRES_AT = '2026-10-03T00:00:00.000Z';
const RECEIPT_ID = 'approved-four-product-canary-2026-10-02-v1';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/ai-catalog-canary.yml@refs/heads/main`;
const FIELDS = Object.freeze({ ai_catalog_description: 'multi_line_text_field', ai_catalog_category: 'single_line_text_field' });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertContext(env, now) {
  const instant = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(instant.getTime()) || instant.getTime() >= Date.parse(EXPIRES_AT)) fail('CANARY_EXPIRED');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') ||
      env.GITHUB_RUN_ATTEMPT !== '1') fail('CANARY_WRONG_CONTEXT');
  for (const key of ['AI_CATALOG_WRITES_ENABLED', 'AI_CATALOG_SCHEDULE_ENABLED']) {
    if (env[key] !== undefined && env[key] !== '' && env[key] !== 'false') fail('CANARY_BROAD_GATE_ENABLED');
  }
  if (env.SHOPIFY_STORE !== SHOP) fail('CANARY_WRONG_STORE');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch (_) { fail('CANARY_WRONG_DATABASE'); }
  if (url.origin !== SUPABASE_ORIGIN || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) fail('CANARY_WRONG_DATABASE');
  return instant;
}

function approvedCanaryOptions(args, env = process.env, now = Date.now) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== '--approved-canary') fail('CANARY_ARGUMENTS_DENIED');
  assertContext(env, now);
  return Object.freeze({ mode: 'full', write: true, maxWrites: 4, maxProducts: 4,
    maxDurationMs: 10 * 60 * 1000, productIds: PRODUCT_IDS });
}

function assertApprovedCanaryResult(summary) {
  if (!object(summary) || summary.mode !== 'canary' || summary.dryRun !== false ||
      summary.activated !== false || summary.status !== 'completed' || summary.complete !== true ||
      summary.failed !== false || summary.examined !== 4 || summary.written !== 4 ||
      summary.verifiedWrites !== 4 || summary.blocked !== 0 || summary.skipped !== 0 ||
      summary.noops !== 0 || summary.sourceRaces !== 0 || summary.checkpointAdvanced !== false ||
      !Array.isArray(summary.errors) || summary.errors.length) fail('CANARY_RESULT_INCOMPLETE');
  return true;
}

function scopeApprovedCanary({ shopify, store, env = process.env, now = Date.now } = {}) {
  assertContext(env, now);
  if (!shopify || typeof shopify.readProduct !== 'function' || typeof shopify.setMetafields !== 'function' ||
      !store || ['acquireLease', 'releaseLease', 'renewLease', 'appendAudit'].some(key => typeof store[key] !== 'function')) fail('CANARY_INVALID_ADAPTER');
  const permitted = new Set(PRODUCT_IDS);
  const attempted = new Set();
  let claimed = false;
  let leaseHeld = false;
  let acquiring = false;
  const assertProduct = id => { if (!permitted.has(id)) fail('CANARY_PRODUCT_DENIED'); };
  const guardedShopify = Object.freeze({
    async listProducts() { fail('CANARY_LISTING_DENIED'); },
    async readProduct(id) {
      assertContext(env, now); assertProduct(id);
      const product = await shopify.readProduct(id);
      if (product && product.id !== id) fail('CANARY_PRODUCT_MISMATCH');
      return product;
    },
    async setMetafields(fields) {
      assertContext(env, now);
      if (!claimed || !leaseHeld) fail('CANARY_RECEIPT_REQUIRED');
      if (!Array.isArray(fields) || fields.length !== 2) fail('CANARY_FIELDS_DENIED');
      const owner = fields[0]?.ownerId; assertProduct(owner);
      const keys = new Set();
      for (const field of fields) {
        if (!object(field) || Object.keys(field).some(key => !['ownerId', 'namespace', 'key', 'type', 'value', 'compareDigest'].includes(key)) ||
            field.ownerId !== owner || field.namespace !== 'custom' || !Object.hasOwn(FIELDS, field.key) ||
            field.type !== FIELDS[field.key] || keys.has(field.key) || typeof field.value !== 'string' || !field.value.trim() ||
            !Object.hasOwn(field, 'compareDigest') || (field.compareDigest !== null && !/^[a-f0-9]{64}$/.test(field.compareDigest || '')) ||
            (field.key === 'ai_catalog_category' && /[\r\n]/.test(field.value))) fail('CANARY_FIELDS_DENIED');
        keys.add(field.key);
      }
      if (attempted.size >= 4 || attempted.has(owner)) fail('CANARY_WRITE_LIMIT');
      // Count attempts before the network call, including ambiguous failures.
      attempted.add(owner);
      return shopify.setMetafields(fields);
    },
  });
  const guardedStore = Object.freeze({
    ...store,
    async acquireLease() {
      assertContext(env, now);
      if (acquiring || leaseHeld || claimed) fail('CANARY_REPLAY_DENIED');
      acquiring = true;
      try {
        await store.acquireLease(); leaseHeld = true;
        // appendAudit uses the existing insert-only RPC under this same lease.
        // A deterministic ID makes the authorization one-shot across all runs.
        const receipt = await store.appendAudit(RECEIPT_ID, { type: 'approved_canary_claim',
          scope: RECEIPT_ID, at: assertContext(env, now).toISOString(), expiresAt: EXPIRES_AT,
          repository: REPOSITORY, shop: SHOP, productIds: [...PRODUCT_IDS],
          maxWriteAttempts: 4, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
        if (receipt !== RECEIPT_ID) fail('CANARY_RECEIPT_UNCONFIRMED');
        claimed = true;
        return true;
      } catch (err) {
        // syncCatalog sets its leased flag only after this function resolves.
        // Clean up here if the receipt insert fails (including a replay).
        if (leaseHeld) {
          leaseHeld = false;
          try { await store.releaseLease(); } catch (_) { fail('CANARY_RECEIPT_RELEASE_FAILED'); }
        }
        throw err;
      } finally { acquiring = false; }
    },
    async renewLease() {
      assertContext(env, now);
      if (!claimed || !leaseHeld) fail('CANARY_RECEIPT_REQUIRED');
      return store.renewLease();
    },
    async releaseLease() {
      // Always permit cleanup, including after expiry or a context failure.
      if (!leaseHeld) fail('CANARY_LEASE_NOT_HELD');
      leaseHeld = false;
      return store.releaseLease();
    },
  });
  return Object.freeze({ shopify: guardedShopify, store: guardedStore });
}

module.exports = { PRODUCT_IDS, REPOSITORY, SHOP, SUPABASE_ORIGIN, EXPIRES_AT, RECEIPT_ID,
  approvedCanaryOptions, assertApprovedCanaryResult, scopeApprovedCanary };
