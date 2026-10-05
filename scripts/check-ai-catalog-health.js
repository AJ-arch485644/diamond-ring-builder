#!/usr/bin/env node
'use strict';

const { evaluateCatalogHealth } = require('../lib/ai-catalog-health');

async function main() {
  const scheduled = process.env.AI_CATALOG_SCHEDULE_ENABLED === 'true';
  const writes = process.env.AI_CATALOG_WRITES_ENABLED === 'true';
  if (scheduled && !writes) {
    const health = { ok: false, status: 'unhealthy', enabled: false, issues: ['SCHEDULE_ENABLED_WITH_WRITES_DISABLED'] };
    process.stdout.write(JSON.stringify(health) + '\n');
    process.exitCode = 1;
    return health;
  }
  const enabled = scheduled && writes;
  let state = {};
  if (enabled) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('MISSING_PRIVATE_RUNTIME_CREDENTIALS');
    const { createClient } = require('@supabase/supabase-js');
    const { createPrivateStore } = require('../lib/ai-catalog-io');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) },
    });
    // No lease, token read, audit/state writes, Shopify requests, or raw state output.
    state = await createPrivateStore(supabase, { shop: process.env.SHOPIFY_STORE }).loadState();
  }
  const health = evaluateCatalogHealth(state, { enabled });
  process.stdout.write(JSON.stringify(health) + '\n');
  if (enabled && !health.ok) process.exitCode = 1;
  return health;
}

if (require.main === module) main().catch(() => {
  console.error('AI_CATALOG_HEALTH_CHECK_FAILED: health could not be verified; inspect private runtime access.');
  process.exitCode = 1;
});
module.exports = { main };
