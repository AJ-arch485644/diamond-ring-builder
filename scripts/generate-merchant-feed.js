/**
 * Google Merchant Center Feed Generator
 * Pulls diamond inventory from Supabase and generates a TSV feed file.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────
const SITE_URL = 'https://diyona.com';
const BRAND = 'Diyona';
const FEED_FILENAME = 'diyona-diamonds.tsv';
const BATCH_SIZE = 10000; // Requires Supabase Max Rows set to 10000+

// ─── Google Merchant Columns ──────────────────────────────────────
const COLUMNS = [
  'id',
  'title',
  'description',
  'link',
  'image_link',
  'price',
  'availability',
  'brand',
  'condition',
  'identifier_exists',
  'product_type',
  'google_product_category',
  'custom_label_0', // shape
  'custom_label_1', // color grade bucket
  'custom_label_2', // clarity grade bucket
  'custom_label_3', // carat range bucket
  'custom_label_4', // price range bucket
];

// ─── Helpers ──────────────────────────────────────────────────────

function normalizeCut(raw) {
  if (!raw) return '';
  const map = {
    EX: 'Excellent', EXC: 'Excellent', ID: 'Ideal', IDL: 'Ideal',
    VG: 'Very Good', G: 'Good', GD: 'Good', F: 'Fair', FR: 'Fair',
    P: 'Poor', PR: 'Poor',
  };
  const upper = raw.toUpperCase().trim();
  return map[upper] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function buildTitle(d) {
  const parts = [
    `${d.carat}ct`,
    d.shape,
    d.color,
    d.clarity,
    normalizeCut(d.cut),
    'Lab Grown Diamond',
  ];
  return parts.filter(Boolean).join(' ');
}

function buildDescription(d) {
  const cut = normalizeCut(d.cut);
  const dims = (d.length && d.width && d.depth_mm)
    ? `${d.length} × ${d.width} × ${d.depth_mm} mm`
    : '';

  let desc = `${d.carat} carat ${d.shape} lab grown diamond`;
  desc += ` with ${d.color} color and ${d.clarity} clarity.`;
  if (cut) desc += ` ${cut} cut grade.`;
  if (d.polish) desc += ` ${normalizeCut(d.polish)} polish.`;
  if (d.symmetry) desc += ` ${normalizeCut(d.symmetry)} symmetry.`;
  if (d.lab && d.certificate_number) desc += ` Certified by ${d.lab.toUpperCase()} (${d.certificate_number}).`;
  if (dims) desc += ` Dimensions: ${dims}.`;
  desc += ` Free shipping and 30-day returns.`;

  return desc;
}

function buildLink(d) {
  return `${SITE_URL}/pages/diamond-detail?sku=${encodeURIComponent(d.sku)}`;
}

function colorBucket(color) {
  if (!color) return 'Other';
  if ('DEF'.includes(color)) return 'Colorless';
  if ('GHIJ'.includes(color)) return 'Near Colorless';
  return 'Faint';
}

function clarityBucket(clarity) {
  if (!clarity) return 'Other';
  if (['FL', 'IF'].includes(clarity)) return 'Flawless';
  if (['VVS1', 'VVS2'].includes(clarity)) return 'VVS';
  if (['VS1', 'VS2'].includes(clarity)) return 'VS';
  if (['SI1', 'SI2'].includes(clarity)) return 'SI';
  return 'Included';
}

function caratBucket(carat) {
  const c = parseFloat(carat) || 0;
  if (c < 0.5) return 'Under 0.5ct';
  if (c < 1) return '0.5-0.99ct';
  if (c < 1.5) return '1-1.49ct';
  if (c < 2) return '1.5-1.99ct';
  if (c < 3) return '2-2.99ct';
  return '3ct+';
}

function priceBucket(price) {
  const p = Number(price) || 0;
  if (p < 500) return 'Under $500';
  if (p < 1000) return '$500-$999';
  if (p < 2000) return '$1000-$1999';
  if (p < 5000) return '$2000-$4999';
  return '$5000+';
}

function escTsv(val) {
  if (val == null) return '';
  return String(val).replace(/[\t\n\r]/g, ' ');
}

// ─── Map a Supabase row → Merchant feed row ──────────────────────
function mapDiamond(d) {
  const price = Number(d.price_usd) || 0;
  if (price <= 0) return null; // skip diamonds without a price

  return {
    id: d.sku,
    title: buildTitle(d),
    description: buildDescription(d),
    link: buildLink(d),
    image_link: d.image_url || '',
    price: `${price.toFixed(2)} USD`,
    availability: 'in_stock',
    brand: BRAND,
    condition: 'new',
    identifier_exists: 'false',
    product_type: 'Jewelry > Loose Diamonds',
    google_product_category: '188', // Apparel & Accessories > Jewelry
    custom_label_0: d.shape || '',
    custom_label_1: colorBucket(d.color),
    custom_label_2: clarityBucket(d.clarity),
    custom_label_3: caratBucket(d.carat),
    custom_label_4: priceBucket(price),
  };
}

// ─── Helpers for resilient fetching ───────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(supabase, offset, batchSize, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { data, error } = await supabase
      .from('public_diamonds')
      .select('*')
      .range(offset, offset + batchSize - 1);

    if (!error) return { data, error: null };

    console.warn(`  Attempt ${attempt}/${retries} failed at offset ${offset}: ${error.message}`);
    if (attempt < retries) {
      const backoff = attempt * 3000; // 3s, 6s, 9s
      console.log(`  Waiting ${backoff / 1000}s before retry...`);
      await sleep(backoff);
    } else {
      return { data: null, error };
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  console.log('Fetching diamonds from Supabase...');

  let allDiamonds = [];
  let offset = 0;
  let keepGoing = true;

  while (keepGoing) {
    const { data, error } = await fetchWithRetry(supabase, offset, BATCH_SIZE);

    if (error) {
      console.error('Supabase error after retries:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      keepGoing = false;
    } else {
      allDiamonds = allDiamonds.concat(data);
      offset += BATCH_SIZE;
      console.log(`  Fetched ${allDiamonds.length} so far...`);
      if (data.length < BATCH_SIZE) keepGoing = false;

      // Small delay every 50 batches to avoid overwhelming Supabase
      if ((offset / BATCH_SIZE) % 50 === 0) {
        console.log('  Pausing 2s to ease server load...');
        await sleep(2000);
      }
    }
  }

  console.log(`Total diamonds fetched: ${allDiamonds.length}`);

  // Map to feed rows, filter out any nulls (bad data)
  const rows = allDiamonds.map(mapDiamond).filter(Boolean);
  console.log(`Valid feed rows: ${rows.length}`);

  // Build TSV
  const header = COLUMNS.join('\t');
  const lines = rows.map(row =>
    COLUMNS.map(col => escTsv(row[col])).join('\t')
  );

  const tsv = [header, ...lines].join('\n');

  // Write output
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, FEED_FILENAME);
  fs.writeFileSync(outPath, tsv, 'utf-8');

  const sizeMB = (Buffer.byteLength(tsv) / 1024 / 1024).toFixed(2);
  console.log(`Feed written to ${outPath} (${sizeMB} MB, ${rows.length} products)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
