module.exports = async function handler(req, res) {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Missing shop or code');
  }

  try {
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code: code
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Failed to get token', detail: tokenData });
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    await supabase
      .from('shopify_tokens')
      .upsert({
        shop: shop,
        access_token: tokenData.access_token,
        scope: tokenData.scope,
        updated_at: new Date().toISOString()
      }, { onConflict: 'shop' });

    res.status(200).send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Ring Builder installed successfully!</h2>
          <p>Access token saved for ${shop}</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: 'OAuth failed', detail: err.message });
  }
};