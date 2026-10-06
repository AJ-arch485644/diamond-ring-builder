'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {createService,createHandler}=require('../lib/cart-share-service');
const {createClient}=require('../theme/assets/diyona-cart-share');
const clone=x=>JSON.parse(JSON.stringify(x));
function system() {
  const h={now:Date.parse('2026-10-06T20:00:00Z'),records:new Map(),catalogReads:0,supplierReads:0,rateCalls:0};
  h.rows=[{sku:'STONE',availability:'available',carat:2,shape:'Round',color:'E',clarity:'VS1',lab:'IGI',certificate_number:'123456'}];
  const spec=[['111','SETTING','setting','Engagement Ring'],['222','STONE','diamond','Diamond'],['333','ENGRAVING-FEE','diamond','Diamond'],['444','NECKLACE','necklace-pdp','Necklace']];
  h.catalog=spec.map(([id,sku,template,type])=>({id:'gid://shopify/ProductVariant/'+id,legacyResourceId:id,sku,requiresComponents:false,inventoryQuantity:10,inventoryPolicy:'DENY',
    inventoryItem:{tracked:true,harmonizedSystemCode:'711319'},product:{status:'ACTIVE',onlineStoreUrl:'https://diyona.com/products/item-'+id,publishedInContext:true,productType:type,
      templateSuffix:template,title:id==='333'?'Engraving Fee':id==='111'?'Classic Solitaire':'Native Item',handle:id==='333'?'engraving-fee':'item-'+id,vendor:'Diyona',requiresSellingPlan:false},
    contextualPricing:{price:{amount:id==='222'?'1200.00':'50.00',currencyCode:'CAD'}}}));
  const store={insert:async r=>h.records.set(r.token_hash,clone(r)),read:async key=>clone(h.records.get(key)||null),consumeRate:async()=>{h.rateCalls++;return true;}};
  h.service=createService({store,now:()=>h.now,supplier:{read:async()=>{h.supplierReads++;return clone(h.rows);}},catalog:{read:async()=>{h.catalogReads++;return clone(h.catalog);}},engravingVariantId:'333'});
  const env={CART_SHARE_ENABLED:'true',CART_SHARE_ALLOWED_ORIGINS:'["https://diyona.com"]',CART_SHARE_RATE_SECRET:'s'.repeat(32),SHOPIFY_STORE:'diyona.myshopify.com'};
  h.handler=createHandler({env,dependencies:()=>({store,service:h.service})});
  async function api(method,body,query) {
    const res={status(s){this.statusCode=s;return this;},setHeader(){},json(value){this.value=value;return this;},end(){}};
    await h.handler({method,body,query,headers:{origin:'https://diyona.com','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}},res);
    if(res.statusCode>=400)throw Object.assign(new Error(res.value.error),{code:res.value.error});
    return clone(res.value);
  }
  h.client=(cart)=>{
    const c={cart:clone(cart),adds:0,journal:new Map()};
    const transport={getCart:async()=>clone(c.cart),createShare:snapshot=>api('POST',{action:'create',snapshot}),getShare:token=>api('GET',undefined,{token}),
      prepareShare:(token,context)=>api('POST',{action:'prepare',token,...context}),addItems:async items=>{c.adds++;c.cart.items=items.map(i=>({key:i.id+':native-key',variant_id:Number(i.id),quantity:i.quantity,properties:clone(i.properties),sku:spec.find(s=>s[0]===i.id)[1]}));}};
    c.sdk=createClient({enabled:true,transport,crypto:webcrypto,now:()=>h.now,wait:async ms=>{h.now+=ms;},journal:{get:k=>c.journal.get(k),set:(k,v)=>c.journal.set(k,v)},
      coordinator:{state:()=>({ready:true,busy:false,revision:1,context:'cart-'+cart.token}),exclusive:fn=>fn()}});
    return c;
  };
  return h;
}
const line=(id,sku,properties)=>({variant_id:id,sku,quantity:1,key:id+':source',properties});
function sender() {return {token:'never-share-this-sender-cart',currency:'USD',note:'',attributes:{_visitor_id:'private-tracking',_landing_url:'https://private.example'},items:[
  line(111,'SETTING',{_ring_builder:'true','Paired Diamond':'Old description','Diamond SKU':'STONE','Ring Size':'','Custom Engraving':'Forever',_diy_operation_v1:'sender-cancelled-op','Ship by':'old-date'}),
  line(222,'STONE',{_ring_builder:'true',_ring_type:'Ring',_diamond_sku:'STONE','Paired Setting':'Old name','Ring Size':'',_engraving:'Old engraving',_diy_operation_v1:'sender-cancelled-op'}),
  line(333,'ENGRAVING-FEE',{_ring_builder:'true',_diamond_sku:'STONE','Engraving Text':'Forever',_diy_operation_v1:'sender-cancelled-op'}),
  line(444,'NECKLACE',{'Chain Length':'18 in'})]};}
test('full API and SDK round trip preserves an unsized engraved ring plus chain across recipient markets',async()=>{
  const h=system(),source=h.client(sender());
  const share=await source.sdk.capture();assert.equal(h.records.size,1);assert.equal(source.adds,0);assert.equal(h.catalogReads,0);
  const stored=JSON.stringify([...h.records.values()]);
  for(const secret of ['never-share-this-sender-cart','sender-cancelled-op','private-tracking','old-date',share.token])assert.ok(!stored.includes(secret));
  const dest=h.client({token:'recipient',currency:'CAD',note:'',attributes:{_visitor_id:'recipient-tracking'},items:[]});
  await dest.sdk.preview(share.token);assert.equal(dest.adds,0);assert.equal(h.supplierReads,0);
  const prepared=await dest.sdk.prepare(share.token,{country:'CA',currency:'CAD'});assert.equal(dest.adds,0);
  assert.equal(prepared.prices[1].unitPrice.currencyCode,'CAD');assert.equal(prepared.lines[1].properties.Certificate,'IGI 123456');
  assert.equal(prepared.lines[1].properties['Paired Setting'],'Classic Solitaire');assert.equal(prepared.lines[1].properties._engraving,'Forever');
  const result=await dest.sdk.restore(prepared);assert.equal(result.checkoutReady,false);assert.equal(dest.adds,1);assert.equal(result.cart.items.length,4);
  assert.equal(result.cart.items[0].properties['Ring Size'],'');assert.equal(result.cart.items[1].properties['Ring Size'],'');
  assert.equal(result.cart.items[3].properties['Chain Length'],'18 in');assert.equal(result.cart.attributes._visitor_id,'recipient-tracking');
  const operations=result.cart.items.map(i=>i.properties._diy_operation_v1);assert.equal(operations[0],operations[1]);assert.equal(operations[1],operations[2]);assert.notEqual(operations[2],operations[3]);
  assert.equal((await dest.sdk.recover(share.token)).recovered,true);assert.equal(dest.adds,1);
  assert.deepEqual((await h.service.read(share.token)).snapshot,share.snapshot); // Hydration did not alter immutable record.
});
test('supplier deletion after sharing leaves readable link but blocks the entire recipient add',async()=>{
  const h=system(),source=h.client(sender()),share=await source.sdk.capture();h.rows=[];
  const dest=h.client({token:'recipient',currency:'CAD',note:'',attributes:{},items:[]});
  assert.equal((await dest.sdk.preview(share.token)).snapshot.lines.length,4);
  await assert.rejects(dest.sdk.prepare(share.token,{country:'CA',currency:'CAD'}),{code:'DIAMOND_UNAVAILABLE'});assert.equal(dest.adds,0);
});
