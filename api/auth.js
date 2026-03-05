module.exports = async function handler(req, res) {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).send('Missing ?shop=yourstore.myshopify.com');
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const redirectUri = `${process.env.APP_URL}/api/auth/callback`;
  const scopes = 'write_products,read_products';
  const nonce = Math.random().toString(36).substring(2, 15);

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${clientId}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.redirect(authUrl);
};