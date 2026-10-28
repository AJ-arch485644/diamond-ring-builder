'use strict';
const { resolveOwnedDiamond, problem } = require('../lib/owned-diamond-cart');
const { diamondTitle } = require('../lib/diamond-title');
const { setOwnedInventoryHSCode } = require('../lib/owned-shopify');

let cachedToken = null;
let tokenExpiry = 0;

async function getShopifyToken(supabase, shop) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const { data } = await supabase
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', shop)
    .single();
  if (!data) throw new Error('No Shopify token found. Install the app first.');
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 3600000; // cache for 1 hour
  return cachedToken;
}

// Dedup: find an existing ACTIVE product variant for this diamond SKU so we reuse it
// instead of minting a duplicate product on every call (the root cause of the 21% duplicate pile-up).
async function findExistingVariantBySku(supabase, shop, sku) {
  const token = await getShopifyToken(supabase, shop);
  const query = `query($q:String!){ productVariants(first:50, query:$q){ edges { node { sku legacyResourceId inventoryItem { legacyResourceId } product { legacyResourceId title status } } } } }`;
  const r = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { q: 'sku:' + JSON.stringify(sku) } })
  });
  const j = await r.json();
  if (!r.ok || j.errors?.length || !Array.isArray(j.data?.productVariants?.edges)) throw problem('COMMERCE_TEMPORARILY_UNAVAILABLE', 503);
  const matches = j.data.productVariants.edges.map(edge => edge.node).filter(node => node.sku === sku && node.product?.status === 'ACTIVE');
  if (matches.length > 1 || j.data.productVariants.edges.length === 50) throw problem('SUPPLIER_IDENTITY_AMBIGUOUS');
  if (!matches.length) return null;
  const n = matches[0];
  return { variant_id: Number(n.legacyResourceId), shopify_id: Number(n.product.legacyResourceId), title: n.product.title, inventory_item_id: n.inventoryItem ? Number(n.inventoryItem.legacyResourceId) : null };
}

function defaultClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}
function createHandler({ getClient = defaultClient, resolveOwned = resolveOwnedDiamond,
  findSupplierVariant = findExistingVariantBySku, createSupplier = createShopifyProduct,
  setShipping = setVariantMetafield, setHS = setInventoryHSCode, setOwnedHS = setOwnedInventoryHSCode, env = process.env } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Legacy theme callers use GET. Keep that contract while ensuring a stock
    // resolution or supplier creation can never be replayed from a CDN cache.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    const sku = req.query?.sku ?? req.body?.sku;
    const type = req.query?.type ?? req.body?.type ?? 'Ring';
    if (typeof sku !== 'string' || !sku.trim() || sku !== sku.trim() || sku.length > 150 || /[\x00-\x1f\x7f]/.test(sku)) return res.status(400).json({error:'INVALID_SKU'});
    if (!['Ring','Loose'].includes(type)) return res.status(400).json({error:'INVALID_PURCHASE_TYPE'});
    const hsCode = type === 'Loose' ? '7104.91' : '7113.19';
    try {
      const supabase = getClient();
      const shop = env.SHOPIFY_STORE;
      if (typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw problem('COMMERCE_TEMPORARILY_UNAVAILABLE',503);
      const owned = await resolveOwned({supabase,sku,shop});
      if (owned) {
        // Product, price, dispatch and inventory already exist. Keep the legacy
        // purchase-intent customs classification without creating or restocking.
        await setOwnedHS(owned.inventory_item_id,hsCode);
        const { inventory_item_id, ...publicResult } = owned;
        return res.status(200).json(publicResult);
      }
      // Supplier aliases suppressed by an owned certificate are absent from the
      // unified view and must not be created through the raw feed table either.
      const { data: rows, error } = await supabase.from('public_diamonds')
        .select('*').eq('sku',sku).eq('inventory_source','supplier').limit(2);
      if (error || !Array.isArray(rows)) throw problem('CATALOG_TEMPORARILY_UNAVAILABLE',503);
      if (rows.length !== 1) throw problem(rows.length ? 'SUPPLIER_IDENTITY_AMBIGUOUS' : 'DIAMOND_UNAVAILABLE',rows.length ? 409 : 404);
      const diamond = rows[0];
      if (diamond.sku !== sku || diamond.inventory_source !== 'supplier' || !Number.isFinite(Number(diamond.price_usd)) || Number(diamond.price_usd) <= 0) throw problem('DIAMOND_UNAVAILABLE',404);
      const existing = await findSupplierVariant(supabase,shop,diamond.sku);
      if (existing) {
        await setShipping(existing.variant_id,diamond.max_delivery_days || 10);
        await setHS(existing.inventory_item_id,hsCode);
        return res.status(200).json({shopify_id:existing.shopify_id,variant_id:existing.variant_id,title:existing.title,reused:true,inventory_source:'supplier',is_diyona_select:false});
      }
      const product = await createSupplier(diamond,type);
      const variant = product.variants[0];
      await setShipping(variant.id,diamond.max_delivery_days || 10);
      await setHS(variant.inventory_item_id,hsCode);
      return res.status(200).json({shopify_id:product.id,variant_id:variant.id,title:product.title,inventory_source:'supplier',is_diyona_select:false});
    } catch (error) {
      // Shopify bodies, access tokens, database details and stack traces remain private.
      return res.status(error.status || 503).json({error:error.code || 'COMMERCE_TEMPORARILY_UNAVAILABLE'});
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;

async function createShopifyProduct(diamond, type) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const shop = process.env.SHOPIFY_STORE;
  const { data: tokenRow } = await supabase
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', shop)
    .single();
  if (!tokenRow) throw new Error('No Shopify token found. Install the app first.');
  const shopifyUrl = `https://${shop}/admin/api/2024-01/products.json`;
  const title = diamondTitle(diamond);
  const response = await fetch(shopifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenRow.access_token
    },
    body: JSON.stringify({
      product: {
        title: title,
        product_type: type === 'Ring' ? 'Diamond' : type,
        vendor: 'Lab Diamond',
        tags: `lab-grown, ${diamond.shape}, ${diamond.color}, ${diamond.clarity}`,
        published: true,
        template_suffix: 'diamond',
        variants: [{
          price: diamond.price_usd.toString(),
          compare_at_price: Number(diamond.price_usd) > 0
            ? (Number(diamond.price_usd) * 2).toFixed(2)
            : null,
          sku: diamond.sku,
          inventory_management: 'shopify',
          inventory_quantity: 1,
          requires_shipping: true
        }],
        images: diamond.image_url ? [{ src: diamond.image_url }] : []
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Shopify error: ${JSON.stringify(data)}`);
  return data.product;
}

async function setInventoryHSCode(inventoryItemId, hsCode) {
  if (!inventoryItemId || !hsCode) return;
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const shop = process.env.SHOPIFY_STORE;
  const { data: tokenRow } = await supabase
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', shop)
    .single();
  if (!tokenRow) return;

  const url = `https://${shop}/admin/api/2024-01/inventory_items/${inventoryItemId}.json`;
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenRow.access_token
    },
    body: JSON.stringify({
      inventory_item: {
        id: inventoryItemId,
        harmonized_system_code: hsCode,
        country_code_of_origin: 'IN'
      }
    })
  });
}

async function setVariantMetafield(variantId, shippingDays) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const shop = process.env.SHOPIFY_STORE;
  const { data: tokenRow } = await supabase
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', shop)
    .single();
  if (!tokenRow) return;

  const url = `https://${shop}/admin/api/2024-01/variants/${variantId}/metafields.json`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenRow.access_token
    },
    body: JSON.stringify({
      metafield: {
        namespace: 'custom',
        key: 'shipping_days',
        value: shippingDays.toString(),
        type: 'number_integer'
      }
    })
  });
}
