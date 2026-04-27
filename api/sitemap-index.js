module.exports = async function handler(req, res) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://diyona.com/sitemap.xml</loc></sitemap>
  <sitemap><loc>https://diyona.com/sitemap-diamonds.xml</loc></sitemap>
</sitemapindex>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).send(xml);
};
