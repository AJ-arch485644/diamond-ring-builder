'use strict';
const {problem} = require('./owned-diamond-cart');

// Orders remain authoritative while an in-place supplier import is running.
// Read the protected allocation view, never a stale availability flag or cache.
async function assertSupplierUnreserved(supabase, sku) {
  const {data, error} = await supabase.schema('ops').from('supplier_order_reservations')
    .select('sku').eq('sku', sku).limit(1);
  if (error || !Array.isArray(data)) throw problem('CATALOG_TEMPORARILY_UNAVAILABLE', 503);
  if (data.length) throw problem('DIAMOND_UNAVAILABLE', 409);
}

module.exports = {assertSupplierUnreserved};
