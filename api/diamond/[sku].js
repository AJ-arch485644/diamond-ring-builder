// Data access via Supabase REST (service key) — the raw-Postgres DATABASE_URL
// credential went stale and was 500ing every SEO page and sub-sitemap.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// PostgREST caps rows per request (project max-rows setting, ~10k), so large
// reads must page in chunks.
async function fetchChunked(columns, orderCol, ascending, limit, offset) {
  const CHUNK = 10000;
  let rows = [];
  let pos = offset;
  while (rows.length < limit) {
    const want = Math.min(CHUNK, limit - rows.length);
    const { data, error } = await supabase
      .from('diamonds')
      .select(columns)
      .eq('availability', 'available')
      .eq('is_lab_grown', true)
      .order(orderCol, { ascending })
      .range(pos, pos + want - 1);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
    if (!data || data.length < want) break;
    pos += want;
  }
  return rows;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPrice(price) {
  if (!price) return 'Contact for Price';
  return '$' + Number(price).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function buildSlug(d) {
  // e.g. "2.11ct-emerald-f-si1-igi-LG622472504-AFABAD71E"
  return [
    d.carat + 'ct',
    (d.shape || '').toLowerCase(),
    (d.color || '').toLowerCase(),
    (d.clarity || '').toLowerCase(),
    (d.lab || '').toLowerCase(),
    d.certificate_number || '',
    d.sku
  ].filter(Boolean).join('-').replace(/[^a-z0-9.-]/gi, '-').replace(/-+/g, '-');
}

function buildPage(d) {
  const slug = buildSlug(d);
  // Fancy shapes come from Nivoda with no cut grade (literal '-') — don't let
  // that leak into copy as "- cut" or into structured data
  const cut = (d.cut && String(d.cut).trim() && d.cut !== '-') ? d.cut : null;
  const title = `${d.carat}ct ${d.shape} ${d.color} ${d.clarity} Lab Diamond | ${d.lab} ${d.certificate_number} | Diyona`;
  const desc = `Shop this ${d.carat} carat ${d.shape} cut lab-grown diamond. ${d.color} color, ${d.clarity} clarity${cut ? `, ${cut} cut` : ''}. ${d.lab} certified #${d.certificate_number}. Free shipping, 30-day returns.`;
  const canonical = `https://diyona.com/a/lab-diamonds/${slug}`;
  const image = d.image_url || 'https://diyona.com/cdn/shop/files/diyona-logo.png';
  const ringBuilderUrl = `https://diyona.com/pages/diamond-detail?sku=${encodeURIComponent(d.sku)}&ring_builder=true`;
  const looseUrl = `https://diyona.com/pages/diamond-detail?sku=${encodeURIComponent(d.sku)}`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    "name": `${d.carat}ct ${d.shape} Lab-Grown Diamond`,
    "description": desc,
    "sku": d.sku,
    "brand": { "@type": "Brand", "name": "Diyona" },
    "category": "Lab-Grown Diamonds",
    "image": image,
    "offers": {
      "@type": "Offer",
      "price": d.price_usd || 0,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": canonical,
      "seller": { "@type": "Organization", "name": "Diyona" }
    },
    "additionalProperty": [
      { "@type": "PropertyValue", "name": "Certificate Number", "value": d.certificate_number || '' },
      { "@type": "PropertyValue", "name": "Certification Lab", "value": d.lab || '' },
      { "@type": "PropertyValue", "name": "Shape", "value": d.shape || '' },
      { "@type": "PropertyValue", "name": "Color Grade", "value": d.color || '' },
      { "@type": "PropertyValue", "name": "Clarity Grade", "value": d.clarity || '' },
      { "@type": "PropertyValue", "name": "Cut Grade", "value": cut || '' }
    ].filter(p => p.value)
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="product">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:price:amount" content="${d.price_usd || 0}">
  <meta property="og:price:currency" content="USD">
  <meta name="robots" content="index, follow">
  <link rel="icon" type="image/png" href="https://diyona.com/cdn/shop/files/FAVICON_DIYONA_32x32.png">
  <script type="application/ld+json">${jsonLd}</script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1a1a1a;
      background: #fafaf8;
      line-height: 1.6;
    }
    a { color: inherit; text-decoration: none; }

    /* Header */
    .header {
      background: #001f1a;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .header img { height: 36px; }
    .header-logo-text {
      color: #fff;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: 2px;
      font-family: Georgia, 'Times New Roman', serif;
    }

    /* Hero */
    .hero {
      background: linear-gradient(135deg, #001f1a 0%, #003d33 100%);
      color: #fff;
      padding: 48px 24px 40px;
      text-align: center;
    }
    .hero h1 {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: clamp(1.75rem, 4vw, 2.5rem);
      font-weight: 400;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .hero .cert {
      font-size: 0.95rem;
      opacity: 0.8;
      margin-bottom: 20px;
    }
    .hero .price {
      font-size: clamp(2rem, 5vw, 2.75rem);
      font-weight: 700;
      color: #c9a94e;
    }

    /* Container */
    .container { max-width: 960px; margin: 0 auto; padding: 0 24px; }

    /* Specs Grid */
    .specs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
      padding: 32px 24px;
      max-width: 960px;
      margin: 0 auto;
    }
    .spec-card {
      background: #fff;
      border: 1px solid #e8e5e0;
      border-radius: 10px;
      padding: 20px 16px;
      text-align: center;
    }
    .spec-card .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #6b6b6b;
      margin-bottom: 6px;
    }
    .spec-card .value {
      font-size: 1.25rem;
      font-weight: 600;
      color: #001f1a;
    }

    /* CTA */
    .cta-section {
      text-align: center;
      padding: 24px 24px 40px;
    }
    .btn {
      display: inline-block;
      padding: 16px 40px;
      border-radius: 50px;
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: 0.5px;
      transition: transform 0.2s, box-shadow 0.2s;
      cursor: pointer;
      border: none;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.15); }
    .btn-primary { background: #001f1a; color: #fff; margin-right: 12px; margin-bottom: 12px; }
    .btn-secondary { background: transparent; color: #001f1a; border: 2px solid #001f1a; }

    /* Details Table */
    .details-section {
      max-width: 960px;
      margin: 0 auto;
      padding: 0 24px 40px;
    }
    .details-section h2 {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 1.5rem;
      font-weight: 400;
      margin-bottom: 20px;
      color: #001f1a;
    }
    .details-table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid #e8e5e0;
    }
    .details-table tr:nth-child(even) { background: #fafaf8; }
    .details-table td {
      padding: 14px 20px;
      font-size: 0.95rem;
      border-bottom: 1px solid #f0ede8;
    }
    .details-table td:first-child {
      font-weight: 600;
      color: #555;
      width: 40%;
    }

    /* Trust Badges */
    .trust-section {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 20px;
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 48px;
    }
    .trust-badge {
      text-align: center;
      padding: 20px;
      background: #fff;
      border: 1px solid #e8e5e0;
      border-radius: 10px;
    }
    .trust-badge .icon { font-size: 1.75rem; margin-bottom: 8px; }
    .trust-badge .badge-title { font-weight: 600; font-size: 0.9rem; color: #001f1a; }
    .trust-badge .badge-sub { font-size: 0.8rem; color: #6b6b6b; margin-top: 4px; }

    /* Footer */
    .footer {
      background: #001f1a;
      color: rgba(255,255,255,0.7);
      text-align: center;
      padding: 32px 24px;
      font-size: 0.85rem;
    }
    .footer a { color: #c9a94e; text-decoration: underline; }

    @media (max-width: 600px) {
      .specs-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .trust-section { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .btn { display: block; margin: 0 0 12px; }
    }
  </style>
  <script>
    // Redirect real users to the ring builder — bots/crawlers don't execute JS so they see the SEO page
    (function(){
      var ua = navigator.userAgent.toLowerCase();
      var isBot = /googlebot|bingbot|yandex|baiduspider|facebookexternalhit|twitterbot|rogerbot|linkedinbot|embedly|showyoubot|outbrain|pinterest|slackbot|vkshare|w3c_validator|semrush|ahrefs|mj12bot|dotbot|oai-searchbot|gptbot|chatgpt-user|perplexitybot|perplexity-user|claudebot|claude-web|anthropic-ai|amazonbot|applebot|duckduckbot|meta-externalagent|bytespider|chrome-lighthouse|google-inspectiontool/i.test(ua);
      if (!isBot) {
        window.location.replace('https://diyona.com/pages/diamond-detail?sku=' + encodeURIComponent('${esc(d.sku)}') + '&ring_builder=true');
      }
    })();
  </script>
</head>
<body>
  <header class="header">
    <a href="https://diyona.com" aria-label="Diyona Home">
      <span class="header-logo-text">DIYONA</span>
    </a>
  </header>

  <main>
  <section class="hero">
    <h1>${esc(d.carat)}ct ${esc(d.shape)} Lab-Grown Diamond</h1>
    <p class="cert">${esc(d.lab)} Certified &middot; #${esc(d.certificate_number)}</p>
    <p class="price">${fmtPrice(d.price_usd)}</p>
  </section>

  <div class="specs-grid">
    <div class="spec-card"><div class="label">Carat</div><div class="value">${esc(d.carat)}</div></div>
    <div class="spec-card"><div class="label">Color</div><div class="value">${esc(d.color)}</div></div>
    <div class="spec-card"><div class="label">Clarity</div><div class="value">${esc(d.clarity)}</div></div>
    <div class="spec-card"><div class="label">Cut</div><div class="value">${esc(cut || 'N/A')}</div></div>
    <div class="spec-card"><div class="label">Lab</div><div class="value">${esc(d.lab)}</div></div>
    <div class="spec-card"><div class="label">Certificate</div><div class="value">${esc(d.certificate_number)}</div></div>
  </div>

  <div class="cta-section">
    <a href="${esc(ringBuilderUrl)}" class="btn btn-primary">View in Ring Builder</a>
    <a href="${esc(looseUrl)}" class="btn btn-secondary">Buy Loose Diamond</a>
  </div>

  <div class="details-section">
    <h2>Technical Specifications</h2>
    <table class="details-table">
      <tr><td>Shape</td><td>${esc(d.shape)}</td></tr>
      <tr><td>Carat Weight</td><td>${esc(d.carat)}</td></tr>
      <tr><td>Color Grade</td><td>${esc(d.color)}</td></tr>
      <tr><td>Clarity Grade</td><td>${esc(d.clarity)}</td></tr>
      <tr><td>Cut Grade</td><td>${esc(cut || 'N/A')}</td></tr>
      <tr><td>Polish</td><td>${esc(d.polish || 'N/A')}</td></tr>
      <tr><td>Symmetry</td><td>${esc(d.symmetry || 'N/A')}</td></tr>
      <tr><td>Fluorescence</td><td>${esc(d.fluorescence || 'None')}</td></tr>
      <tr><td>Certification Lab</td><td>${esc(d.lab)}</td></tr>
      <tr><td>Certificate Number</td><td>${esc(d.certificate_number)}</td></tr>
      <tr><td>Measurements (L x W x D)</td><td>${esc(d.length || '-')} x ${esc(d.width || '-')} x ${esc(d.depth_mm || '-')} mm</td></tr>
      <tr><td>Depth %</td><td>${d.depth_percent ? esc(d.depth_percent) + '%' : 'N/A'}</td></tr>
      <tr><td>Table %</td><td>${d.table_percent ? esc(d.table_percent) + '%' : 'N/A'}</td></tr>
    </table>
  </div>

  <div class="trust-section">
    <div class="trust-badge">
      <div class="icon">&#128176;</div>
      <div class="badge-title">${esc(d.lab)} Certified</div>
      <div class="badge-sub">Independent grading report</div>
    </div>
    <div class="trust-badge">
      <div class="icon">&#128666;</div>
      <div class="badge-title">Free Shipping</div>
      <div class="badge-sub">Insured & tracked delivery</div>
    </div>
    <div class="trust-badge">
      <div class="icon">&#128260;</div>
      <div class="badge-title">30-Day Returns</div>
      <div class="badge-sub">Hassle-free return policy</div>
    </div>
    <div class="trust-badge">
      <div class="icon">&#128737;</div>
      <div class="badge-title">Lifetime Warranty</div>
      <div class="badge-sub">We stand behind every stone</div>
    </div>
  </div>
  </main>

  <footer class="footer">
    <p>&copy; ${new Date().getFullYear()} <a href="https://diyona.com">Diyona</a>. All rights reserved.</p>
    <p style="margin-top:8px;">Lab-Grown Diamonds &middot; Engagement Rings &middot; Fine Jewelry</p>
  </footer>
</body>
</html>`;
}

function build404() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diamond Not Found | Diyona</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="icon" type="image/png" href="https://diyona.com/cdn/shop/files/FAVICON_DIYONA_32x32.png">
  <style>
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #fafaf8; color: #1a1a1a; display: flex; flex-direction: column;
      align-items: center; justify-content: center; min-height: 100vh; text-align: center; padding: 24px;
    }
    h1 { font-family: Georgia, 'Times New Roman', serif; color: #001f1a; font-size: 2rem; margin-bottom: 12px; }
    p { color: #666; margin-bottom: 24px; }
    a {
      display: inline-block; padding: 14px 36px; background: #001f1a; color: #fff;
      border-radius: 50px; font-weight: 600; text-decoration: none;
    }
  </style>
</head>
<body>
  <h1>Diamond Not Found</h1>
  <p>This diamond may no longer be available. Browse our full collection to find your perfect stone.</p>
  <a href="https://diyona.com">Browse Diamonds</a>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  let { sku } = req.query;

  // Serve sitemap index at /a/lab-diamonds/sitemap.xml
  // Uses 20 pages of 25,000 each = 500K max diamonds (adjust if inventory grows)
  if (sku === 'sitemap.xml' || sku === 'sitemap') {
    try {
      const totalPages = 20;
      const today = new Date().toISOString().split('T')[0];
      const sitemaps = [];
      for (let i = 1; i <= totalPages; i++) {
        sitemaps.push(`  <sitemap>\n    <loc>https://diyona.com/a/lab-diamonds/sitemap-${i}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`);
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps.join('\n')}\n</sitemapindex>`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
      return res.status(200).send(xml);
    } catch (err) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</sitemapindex>');
    }
  }

  // Serve individual sitemap pages at /a/lab-diamonds/sitemap-1.xml, sitemap-2.xml, etc.
  const sitemapMatch = sku.match(/^sitemap-(\d+)\.xml$/);
  if (sitemapMatch) {
    try {
      const page = parseInt(sitemapMatch[1]);
      const perPage = 25000;
      const offset = (page - 1) * perPage;
      // Lightweight query — only fetch what we need for the URL
      const rows = await fetchChunked(
        'sku, shape, carat, color, clarity, lab, certificate_number',
        'sku', true, perPage, offset
      );
      if (rows.length === 0) {
        // Empty page — return empty sitemap
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 's-maxage=3600');
        return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>');
      }
      const today = new Date().toISOString().split('T')[0];
      const urls = rows.map(row => {
        const slug = [row.carat + 'ct', (row.shape||'').toLowerCase(), (row.color||'').toLowerCase(), (row.clarity||'').toLowerCase(), (row.lab||'').toLowerCase(), row.certificate_number||'', row.sku].filter(Boolean).join('-').replace(/[^a-z0-9.-]/gi, '-').replace(/-+/g, '-');
        return `<url><loc>https://diyona.com/a/lab-diamonds/${esc(slug)}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`;
      }).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
      return res.status(200).send(xml);
    } catch (err) {
      console.error('Sitemap page error:', err.message);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(500).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>');
    }
  }

  if (!sku) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(build404());
  }

  // Support slug-style URLs like "2.11ct-emerald-f-si1-igi-LG622472504-AFABAD71E"
  // The actual SKU is always the last segment after the final hyphen
  // But also support plain SKU for backwards compatibility
  const parts = sku.split('-');
  const possibleSku = parts[parts.length - 1]; // Last segment is the SKU

  try {
    // Try the full value first (plain SKU), then the extracted slug SKU
    const DETAIL_COLS = `sku, shape, carat, color, clarity, cut, polish, symmetry,
              fluorescence, lab, price_usd, length, width,
              depth_mm, depth_percent, table_percent,
              image_url, video_url, certificate_url, certificate_number`;
    let { data: rows, error } = await supabase
      .from('diamonds').select(DETAIL_COLS).eq('sku', sku).limit(1);
    if (error) throw new Error(error.message);
    if ((!rows || !rows.length) && possibleSku !== sku) {
      ({ data: rows, error } = await supabase
        .from('diamonds').select(DETAIL_COLS).eq('sku', possibleSku).limit(1));
      if (error) throw new Error(error.message);
    }

    if (!rows || !rows.length) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(404).send(build404());
    }

    const html = buildPage(rows[0]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(html);

  } catch (err) {
    console.error('Diamond page error:', err.message);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(build404());
  }
};
