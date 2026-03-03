const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});

const ALL_SHAPES = ['Round','Oval','Cushion','Princess','Emerald','Pear','Radiant','Marquise','Asscher','Heart'];

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

    const shapes = params.shape ? params.shape.split(',').map(s => s.trim()) : ALL_SHAPES;
    const needsMultiQuery = !params.shape && (params.carat_min || params.carat_max || params.price_min || params.price_max);

    let data;

    if (needsMultiQuery) {
      // No shape selected + numeric filters = query each shape separately then merge
      const promises = shapes.map(shape => {
        let where = ["availability = 'available'", 'is_lab_grown = true', `shape = $1`];
        let values = [shape];
        let idx = 2;

        if (params.carat_min) { where.push(`carat >= $${idx}`); values.push(parseFloat(params.carat_min)); idx++; }
        if (params.carat_max) { where.push(`carat <= $${idx}`); values.push(parseFloat(params.carat_max)); idx++; }
        if (params.price_min) { where.push(`price_usd >= $${idx}`); values.push(parseFloat(params.price_min)); idx++; }
        if (params.price_max) { where.push(`price_usd <= $${idx}`); values.push(parseFloat(params.price_max)); idx++; }
        if (params.color) { where.push(`color = ANY($${idx})`); values.push(params.color.split(',').map(s => s.trim())); idx++; }
        if (params.clarity) { where.push(`clarity = ANY($${idx})`); values.push(params.clarity.split(',').map(s => s.trim())); idx++; }
        if (params.cut) { where.push(`cut = ANY($${idx})`); values.push(params.cut.split(',').map(s => s.trim())); idx++; }
        if (params.lab) { where.push(`lab = ANY($${idx})`); values.push(params.lab.split(',').map(s => s.trim())); idx++; }
        if (params.fluorescence) { where.push(`fluorescence = ANY($${idx})`); values.push(params.fluorescence.split(',').map(s => s.trim())); idx++; }

        values.push(perPage + offset); // fetch enough to cover pagination

        const sql = `
          SELECT sku,shape,carat,color,clarity,cut,polish,symmetry,
                 fluorescence,lab,price_usd,cost_usd,length,width,
                 depth_mm,depth_percent,table_percent,
                 image_url,video_url,certificate_url,certificate_number
          FROM diamonds
          WHERE ${where.join(' AND ')}
          ORDER BY price_usd ASC
          LIMIT $${idx}
        `;

        return pool.query(sql, values).then(r => r.rows);
      });

      const results = await Promise.all(promises);
      const merged = results.flat().sort((a, b) => a.price_usd - b.price_usd);
      data = merged.slice(offset, offset + perPage);

    } else {
      // Shape selected or no numeric filters = single query
      let where = ["availability = 'available'", 'is_lab_grown = true'];
      let values = [];
      let idx = 1;

      if (params.shape) { where.push(`shape = ANY($${idx})`); values.push(shapes); idx++; }
      if (params.carat_min) { where.push(`carat >= $${idx}`); values.push(parseFloat(params.carat_min)); idx++; }
      if (params.carat_max) { where.push(`carat <= $${idx}`); values.push(parseFloat(params.carat_max)); idx++; }
      if (params.price_min) { where.push(`price_usd >= $${idx}`); values.push(parseFloat(params.price_min)); idx++; }
      if (params.price_max) { where.push(`price_usd <= $${idx}`); values.push(parseFloat(params.price_max)); idx++; }
      if (params.color) { where.push(`color = ANY($${idx})`); values.push(params.color.split(',').map(s => s.trim())); idx++; }
      if (params.clarity) { where.push(`clarity = ANY($${idx})`); values.push(params.clarity.split(',').map(s => s.trim())); idx++; }
      if (params.cut) { where.push(`cut = ANY($${idx})`); values.push(params.cut.split(',').map(s => s.trim())); idx++; }
      if (params.lab) { where.push(`lab = ANY($${idx})`); values.push(params.lab.split(',').map(s => s.trim())); idx++; }
      if (params.fluorescence) { where.push(`fluorescence = ANY($${idx})`); values.push(params.fluorescence.split(',').map(s => s.trim())); idx++; }

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
      data = result.rows;
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