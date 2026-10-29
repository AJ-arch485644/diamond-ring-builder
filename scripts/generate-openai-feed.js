const { catalogBatches } = require('../lib/catalog-export');
const { storefrontUrl } = require('../lib/catalog-links');
const { selectMetadataForFeed, reportInvalidSelectMetadata } = require('../lib/feed-select-metadata');
/**
 * OpenAI (ChatGPT shopping / ACP) Product Feed Generator
 * Pulls diamond inventory from Supabase and generates a gzipped TSV feed per
 * https://developers.openai.com/commerce/specs/feed. The workflow publishes it
 * to the rolling `feeds` GitHub Release (the ~80MB artifact exceeds Supabase
 * Storage's per-file cap).
 *
 * Sibling of generate-merchant-feed.js. Both use the shared factual renderer
 * for owned Select descriptions. Owned links use native Shopify products;
 * supplier links use server-rendered /a/lab-diamonds/ SEO pages.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 * Optional:
 *   LIMIT   cap fetched rows (testing)
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Config ───────────────────────────────────────────────────────
const SITE_URL = 'https://diyona.com';
const BRAND = 'Diyona';
const FEED_FILENAME = 'diyona-diamonds-openai.tsv.gz';
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

function buildTitle(d, selectMetadata = selectMetadataForFeed(d)) {
  const cut = selectMetadata
    ? selectMetadata.additionalProperties.find(property => property.name === 'Cut grade')?.value || ''
    : normalizeCut(d.cut);
  // Spec cap: 150 chars — this pattern tops out well under it.
  const parts = [
    `${d.carat}ct`,
    d.shape,
    d.color,
    d.clarity,
    cut,
    'Lab Grown Diamond',
  ];
  return parts.filter(Boolean).join(' ');
}

function buildDescription(d, selectMetadata = selectMetadataForFeed(d)) {
  if (selectMetadata) return selectMetadata.plainText;
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
  return d.inventory_source === 'owned' ? storefrontUrl(d) : `${SITE_URL}/a/lab-diamonds/${buildSlug(d)}`;
}

function escTsv(val) {
  if (val == null) return '';
  return String(val).replace(/[\t\n\r]/g, ' ');
}

// ─── Map a Supabase row → OpenAI feed row ─────────────────────────
function mapDiamond(d, options) {
  const price = Number(d.price_usd) || 0;
  if (price <= 0) return null;
  if (!d.image_url) return null; // image_url is required by the spec
  let selectMetadata;
  try { selectMetadata = selectMetadataForFeed(d); }
  catch (error) {
    if (!/^SELECT_[A-Z_]+$/.test(error.code || '')) throw error;
    options?.onInvalidMetadata?.(d, error);
    return null;
  }

  return {
    item_id: d.sku,
    title: buildTitle(d, selectMetadata),
    description: buildDescription(d, selectMetadata),
    brand: BRAND,
    url: buildLink(d),
    image_url: d.image_url,
    video_url: d.video_url || '',
    price: `${price.toFixed(2)} USD`,
    availability: 'in_stock',
    is_eligible_search: 'true',
    is_eligible_checkout: 'false', // discovery only; no ACP checkout implementation
    target_countries: 'US',
    seller_name: BRAND,
  };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const limit = parseInt(process.env.LIMIT) || Infinity;
  console.log('Fetching diamonds from Supabase...');

  const allDiamonds = [];
  const columns = 'sku,shape,carat,color,clarity,cut,polish,symmetry,fluorescence,lab,certificate_number,certificate_url,growth_method,price_usd,image_url,video_url,length,width,depth_mm,ratio,table_percent,depth_percent,inventory_source,is_diyona_select,is_lab_grown,shopify_product_id,shopify_variant_id,product_handle';
  for await (const batch of catalogBatches(supabase, { columns, batchSize: BATCH_SIZE })) {
    allDiamonds.push(...batch.slice(0, limit - allDiamonds.length));
    console.log(`  Fetched ${allDiamonds.length} so far...`);
    if (allDiamonds.length >= limit) break;
  }
  console.log(`Total diamonds fetched: ${allDiamonds.length}`);

  const rows = allDiamonds.map(d => mapDiamond(d, { onInvalidMetadata: reportInvalidSelectMetadata })).filter(Boolean);
  const skipped = allDiamonds.length - rows.length;
  console.log(`Valid feed rows: ${rows.length} (skipped ${skipped} without price or image, or with invalid owned metadata)`);

  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, FEED_FILENAME);

  // Stream through gzip — the full TSV (~500MB) exceeds V8's max string length
  let rawBytes = 0;
  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(outPath);
    gzip.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    gzip.pipe(out);

    const writeLine = (line) => {
      rawBytes += Buffer.byteLength(line);
      return gzip.write(line);
    };

    (async () => {
      writeLine(COLUMNS.join('\t') + '\n');
      for (const row of rows) {
        const ok = writeLine(COLUMNS.map(col => escTsv(row[col])).join('\t') + '\n');
        if (!ok) await new Promise(r => gzip.once('drain', r));
      }
      gzip.end();
    })().catch(reject);
  });

  const gzBytes = fs.statSync(outPath).size;
  console.log(`Feed written to ${outPath} (${(rawBytes / 1024 / 1024).toFixed(1)} MB raw, ${(gzBytes / 1024 / 1024).toFixed(1)} MB gzipped, ${rows.length} products)`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { COLUMNS, buildTitle, buildDescription, buildLink, mapDiamond, escTsv, main };
