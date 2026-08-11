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

async function seedIfEmpty() {
  const { count, error } = await supabase.from('select_audit').select('sku', { count: 'exact', head: true });
  if (error) throw new Error('select_audit count: ' + error.message);
  if (count > 0) return;
  const fleet = JSON.parse(fs.readFileSync(path.join(__dirname, 'select-fleet-certified.json'), 'utf8'));
  const denied = JSON.parse(fs.readFileSync(path.join(__dirname, 'select-owner-denied.json'), 'utf8'));
  console.log('[seed] fleet-certified', fleet.length, '+ owner-denied', denied.length);
  const rows = fleet.map(sku => ({ sku, cut_pass: true, shape_ok: true, source: 'fleet' }))
    .concat(denied.map(sku => ({ sku, cut_pass: false, shape_ok: null, source: 'owner' })));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: e } = await supabase.from('select_audit').upsert(rows.slice(i, i + 500), { onConflict: 'sku' });
    if (e) console.error('[seed] ' + e.message);
  }
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
  await seedIfEmpty();

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

  // score new candidates: shape veto + cut threshold
  let scored = 0, passed = 0, dlFail = 0;
  for (let i = 0; i < toScore.length && timeLeft() > 8 * 60000; i += 24) {
    const slice = toScore.slice(i, i + 24);
    const fetched = [];
    for (const sku of slice) {
      try {
        const { buf, etag } = await download(stones[sku].url);
        fetched.push({ sku, fam: stones[sku].fam, x: await preprocess(buf), etag });
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
      if (error) console.error('[score] ' + error.message);
    }
    scored += rows.length;
    rows.forEach(r => ledger.set(r.sku, r));
    if (scored % 96 === 0) console.log('[score]', scored, '/', toScore.length, '| passed', passed);
  }
  report.scored = scored; report.newPassed = passed; report.dlFail = dlFail;
  console.log('[score] done:', scored, 'scored |', passed, 'passed |', dlFail, 'dl failures');

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
