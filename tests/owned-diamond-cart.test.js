'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOwnedDiamond, assertNativeVariant } = require('../lib/owned-diamond-cart');
const { createHandler } = require('../api/create-product');
const { diamondTitle } = require('../lib/diamond-title');
const { storefrontUrl } = require('../lib/catalog-links');

function fixture() {
  const stone = {id:'stone-1',sku:'MB25-74',shop_domain:'060481-3.myshopify.com',product_id:'gid://shopify/Product/10',variant_id:'gid://shopify/ProductVariant/20',inventory_item_id:'gid://shopify/InventoryItem/30',location_id:'gid://shopify/Location/81035493692',desired_price:418.08,observed_quantity:1,product_deleted_at:null,lifecycle:'owned',publish_intent:'active',physically_held:true,observed_product_status:'ACTIVE',observed_published:true,availability_blocked:false};
  const visible = {sku:stone.sku,inventory_source:'owned',is_diyona_select:true,shopify_product_id:'10',shopify_variant_id:'20',price_usd:418.08};
  const data = {shop:{currencyCode:'USD'},productVariant:{id:stone.variant_id,legacyResourceId:'20',sku:stone.sku,price:'418.08',inventoryPolicy:'DENY',inventoryItem:{id:stone.inventory_item_id,tracked:true,inventoryLevel:{quantities:[{name:'available',quantity:1}]}},product:{id:stone.product_id,legacyResourceId:'10',title:'3.05ct Radiant G VVS2 Lab Diamond',status:'ACTIVE',onlineStoreUrl:'https://diyona.com/products/owned',publishedOnPublication:true,tags:['diyona-select'],stoneId:{value:stone.id},inventorySource:{value:'owned'},variants:{nodes:[{id:stone.variant_id}]}}}};
  return {stone,visible,data};
}
function client(results, calls=[]) {
  return {schema(name){assert.equal(name,'ops');return this;},from(table){calls.push(table);const query={};for(const method of ['select','eq','limit'])query[method]=()=>query;query.then=(yes,no)=>Promise.resolve(table==='supplier_order_reservations'?{data:[]}:results.shift()).then(yes,no);return query;}};
}
function response() { return {headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;},end(){return this;}}; }

test('owned mapped variant is reused after private/public/native validation with no creation',async()=>{
  const {stone,visible,data}=fixture();const tables=[];let reads=0;
  const result=await resolveOwnedDiamond({supabase:client([{data:[stone]},{data:[visible]}],tables),sku:stone.sku,shop:stone.shop_domain,shopify:{graphql:async(query,variables)=>{reads++;assert.equal(variables.id,stone.variant_id);assert.equal(variables.location,stone.location_id);assert.doesNotMatch(query,/mutation/);return data;}}});
  assert.deepEqual(tables,['dio_select_test_stones','public_diamonds']);assert.equal(reads,1);assert.equal(result.variant_id,20);assert.equal(result.shipping_days,1);assert.equal(result.is_diyona_select,true);
});
test('only genuinely unknown owned identity returns null for supplier path',async()=>{
  assert.equal(await resolveOwnedDiamond({supabase:client([{data:[]}]),sku:'supplier',shop:'060481-3.myshopify.com'}),null);
  await assert.rejects(resolveOwnedDiamond({supabase:client([{error:{message:'private database error'}}]),sku:'supplier',shop:'060481-3.myshopify.com'}),/CATALOG_TEMPORARILY_UNAVAILABLE/);
});
test('hidden and non-sellable owned identities fail closed before Shopify lookup',async()=>{
  for(const patch of [{lifecycle:'sandbox'},{publish_intent:'draft'},{publish_intent:'withdrawn'},{physically_held:false},{observed_product_status:'DRAFT'},{observed_published:false},{observed_quantity:0},{availability_blocked:true},{desired_price:null},{product_deleted_at:'2026-10-28'}]) {
    const {stone}=fixture();await assert.rejects(resolveOwnedDiamond({supabase:client([{data:[{...stone,...patch}]}]),sku:stone.sku,shop:stone.shop_domain}),/DIAMOND_UNAVAILABLE/);
  }
  const {stone}=fixture();await assert.rejects(resolveOwnedDiamond({supabase:client([{data:[stone]},{data:[]}]),sku:stone.sku,shop:stone.shop_domain}),/DIAMOND_UNAVAILABLE/);
});
test('native recheck rejects wrong mapping, ambiguous variant and counterfeit source',()=>{
  for(const edit of [d=>d.productVariant.sku='other',d=>d.productVariant.id='gid://shopify/ProductVariant/21',d=>d.productVariant.inventoryItem.id='gid://shopify/InventoryItem/31',d=>d.productVariant.product.id='gid://shopify/Product/11',d=>d.productVariant.product.stoneId.value='other',d=>d.productVariant.product.inventorySource.value='supplier',d=>d.productVariant.product.tags=[],d=>d.productVariant.product.variants.nodes.push({id:'gid://shopify/ProductVariant/22'})]) {
    const {stone,visible,data}=fixture();edit(data);assert.throws(()=>assertNativeVariant(data,stone,visible),/OWNED_MAPPING_MISMATCH/);
  }
});
test('native stock, tracking, publication and price all fail closed',()=>{
  for(const edit of [d=>d.productVariant.inventoryItem.inventoryLevel.quantities[0].quantity=0,d=>d.productVariant.inventoryItem.inventoryLevel.quantities[0].quantity=2,d=>d.productVariant.inventoryItem.tracked=false,d=>d.productVariant.inventoryPolicy='CONTINUE',d=>d.productVariant.product.status='DRAFT',d=>d.productVariant.product.onlineStoreUrl=null,d=>d.productVariant.product.publishedOnPublication=false]) {
    const {stone,visible,data}=fixture();edit(data);assert.throws(()=>assertNativeVariant(data,stone,visible),/DIAMOND_UNAVAILABLE/);
  }
  for(const edit of [d=>d.productVariant.price='418.09',d=>d.shop.currencyCode='CAD']) {
    const {stone,visible,data}=fixture();edit(data);assert.throws(()=>assertNativeVariant(data,stone,visible),/OWNED_PRICE_NOT_SYNCED/);
  }
});
test('public mapping drift and native API failures never fall through',async()=>{
  const {stone,visible}=fixture();
  await assert.rejects(resolveOwnedDiamond({supabase:client([{data:[stone]},{data:[{...visible,shopify_variant_id:'21'}]}]),sku:stone.sku,shop:stone.shop_domain}),/OWNED_MAPPING_MISMATCH/);
  await assert.rejects(resolveOwnedDiamond({supabase:client([{data:[stone]},{data:[visible]}]),sku:stone.sku,shop:stone.shop_domain,shopify:{graphql:async()=>{throw Error('OWNED_COMMERCE_UNAVAILABLE');}}}),/OWNED_COMMERCE_UNAVAILABLE/);
});
test('cart owned error prevents supplier reads and creation; errors are safe and no-store',async()=>{
  let supplierCalls=0;const handler=createHandler({getClient:()=>({from(){supplierCalls++;throw Error('unexpected');}}),resolveOwned:async()=>{const error=new Error('upstream private response');error.code='DIAMOND_UNAVAILABLE';error.status=404;throw error;},env:{SHOPIFY_STORE:'060481-3.myshopify.com'}});
  const res=response();await handler({method:'GET',query:{sku:'MB25-74'}},res);
  assert.equal(res.statusCode,404);assert.deepEqual(res.body,{error:'DIAMOND_UNAVAILABLE'});assert.equal(supplierCalls,0);assert.equal(res.headers['Vercel-CDN-Cache-Control'],'no-store');
});
test('owned cart returns existing numeric identity and preserves Loose customs intent only',async()=>{
  const calls=[];const handler=createHandler({getClient:()=>({}),resolveOwned:async()=>({shopify_id:10,variant_id:20,inventory_item_id:30,title:'Diamond',reused:true,inventory_source:'owned',is_diyona_select:true,shipping_days:1}),setOwnedHS:async(...args)=>calls.push(args),setHS:async()=>assert.fail('owned must not use supplier token'),createSupplier:async()=>assert.fail('must not create'),setShipping:async()=>assert.fail('dispatch is already synced'),env:{SHOPIFY_STORE:'060481-3.myshopify.com'}});
  const res=response();await handler({method:'POST',body:{sku:'MB25-74',type:'Loose',price:1,is_diyona_select:false}},res);
  assert.equal(res.statusCode,200);assert.equal(res.body.variant_id,20);assert.equal('inventory_item_id' in res.body,false);assert.deepEqual(calls,[[30,'7104.91']]);
});
test('supplier path reads only visible supplier row and preserves existing create flow',async()=>{
  const tables=[];const calls=[];const handler=createHandler({getClient:()=>client([{data:[{sku:'SUP-1',inventory_source:'supplier',price_usd:500,max_delivery_days:6}]}],tables),resolveOwned:async()=>null,findSupplierVariant:async()=>null,createSupplier:async(d,type)=>{calls.push(['create',d.sku,type]);return{id:11,title:'Supplier',variants:[{id:21,inventory_item_id:31}]};},setShipping:async(...args)=>calls.push(['shipping',...args]),setHS:async(...args)=>calls.push(['hs',...args]),env:{SHOPIFY_STORE:'060481-3.myshopify.com'}});
  const res=response();await handler({method:'GET',query:{sku:'SUP-1'}},res);assert.equal(res.statusCode,200);assert.deepEqual(tables,['public_diamonds','supplier_order_reservations','supplier_order_reservations']);assert.deepEqual(calls,[['create','SUP-1','Ring'],['shipping',21,6],['hs',31,'7113.19']]);assert.equal(res.body.is_diyona_select,false);
});
test('title and product links keep owned stock codes out of customer-facing titles and slug parsing',()=>{
  assert.equal(diamondTitle({carat:'3.050',shape:'Radiant',color:'G',clarity:'VVS2',sku:'MB25-74'}),'3.05ct Radiant G VVS2 Lab Diamond');
  assert.equal(storefrontUrl({inventory_source:'owned',product_handle:'diamond-mb25-74',sku:'MB25-74'}),'https://diyona.com/products/diamond-mb25-74');
  assert.equal(storefrontUrl({inventory_source:'supplier',sku:'SUP-1'}),'https://diyona.com/pages/diamond-detail?sku=SUP-1');
  assert.throws(()=>diamondTitle({carat:0,shape:'Round',color:'D',clarity:'VS1'}));
});
