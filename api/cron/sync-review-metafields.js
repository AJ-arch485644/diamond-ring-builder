// Syncs approved review aggregates from Supabase public.reviews into a
// `diyona.reviews_summary` JSON metafield on each reviewed Shopify product.
// The theme's snippets/schema-product.liquid reads that metafield to emit
// aggregateRating + review JSON-LD (rich result stars). Runs every 6h via
// vercel.json cron; safe to trigger manually — the sync is idempotent.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getShopifyToken() {
  const { data, error } = await supabase
    .from('shopify_tokens')
    .select('access_token')
    .eq('shop', process.env.SHOPIFY_STORE)
    .single();
  if (error || !data) throw new Error('No Shopify token found. Install the app first.');
  return data.access_token;
}

async function shopifyGraphql(token, query, variables) {
  const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select('product_id, author_name, rating, title, body, published_at')
      .eq('status', 'approved')
      .order('published_at', { ascending: false });
    if (error) throw new Error(error.message);

    // Group by product; keep the 5 most recent reviews per product for markup
    const byProduct = new Map();
    for (const r of reviews) {
      if (!r.product_id) continue;
      if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
      byProduct.get(r.product_id).push(r);
    }

    const metafields = [];
    for (const [productId, rows] of byProduct) {
      const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
      const summary = {
        rating: Math.round(avg * 10) / 10,
        count: rows.length,
        reviews: rows.slice(0, 5).map(r => ({
          author: r.author_name || 'Diyona Customer',
          rating: r.rating,
          title: r.title || '',
          body: (r.body || '').slice(0, 300),
          date: (r.published_at || '').slice(0, 10)
        }))
      };
      metafields.push({
        ownerId: `gid://shopify/Product/${productId}`,
        namespace: 'diyona',
        key: 'reviews_summary',
        type: 'json',
        value: JSON.stringify(summary)
      });
    }

    // metafieldsSet accepts max 25 per call
    const token = await getShopifyToken();
    const mutation = `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`;
    let written = 0;
    const userErrors = [];
    for (let i = 0; i < metafields.length; i += 25) {
      const batch = metafields.slice(i, i + 25);
      const data = await shopifyGraphql(token, mutation, { metafields: batch });
      written += (data.metafieldsSet.metafields || []).length;
      userErrors.push(...(data.metafieldsSet.userErrors || []));
    }

    return res.status(200).json({
      products: byProduct.size,
      reviewsTotal: reviews.length,
      metafieldsWritten: written,
      userErrors
    });
  } catch (err) {
    console.error('Review metafield sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
