'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertSupplierUnreserved} = require('../lib/supplier-reservations');
const {createHandler} = require('../api/create-product');
function query(result) {
  const q = {};
  for(const method of ['select','eq','limit']) q[method] = () => q;
  q.then = (yes,no) => Promise.resolve(typeof result === 'function' ? result() : result).then(yes,no);
  return q;
}
function response() {return {setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
test('reservation read failures never treat the supplier as available',async()=>{
  for(const result of [{error:{message:'private failure'}},{data:null},{data:{}}]) {
    const db={schema(name){assert.equal(name,'ops');return {from(table){assert.equal(table,'supplier_order_reservations');return query(result);}};}};
    await assert.rejects(assertSupplierUnreserved(db,'SUP'),error=>error.code==='CATALOG_TEMPORARILY_UNAVAILABLE'&&error.status===503);
  }
});
test('order arriving during Shopify lookup prevents both reuse and new creation',async()=>{
  for(const existing of [null,{shopify_id:10,variant_id:20,inventory_item_id:30}]) {
    let reserved=false,writes=0;
    const db={from:()=>query({data:[{sku:'SUP',inventory_source:'supplier',price_usd:100}]}),schema:()=>({from:()=>query(()=>({data:reserved?[{sku:'SUP'}]:[]}))})};
    const handler=createHandler({getClient:()=>db,resolveOwned:async()=>null,findSupplierVariant:async()=>{reserved=true;return existing;},createSupplier:async()=>{writes++;},setShipping:async()=>{writes++;},setHS:async()=>{writes++;},env:{SHOPIFY_STORE:'060481-3.myshopify.com'}});
    const res=response();await handler({method:'POST',body:{sku:'SUP'}},res);
    assert.equal(res.statusCode,409);assert.deepEqual(res.body,{error:'DIAMOND_UNAVAILABLE'});assert.equal(writes,0);
  }
});
test('an order arriving during supplier preparation prevents a successful cart response',async()=>{
  let reserved=false;
  const db={from:()=>query({data:[{sku:'SUP',inventory_source:'supplier',price_usd:100}]}),schema:()=>({from:()=>query(()=>({data:reserved?[{sku:'SUP'}]:[]}))})};
  const handler=createHandler({getClient:()=>db,resolveOwned:async()=>null,findSupplierVariant:async()=>null,createSupplier:async()=>{reserved=true;return{id:10,title:'SUP',variants:[{id:20,inventory_item_id:30}]};},setShipping:async()=>{},setHS:async()=>{},env:{SHOPIFY_STORE:'060481-3.myshopify.com'}});
  const res=response();await handler({method:'POST',body:{sku:'SUP'}},res);assert.equal(res.statusCode,409);assert.equal(res.body.variant_id,undefined);
});
