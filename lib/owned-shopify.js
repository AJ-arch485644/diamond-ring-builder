'use strict';

// Owned inventory uses its own server-only app credentials. Supplier OAuth and
// shopify_tokens are deliberately independent and never used as a fallback.
const SHOP = '060481-3.myshopify.com';
const API_VERSION = '2026-10';
function unavailable() { const error = new Error('OWNED_COMMERCE_UNAVAILABLE'); error.code = error.message; error.status = 503; return error; }
function createOwnedShopifyClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached = null, pending = null, clientId = null, clientSecret = null;
  function configure() {
    const id = env.OWNED_SHOPIFY_CLIENT_ID, secret = env.OWNED_SHOPIFY_CLIENT_SECRET;
    if (typeof id !== 'string' || !id.trim() || typeof secret !== 'string' || !secret.trim()) throw unavailable();
    if (id !== clientId || secret !== clientSecret) { clientId = id; clientSecret = secret; cached = null; pending = null; }
  }
  async function token(rejectedToken) {
    configure();
    if (rejectedToken && cached?.value === rejectedToken) cached = null;
    if (cached && now() < cached.expiresAt) return cached.value;
    if (!pending) {
      const id = clientId, secret = clientSecret;
      const refresh = (async () => {
        try {
          const response = await fetchImpl(`https://${SHOP}/admin/oauth/access_token`, {
            method:'POST', redirect:'error', headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret}),
            signal:AbortSignal.timeout(12000)
          });
          if (!response.ok) throw unavailable();
          const data = await response.json();
          const lifetime = Number(data.expires_in);
          if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86400 * 7) throw unavailable();
          if (id !== clientId || secret !== clientSecret) throw unavailable();
          cached = {value:data.access_token,expiresAt:now() + Math.max(0, lifetime * 1000 - Math.min(60000, lifetime * 100))};
          return cached.value;
        } catch (_) { throw unavailable(); }
      })();
      pending = refresh;
      refresh.finally(() => { if (pending === refresh) pending = null; }).catch(() => {});
    }
    return pending;
  }
  async function graphql(query, variables) {
    try {
      let credential = await token();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
          method:'POST', redirect:'error', headers:{'Content-Type':'application/json','X-Shopify-Access-Token':credential},
          body:JSON.stringify({query,variables}), signal:AbortSignal.timeout(12000)
        });
        if (response.status === 401 && attempt === 0) { credential = await token(credential); continue; }
        if (!response.ok) throw unavailable();
        const result = await response.json();
        if (result.errors?.length || !result.data || typeof result.data !== 'object') throw unavailable();
        return result.data;
      }
      throw unavailable();
    } catch (_) { throw unavailable(); }
  }
  return {graphql};
}
const ownedShopify = createOwnedShopifyClient();
async function setOwnedInventoryHSCode(inventoryItemId, hsCode, client = ownedShopify) {
  const id = String(inventoryItemId ?? '');
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || !['7104.91','7113.19'].includes(hsCode)) throw unavailable();
  const result = await client.graphql(`mutation OwnedInventoryClassification($id:ID!,$input:InventoryItemInput!){
    inventoryItemUpdate(id:$id,input:$input){inventoryItem{id} userErrors{field message}}
  }`,{id:`gid://shopify/InventoryItem/${id}`,input:{harmonizedSystemCode:hsCode.replace('.',''),countryCodeOfOrigin:'IN'}});
  const update = result.inventoryItemUpdate;
  if (!update || !Array.isArray(update.userErrors) || update.userErrors.length || update.inventoryItem?.id !== `gid://shopify/InventoryItem/${id}`) throw unavailable();
}
module.exports = {createOwnedShopifyClient,ownedShopify,setOwnedInventoryHSCode,SHOP,API_VERSION};
