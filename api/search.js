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

    const rpcParams = {
      p_shapes: params.shape || null,
      p_carat_min: params.carat_min ? parseFloat(params.carat_min) : null,
      p_carat_max: params.carat_max ? parseFloat(params.carat_max) : null,
      p_price_min: params.price_min ? parseFloat(params.price_min) : null,
      p_price_max: params.price_max ? parseFloat(params.price_max) : null,
      p_colors: params.color || null,
      p_clarities: params.clarity || null,
      p_cuts: params.cut || null,
      p_labs: params.lab || null,
      p_fluorescences: params.fluorescence || null,
      p_sort: params.sort || 'price_usd',
      p_sort_dir: params.sort_dir || 'asc',
      p_limit: perPage,
      p_offset: offset
    };

    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/search_diamonds`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify(rpcParams)
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText);
    }

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