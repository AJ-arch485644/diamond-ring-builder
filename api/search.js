module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const params = req.method === 'POST' ? req.body : req.query;
    const page = parseInt(params.page) || 1;
    const perPage = Math.min(parseInt(params.per_page) || 20, 50);
    const offset = (page - 1) * perPage;

    const qs = [
      'select=sku,shape,carat,color,clarity,cut,polish,symmetry,fluorescence,lab,price_usd,cost_usd,length,width,depth_mm,depth_percent,table_percent,image_url,video_url,certificate_url,certificate_number',
      'availability=eq.available',
      'is_lab_grown=eq.true',
      'order=price_usd.asc',
      `limit=${perPage}`,
      `offset=${offset}`
    ];

    if (params.shape) qs.push(`shape=in.(${params.shape})`);
    if (params.carat_min) qs.push(`carat=gte.${params.carat_min}`);
    if (params.carat_max) qs.push(`carat=lte.${params.carat_max}`);
    if (params.price_min) qs.push(`price_usd=gte.${params.price_min}`);
    if (params.price_max) qs.push(`price_usd=lte.${params.price_max}`);
    if (params.color) qs.push(`color=in.(${params.color})`);
    if (params.clarity) qs.push(`clarity=in.(${params.clarity})`);
    if (params.cut) qs.push(`cut=in.(${params.cut})`);
    if (params.lab) qs.push(`lab=in.(${params.lab})`);
    if (params.fluorescence) qs.push(`fluorescence=in.(${params.fluorescence})`);

    const url = `${process.env.SUPABASE_URL}/rest/v1/diamonds?${qs.join('&')}`;

    const response = await fetch(url, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      Diamonds: {
        data: data,
        total: data.length >= perPage ? 999 : offset + data.length,
        per_page: perPage,
        current_page: page,
        has_more: data.length >= perPage
      }
    });

  } catch (err) {
    console.error('Search error:', err.message, err);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
};