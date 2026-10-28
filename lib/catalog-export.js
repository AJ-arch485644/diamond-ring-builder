'use strict';

// Walk indexed source/SKU keys without OFFSET. SKU is not unique in the supplier
// feed: refetch each page's final SKU group completely before advancing past it.
// An exact count on that small group detects server row caps without ever counting
// the full catalog. A short page is not treated as the end of the catalog.
async function* catalogBatches(client, options = {}) {
  const { columns = '*', batchSize = 10000, retries = 3,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw Error('INVALID_EXPORT_BATCH_SIZE');
  async function read(isSelect, cursor, group = false) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      let query = client.from('public_diamonds').select(columns, group ? { count: 'exact' } : {})
        .eq('is_diyona_select', isSelect).not('sku', 'is', null).neq('sku', '')
        .order('is_diyona_select', { ascending: false }).order('sku', { ascending: true }).limit(batchSize);
      if (cursor !== null) query = group ? query.eq('sku', cursor) : query.gt('sku', cursor);
      const result = await query;
      if (!result.error) {
        if (!Array.isArray(result.data) || result.data.some(row => typeof row.sku !== 'string' || !row.sku || row.is_diyona_select !== isSelect)) throw Error('INVALID_EXPORT_PAGE');
        return result;
      }
      if (attempt === retries) throw Error('CATALOG_EXPORT_QUERY_FAILED');
      await sleep(attempt * 3000);
    }
    throw Error('CATALOG_EXPORT_QUERY_FAILED');
  }
  for (const isSelect of [true, false]) {
    let cursor = null;
    while (true) {
      const page = await read(isSelect, cursor);
      if (!page.data.length) break;
      const lastSku = page.data.at(-1).sku;
      if (lastSku === cursor) throw Error('CATALOG_EXPORT_CURSOR_STALLED');
      const tail = await read(isSelect, lastSku, true);
      if (!Number.isSafeInteger(tail.count) || tail.count !== tail.data.length || tail.data.some(row => row.sku !== lastSku)) throw Error('CATALOG_EXPORT_SKU_GROUP_INCOMPLETE');
      const prefix = page.data.filter(row => row.sku !== lastSku);
      yield prefix.concat(tail.data);
      cursor = lastSku;
    }
  }
}

module.exports = { catalogBatches };
