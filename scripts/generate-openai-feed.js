/**
 * OpenAI (ChatGPT shopping / ACP) Product Feed Generator
 * Pulls diamond inventory from Supabase and generates a gzipped TSV feed per
 * https://developers.openai.com/commerce/specs/feed, then uploads it to the
 * public Supabase Storage bucket `feeds`.
 *
 * Sibling of generate-merchant-feed.js — same fetch loop and copy builders,
 * but links point at the server-rendered /a/lab-diamonds/ SEO pages (crawlable
 * without JS) instead of the JS-hydrated /pages/diamond-detail?sku= pages.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_KEY   (upload; skipped with a warning if absent)
 * Optional:
 *   LIMIT        cap fetched rows (testing)
 *   SKIP_UPLOAD  write local file only
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Config ───────────────────────────────────────────────────────
const SITE_URL = 'https://diyona.com';
const BRAND = 'Diyona';
const FEED_FILENAME = 'diyona-diamonds-openai.tsv.gz';
const STORAGE_BUCKET = 'feeds';
const BATCH_SIZE = 10000;

// ─── OpenAI feed columns (spec: developers.openai.com/commerce) ───
const COLUMNS = [
  'item_id',
  'title',
  'description',
  'brand',
  'url',
  'image_url',
  'video_url',
  'mpn',
  'price',
  'availability',
  'is_eligible_search',
  'is_eligible_checkout',
  'target_countries',
  'seller_name',
];

// ─── Helpers ──────────────────────────────────────────────────────

function normalizeCut(raw) {
  if (!raw) return '';
  // Fancy shapes carry placeholder cut values like "-" or "N/A" in the feed
  if (/^[-–—\s]*$/.test(raw) || ['N/A', 'NA', 'NONE'].includes(raw.toUpperCase().trim())) return '';
  const map = {
    EX: 'Excellent', EXC: 'Excellent', ID: 'Ideal', IDL: 'Ideal',
    VG: 'Very Good', G: 'Good', GD: 'Good', F: 'Fair', FR: 'Fair',
    P: 'Poor', PR: 'Poor',
  };
  const upper = raw.toUpperCase().trim();
  return map[upper] || raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function buildTitle(d) {
  // Spec cap: 150 chars — this pattern tops out well under it.
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
  if (d.ratio) desc += ` Length-to-width ratio ${d.ratio}.`;
  desc += ` Buy loose or pair with an engagement ring setting at Diyona.`;
  desc += ` Free insured shipping and 30-day returns.`;

  return desc;
}

// Same slug the sitemaps and /a/lab-diamonds/ pages use:
// 2.11ct-emerald-f-si1-igi-LG622472504-AFABAD71E
function buildSlug(d) {
  return [
    d.carat + 'ct',
    (d.shape || '').toLowerCase(),
    (d.color || '').toLowerCase(),
    (d.clarity || '').toLowerCase(),
    (d.lab || '').toLowerCase(),
    d.certificate_number || '',
    d.sku,
  ].filter(Boolean).join('-').replace(/[^a-z0-9.-]/gi, '-').replace(/-+/g, '-');
}

function buildLink(d) {
  return `${SITE_URL}/a/lab-diamonds/${buildSlug(d)}`;
}

function escTsv(val) {
  if (val == null) return '';
  return String(val).replace(/[\t\n\r]/g, ' ');
}

// ─── Map a Supabase row → OpenAI feed row ─────────────────────────
function mapDiamond(d) {
  const price = Number(d.price_usd) || 0;
  if (price <= 0) return null;
  if (!d.image_url) return null; // image_url is required by the spec

  return {
    item_id: d.sku,
    title: buildTitle(d),
    description: buildDescription(d),
    brand: BRAND,
    url: buildLink(d),
    image_url: d.image_url,
    video_url: d.video_url || '',
    mpn: (d.certificate_number || '').slice(0, 70),
    price: `${price.toFixed(2)} USD`,
    availability: 'in_stock',
    is_eligible_search: 'true',
    is_eligible_checkout: 'false', // discovery only; no ACP checkout implementation
    target_countries: 'US',
    seller_name: BRAND,
  };
}

// ─── Resilient fetching (same pattern as the GMC feed) ────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(supabase, offset, batchSize, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { data, error } = await supabase
      .from('public_diamonds')
      .select('sku,shape,carat,color,clarity,cut,polish,symmetry,lab,certificate_number,price_usd,image_url,video_url,length,width,depth_mm,ratio')
      .range(offset, offset + batchSize - 1);

    if (!error) return { data, error: null };

    console.warn(`  Attempt ${attempt}/${retries} failed at offset ${offset}: ${error.message}`);
    if (attempt < retries) {
      await sleep(attempt * 3000);
    } else {
      return { data: null, error };
    }
  }
}

// ─── Upload to Supabase Storage (public bucket) ───────────────────
async function uploadFeed(gzBuffer) {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey || process.env.SKIP_UPLOAD) {
    console.warn('SUPABASE_SERVICE_KEY missing or SKIP_UPLOAD set — feed not uploaded.');
    return;
  }
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${FEED_FILENAME}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'application/gzip',
      'x-upsert': 'true',
    },
    body: gzBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Storage upload failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  console.log(`Uploaded to ${process.env.SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${FEED_FILENAME}`);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const limit = parseInt(process.env.LIMIT) || Infinity;
  console.log('Fetching diamonds from Supabase...');

  let allDiamonds = [];
  let offset = 0;
  let keepGoing = true;

  while (keepGoing && allDiamonds.length < limit) {
    const batchSize = Math.min(BATCH_SIZE, limit - allDiamonds.length);
    const { data, error } = await fetchWithRetry(supabase, offset, batchSize);

    if (error) {
      console.error('Supabase error after retries:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      keepGoing = false;
    } else {
      allDiamonds = allDiamonds.concat(data);
      offset += batchSize;
      console.log(`  Fetched ${allDiamonds.length} so far...`);
      if (data.length < batchSize) keepGoing = false;
      if ((offset / BATCH_SIZE) % 50 === 0) await sleep(2000);
    }
  }

  console.log(`Total diamonds fetched: ${allDiamonds.length}`);

  const rows = allDiamonds.map(mapDiamond).filter(Boolean);
  const skipped = allDiamonds.length - rows.length;
  console.log(`Valid feed rows: ${rows.length} (skipped ${skipped} without price or image)`);

  const header = COLUMNS.join('\t');
  const lines = rows.map(row => COLUMNS.map(col => escTsv(row[col])).join('\t'));
  const tsv = [header, ...lines].join('\n');
  const gz = zlib.gzipSync(Buffer.from(tsv, 'utf-8'), { level: 9 });

  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, FEED_FILENAME);
  fs.writeFileSync(outPath, gz);

  console.log(`Feed written to ${outPath} (${(tsv.length / 1024 / 1024).toFixed(1)} MB raw, ${(gz.length / 1024 / 1024).toFixed(1)} MB gzipped, ${rows.length} products)`);

  await uploadFeed(gz);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
