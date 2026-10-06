'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const {createClient, createBrowserTransport} = require('../theme/assets/diyona-cart-share');
const contract = require('../lib/cart-share-contract');
const TOKEN = 'z'.repeat(43);
const clone = value => JSON.parse(JSON.stringify(value));
const product = (id=12345, properties={}) => ({key:id+':key',variant_id:id,sku:'SKU-'+id,quantity:1,properties});
function setup() {
  const h = {time:Date.parse('2026-10-06T18:00:00Z'),revision:1,context:'US|USD|cart',busy:false,ready:true,locked:false,
    cart:{token:'recipient-token',currency:'USD',note:'',attributes:{},items:[]}, reads:0, adds:0, prepares:0, creates:0, writes:[], receipts:new Map()};
  h.lines = contract.normalizeCart({currency:'USD',items:[product(12345,{'Ring Size':'','_needs_ring_size':'true'})]}).lines;
  h.transport = {
    async getCart() { h.reads++; if(h.failRead) throw Error('offline'); return clone(h.cart); },
    async createShare() { h.creates++; return {token:TOKEN,expiresAt:new Date(h.time+60000).toISOString()}; },
    async prepareShare(token,context) { h.prepares++; return {preparation:{version:1,id:'reviewed',country:context.country,currency:context.currency,
      expiresAt:new Date(h.time+120000).toISOString(),lines:clone(h.lines),attributes:{},prices:h.lines.map((line,index)=>({lineIndex:index,variantId:line.variantId,quantity:line.quantity,unitPrice:{amount:'50.00',currencyCode:context.currency}})),priceLocked:false,availabilityConfirmed:false}}; },
    async addItems(items) { h.adds++; h.writes.push(clone(items)); h.cart.items=items.map((line,index)=>({key:line.id+':'+index,variant_id:Number(line.id),sku:h.lines[index].sku,quantity:line.quantity,properties:clone(line.properties)})); },
    async getShare() { return {}; }
  };
  h.options = {enabled:true,transport:h.transport,crypto,now:()=>h.time,pendingTimeoutMs:1000,
    wait:async ms=>{h.time+=ms;if(h.onWait)await h.onWait(ms);},
    journal:{get:k=>h.receipts.get(k),set:(k,v)=>h.receipts.set(k,v)},
    coordinator:{state:()=>({ready:h.ready,busy:h.busy,revision:h.revision,context:h.context}),exclusive:async fn=>{assert.equal(h.locked,false);h.locked=true;try{return await fn();}finally{h.locked=false;}}}};
  h.client=createClient(h.options); h.prepare=()=>h.client.prepare(TOKEN,{country:'US',currency:'USD'});return h;
}

test('pending source releases writer barrier so its producer can settle',async()=>{
  const h=setup();h.cart.items=[product(51975403077948,{_pending_diamond_id:'pending'})];let producerRuns=0;
  h.onWait=async()=>{if(!h.locked){producerRuns++;h.cart.items=[product()];h.revision++;}};
  assert.equal((await h.client.capture()).token,TOKEN);assert.equal(producerRuns,1);assert.equal(h.adds,0);
});

test('busy producer is awaited outside lock and missing initial sentinel is not shared',async()=>{
  const h=setup();h.cart.items=[product()];h.busy=true;
  h.onWait=async()=>{if(h.busy){assert.equal(h.locked,false);h.busy=false;h.cart.items=[product(54321)];}};
  assert.equal((await h.client.capture()).token,TOKEN);assert.equal(h.creates,1);
});

test('navigation while waiting for producer aborts without sharing either context',async()=>{
  const h=setup();h.busy=true;h.cart.items=[product()];h.onWait=async()=>{h.context='CA|CAD|cart';h.busy=false;};
  await assert.rejects(h.client.capture(),{code:'CART_CHANGED'});assert.equal(h.creates,0);assert.equal(h.reads,0);
});

test('server snapshot save is never replayed when final validation becomes busy',async()=>{
  const h=setup();h.cart.items=[product()];h.transport.createShare=async()=>{h.creates++;h.busy=true;return {token:TOKEN,expiresAt:new Date(h.time+60000).toISOString()};};
  await assert.rejects(h.client.capture(),{code:'CART_BUSY'});assert.equal(h.creates,1);
});

test('prepare fails closed for invalid authoritative response lines before cart write',async()=>{
  for(const mutate of [
    line=>{line.variantId='51975403077948';},
    line=>{line.quantity=-1;},
    line=>{line.properties._pending_diamond_id='pending';},
    line=>{line.properties['Unexpected HTML']='<img src=x onerror=alert(1)>';},
    line=>{line.groupId='spoofed-ring';},
    line=>{line.kind='diamond';},
    line=>{line.variantId=12345;}
  ]) {
    const h=setup();mutate(h.lines[0]);await assert.rejects(h.prepare(),{code:'INVALID_PREPARATION'});assert.equal(h.adds,0);
  }
});

test('prepare rejects a response body changed to malformed partial ring',async()=>{
  const h=setup();h.lines[0].properties={_ring_builder:'true','Paired Diamond':'1ct round','Diamond SKU':'STONE'};
  h.lines[0].kind='setting';await assert.rejects(h.prepare(),{code:'INVALID_PREPARATION'});assert.equal(h.adds,0);
});

test('readback rejects wrong native SKU even with exact imported properties',async()=>{
  const h=setup();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);h.cart.items[0].sku='DIFFERENT';};
  const handle=await h.prepare();await assert.rejects(h.client.restore(handle),{code:'RESTORE_PARTIAL'});assert.equal(h.adds,1);
  await assert.rejects(h.client.restore(handle),{code:'RESTORE_PARTIAL'});assert.equal(h.adds,1);
});

test('readback rejects unrequested selling plans and native component relationships',async()=>{
  for(const extra of [{selling_plan_allocation:{selling_plan:{id:7}}},{selling_plan:7},{parent_relationship:{parent_key:'parent'}},{item_components:[{}]}]) {
    const h=setup();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);Object.assign(h.cart.items[0],extra);};
    const handle=await h.prepare();await assert.rejects(h.client.restore(handle),{code:'RESTORE_PARTIAL'});assert.equal(h.adds,1);
  }
});

test('readback refuses additional recipient lines without removing them or replaying',async()=>{
  const h=setup();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);h.cart.items.push(product(44444));};
  const handle=await h.prepare();await assert.rejects(h.client.restore(handle),{code:'RESTORE_PARTIAL'});assert.equal(h.cart.items.length,2);assert.equal(h.adds,1);
});

test('readback refuses dropped missing-size marker but accepts dropped empty size only',async()=>{
  const h=setup();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);delete h.cart.items[0].properties._needs_ring_size;};
  const handle=await h.prepare();await assert.rejects(h.client.restore(handle),{code:'RESTORE_PARTIAL'});assert.equal(h.adds,1);
});

test('uncertain successful restore can recover read-only after reload and preparation expiry',async()=>{
  const h=setup();const handle=await h.prepare(),add=h.transport.addItems;
  h.transport.addItems=async items=>{await add(items);h.failRead=true;throw Error('lost response');};
  await assert.rejects(h.client.restore(handle),{code:'RESTORE_UNCERTAIN'});
  h.failRead=false;h.time+=300000;h.client=createClient(h.options);const beforeJournal=clone([...h.receipts]);
  const result=await h.client.recover(TOKEN);assert.equal(result.recovered,true);assert.equal(result.checkoutReady,false);
  assert.equal(h.adds,1);assert.equal(h.prepares,1);assert.deepEqual([...h.receipts],beforeJournal);
});

test('read-only recover never converts absent, unknown or partial receipt into a new add',async()=>{
  const h=setup();await assert.rejects(h.client.recover(TOKEN),{code:'RESTORE_NOT_FOUND'});assert.equal(h.adds,0);
  const handle=await h.prepare();h.transport.addItems=async()=>{h.adds++;throw Error('timeout');};
  await assert.rejects(h.client.restore(handle),{code:'RESTORE_UNCERTAIN'});
  h.client=createClient(h.options);await assert.rejects(h.client.recover(TOKEN),{code:'RESTORE_UNCERTAIN'});assert.equal(h.adds,1);
});

test('read-only recovery requires same cart identity and native currency',async()=>{
  const h=setup();await h.client.restore(await h.prepare());h.cart.currency='CAD';
  await assert.rejects(h.client.recover(TOKEN),{code:'RESTORE_UNCERTAIN'});h.cart.currency='USD';h.cart.token='new-cart';
  await assert.rejects(h.client.recover(TOKEN),{code:'RESTORE_NOT_FOUND'});assert.equal(h.adds,1);
});

test('stale read across recovery contexts cannot claim success',async()=>{
  const h=setup();await h.client.restore(await h.prepare());const read=h.transport.getCart;
  h.transport.getCart=async()=>{const result=await read();h.revision++;return result;};
  await assert.rejects(h.client.recover(TOKEN),{code:'CART_CHANGED'});assert.equal(h.adds,1);
});

test('known recipient attribution survives restore and is never sent to Ajax add payload',async()=>{
  const h=setup();h.cart.attributes={_utm_source:'recipient-ad',_visitor_id:'recipient-id'};
  const result=await h.client.restore(await h.prepare());assert.deepEqual(result.cart.attributes,{_utm_source:'recipient-ad',_visitor_id:'recipient-id'});
  assert.ok(!JSON.stringify(h.writes).includes('recipient-ad'));assert.ok(!JSON.stringify(h.writes).includes('recipient-id'));
  assert.equal((await h.client.recover(TOKEN)).alreadyRestored,true);
});

test('unexpected attribution removal during add is uncertain and never silently accepted',async()=>{
  const h=setup();h.cart.attributes={_utm_source:'recipient-ad'};const add=h.transport.addItems;
  h.transport.addItems=async items=>{await add(items);h.cart.attributes={};};
  await assert.rejects(h.client.restore(await h.prepare()),{code:'RESTORE_UNCERTAIN'});assert.equal(h.adds,1);
});

test('same recipient notes and unsupported properties remain untouched on refusal',async()=>{
  const h=setup();h.cart.note='gift note';h.cart.attributes={_utm_source:'source'};
  await assert.rejects(h.prepare(),{code:'DESTINATION_METADATA_PRESENT'});assert.equal(h.cart.note,'gift note');assert.equal(h.adds,0);
});

test('restore group ownership is fresh and shared only across members of each ring',async()=>{
  const h=setup();const members=[];
  for(let n=1;n<=2;n++) {
    const sku='STONE-'+n;
    members.push({...product(100+n),sku,properties:{_ring_builder:'true',_ring_type:'Ring',_diamond_sku:sku,'Paired Setting':'Setting','Ring Size':'US 7¼',_diy_operation_v1:'source-op-'+n}});
    members.push({...product(200+n),properties:{_ring_builder:'true','Paired Diamond':'Round','Diamond SKU':sku,'Ring Size':'US 7¼',_diy_operation_v1:'source-op-'+n}});
  }
  h.lines=contract.normalizeCart({currency:'USD',items:members}).lines;
  await h.client.restore(await h.prepare());const props=h.writes[0].map(line=>line.properties);
  assert.equal(props[0]._diy_operation_v1,props[1]._diy_operation_v1);assert.equal(props[2]._diy_operation_v1,props[3]._diy_operation_v1);
  assert.notEqual(props[0]._diy_operation_v1,props[2]._diy_operation_v1);assert.ok(props.every(p=>!p._diy_operation_v1.startsWith('source-op')));
  assert.equal(new Set(props.map(p=>p._diy_share_import_v1)).size,1);assert.equal(new Set(props.map(p=>p._diy_share_line_v1)).size,4);
});

test('secure randomness and durable receipt storage are required before Ajax mutation',async()=>{
  const h=setup();h.options.crypto={};h.client=createClient(h.options);await assert.rejects(h.client.restore(await h.prepare()),{code:'SECURE_CRYPTO_REQUIRED'});assert.equal(h.adds,0);
});

test('browser transport rejects credential/query injection and off-origin cart roots',()=>{
  for(const apiUrl of ['http://example.test/cart','https://user:pass@example.test/cart','https://example.test/cart?key=secret','https://example.test/cart#token']) assert.throws(()=>createBrowserTransport({apiUrl}),{code:'INVALID_API_URL'});
  for(const root of ['//example.test/','/../','/en%2fca/','https://example.test/']) assert.throws(()=>createBrowserTransport({apiUrl:'https://example.test/api',root}),{code:'INVALID_CART_ROOT'});
});
