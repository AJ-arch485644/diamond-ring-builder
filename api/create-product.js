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
  const query = `query($q:String!){ productVariants(first:1, query:$q){ edges { node { legacyResourceId product { legacyResourceId title status } } } } }`;
  const r = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { q: 'sku:' + sku } })
  });
  const j = await r.json();
  const edge = j && j.data && j.data.productVariants && j.data.productVariants.edges && j.data.productVariants.edges[0];
  if (!edge) return null;
  const n = edge.node;
  if (n.product && n.product.status && n.product.status !== 'ACTIVE') return null; // skip archived/draft leftovers
  return { variant_id: Number(n.legacyResourceId), shopify_id: Number(n.product.legacyResourceId), title: n.product.title };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const sku = req.query.sku || req.body?.sku;
  const type = req.query.type || req.body?.type || 'Ring';
  if (!sku) return res.status(400).json({ error: 'SKU required' });
  try {
    const { data: diamond, error } = await supabase
      .from('diamonds')
      .select('*')
      .eq('sku', sku)
      .eq('availability', 'available')
      .single();
    if (error || !diamond) {
      return res.status(404).json({ error: 'Diamond not found or unavailable' });
    }

    // Idempotent by SKU: reuse an existing product if one was already created for this diamond.
    // Prevents duplicate products from repeat add-to-cart, reloads during the pending window, or retries.
    const shop = process.env.SHOPIFY_STORE;
    const existing = await findExistingVariantBySku(supabase, shop, diamond.sku);
    if (existing) {
      await setVariantMetafield(existing.variant_id, diamond.max_delivery_days || 10);
      return res.status(200).json({ shopify_id: existing.shopify_id, variant_id: existing.variant_id, title: existing.title, reused: true });
    }

    const shopifyProduct = await createShopifyProduct(diamond, type);
    const variantId = shopifyProduct.variants[0].id;

    // Use the diamond's actual fulfillment time for both Loose and Ring flows.
    // Cart's MAX across line items ensures the slower of diamond/setting drives the date.
    // Fallback 10 matches the setting default + diamond PDP fallback, so null-data diamonds promise consistently across surfaces.
    const shippingDays = diamond.max_delivery_days || 10;
    await setVariantMetafield(variantId, shippingDays);

    res.status(200).json({
      shopify_id: shopifyProduct.id,
      variant_id: variantId,
      title: shopifyProduct.title
    });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product', detail: err.message });
  }
};

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
  const title = `${diamond.carat}ct ${diamond.shape} ${diamond.color} ${diamond.clarity} Lab Diamond`;
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