const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});

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

    let where = ['availability = $1', 'is_lab_grown = $2'];
    let values = ['available', true];
    let idx = 3;

    if (params.shape) {
      const shapes = params.shape.split(',').map(s => s.trim());
      where.push(`shape = ANY($${idx})`);
      values.push(shapes);
      idx++;
    }
    if (params.carat_min) {
      where.push(`carat >= $${idx}`);
      values.push(parseFloat(params.carat_min));
      idx++;
    }
    if (params.carat_max) {
      where.push(`carat <= $${idx}`);
      values.push(parseFloat(params.carat_max));
      idx++;
    }
    if (params.price_min) {
      where.push(`price_usd >= $${idx}`);
      values.push(parseFloat(params.price_min));
      idx++;
    }
    if (params.price_max) {
      where.push(`price_usd <= $${idx}`);
      values.push(parseFloat(params.price_max));
      idx++;
    }
    if (params.color) {
      const colors = params.color.split(',').map(s => s.trim());
      where.push(`color = ANY($${idx})`);
      values.push(colors);
      idx++;
    }
    if (params.clarity) {
      const clarities = params.clarity.split(',').map(s => s.trim());
      where.push(`clarity = ANY($${idx})`);
      values.push(clarities);
      idx++;
    }
    if (params.cut) {
      const cuts = params.cut.split(',').map(s => s.trim());
      where.push(`cut = ANY($${idx})`);
      values.push(cuts);
      idx++;
    }
    if (params.lab) {
      const labs = params.lab.split(',').map(s => s.trim());
      where.push(`lab = ANY($${idx})`);
      values.push(labs);
      idx++;
    }
    if (params.fluorescence) {
      const fluors = params.fluorescence.split(',').map(s => s.trim());
      where.push(`fluorescence = ANY($${idx})`);
      values.push(fluors);
      idx++;
    }

    values.push(perPage);
    values.push(offset);

    const sql = `
      SELECT sku,shape,carat,color,clarity,cut,polish,symmetry,
             fluorescence,lab,price_usd,cost_usd,length,width,
             depth_mm,depth_percent,table_percent,
             image_url,video_url,certificate_url,certificate_number
      FROM diamonds
      WHERE ${where.join(' AND ')}
      ORDER BY price_usd ASC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const result = await pool.query(sql, values);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      Diamonds: {
        data: result.rows,
        total: result.rows.length >= perPage ? 999 : offset + result.rows.length,
        per_page: perPage,
        current_page: page,
        has_more: result.rows.length >= perPage
      }
    });

  } catch (err) {
    console.error('Search error:', err.message, err);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
};