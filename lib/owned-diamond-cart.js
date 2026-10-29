'use strict';

const { ownedShopify, SHOP, API_VERSION } = require('./owned-shopify');
const READ_VARIANT = `query OwnedCartVariant($id:ID!,$location:ID!){
  shop { currencyCode }
  productVariant(id:$id){id legacyResourceId sku price inventoryPolicy
    inventoryItem{id tracked harmonizedSystemCode countryCodeOfOrigin inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}
    product{id legacyResourceId title handle status onlineStoreUrl tags
      publishedOnPublication(publicationId:"gid://shopify/Publication/135477526844")
      stoneId:metafield(namespace:"dio_select_test",key:"stone_id"){value}
      inventorySource:metafield(namespace:"diyona_inventory",key:"source"){value}
      variants(first:2){nodes{id}}
    }
  }
}`;
function problem(code, status = 409) { const error = new Error(code); error.code = code; error.status = status; return error; }
function gid(type, value) {
  const text = String(value ?? '');
  const match = text.match(new RegExp(`^(?:gid://shopify/${type}/)?([1-9][0-9]*)$`));
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw problem('OWNED_MAPPING_INVALID');
  return { gid: `gid://shopify/${type}/${match[1]}`, numeric: Number(match[1]) };
}
function sameMoney(a, b) {
  return Number.isFinite(Number(a)) && Number(a) > 0 && Number.isFinite(Number(b)) && Number(b) > 0 &&
    Math.abs(Number(a) - Number(b)) < 0.000001;
}
async function exactlyOne(query, code) {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw problem('CATALOG_TEMPORARILY_UNAVAILABLE', 503);
  if (data.length > 1) throw problem(code);
  return data[0] || null;
}
function assertNativeVariant(data, stone, visible, type = 'Ring') {
  if (!['Ring', 'Loose'].includes(type)) throw problem('INVALID_PURCHASE_TYPE', 400);
  const variant = data?.productVariant;
  const product = variant?.product;
  const variantId = gid('ProductVariant', stone.variant_id);
  const productId = gid('Product', stone.product_id);
  const itemId = gid('InventoryItem', stone.inventory_item_id);
  if (!variant || variant.id !== variantId.gid || String(variant.legacyResourceId) !== String(variantId.numeric) ||
      variant.sku !== stone.sku || variant.inventoryItem?.id !== itemId.gid ||
      !product || product.id !== productId.gid || String(product.legacyResourceId) !== String(productId.numeric) ||
      product.stoneId?.value !== stone.id || product.inventorySource?.value !== 'owned' || !product.tags?.includes('diyona-select') ||
      product.variants?.nodes?.length !== 1 || product.variants.nodes[0].id !== variantId.gid) {
    throw problem('OWNED_MAPPING_MISMATCH');
  }
  if (product.status !== 'ACTIVE' || product.publishedOnPublication !== true || typeof product.onlineStoreUrl !== 'string' || !product.onlineStoreUrl.startsWith('https://') ||
      variant.inventoryPolicy !== 'DENY' || variant.inventoryItem.tracked !== true ||
      variant.inventoryItem.inventoryLevel?.quantities?.find(row => row.name === 'available')?.quantity !== 1) {
    throw problem('DIAMOND_UNAVAILABLE', 404);
  }
  // A stale catalog or a competing Shopify price edit must reconcile before cart.
  // This is the base USD price; contextual market pricing remains Shopify's job.
  if (data.shop?.currencyCode !== 'USD' || !sameMoney(variant.price, stone.desired_price) || !sameMoney(variant.price, visible.price_usd)) {
    throw problem('OWNED_PRICE_NOT_SYNCED');
  }
  const dispatchDays = Number(stone.dispatch_business_days);
  if (stone.dispatch_business_days == null || !Number.isInteger(dispatchDays) || dispatchDays < 0 || dispatchDays > 30) {
    throw problem('OWNED_CATALOG_NOT_READY');
  }
  const expectedHS = type === 'Loose' ? '710491' : '711319';
  const revision = Number(stone.revision);
  return { shopify_id: productId.numeric, variant_id: variantId.numeric,
    shopify_product_id: productId.numeric, shopify_variant_id: variantId.numeric, sku: stone.sku,
    inventory_item_id: itemId.numeric, title: product.title, reused: true,
    inventory_source: 'owned', is_diyona_select: true, price_usd: Number(variant.price),
    shipping_days: dispatchDays, min_delivery_days: dispatchDays, max_delivery_days: dispatchDays,
    product_handle: product.handle || null,
    catalog_revision: stone.revision != null && Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
    needs_hs_update: String(variant.inventoryItem.harmonizedSystemCode || '').replace('.', '') !== expectedHS ||
      variant.inventoryItem.countryCodeOfOrigin !== 'IN' };
}

// null means the identity is not owned. Every other owned failure throws, so
// unavailable/draft/test stones can never fall through to supplier creation.
async function resolveOwnedDiamond({ supabase, sku, shop, type = 'Ring', expectOwned = false, shopify = ownedShopify }) {
  const privateRead = exactlyOne(supabase.from('dio_select_test_stones')
    .select('id,sku,shop_domain,product_id,variant_id,inventory_item_id,location_id,desired_price,observed_quantity,product_deleted_at,lifecycle,publish_intent,physically_held,observed_product_status,observed_published,availability_blocked,dispatch_business_days,revision')
    .eq('sku', sku).limit(2), 'OWNED_IDENTITY_AMBIGUOUS');
  const readVisible = () => exactlyOne(supabase.from('public_diamonds')
      .select('sku,inventory_source,is_diyona_select,shopify_product_id,shopify_variant_id,price_usd')
      .eq('sku', sku).eq('inventory_source', 'owned').limit(2), 'OWNED_IDENTITY_AMBIGUOUS');
  let stone, publicResult;
  if (expectOwned) {
    // The client hint only enables parallel reads and forbids supplier fallback.
    // Private identity still decides ownership; both reads must succeed for sale.
    const results = await Promise.allSettled([privateRead, readVisible()]);
    if (results[0].status === 'rejected') throw results[0].reason;
    stone = results[0].value;
    publicResult = results[1];
  } else {
    // Preserve the supplier path's original single private identity lookup.
    stone = await privateRead;
  }
  if (!stone) {
    if (expectOwned) throw problem('DIAMOND_UNAVAILABLE', 404);
    return null;
  }
  if (shop !== SHOP) throw problem('OWNED_COMMERCE_UNAVAILABLE',503);
  if (stone.sku !== sku || stone.shop_domain !== shop || stone.product_deleted_at || stone.observed_quantity !== 1 || !sameMoney(stone.desired_price, stone.desired_price) ||
      stone.lifecycle !== 'owned' || stone.publish_intent !== 'active' || stone.physically_held !== true ||
      stone.observed_product_status !== 'ACTIVE' || stone.observed_published !== true || stone.availability_blocked !== false) {
    throw problem('DIAMOND_UNAVAILABLE', 404);
  }
  // The public projection is the single eligibility contract (receipt, approval,
  // publish state, conflicts and stock). Private identity above remains
  // authoritative even when the stone is absent from this public view.
  if (publicResult?.status === 'rejected') throw publicResult.reason;
  const visible = publicResult ? publicResult.value : await readVisible();
  if (!visible || visible.sku !== sku || visible.inventory_source !== 'owned' || visible.is_diyona_select !== true) throw problem('DIAMOND_UNAVAILABLE', 404);
  const variant = gid('ProductVariant', stone.variant_id);
  if (gid('ProductVariant', visible.shopify_variant_id).gid !== variant.gid || gid('Product', visible.shopify_product_id).gid !== gid('Product', stone.product_id).gid) throw problem('OWNED_MAPPING_MISMATCH');
  const location = gid('Location', stone.location_id);
  const data = await shopify.graphql(READ_VARIANT,{id:variant.gid,location:location.gid});
  return assertNativeVariant(data, stone, visible, type);
}

module.exports = { resolveOwnedDiamond, assertNativeVariant, problem, gid, API_VERSION };
