// Nightly Diyona Select refresh — keeps the badge whitelist alive as inventory
// churns. Runs after the image audit in the same workflow.
//
//   1. Rebuild the candidate pool: every Select combo (12 shape variants x 9
//      carat anchors x D/E x VS1..FL) with the storefront engine's exact gates;
//      candidates = stones within 7% of each combo's retail floor (+rung alternates).
//   2. Score candidates not yet in the select_audit ledger: shape CNN must agree
//      with the certificate shape AND the cut CNN must clear its precision-tuned
//      threshold. The committed owner-denied list is a permanent veto.
//   3. Assemble the whitelist from all passing candidates and publish it as
//      assets/select-certified.json to both themes — UNLESS sanity caps trip
//      (abnormal shrink/growth), in which case it holds and reports instead.
//
// Ledger seeding: first run loads the fleet-certified list (Haiku+Sonnet+owner
// certification of 2026-08-10) as source='fleet'. The CNN takes over for new
// stones. Writes ONLY to select_audit + the theme asset; never to diamonds.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ort = require('onnxruntime-node');
const { preprocess, download } = require('./audit.js');

const MODEL_DIR = path.join(__dirname, 'model');
const CUT_MODEL = path.join(MODEL_DIR, 'cut-cnn.onnx');
const META = path.join(MODEL_DIR, 'cut-cnn-meta.json');
const TIME_BUDGET_MIN = parseInt(process.env.REFRESH_TIME_BUDGET_MIN || '45', 10);
const SCORE_CAP = parseInt(process.env.REFRESH_SCORE_CAP || '400', 10);
const DEADLINE = Date.now() + TIME_BUDGET_MIN * 60000;
const timeLeft = () => DEADLINE - Date.now();
const THEMES = (process.env.SHOPIFY_THEME_IDS || '187284947260,186277921084').split(',');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ROUND_CUTS = ['EX', 'ID', 'EXC', 'IDL', 'Excellent', 'Ideal'];
const SHAPES = {
  'round':          { db: ['Round'],    ratio: [0.99, 1.02], cuts: ROUND_CUTS, gate: { table: [54, 60.5], depth: [60, 62.9] } },
  'oval':           { db: ['Oval'],     ratio: [1.42, 1.50], gate: { table: [54, 63], depth: [58, 66.5] } },
  'radiant':        { db: ['Radiant'],  ratio: [1.42, 1.50], gate: { table: [58, 68], depth: [58, 68] } },
  'emerald':        { db: ['Emerald'],  ratio: [1.40, 1.52], gate: { table: [58, 68], depth: [58, 67] } },
  'pear':           { db: ['Pear'],     ratio: [1.50, 1.65], gate: { table: [54, 64], depth: [58, 66] } },
  'marquise':       { db: ['Marquise'], ratio: [1.90, 2.15], gate: { table: [54, 64], depth: [58, 66] } },
  'princess':       { db: ['Princess'], ratio: [1.00, 1.05], gate: { table: [60, 74], depth: [62, 75] } },
  'asscher':        { db: ['Asscher'],  ratio: [1.00, 1.05], gate: { table: [58, 68], depth: [60, 68] } },
  'heart':          { db: ['Heart'],    ratio: [0.95, 1.05], gate: { table: [54, 64], depth: [56, 64] } },
  'cushion':        { db: ['Cushion', 'CUSHION MODIFIED', 'CUSHION BRILLIANT'], ratio: [1.25, 1.45], gate: { table: [58, 67], depth: [58, 68] } },
  'long cushion':   { db: ['Cushion', 'CUSHION MODIFIED', 'CUSHION BRILLIANT'], ratio: [1.25, 1.50], gate: { table: [58, 67], depth: [58, 68] } },
  'square cushion': { db: ['Cushion', 'CUSHION MODIFIED', 'CUSHION BRILLIANT'], ratio: [0.98, 1.05], gate: { table: [58, 67], depth: [58, 68] } }
};
const ANCHORS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
const COLORS = ['D', 'E'];
const CLARITIES = ['VS1', 'VVS2', 'VVS1', 'IF', 'FL'];
const FAM = s => { s = String(s || '').toLowerCase(); return s.includes('cushion') ? 'cushion' : s; };
const retail = d => Number(d.markup_price || d.price_usd || 0);

let shapeSession = null, cutSession = null, CLASSES = null, THRESHOLD = null;
async function loadModels() {
  CLASSES = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'shape-classes.json'), 'utf8'));
  THRESHOLD = JSON.parse(fs.readFileSync(META, 'utf8')).threshold;
  shapeSession = await ort.InferenceSession.create(path.join(MODEL_DIR, 'shape-cnn.onnx'));
  cutSession = await ort.InferenceSession.create(CUT_MODEL);
}

async function scoreBatch(items) {   // [{sku, fam, x}] -> [{sku, shapePred, cutProb}]
  if (!items.length) return [];
  const n = items.length;
  const data = new Float32Array(n * 3 * 224 * 224);
  items.forEach((it, i) => data.set(it.x, i * 3 * 224 * 224));
  const tensor = new ort.Tensor('float32', data, [n, 3, 224, 224]);
  const sOut = await shapeSession.run({ input: tensor });
  const cOut = await cutSession.run({ input: tensor });
  const sLogits = sOut[shapeSession.outputNames[0]].data;
  const cLogits = cOut[cutSession.outputNames[0]].data;
  const k = CLASSES.length;
  return items.map((it, i) => {
    let best = 0;
    for (let j = 1; j < k; j++) if (sLogits[i * k + j] > sLogits[i * k + best]) best = j;
    return { sku: it.sku, fam: it.fam, shapePred: CLASSES[best],
      cutProb: 1 / (1 + Math.exp(-cLogits[i])) };
  });
}

async function rungQuery(cfg, color, clarity, lo, hi) {
  let q = supabase.from('diamonds')
    .select('sku,shape,carat,color,clarity,price_usd,markup_price,image_url')
    .eq('availability', 'available').eq('is_lab_grown', true)
    .in('shape', cfg.db)
    .gte('carat', lo).lte('carat', hi)
    .eq('color', color).eq('clarity', clarity).eq('lab', 'IGI')
    .eq('polish', 'EX').eq('symmetry', 'EX')
    .gte('ratio', cfg.ratio[0]).lte('ratio', cfg.ratio[1])
    .gte('table_percent', cfg.gate.table[0]).lte('table_percent', cfg.gate.table[1])
    .gte('depth_percent', cfg.gate.depth[0]).lte('depth_percent', cfg.gate.depth[1])
    .not('image_url', 'is', null)
    .order('price_usd', { ascending: true }).limit(20);
  if (cfg.cuts) q = q.in('cut', cfg.cuts);
  const { data, error } = await q;
  if (error) { console.error('[pool] ' + error.message); return []; }
  return data || [];
}

async function buildPool(ownerDenied) {
  const combos = {}, stones = {};
  const jobs = [];
  for (const [variant, cfg] of Object.entries(SHAPES))
    for (const anchor of ANCHORS)
      for (const color of COLORS)
        for (const clarity of CLARITIES)
          jobs.push({ variant, cfg, anchor, color, clarity });
  let done = 0;
  async function worker() {
    while (jobs.length) {
      if (timeLeft() < 15 * 60000) { jobs.length = 0; break; }
      const j = jobs.shift();
      const rungs = [
        [j.anchor, +(j.anchor + 0.095).toFixed(3)],
        [+(j.anchor + 0.10).toFixed(2), +(j.anchor + 0.205).toFixed(3)],
        [+(j.anchor + 0.21).toFixed(2), +(j.anchor + 0.35).toFixed(2)]
      ];
      const res = await Promise.all(rungs.map(b => rungQuery(j.cfg, j.color, j.clarity, b[0], b[1])));
      const have = {}, pool = [];
      res.forEach(rows => rows.forEach(r => {
        if (have[r.sku] || ownerDenied.has(r.sku)) return;
        have[r.sku] = 1; r.retail = retail(r);
        if (r.retail > 0 && String(r.image_url || '').trim()) pool.push(r);
      }));
      done++;
      if (!pool.length) continue;
      pool.sort((a, b) => a.retail - b.retail);
      const floor = pool[0].retail;
      const cap = Math.max(floor * 1.07, floor + 25);
      const cands = pool.filter(s => s.retail <= cap).slice(0, 8);
      rungs.forEach(([lo, hi]) => {
        const rp = pool.filter(s => s.carat >= lo && s.carat <= hi);
        if (!rp.length) return;
        const rcap = Math.max(rp[0].retail * 1.07, rp[0].retail + 25);
        rp.filter(s => s.retail <= rcap).slice(0, 2).forEach(s => {
          if (!cands.some(c => c.sku === s.sku)) cands.push(s);
        });
      });
      const key = [j.variant, j.anchor.toFixed(1), j.color, j.clarity].join('|');
      combos[key] = cands.slice(0, 10).map(s => s.sku);
      cands.slice(0, 10).forEach(s => {
        if (!stones[s.sku]) stones[s.sku] = { sku: s.sku, fam: FAM(s.shape), url: s.image_url };
      });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log('[pool]', done, 'combos walked |', Object.keys(combos).length, 'non-empty |',
    Object.keys(stones).length, 'unique candidates');
  return { combos, stones };
}

async function seedFleetLists() {
  // Idempotent every run: ON CONFLICT DO NOTHING fills gaps without ever
  // overwriting CNN or owner rows. Fleet judgment (certifications AND denials)
  // permanently stands; the CNN only rules on stones no judge has seen.
  const files = [
    ['select-fleet-certified.json', sku => ({ sku, cut_pass: true, shape_ok: true, source: 'fleet' })],
    ['select-fleet-denied.json', sku => ({ sku, cut_pass: false, shape_ok: null, source: 'fleet-denied' })],
    ['select-owner-denied.json', sku => ({ sku, cut_pass: false, shape_ok: null, source: 'owner' })]
  ];
  for (const [file, toRow] of files) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8')).map(toRow);
    for (let i = 0; i < rows.length; i += 500) {
      const { error: e } = await supabase.from('select_audit')
        .upsert(rows.slice(i, i + 500), { onConflict: 'sku', ignoreDuplicates: true });
      if (e) console.error('[seed] ' + e.message);
    }
    // Denials additionally OVERRIDE any existing CNN verdict: a judge (fleet or
    // owner) outranks the model, even when the model scored the stone first.
    if (!rows[0].cut_pass) {
      const skus = rows.map(r => r.sku);
      for (let i = 0; i < skus.length; i += 500) {
        const { error: e } = await supabase.from('select_audit')
          .update({ cut_pass: false, source: rows[0].source })
          .in('sku', skus.slice(i, i + 500)).eq('source', 'cnn');
        if (e) console.error('[seed-override] ' + e.message);
      }
    }
  }
  console.log('[seed] fleet lists reconciled');
}

// Shared scorer: download -> preprocess -> shape veto + cut threshold -> ledger.
// Only ever writes skus absent from the ledger, so judge rows (fleet/owner) are
// untouchable. minLeft = minutes of budget this phase must leave for later ones.
async function scoreList(items, ledger, tag, minLeft) {
  let scored = 0, passed = 0, dlFail = 0;
  for (let i = 0; i < items.length && timeLeft() > minLeft * 60000; i += 24) {
    const slice = items.slice(i, i + 24);
    const fetched = [];
    for (const it of slice) {
      try {
        const { buf, etag } = await download(it.url);
        fetched.push({ sku: it.sku, fam: it.fam, x: await preprocess(buf), etag });
      } catch (e) { dlFail++; }
    }
    const results = await scoreBatch(fetched);
    const rows = results.map((r, j) => {
      const shapeOk = r.shapePred === r.fam;
      const pass = shapeOk && r.cutProb >= THRESHOLD;
      if (pass) passed++;
      return { sku: r.sku, fam: r.fam, cut_score: Math.round(r.cutProb * 1000) / 1000,
        cut_pass: pass, shape_ok: shapeOk, source: 'cnn', etag: fetched[j].etag,
        scored_at: new Date().toISOString() };
    });
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await supabase.from('select_audit').upsert(rows.slice(k, k + 500), { onConflict: 'sku' });
      if (error) console.error(tag + ' ' + error.message);
    }
    scored += rows.length;
    rows.forEach(r => ledger.set(r.sku, r));
    if (scored % 480 === 0) console.log(tag, scored, '/', items.length, '| passed', passed);
  }
  return { scored, passed, dlFail };
}

// The backfill enumeration collapses the three cushion variants into one sweep
// (their ratio windows nest) so shared stones are not re-paginated three times.
function backfillShapes() {
  const out = {};
  for (const [k, cfg] of Object.entries(SHAPES)) {
    if (k.includes('cushion')) continue;
    out[k] = cfg;
  }
  out['cushion'] = { db: SHAPES['cushion'].db, ratio: [0.98, 1.50], gate: SHAPES['cushion'].gate };
  return out;
}

async function backfillUniverse(ledger, ownerDenied, report) {
  const CAP = parseInt(process.env.BACKFILL_CAP || '15000', 10);
  if (!CAP) { console.log('[backfill] disabled'); return; }
  let scored = 0, passed = 0, dlFail = 0, walked = 0;
  for (const [variant, cfg] of Object.entries(backfillShapes())) {
    if (scored >= CAP || timeLeft() < 6 * 60000) break;
    let last = '';
    while (scored < CAP && timeLeft() > 6 * 60000) {
      let q = supabase.from('diamonds')
        .select('sku,shape,image_url')
        .eq('availability', 'available').eq('is_lab_grown', true)
        .in('shape', cfg.db).eq('lab', 'IGI').eq('polish', 'EX').eq('symmetry', 'EX')
        .in('color', COLORS).in('clarity', CLARITIES)
        .gte('ratio', cfg.ratio[0]).lte('ratio', cfg.ratio[1])
        .gte('table_percent', cfg.gate.table[0]).lte('table_percent', cfg.gate.table[1])
        .gte('depth_percent', cfg.gate.depth[0]).lte('depth_percent', cfg.gate.depth[1])
        .not('image_url', 'is', null)
        .order('sku', { ascending: true }).limit(1000);
      if (cfg.cuts) q = q.in('cut', cfg.cuts);
      if (last) q = q.gt('sku', last);
      const { data, error } = await q;
      if (error) { console.error('[backfill] ' + error.message); break; }
      if (!data || !data.length) break;
      last = data[data.length - 1].sku;
      walked += data.length;
      const fresh = [];
      for (let i = 0; i < data.length; i += 500) {
        const batch = data.slice(i, i + 500);
        const skus = batch.map(r => r.sku);
        const { data: hits } = await supabase.from('select_audit').select('sku').in('sku', skus);
        const known = new Set((hits || []).map(h => h.sku));
        batch.forEach(r => {
          if (known.has(r.sku) || ownerDenied.has(r.sku)) return;
          const url = String(r.image_url || '').trim();
          if (url) fresh.push({ sku: r.sku, fam: FAM(r.shape), url });
        });
      }
      if (fresh.length) {
        const room = CAP - scored;
        const s = await scoreList(fresh.slice(0, room), ledger, '[backfill]', 5);
        scored += s.scored; passed += s.passed; dlFail += s.dlFail;
      }
      if (data.length < 1000) break;
    }
    console.log('[backfill]', variant, 'done | total scored', scored, '| passed', passed);
  }
  report.backfillWalked = walked; report.backfillScored = scored;
  report.backfillPassed = passed; report.backfillDlFail = dlFail;
  console.log('[backfill] done:', scored, 'scored |', passed, 'passed |', walked, 'rows walked');
}

async function shopifyToken() {
  const r = await fetch('https://' + process.env.SHOPIFY_STORE + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' })
  });
  return (await r.json()).access_token;
}

async function main() {
  const report = { held: false };
  if (!fs.existsSync(CUT_MODEL) || !fs.existsSync(META)) {
    console.log('select-refresh skipped: cut model not present yet');
    return;
  }
  await loadModels();
  console.log('[models] loaded, cut threshold', THRESHOLD);
  const ownerDenied = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'select-owner-denied.json'), 'utf8')));
  await seedFleetLists();

  const { combos, stones } = await buildPool(ownerDenied);
  const allSkus = Object.keys(stones);

  // ledger lookup
  const ledger = new Map();
  for (let i = 0; i < allSkus.length; i += 500) {
    const { data, error } = await supabase.from('select_audit')
      .select('sku,cut_pass,shape_ok,source').in('sku', allSkus.slice(i, i + 500));
    if (error) { console.error('[ledger] ' + error.message); continue; }
    (data || []).forEach(r => ledger.set(r.sku, r));
  }
  const toScore = allSkus.filter(s => !ledger.has(s)).slice(0, SCORE_CAP);
  report.candidates = allSkus.length;
  report.known = ledger.size;
  report.toScore = toScore.length;
  console.log('[score] new candidates to score:', toScore.length, 'of', allSkus.length);

  // score new candidates: shape veto + cut threshold (priority lane)
  const s1 = await scoreList(toScore.map(sku => ({ sku, fam: stones[sku].fam, url: stones[sku].url })),
    ledger, '[score]', 8);
  report.scored = s1.scored; report.newPassed = s1.passed; report.dlFail = s1.dlFail;
  console.log('[score] done:', s1.scored, 'scored |', s1.passed, 'passed |', s1.dlFail, 'dl failures');

  // Catalog-wide backfill: pre-certify the WHOLE gated-eligible universe (every
  // stone that could ever appear in a Select search, regardless of today's
  // price floors) so the bench is always scored before price drift needs it.
  await backfillUniverse(ledger, ownerDenied, report);

  // assemble whitelist: every current candidate whose ledger row passes
  const whitelist = new Set();
  Object.values(combos).forEach(cands => cands.forEach(sku => {
    const l = ledger.get(sku);
    if (l && l.cut_pass && !ownerDenied.has(sku)) whitelist.add(sku);
  }));
  const badged = Object.values(combos).filter(c => c.some(sku => whitelist.has(sku))).length;
  report.whitelist = whitelist.size;
  report.combosBadged = badged; report.combosTotal = Object.keys(combos).length;
  console.log('[assemble] whitelist', whitelist.size, '| combos badged', badged, '/', Object.keys(combos).length);

  // compare with deployed + sanity caps
  const tok = await shopifyToken();
  const H = { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' };
  let deployed = null;
  try {
    const r = await fetch('https://' + process.env.SHOPIFY_STORE + '/admin/api/2025-01/themes/' +
      THEMES[0] + '/assets.json?asset[key]=assets/select-certified.json', { headers: H });
    const j = await r.json();
    if (j.asset && j.asset.value) deployed = JSON.parse(j.asset.value);
  } catch (e) {}
  if (deployed) {
    const adds = [...whitelist].filter(s => !deployed.includes(s)).length;
    const removes = deployed.filter(s => !whitelist.has(s)).length;
    report.deployed = deployed.length; report.adds = adds; report.removes = removes;
    console.log('[publish] deployed', deployed.length, '| adds', adds, '| removes', removes);
    if (whitelist.size < deployed.length * 0.7 || whitelist.size > deployed.length * 1.5) {
      report.held = true;
      console.error('[publish] SANITY CAP TRIPPED — holding for human review, not publishing');
      fs.writeFileSync(path.join(__dirname, 'select-refresh-report.json'), JSON.stringify(report, null, 1));
      return;
    }
  }
  const payload = JSON.stringify([...whitelist].sort());
  for (const theme of THEMES) {
    const r = await fetch('https://' + process.env.SHOPIFY_STORE + '/admin/api/2025-01/themes/' + theme + '/assets.json', {
      method: 'PUT', headers: H,
      body: JSON.stringify({ asset: { key: 'assets/select-certified.json', value: payload } })
    });
    console.log(r.status === 200 ? '[publish] PUT OK' : '[publish] PUT FAIL', theme, whitelist.size, 'skus');
  }
  fs.writeFileSync(path.join(__dirname, 'select-refresh-report.json'), JSON.stringify(report, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Select refresh\n\n| metric | value |\n|---|---|\n' +
      Object.entries(report).map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') + '\n');
  }
}

if (require.main === module) main().catch(e => { console.error('REFRESH ERROR:', e); process.exitCode = 1; });
