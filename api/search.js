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

    // Select only the columns we need - no count
    let query = supabase
      .from('diamonds')
      .select('sku,shape,carat,color,clarity,cut,polish,symmetry,fluorescence,lab,price_usd,cost_usd,length,width,depth_mm,depth_percent,table_percent,image_url,video_url,certificate_url,certificate_number')
      .eq('availability', 'available')
      .eq('is_lab_grown', true);

    // Filters
    if (params.shape) {
      query = query.in('shape', params.shape.split(',').map(s => s.trim()));
    }
    if (params.carat_min) query = query.gte('carat', parseFloat(params.carat_min));
    if (params.carat_max) query = query.lte('carat', parseFloat(params.carat_max));
    if (params.price_min) query = query.gte('price_usd', parseFloat(params.price_min));
    if (params.price_max) query = query.lte('price_usd', parseFloat(params.price_max));
    if (params.color) {
      query = query.in('color', params.color.split(',').map(s => s.trim()));
    }
    if (params.clarity) {
      query = query.in('clarity', params.clarity.split(',').map(s => s.trim()));
    }
    if (params.cut) {
      query = query.in('cut', params.cut.split(',').map(s => s.trim()));
    }
    if (params.lab) {
      query = query.in('lab', params.lab.split(',').map(s => s.trim()));
    }
    if (params.fluorescence) {
      query = query.in('fluorescence', params.fluorescence.split(',').map(s => s.trim()));
    }

    // Sorting
    const sortField = params.sort || 'price_usd';
    const sortDir = params.sort_dir === 'desc' ? false : true;
    const validSortFields = ['price_usd', 'carat', 'color', 'clarity'];
    if (validSortFields.includes(sortField)) {
      query = query.order(sortField, { ascending: sortDir });
    }

    // Pagination
    query = query.range(offset, offset + perPage - 1);

    const { data, error } = await query;

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
