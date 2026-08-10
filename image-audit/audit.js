// Nightly catalog image audit — REPORT-ONLY.
//
// Classifies diamond images with the shape CNN (image-audit/model/) and keeps a
// persistent audit ledger in the image_audit table. It NEVER writes to the
// diamonds table, never touches the public_diamonds view, and has zero effect on
// the storefront: flags are surfaced to humans (workflow summary + rolling
// GitHub issue) and enforcement stays with the manually curated theme blocklist.
//
// Phases (each respects the shared time budget):
//   0. seed      — first run only: load the one-time full-scan baseline into an
//                  empty image_audit table.
//   1. enumerate — walk diamonds (read-only) to find SKUs with no audit row and
//                  SKUs whose image_url changed; backfill missing ledger URLs.
//   2. classify  — download + classify the phase-1 queue (capped by NEW_CAP).
//   3. sweep     — conditional HEAD (If-None-Match) on the least-recently
//                  checked ledger rows; on a changed ETag, re-download and
//                  re-classify (capped by SWEEP_CAP).
//   4. report    — counts + newly flagged SKUs to stdout, GITHUB_STEP_SUMMARY,
//                  and image-audit/new-flags.json for the issue step.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

// Lazy so the inference helpers can be imported (tests, tooling) without env.
let _supabase = null;
const supabase = new Proxy({}, {
  get(_, prop) {
    if (!_supabase) {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
      _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    return _supabase[prop];
  }
});

const NEW_CAP = parseInt(process.env.NEW_CAP || '25000', 10);
const SWEEP_CAP = parseInt(process.env.SWEEP_CAP || '60000', 10);
const TIME_BUDGET_MIN = parseInt(process.env.TIME_BUDGET_MIN || '200', 10);
const DL_CONCURRENCY = parseInt(process.env.DL_CONCURRENCY || '4', 10);
const CONF_FLAG = 0.85;                 // same bar the offline full scan used
const BATCH = 1000;                     // supabase upsert batch
const IN_BATCH = 500;                   // .in() batch (PostgREST URL length limit)
const UA = 'Mozilla/5.0 (diyona image audit)';
const DEADLINE = Date.now() + TIME_BUDGET_MIN * 60000;
const timeLeft = () => DEADLINE - Date.now();

const FAM = {
  'round': 'round', 'oval': 'oval', 'radiant': 'radiant', 'emerald': 'emerald',
  'pear': 'pear', 'marquise': 'marquise', 'princess': 'princess',
  'asscher': 'asscher', 'heart': 'heart', 'cushion': 'cushion',
  'square cushion': 'cushion', 'long cushion': 'cushion',
  'cushion modified': 'cushion', 'cushion brilliant': 'cushion'
};

// ── model ──────────────────────────────────────────────────────────────────
const CLASSES = JSON.parse(fs.readFileSync(path.join(__dirname, 'model', 'shape-classes.json'), 'utf8'));
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let session = null;
async function getSession() {
  if (!session) session = await ort.InferenceSession.create(path.join(__dirname, 'model', 'shape-cnn.onnx'));
  return session;
}

// Preprocess exactly like the offline scan: shortest side -> 256, center crop
// 224, /255, per-channel normalize, CHW float32.
async function preprocess(buf) {
  // toColourspace('srgb') forces 3 channels — grayscale/CMYK sources otherwise
  // yield a differently-strided raw buffer that silently NaN-corrupts the tensor.
  const img = sharp(buf, { failOn: 'none' }).toColourspace('srgb').removeAlpha();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('no dims');
  const s = 256 / Math.min(meta.width, meta.height);
  const w = Math.round(meta.width * s), h = Math.round(meta.height * s);
  const left = Math.floor((w - 224) / 2), top = Math.floor((h - 224) / 2);
  const raw = await img.resize(w, h, { fit: 'fill' })
    .extract({ left, top, width: 224, height: 224 })
    .raw().toBuffer();
  if (raw.length !== 3 * 224 * 224) throw new Error('bad channels: ' + raw.length);
  const x = new Float32Array(3 * 224 * 224);
  for (let p = 0; p < 224 * 224; p++) {
    for (let c = 0; c < 3; c++) {
      x[c * 224 * 224 + p] = (raw[p * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return x;
}

async function classifyBatch(items) {   // items: [{sku, fam, x}]
  if (!items.length) return [];
  const sess = await getSession();
  const n = items.length;
  const data = new Float32Array(n * 3 * 224 * 224);
  items.forEach((it, i) => data.set(it.x, i * 3 * 224 * 224));
  const out = await sess.run({ input: new ort.Tensor('float32', data, [n, 3, 224, 224]) });
  const logits = out[sess.outputNames[0]].data;
  const k = CLASSES.length;
  return items.map((it, i) => {
    const row = Array.from(logits.slice(i * k, (i + 1) * k));
    const mx = Math.max(...row);
    const exps = row.map(v => Math.exp(v - mx));
    const sum = exps.reduce((a, b) => a + b, 0);
    let best = 0;
    row.forEach((v, j) => { if (v > row[best]) best = j; });
    return { sku: it.sku, fam: it.fam, pred: CLASSES[best], conf: exps[best] / sum };
  });
}

// ── http helpers ───────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Global rate gate shared by every CDN request (downloads AND sweep HEADs):
// ~5 req/s so the audit stays politely under the CDN's observed sustained
// throttle. The storefront hotlinks these same URLs — never crowd it.
let nextSlot = 0;
async function rateGate() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 200;
  if (wait) await sleep(wait);
}
async function fetchTimeout(url, opts, ms) {
  await rateGate();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}
async function download(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchTimeout(url, { headers: { 'User-Agent': UA } }, 25000);
    if (r.status === 429 || r.status === 503) {
      // Throttled: back off hard (honor Retry-After up to 30s) and retry once.
      if (attempt >= 1) throw new Error('throttled ' + r.status);
      const ra = parseInt(r.headers.get('retry-after') || '0', 10);
      await sleep(Math.min(Math.max(ra * 1000, 5000), 30000));
      continue;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) throw new Error('tiny body');
    return { buf, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') };
  }
}

// Small promise pool: run fn over items with fixed concurrency, in order of
// completion. Collects results; individual failures return {err}.
async function pool(items, conc, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx]); }
      catch (e) { results[idx] = { err: String(e.message || e).slice(0, 80) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return results;
}

// ── db helpers (image_audit ONLY — this script never writes anywhere else) ──
// PostgREST bulk upserts require every row in a request to share the SAME key
// set, so rows are grouped by their key signature before batching.
async function auditUpsert(rows) {
  const groups = {};
  rows.forEach(r => {
    const sig = Object.keys(r).sort().join(',');
    (groups[sig] = groups[sig] || []).push(r);
  });
  for (const group of Object.values(groups)) {
    for (let i = 0; i < group.length; i += BATCH) {
      const batch = group.slice(i, i + BATCH);
      const { error } = await supabase.from('image_audit').upsert(batch, { onConflict: 'sku' });
      if (error) console.error('[upsert] ' + error.message);
    }
  }
}

function classificationRow(c, url, etag, lastModified, now) {
  const mismatch = !!(c.fam && c.pred && c.pred !== c.fam);
  return {
    sku: c.sku, image_url: url, fam: c.fam, pred: c.pred,
    conf: c.conf == null ? null : Math.round(c.conf * 1000) / 1000,
    mismatch, flagged: mismatch && c.conf >= CONF_FLAG,
    etag: etag || null, last_modified: lastModified || null,
    checked_at: now, classified_at: now, fail_count: 0
  };
}

// ── phase 0: seed ──────────────────────────────────────────────────────────
async function seedIfEmpty(stats) {
  const { count, error } = await supabase.from('image_audit')
    .select('sku', { count: 'exact', head: true });
  if (error) throw new Error('seed count failed: ' + error.message);
  if (count > 0) { console.log('[seed] table has', count, 'rows — skipping'); return; }
  const file = path.join(__dirname, 'baseline.jsonl.gz');
  if (!fs.existsSync(file)) { console.log('[seed] no baseline file — skipping'); return; }
  console.log('[seed] empty table: loading baseline...');
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()) });
  const stamp = '2026-08-10T00:00:00Z';   // when the offline full scan finished
  let batch = [], n = 0, bad = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (timeLeft() < 15 * 60000) {
      // Bail gracefully; unseeded remainder self-heals via enumerate (as "new").
      console.error('[seed] time budget low — stopping early at', n, 'rows');
      break;
    }
    let r;
    try { r = JSON.parse(line); } catch (e) { bad++; continue; }
    if (!r || !r.s) { bad++; continue; }
    const mismatch = !!(r.f && r.p && r.p !== 'unsupported' && r.p !== r.f);
    batch.push({
      sku: r.s, fam: r.f, pred: r.p, conf: r.c,
      mismatch, flagged: mismatch && r.c >= CONF_FLAG,
      classified_at: stamp, checked_at: null, fail_count: 0
    });
    if (batch.length >= BATCH) { await auditUpsert(batch); n += batch.length; batch = []; }
    if (n && n % 50000 === 0) console.log('[seed]', n, 'rows');
  }
  if (batch.length) { await auditUpsert(batch); n += batch.length; }
  stats.seeded = n;
  if (bad) console.error('[seed] skipped', bad, 'malformed lines');
  console.log('[seed] done:', n, 'rows');
}

// ── phase 1: enumerate ─────────────────────────────────────────────────────
async function enumerate(stats) {
  // Keyset pagination on sku: verified unique across the whole table (sku is
  // Nivoda's stockId; 0 duplicates in 755k rows as of 2026-08-10). A restarted
  // run re-walks from the top — cheap (~5 min) and always self-consistent.
  const queue = [];        // {sku, fam, url} needing (re)classification
  const backfill = [];     // ledger rows missing image_url (baseline-seeded)
  let last = '', pages = 0;
  while (timeLeft() > 10 * 60000) {
    let q = supabase.from('diamonds')
      .select('sku,shape,image_url')
      .not('image_url', 'is', null)
      .order('sku', { ascending: true })
      .limit(1000);
    if (last) q = q.gt('sku', last);
    const { data, error } = await q;
    if (error) { console.error('[enum] page failed: ' + error.message); break; }
    if (!data || !data.length) break;
    last = data[data.length - 1].sku;
    pages++;
    const bySku = new Map(data.map(r => [r.sku, r]));
    const skus = data.map(r => r.sku);
    const known = new Map();
    for (let i = 0; i < skus.length; i += IN_BATCH) {
      const { data: hits, error: e2 } = await supabase.from('image_audit')
        .select('sku,image_url').in('sku', skus.slice(i, i + IN_BATCH));
      if (e2) { console.error('[enum] lookup failed: ' + e2.message); continue; }
      (hits || []).forEach(h => known.set(h.sku, h.image_url));
    }
    for (const r of data) {
      const url = String(r.image_url || '').trim();
      if (!url) continue;
      const fam = FAM[String(r.shape || '').trim().toLowerCase()] || null;
      if (!known.has(r.sku)) {
        queue.push({ sku: r.sku, fam, url });
      } else if (known.get(r.sku) == null) {
        backfill.push({ sku: r.sku, image_url: url });
      } else if (known.get(r.sku) !== url) {
        // vendor swapped the image URL entirely -> treat as a brand new image
        queue.push({ sku: r.sku, fam, url, urlChanged: true });
      }
    }
    if (pages % 100 === 0) console.log('[enum]', pages, 'pages | new-or-changed', queue.length);
    if (data.length < 1000) break;
  }
  stats.enumPages = pages;
  stats.urlChanged = queue.filter(r => r.urlChanged).length;
  console.log('[enum] done:', pages, 'pages | queue', queue.length,
    '(url-changed ' + stats.urlChanged + ') | url backfills', backfill.length);
  if (backfill.length) await auditUpsert(backfill);
  stats.backfilled = backfill.length;
  return queue;
}

// ── phase 2: classify new/changed ──────────────────────────────────────────
async function classifyQueue(queue, stats, flags) {
  const todo = queue.slice(0, NEW_CAP);
  stats.newQueued = queue.length; stats.newTaken = todo.length;
  let done = 0, failed = 0, consecFail = 0, unsupported = 0;
  for (let i = 0; i < todo.length && timeLeft() > 5 * 60000; i += 64) {
    const slice = todo.slice(i, i + 64);
    const now = new Date().toISOString();
    // Unsupported cert shapes are recorded once and never re-enumerated.
    const unsup = slice.filter(r => !r.fam);
    if (unsup.length) {
      await auditUpsert(unsup.map(r => ({
        sku: r.sku, image_url: r.url, fam: null, pred: 'unsupported', conf: null,
        mismatch: false, flagged: false, checked_at: now, classified_at: now, fail_count: 0
      })));
      unsupported += unsup.length;
    }
    const rest = slice.filter(r => r.fam);
    const fetched = await pool(rest, DL_CONCURRENCY, async r => {
      const { buf, etag, lastModified } = await download(r.url);
      return { r, x: await preprocess(buf), etag, lastModified };
    });
    const good = [], rows = [];
    fetched.forEach((f, j) => {
      if (f && !f.err) { good.push(f); consecFail = 0; }
      else {
        failed++; consecFail++;
        // No fail_count here: a new row defaults to 0 and the sweep increments;
        // an existing row keeps its accumulated count (never reset by a retry).
        // pred stays NULL, which the sweep's filter explicitly includes so the
        // stone is re-attempted until it classifies or ages out at 5 failures.
        const r = rest[j];
        rows.push({ sku: r.sku, image_url: r.url, fam: r.fam, checked_at: now });
      }
    });
    const preds = await classifyBatch(good.map(f => ({ sku: f.r.sku, fam: f.r.fam, x: f.x })));
    preds.forEach((c, j) => {
      const f = good[j];
      const row = classificationRow(c, f.r.url, f.etag, f.lastModified, now);
      rows.push(row);
      if (row.flagged) flags.push({ sku: row.sku, fam: row.fam, pred: row.pred,
        conf: row.conf, image_url: row.image_url, source: f.r.urlChanged ? 'url-change' : 'new' });
    });
    await auditUpsert(rows);
    done += preds.length;
    if (consecFail > 50) { console.error('[classify] 50 consecutive failures — CDN unhappy, stopping phase'); break; }
    if ((i / 64) % 20 === 0) console.log('[classify]', done, 'classified |', failed, 'failed |', Math.round(timeLeft() / 60000) + 'min left');
  }
  stats.newClassified = done; stats.newFailed = failed; stats.unsupported = unsupported;
  console.log('[classify] done:', done, 'classified,', failed, 'failed,', unsupported, 'unsupported');
}

// ── phase 3: rotating conditional sweep ────────────────────────────────────
async function sweep(stats, flags) {
  if (timeLeft() < 10 * 60000) { console.log('[sweep] no time left — skipping'); return; }
  // pred IS NULL rows are download failures from earlier runs — they MUST stay
  // in rotation (a bare .neq would silently drop them: NULL != x is NULL in SQL).
  const { data, error } = await supabase.from('image_audit')
    .select('sku,image_url,etag,last_modified,fam,pred,fail_count')
    .or('pred.is.null,pred.neq.unsupported')
    .not('image_url', 'is', null)
    .lt('fail_count', 5)
    .order('checked_at', { ascending: true, nullsFirst: true })
    .limit(SWEEP_CAP);
  if (error) { console.error('[sweep] select failed: ' + error.message); return; }
  console.log('[sweep] slice:', data.length, 'rows');
  let unchanged = 0, changed = 0, firstEtag = 0, failed = 0, reclassified = 0;
  let consecFail = 0;
  for (let i = 0; i < data.length && timeLeft() > 4 * 60000; i += 200) {
    const slice = data.slice(i, i + 200);
    const now = new Date().toISOString();
    const rows = [];
    const changedRows = [];
    const results = await pool(slice, 6, async r => {
      const headers = { 'User-Agent': UA };
      if (r.etag) headers['If-None-Match'] = r.etag;
      const resp = await fetchTimeout(r.image_url, { method: 'HEAD', headers }, 15000);
      return { status: resp.status, ok: resp.ok, etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified') };
    });
    results.forEach((res, j) => {
      const r = slice[j];
      const failRow = () => {
        failed++; consecFail++;
        rows.push({ sku: r.sku, checked_at: now, fail_count: (r.fail_count || 0) + 1 });
      };
      if (!res || res.err) return failRow();
      if (res.status === 304) {            // provably unchanged
        consecFail = 0; unchanged++;
        rows.push({ sku: r.sku, checked_at: now, fail_count: 0 });
        return;
      }
      // Any other non-2xx (429/503 throttle, 403/404, 5xx) is a FAILURE — it is
      // never evidence the image changed, and escalating to a GET during a
      // throttling event would be the worst possible response.
      if (!res.ok) return failRow();
      consecFail = 0;
      if (r.pred == null && r.fam) {       // stranded earlier failure: classify now
        changed++;
        changedRows.push(r);
      } else if (!r.etag) {                // first visit: record validators only
        firstEtag++;
        rows.push({ sku: r.sku, etag: res.etag, last_modified: res.lastModified,
          checked_at: now, fail_count: 0 });
      } else if (res.etag && res.etag !== r.etag) {
        changed++;                          // content swapped behind the same URL
        changedRows.push(r);
      } else if (!res.etag && res.lastModified && r.last_modified &&
                 res.lastModified !== r.last_modified) {
        changed++;                          // no etag from CDN: fall back to Last-Modified
        changedRows.push(r);
      } else {
        unchanged++;
        rows.push({ sku: r.sku, checked_at: now, fail_count: 0 });
      }
    });
    await auditUpsert(rows);
    if (consecFail > 60) { console.error('[sweep] 60 consecutive failures — CDN unhappy, stopping phase'); break; }
    // Re-download + re-classify content changes (small volume expected)
    if (changedRows.length) {
      const fetched = await pool(changedRows, DL_CONCURRENCY, async r => {
        const { buf, etag, lastModified } = await download(r.image_url);
        return { r, x: await preprocess(buf), etag, lastModified };
      });
      const good = fetched.filter(f => f && !f.err);
      const preds = await classifyBatch(good.map(f => ({ sku: f.r.sku, fam: f.r.fam, x: f.x })));
      const rerows = preds.map((c, j) => {
        const f = good[j];
        const row = classificationRow(c, f.r.image_url, f.etag, f.lastModified, now);
        if (row.flagged) flags.push({ sku: row.sku, fam: row.fam, pred: row.pred,
          conf: row.conf, image_url: row.image_url, source: 'etag-change' });
        return row;
      });
      await auditUpsert(rerows);
      reclassified += rerows.length;
    }
    if ((i / 200) % 25 === 0) console.log('[sweep]', i + slice.length, '/', data.length,
      '| unchanged', unchanged, '| changed', changed, '| first-etag', firstEtag);
  }
  stats.sweepUnchanged = unchanged; stats.sweepChanged = changed;
  stats.sweepFirstEtag = firstEtag; stats.sweepFailed = failed;
  stats.sweepReclassified = reclassified;
  console.log('[sweep] done: unchanged', unchanged, '| changed', changed,
    '| first-etag', firstEtag, '| failed', failed, '| reclassified', reclassified);
}

// ── phase 4: report ────────────────────────────────────────────────────────
function report(stats, flags) {
  console.log('\n=== AUDIT SUMMARY ===');
  console.log(JSON.stringify(stats, null, 1));
  console.log('new flags this run:', flags.length);
  fs.writeFileSync(path.join(__dirname, 'new-flags.json'), JSON.stringify(flags, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['## Nightly image audit', '',
      '| metric | value |', '|---|---|',
      ...Object.entries(stats).map(([k, v]) => '| ' + k + ' | ' + v + ' |'), '',
      flags.length ? '### New flags (' + flags.length + ')' : 'No new flags.',
      ...flags.slice(0, 100).map(f =>
        '- `' + f.sku + '` cert **' + f.fam + '** → looks **' + f.pred + '** (' +
        Math.round(f.conf * 100) + '%, ' + f.source + ') — [image](' + f.image_url + ')'),
      flags.length > 100 ? '…and ' + (flags.length - 100) + ' more in new-flags.json' : ''
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
}

async function main() {
  const t0 = Date.now();
  const stats = {}; const flags = [];
  try {
    await seedIfEmpty(stats);
    const queue = await enumerate(stats);
    await classifyQueue(queue, stats, flags);
    await sweep(stats, flags);
  } catch (e) {
    console.error('AUDIT ERROR:', e);
    process.exitCode = 1;
  } finally {
    stats.minutes = Math.round((Date.now() - t0) / 60000);
    report(stats, flags);
  }
}

if (require.main === module) main();
module.exports = { preprocess, classifyBatch, download };
