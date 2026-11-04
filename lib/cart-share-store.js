'use strict';
const { ShareCartError } = require('./cart-share-contract');
function unavailable() { throw new ShareCartError('SHARE_STORAGE_UNAVAILABLE', 503); }
function createStore(db) {
  return {
    async consumeRate(key, limit, windowSeconds) {
      const { data, error } = await db.rpc('cart_share_consume_rate', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error || typeof data !== 'boolean') unavailable();
      return data;
    },
    async insert(record) {
      const { error } = await db.from('cart_shares').insert(record);
      if (error) unavailable();
    },
    async read(tokenHash) {
      const { data, error } = await db.from('cart_shares').select('token_hash,snapshot_hash,payload,created_at,expires_at,revoked_at').eq('token_hash', tokenHash).limit(2);
      if (error || !Array.isArray(data) || data.length > 1) unavailable();
      return data[0] || null;
    }
  };
}
function createSupplier(db) {
  return {
    async read(skus) {
      if (!skus.length) return [];
      const { data, error } = await db.from('diamonds').select('sku,availability,carat,shape,color,clarity,lab,certificate_number').in('sku', skus).limit(skus.length + 1);
      if (error || !Array.isArray(data)) throw new ShareCartError('SUPPLIER_UNAVAILABLE', 503);
      return data;
    }
  };
}
module.exports = { createStore, createSupplier };
