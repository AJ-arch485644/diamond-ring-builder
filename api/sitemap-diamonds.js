const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT sku, shape, carat, color, clarity, lab, certificate_number, updated_at
       FROM diamonds
       WHERE availability = 'available' AND is_lab_grown = true
       ORDER BY price_usd DESC
       LIMIT 50000`
    );

    const urls = rows.map(row => {
      const lastmod = row.updated_at
        ? new Date(row.updated_at).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      // Build descriptive slug: 2.11ct-emerald-f-si1-igi-LG622472504-AFABAD71E
      const slug = [
        row.carat + 'ct',
        (row.shape || '').toLowerCase(),
        (row.color || '').toLowerCase(),
        (row.clarity || '').toLowerCase(),
        (row.lab || '').toLowerCase(),
        row.certificate_number || '',
        row.sku
      ].filter(Boolean).join('-').replace(/[^a-z0-9.-]/gi, '-').replace(/-+/g, '-');
      return `  <url>
    <loc>https://diyona.com/a/lab-diamonds/${esc(slug)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).send(xml);

  } catch (err) {
    console.error('Sitemap error:', err.message);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`);
  }
};
