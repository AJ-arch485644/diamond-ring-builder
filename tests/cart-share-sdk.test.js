'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const { createClient, createBrowserTransport } = require('../theme/assets/diyona-cart-share');
const token = 'a'.repeat(43);
const copy = value => JSON.parse(JSON.stringify(value));
function item(id = 12345, properties = {}) { return {key:String(id)+':key',variant_id:id,quantity:1,sku:'BAND-'+id,properties}; }
function empty() { return {token:'private-cart-token',currency:'USD',items:[],attributes:{},note:''}; }
function harness(overrides = {}) {
  const h = {time:Date.parse('2026-10-06T18:00:00Z'),revision:0,context:'cart|US|USD',busy:false,ready:true,
    cart:empty(),reads:0,writes:[],created:[],receipts:new Map(),calls:[], pending:null};
  const transport = {
    async getCart() { h.reads++; return copy(h.cart); },
    async createShare(snapshot) { h.created.push(snapshot); return {token,expiresAt:new Date(h.time+86400000).toISOString()}; },
    async getShare(t) { h.calls.push(['preview',t]); return {snapshot:{}}; },
    async prepareShare(t,context) { h.calls.push(['prepare',t]); return {preparation:{version:1,id:'preparation-1',expiresAt:new Date(h.time+120000).toISOString(),
      country:context.country,currency:context.currency,attributes:{},lines:[{variantId:'12345',quantity:1,kind:'product',sku:'BAND-12345',properties:{'Ring Size':''}}],prices:[{lineIndex:0,variantId:'12345',quantity:1,unitPrice:{amount:'50.00',currencyCode:'USD'}}],priceLocked:false,availabilityConfirmed:false}}; },
    async addItems(items) { h.writes.push(copy(items)); h.cart.items=items.map(i=>item(Number(i.id),i.properties)); }
  };
  Object.assign(transport,overrides.transport);
  const journal={get:k=>h.receipts.get(k),set:(k,v)=>h.receipts.set(k,v)};
  const coordinator={state:()=>({revision:h.revision,context:h.context,busy:h.busy,ready:h.ready}),
    exclusive:async fn=> { const prior=h.pending || Promise.resolve(); let release; h.pending=new Promise(r=>release=r); await prior; try {return await fn();} finally {release();} }};
  const options={enabled:true,transport,coordinator,journal,crypto,now:()=>h.time,wait:async ms=>{h.time+=ms;},...overrides.options};
  h.transport=transport; h.options=options; h.client=createClient(options); return h;
}
test('loading and disabled construction never touches cart or network',async()=>{
  const h=harness({options:{enabled:false}});
  await assert.rejects(h.client.capture(),{code:'SHARING_DISABLED'});
  assert.equal(h.reads,0);assert.equal(h.writes.length,0);
});
test('sharing requires explicit complete mutation coordinator',async()=>{
  const h=harness({options:{coordinator:null}});
  await assert.rejects(h.client.capture(),{code:'INTEGRATION_REQUIRED'}); assert.equal(h.reads,0);
});
test('stable capture preserves blank size and sizing requirement without cart writes',async()=>{
  const h=harness();h.cart.items=[item(12345,{'Ring Size':'','_needs_ring_size':'true'})];
  const share=await h.client.capture();assert.equal(share.token,token);
  assert.equal(h.created[0].lines[0].properties['Ring Size'],'');
  assert.equal(h.created[0].lines[0].properties._needs_ring_size,'true');assert.equal(h.writes.length,0);
  assert.ok(!JSON.stringify(h.created).includes('private-cart-token'));
});
test('context change after server save never releases a stale share token',async()=>{
  const h=harness();h.cart.items=[item()];
  h.transport.createShare=async snapshot=>{h.created.push(snapshot);h.context='cart|CA|CAD';return {token,expiresAt:new Date(h.time+5000).toISOString()};};
  await assert.rejects(h.client.capture(),{code:'CART_CHANGED'});assert.equal(h.writes.length,0);
});
test('source changes silently during save are detected by final cart read',async()=>{
  const h=harness();h.cart.items=[item()];
  h.transport.createShare=async()=>{h.cart.items.push(item(67890));return {token,expiresAt:new Date(h.time+5000).toISOString()};};
  await assert.rejects(h.client.capture(),{code:'CART_CHANGED'});
});
test('placeholder is never shared; settled native product is captured after bounded wait',async()=>{
  const h=harness();h.cart.items=[item(51975403077948,{_pending_diamond_id:'pending',_diamond_sku:'STONE'})];
  h.options.wait=async ms=>{h.time+=ms;h.cart.items=[item()];};h.client=createClient(h.options);
  await h.client.capture();assert.equal(h.created[0].lines[0].variantId,'12345');
});
test('unsettled placeholder times out without snapshot or cart write',async()=>{
  const h=harness({options:{pendingTimeoutMs:1000}});h.cart.items=[item(51975403077948)];
  await assert.rejects(h.client.capture(),{code:'CART_PENDING'});assert.equal(h.created.length,0);assert.equal(h.writes.length,0);
});
test('busy before first placeholder exists blocks an incomplete share',async()=>{
  const h=harness();h.busy=true;h.cart.items=[item()];
  await assert.rejects(h.client.capture(),{code:'CART_BUSY'});assert.equal(h.reads,0);
});
test('preview is read-only and cannot import by opening a link',async()=>{
  const h=harness();await h.client.preview(token);assert.deepEqual(h.calls,[['preview',token]]);assert.equal(h.writes.length,0);
});
test('recipient existing bag is preserved with no prepare or add call',async()=>{
  const h=harness();h.cart.items=[item()];
  await assert.rejects(h.client.prepare(token,{country:'US',currency:'USD'}),{code:'DESTINATION_NOT_EMPTY'});
  assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
});
test('empty recipient with a note or attributes is preserved',async()=>{
  for (const metadata of [{note:'gift message'},{attributes:{campaign:'existing'}}]) {
    const h=harness();Object.assign(h.cart,metadata);
    await assert.rejects(h.client.prepare(token,{country:'US',currency:'USD'}),{code:'DESTINATION_METADATA_PRESENT'});assert.equal(h.writes.length,0);
  }
});
test('prepare is read-only and requires recipient currency',async()=>{
  const h=harness();await assert.rejects(h.client.prepare(token,{country:'CA',currency:'CAD'}),{code:'CURRENCY_CONTEXT_MISMATCH'});assert.equal(h.calls.length,0);
  const p=await h.client.prepare(token,{country:'US',currency:'USD'});assert.equal(p.checkoutReady,false);assert.equal(h.writes.length,0);
});
test('restore uses reviewed private manifest even if display copy is edited',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});p.lines[0].quantity=50;
  const result=await h.client.restore(p);assert.equal(h.writes.length,1);assert.equal(h.writes[0][0].quantity,1);assert.equal(result.checkoutReady,false);
  assert.equal(h.writes[0][0].properties['Ring Size'],'');assert.ok(h.writes[0][0].properties._diy_operation_v1);
  assert.ok(h.writes[0][0].properties._diy_share_import_v1);
});
test('arbitrary or expired restore handles cannot mutate recipient',async()=>{
  const h=harness();await assert.rejects(h.client.restore({}),{code:'PREPARE_REQUIRED'});
  const p=await h.client.prepare(token,{country:'US',currency:'USD'});h.time+=120001;
  await assert.rejects(h.client.restore(p),{code:'PREPARATION_EXPIRED'});assert.equal(h.writes.length,0);
});
test('cart replacement between review and add stops import',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});h.cart.token='another-cart';
  await assert.rejects(h.client.restore(p),{code:'CART_CHANGED'});assert.equal(h.writes.length,0);
});
test('new recipient line after prepare is never cleared or merged',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});h.cart.items=[item(67890)];
  await assert.rejects(h.client.restore(p),{code:'CART_CHANGED'});assert.equal(h.cart.items[0].variant_id,67890);assert.equal(h.writes.length,0);
});
test('lost successful add response is verified without second add',async()=>{
  const h=harness();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);throw Error('timeout');};
  const p=await h.client.prepare(token,{country:'US',currency:'USD'});const result=await h.client.restore(p);assert.equal(result.recoveredLostResponse,true);
  assert.equal((await h.client.restore(p)).alreadyRestored,true);assert.equal(h.writes.length,1);
});
test('two restore clicks serialize and add exactly once',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});
  const result=await Promise.all([h.client.restore(p),h.client.restore(p)]);assert.equal(h.writes.length,1);assert.equal(result[1].alreadyRestored,true);
});
test('unknown unsuccessful add never replays, including a new client after reload',async()=>{
  const h=harness();h.transport.addItems=async items=>{h.writes.push(copy(items));throw Error('timeout');};
  const p=await h.client.prepare(token,{country:'US',currency:'USD'});await assert.rejects(h.client.restore(p),{code:'RESTORE_UNCERTAIN'});
  h.client=createClient(h.options);const p2=await h.client.prepare(token,{country:'US',currency:'USD'});
  await assert.rejects(h.client.restore(p2),{code:'RESTORE_UNCERTAIN'});assert.equal(h.writes.length,1);
});
test('failed verification read suppresses future add attempts',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});const read=h.transport.getCart;
  h.transport.getCart=async()=>{if(h.writes.length)throw Error('offline');return read();};
  await assert.rejects(h.client.restore(p),{code:'RESTORE_UNCERTAIN'});
  h.transport.getCart=read;assert.equal((await h.client.restore(p)).alreadyRestored,true);assert.equal(h.writes.length,1);
});
test('journal must durably write before any request can mutate Shopify',async()=>{
  const h=harness({options:{journal:{get:()=>null,set:()=>{throw Error('quota');}}}});const p=await h.client.prepare(token,{country:'US',currency:'USD'});
  await assert.rejects(h.client.restore(p),{code:'RESTORE_JOURNAL_UNAVAILABLE'});assert.equal(h.writes.length,0);
});
test('malformed prior receipt is not treated as a new cart intent',async()=>{
  const h=harness({options:{journal:{get:()=>'{bad',set:()=>{}}}});const p=await h.client.prepare(token,{country:'US',currency:'USD'});
  await assert.rejects(h.client.restore(p),{code:'RESTORE_JOURNAL_UNAVAILABLE'});assert.equal(h.writes.length,0);
});
test('Ajax dropping empty property does not assign a size or cause replay',async()=>{
  const h=harness();const add=h.transport.addItems;h.transport.addItems=async items=>{await add(items);delete h.cart.items[0].properties['Ring Size'];};
  const p=await h.client.prepare(token,{country:'US',currency:'USD'});await h.client.restore(p);assert.equal(h.writes.length,1);
  assert.ok(!Object.hasOwn(h.cart.items[0].properties,'Ring Size'));
});
test('browser transport uses localized cart paths and no account cookies on share API',async()=>{
  const calls=[];const t=createBrowserTransport({apiUrl:'https://example.com/api/cart-shares',root:'/en-ca/',fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({items:[]})};}});
  await t.getCart();await t.prepareShare(token,{country:'CA',currency:'CAD'});
  assert.equal(calls[0].url,'/en-ca/cart.js');assert.equal(calls[0].opts.credentials,'same-origin');
  assert.equal(calls[1].opts.credentials,'omit');assert.equal(calls[1].opts.cache,'no-store');
  assert.throws(()=>createBrowserTransport({apiUrl:'https://example.com',root:'//evil.com/'}),{code:'INVALID_CART_ROOT'});
});
test('prepared review rejects incomplete, mismatched or misleading price facts',async()=>{
  for(const change of [p=>delete p.version,p=>p.prices=[],p=>p.prices[0].lineIndex=2,p=>p.prices[0].variantId='67890',p=>p.prices[0].quantity=2,
    p=>p.prices[0].unitPrice.currencyCode='CAD',p=>p.prices[0].unitPrice.amount='NaN',p=>p.prices[0].unitPrice.amount='0',p=>p.priceLocked=true,p=>p.availabilityConfirmed=true]) {
    const h=harness();const prepare=h.transport.prepareShare;h.transport.prepareShare=async(...args)=>{const r=await prepare(...args);change(r.preparation);return r;};
    await assert.rejects(h.client.prepare(token,{country:'US',currency:'USD'}),{code:'INVALID_PREPARATION'});assert.equal(h.writes.length,0);
  }
});
test('preparation expiry during final read prevents dispatch and does not consume journal',async()=>{
  const h=harness();const p=await h.client.prepare(token,{country:'US',currency:'USD'});const read=h.transport.getCart;
  h.transport.getCart=async()=>{h.time+=120001;return read();};
  await assert.rejects(h.client.restore(p),{code:'PREPARATION_EXPIRED'});assert.equal(h.writes.length,0);assert.equal(h.receipts.size,0);
});
