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

    const sortField = params.sort || 'price_usd';
    const validSortFields = ['price_usd', 'carat', 'color', 'clarity'];
    const sort = validSortFields.includes(sortField) ? sortField : 'price_usd';
    const sortDir = params.sort_dir === 'desc' ? 'desc' : 'asc';

    const caratMin = params.carat_min ? parseFloat(params.carat_min) : null;
    const caratMax = params.carat_max ? parseFloat(params.carat_max) : null;

    // Progressive carat narrowing - search in small windows to avoid scanning huge ranges
    const caratSteps = [0.5, 1, 2, 3, 5, 10, 20, null];
    let data = [];

    if (caratMin !== null && caratMax !== null && (caratMax - caratMin) > 0.5) {
      // Wide range - search progressively
      let currentMin = caratMin;

      for (const step of caratSteps) {
        const currentMax = step === null ? caratMax : Math.min(caratMin + step, caratMax);
        if (currentMin >= caratMax) break;

        const rpcParams = {
          p_shapes: params.shape || null,
          p_carat_min: currentMin,
          p_carat_max: currentMax,
          p_price_min: params.price_min ? parseFloat(params.price_min) : null,
          p_price_max: params.price_max ? parseFloat(params.price_max) : null,
          p_colors: params.color || null,
          p_clarities: params.clarity || null,
          p_cuts: params.cut || null,
          p_labs: params.lab || null,
          p_fluorescences: params.fluorescence || null,
          p_sort: sort,
          p_sort_dir: sortDir,
          p_limit: perPage,
          p_offset: page === 1 ? 0 : offset
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

        if (!response.ok) throw new Error(await response.text());
        const batch = await response.json();
        data = data.concat(batch);

        if (data.length >= perPage) {
          data = data.slice(0, perPage);
          break;
        }

        currentMin = currentMax;
      }
    } else {
      // Narrow range or no carat filter - search normally
      const rpcParams = {
        p_shapes: params.shape || null,
        p_carat_min: caratMin,
        p_carat_max: caratMax,
        p_price_min: params.price_min ? parseFloat(params.price_min) : null,
        p_price_max: params.price_max ? parseFloat(params.price_max) : null,
        p_colors: params.color || null,
        p_clarities: params.clarity || null,
        p_cuts: params.cut || null,
        p_labs: params.lab || null,
        p_fluorescences: params.fluorescence || null,
        p_sort: sort,
        p_sort_dir: sortDir,
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

      if (!response.ok) throw new Error(await response.text());
      data = await response.json();
    }

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