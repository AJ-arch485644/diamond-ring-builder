'use strict';

const COLUMNS = 'sku,shape,carat,color,clarity,cut,polish,symmetry,fluorescence,lab,price_usd,length,width,depth_mm,depth_percent,table_percent,image_url,video_url,certificate_url,certificate_number,inventory_source,is_diyona_select,shopify_product_id,shopify_variant_id,product_handle,catalog_revision,catalog_updated_at';
const NUMERIC_FILTERS = { carat_min: ['carat','gte'], carat_max: ['carat','lte'], price_min: ['price_usd','gte'], price_max: ['price_usd','lte'], ratio_min: ['ratio','gte'], ratio_max: ['ratio','lte'] };
const LIST_FILTERS = ['shape','color','clarity','cut','lab','fluorescence'];
const SORTS = { price_asc: ['price_usd',true], price_desc: ['price_usd',false], carat_asc: ['carat',true], carat_desc: ['carat',false] };
function invalid() { const error = new Error('INVALID_SEARCH_FILTER'); error.status = 400; return error; }
function scalar(value) { if ((typeof value !== 'string' && typeof value !== 'number') || /[\x00-\x1f\x7f]/.test(String(value))) throw invalid(); return String(value).trim(); }
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  const text = scalar(value);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw invalid();
  return Math.min(Number(text), max);
}
function parseFilters(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid();
  const page = integer(params.page, 1, 100000);
  const perPage = integer(params.per_page, 20, 50);
  const filters = [];
  for (const [name, [column, operator]] of Object.entries(NUMERIC_FILTERS)) {
    if (params[name] === undefined || params[name] === '') continue;
    const text = scalar(params[name]);
    if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) throw invalid();
    filters.push([operator,column,Number(text)]);
  }
  for (const name of LIST_FILTERS) {
    if (params[name] === undefined || params[name] === '') continue;
    const values = scalar(params[name]).split(',').map(value => value.trim());
    if (!values.length || values.length > 30 || values.some(value => !value || value.length > 60 || /[\x00-\x1f\x7f]/.test(value))) throw invalid();
    filters.push(['in',name,values]);
  }
  if (params.sku !== undefined) {
    const sku = scalar(params.sku);
    if (!sku || sku.length > 150 || /[\x00-\x1f\x7f]/.test(sku)) throw invalid();
    filters.push(['eq','sku',sku]);
  }
  if (params.source !== undefined) {
    if (!['owned','supplier'].includes(params.source)) throw invalid();
    filters.push(['eq','inventory_source',params.source]);
  }
  if (params.select_only !== undefined) {
    if (!['true','false',true,false].includes(params.select_only)) throw invalid();
    if (params.select_only === true || params.select_only === 'true') filters.push(['eq','is_diyona_select',true]);
  }
  const sort = params.sort === undefined ? SORTS.price_asc : SORTS[params.sort];
  if (!sort) throw invalid();
  for (const base of ['price','carat','ratio']) {
    if (params[base+'_min'] !== undefined && params[base+'_max'] !== undefined && Number(params[base+'_min']) > Number(params[base+'_max'])) throw invalid();
  }
  return { page, perPage, offset: (page-1)*perPage, filters, sort };
}
function queryCatalog(supabase, input) {
  let query = supabase.from('public_diamonds').select(COLUMNS, { count: 'exact' });
  for (const [operator, column, value] of input.filters) query = query[operator](column,value);
  // Apply source priority in Postgres before pagination, never sort only the
  // currently loaded supplier page. SKU makes equal-price paging deterministic.
  return query.order('is_diyona_select',{ascending:false,nullsFirst:false})
    .order(input.sort[0],{ascending:input.sort[1],nullsFirst:false})
    .order('sku',{ascending:true}).range(input.offset,input.offset+input.perPage-1);
}
function defaultClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY);
}
function createHandler({ getClient = defaultClient } = {}) {
  return async function handler(req,res) {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('CDN-Cache-Control','no-store');
    res.setHeader('Vercel-CDN-Cache-Control','no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    try {
      const input = parseFilters(req.method === 'POST' ? req.body : req.query);
      const { data,error,count } = await queryCatalog(getClient(),input);
      if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0) throw new Error('CATALOG_UNAVAILABLE');
      return res.status(200).json({ Diamonds: { data, total:count, per_page:input.perPage, current_page:input.page, has_more:input.offset+data.length<count } });
    } catch (error) { return res.status(error.status || 503).json({error:error.status === 400 ? 'INVALID_SEARCH_FILTER' : 'CATALOG_UNAVAILABLE'}); }
  };
}
module.exports = { COLUMNS, parseFilters, queryCatalog, createHandler };
