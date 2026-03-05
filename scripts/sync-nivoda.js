const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { parse } = require('csv-parse');
const ftp = require('basic-ftp');
const fs = require('fs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BATCH_SIZE = 500;

function mapRow(row, syncTimestamp) {
  const length = parseFloat(row['length']) || null;
  const width = parseFloat(row['width']) || null;
  return {
    nivoda_id: row['ID'],
    stock_id: row['stockId'],
    sku: row['stockId'],
    certificate_number: row['ReportNo'],
    shape: normalizeShape(row['shape']),
    carat: parseFloat(row['carats']) || null,
    color: row['col'],
    clarity: row['clar'],
    cut: row['cut'] || null,
    polish: row['pol'] || null,
    symmetry: row['symm'] || null,
    fluorescence: row['flo'] || null,
    fluorescence_color: row['floCol'] || null,
    lab: row['lab'],
    length: length,
    width: width,
    depth_mm: parseFloat(row['height']) || null,
    depth_percent: parseFloat(row['depth']) || null,
    table_percent: parseFloat(row['table']) || null,
    culet: row['culet'] || null,
    girdle: row['girdle'] || null,
    eye_clean: row['eyeClean'] || null,
    brown: row['brown'] || null,
    green: row['green'] || null,
    milky: row['milky'] || null,
    discount: parseFloat(row['discount']) || null,
    cost_usd: parseFloat(row['price']) || null,
    price_per_carat: parseFloat(row['pricePerCarat']) || null,
    price_usd: parseFloat(row['markupPrice']) || null,
    markup_currency: row['markupCurrency'] || null,
    delivered_price: parseFloat(row['deliveredPrice']) || null,
    video_url: row['video'] || null,
    image_url: row['image'] || null,
    certificate_url: row['pdf'] || null,
    mine_of_origin: row['mineOfOrigin'] || null,
    is_returnable: row['isReturnable'] === 'Y',
    is_lab_grown: row['lg'] === 'lab',
    min_delivery_days: parseInt(row['minDeliveryDays']) || null,
    max_delivery_days: parseInt(row['maxDeliveryDays']) || null,
    availability: 'available',
    ratio: (length && width && width > 0) ? Math.round((length / width) * 100) / 100 : null,
    updated_at: syncTimestamp
  };
}

function normalizeShape(shape) {
  if (!shape) return null;
  const map = {
    'RD': 'Round', 'BR': 'Round', 'ROUND': 'Round',
    'PR': 'Princess', 'PRINCESS': 'Princess',
    'CU': 'Cushion', 'CUSHION': 'Cushion',
    'OV': 'Oval', 'OVAL': 'Oval',
    'EM': 'Emerald', 'EMERALD': 'Emerald',
    'PS': 'Pear', 'PEAR': 'Pear',
    'MQ': 'Marquise', 'MARQUISE': 'Marquise',
    'AS': 'Asscher', 'ASSCHER': 'Asscher',
    'RA': 'Radiant', 'RADIANT': 'Radiant',
    'HT': 'Heart', 'HEART': 'Heart',
  };
  return map[shape.toUpperCase()] || shape;
}

async function downloadCSV() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: process.env.NIVODA_FTP_HOST,
      user: process.env.NIVODA_FTP_USER,
      password: process.env.NIVODA_FTP_PASS,
      secure: false
    });
    const localPath = path.join(require('os').tmpdir(), 'nivoda-diamonds.csv');
    await client.downloadTo(localPath, process.env.NIVODA_FTP_PATH);
    console.log(`Downloaded CSV to ${localPath}`);
    return localPath;
  } finally {
    client.close();
  }
}

async function syncToDatabase(csvPath) {
  console.log('Starting database sync...');
  const syncTimestamp = new Date().toISOString();
  console.log(`Sync timestamp: ${syncTimestamp}`);

  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const records = [];
  const parser = parse(fileContent, {
    columns: true, skip_empty_lines: true, trim: true,
    delimiter: ',', quote: '"', relax_quotes: true, relax_column_count: true
  });

  for await (const row of parser) {
    const mapped = mapRow(row, syncTimestamp);
    if (!mapped.nivoda_id || !mapped.carat || !mapped.price_usd) continue;
    if (!mapped.is_lab_grown) continue;
    records.push(mapped);
  }

  console.log(`Parsed ${records.length} valid lab-grown diamonds from CSV`);

  // Step 1: Upsert all current diamonds
  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('diamonds')
      .upsert(batch, { onConflict: 'nivoda_id', ignoreDuplicates: false });

    if (error) {
      console.error(`Batch error at ${i}:`, error.message);
      errors++;
    } else {
      inserted += batch.length;
    }
    if ((i / BATCH_SIZE) % 50 === 0) {
      console.log(`Progress: ${inserted}/${records.length} upserted (${errors} batch errors)`);
    }
  }
  console.log(`Upsert complete: ${inserted}/${records.length} (${errors} batch errors)`);

  // Step 2: Mark stale diamonds as unavailable
  console.log('Marking stale diamonds as unavailable...');
  const { error: markError } = await supabase.rpc('mark_stale_unavailable', {
    sync_ts: syncTimestamp
  });
  if (markError) {
    console.error('Mark stale error:', markError.message);
  } else {
    console.log('Stale diamonds marked unavailable');
  }

  // Step 3: Delete all unavailable diamonds immediately
  console.log('Deleting unavailable diamonds...');
  const { error: deleteError, count } = await supabase
    .from('diamonds')
    .delete({ count: 'exact' })
    .eq('availability', 'unavailable');

  if (deleteError) {
    console.error('Delete error:', deleteError.message);
  } else {
    console.log(`Deleted ${count || 0} unavailable diamonds`);
  }

  console.log('Sync complete.');
}

async function main() {
  const startTime = Date.now();
  try {
    const csvPath = await downloadCSV();
    await syncToDatabase(csvPath);
    fs.unlinkSync(csvPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total sync time: ${elapsed}s`);
  } catch (err) {
    console.error('Sync failed:', err);
    process.exit(1);
  }
}

main();