#!/usr/bin/env node
'use strict';

// Deliberate private configuration step; never invoked by a scheduled job.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function verifyProfileReadback(actual, proposed) {
  // Review flags and future private configuration must survive installation too.
  if (!isDeepStrictEqual(actual, proposed)) throw new Error('PROFILE_INSTALL_READBACK_FAILED');
}

async function main() {
  if (process.argv.length !== 3 || process.env.AI_CATALOG_INSTALL_PROFILES !== 'true') throw new Error('PROFILE_INSTALL_NOT_ENABLED');
  const file = process.argv[2];
  if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('PROFILE_BUNDLE_TOO_LARGE');
  const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { createClient } = require('@supabase/supabase-js');
  const { createPrivateStore } = require('../lib/ai-catalog-io');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) },
  });
  const store = createPrivateStore(supabase, { shop: process.env.SHOPIFY_STORE, owner: randomUUID() });
  await store.acquireLease();
  try {
    let previous;
    try { previous = await store.getProfileBundle(); }
    catch (error) { if (error.code !== 'STORE_PROFILES_MISSING') throw error; previous = null; }
    await store.appendAudit({ event: 'profile_bundle_install', at: new Date().toISOString(), previous, proposed: profiles });
    await store.renewLease();
    await store.installProfileBundle(profiles);
    const actual = await store.getProfileBundle();
    verifyProfileReadback(actual, profiles);
    console.log(JSON.stringify({ installedProfiles: Object.keys(profiles).length }));
  } finally { await store.releaseLease(); }
}

if (require.main === module) main().catch(() => {
  console.error('AI_CATALOG_PROFILE_INSTALL_FAILED: private configuration was not verified.');
  process.exitCode = 1;
});
module.exports = { main, verifyProfileReadback };
