'use strict';
const SITE_URL = 'https://diyona.com';
function storefrontUrl(stone) {
  if (stone.inventory_source === 'owned' && typeof stone.product_handle === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(stone.product_handle)) {
    return SITE_URL + '/products/' + stone.product_handle;
  }
  return SITE_URL + '/pages/diamond-detail?sku=' + encodeURIComponent(stone.sku);
}
module.exports = { storefrontUrl };
