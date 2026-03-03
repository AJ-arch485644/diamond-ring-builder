const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

    const { data, error } = await supabase.rpc('search_diamonds', {
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
      p_sort: sort,
      p_sort_dir: sortDir,
      p_limit: perPage,
      p_offset: offset
    });

    if (error) throw error;

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