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
    // 1. Get diamond from database
    const { data: diamond, error } = await supabase
      .from('diamonds')
      .select('*')
      .eq('sku', sku)
      .eq('availability', 'available')
      .single();

    if (error || !diamond) {
      return res.status(404).json({ error: 'Diamond not found or unavailable' });
    }

    // 2. Create product in Shopify
    const shopifyProduct = await createShopifyProduct(diamond, type);

    // 3. Return the Shopify product/variant IDs
    res.status(200).json({
      shopify_id: shopifyProduct.id,
      variant_id: shopifyProduct.variants[0].id,
      title: shopifyProduct.title
    });

  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
};

async function createShopifyProduct(diamond, type) {
  const shopifyUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/products.json`;

  const title = `${diamond.carat}ct ${diamond.shape} ${diamond.color} ${diamond.clarity} Lab Diamond`;

  const response = await fetch(shopifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({
      product: {
        title: title,
        product_type: type === 'Ring' ? 'Diamond' : type,
        vendor: 'Lab Diamond',
        tags: `lab-grown, ${diamond.shape}, ${diamond.color}, ${diamond.clarity}`,
        published: false,
        variants: [{
          price: diamond.price_usd.toString(),
          sku: diamond.sku,
          inventory_management: null,
          requires_shipping: true
        }],
        images: diamond.image_url ? [{ src: diamond.image_url }] : []
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify error: ${JSON.stringify(data)}`);
  }

  return data.product;
}
