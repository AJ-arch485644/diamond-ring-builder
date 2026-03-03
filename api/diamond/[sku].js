const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { sku } = req.query;

  if (!sku) return res.status(400).json({ error: 'SKU required' });

  try {
    const { data, error } = await supabase
      .from('diamonds')
      .select('*')
      .eq('sku', sku)
      .eq('availability', 'available')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Diamond not found' });
    }

    res.status(200).json({ Diamond: data });

  } catch (err) {
    console.error('Detail error:', err);
    res.status(500).json({ error: 'Failed to fetch diamond' });
  }
};
