'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseInput,readQuote,createHandler}=require('../lib/storefront-price-quote');
const clone=x=>JSON.parse(JSON.stringify(x));
const node={id:'gid://shopify/ProductVariant/123',legacyResourceId:'123',sku:'D-1',price:'389.58',product:{id:'gid://shopify/Product/45',legacyResourceId:'45',status:'ACTIVE',handle:'diamond',onlineStoreUrl:'https://example.com/products/diamond',title:'Diamond'},contextualPricing:{price:{amount:'564.0',currencyCode:'CAD'},compareAtPrice:{amount:'1127.0',currencyCode:'CAD'}}};
const data=()=>({shop:{currencyCode:'USD'},productVariants:{nodes:[clone(node)],pageInfo:{hasNextPage:false}}});
const input=()=>parseInput({sku:'D-1',country:'CA',currency:'CAD'});
const fixed=()=>new Date('2026-10-05T18:00:00.000Z');
test('native Canadian quote retains exact market rounding and source base money',()=>{
 const q=readQuote(data(),input(),{now:fixed,build:'test'});assert.deepEqual(q.price,{amount:'564.0',currencyCode:'CAD'});assert.deepEqual(q.basePrice,{amount:'389.58',currencyCode:'USD'});assert.equal(q.priceLocked,false);assert.equal(q.availabilityConfirmed,false);assert.equal(q.variant_id,123);
});
test('explicit native variant lookup can quote setting without inventing base USD',()=>{
 const d={shop:{currencyCode:'GBP'},productVariant:clone(node)};d.productVariant.contextualPricing.price={amount:'849.95',currencyCode:'CAD'};
 const q=readQuote(d,parseInput({variant_id:'123',country:'CA',currency:'CAD'}));assert.equal(q.basePrice.currencyCode,'GBP');assert.equal(q.price.amount,'849.95');
});
test('JPY decimal Money amount stays major units',()=>{const d=data();d.productVariants.nodes[0].contextualPricing={price:{amount:'58000',currencyCode:'JPY'},compareAtPrice:null};assert.equal(readQuote(d,parseInput({sku:'D-1',country:'JP',currency:'JPY'})).price.amount,'58000');});
test('currency mismatch never silently returns USD labelled CAD',()=>{const d=data();d.productVariants.nodes[0].contextualPricing.price.currencyCode='USD';assert.throws(()=>readQuote(d,input()),e=>e.code==='CURRENCY_CONTEXT_MISMATCH');});
test('exact SKU filtering never accepts fuzzy first search result',()=>{const d=data();const wrong=clone(node);wrong.sku='D-10';d.productVariants.nodes.unshift(wrong);assert.equal(readQuote(d,input()).sku,'D-1');});
test('no exact materialized product returns404 without preparation',()=>{const d=data();d.productVariants.nodes[0].sku='D-10';assert.throws(()=>readQuote(d,input()),e=>e.status===404);});
test('duplicate exact active matches fail closed',()=>{const d=data();d.productVariants.nodes.push(clone(node));assert.throws(()=>readQuote(d,input()),e=>e.code==='AMBIGUOUS_IDENTITY');});
test('unexamined search page cannot imply unique identity',()=>{const d=data();d.productVariants.pageInfo.hasNextPage=true;assert.throws(()=>readQuote(d,input()),e=>e.code==='AMBIGUOUS_IDENTITY');});
test('draft or unpublished variants cannot produce native quote',()=>{for(const field of ['status','onlineStoreUrl']){const d=data();d.productVariants.nodes[0].product[field]=field==='status'?'DRAFT':null;assert.throws(()=>readQuote(d,input()),e=>e.status===404);}});
test('requested variant and actual returned variant must match',()=>{assert.throws(()=>readQuote({shop:{currencyCode:'USD'},productVariant:clone(node)},parseInput({variant_id:'124',sku:'D-1',country:'CA'})),e=>e.code==='IDENTITY_MISMATCH');});
test('invalid money or missing native context cannot become zero/estimate',()=>{for(const amount of ['','0','-1','NaN','Infinity','1e3',null]){const d=data();d.productVariants.nodes[0].contextualPricing.price.amount=amount;assert.throws(()=>readQuote(d,input()));}});
test('input requires actual country, rejects arrays/control chars/unsafe IDs',()=>{
 for(const q of [{sku:'D-1'},{country:'CAD',sku:'D-1'},{country:['CA'],sku:'D-1'},{country:'CA',sku:'x\ny'},{country:'CA',sku:['D-1']},{country:'CA',variant_id:'9007199254740993'},{country:'CA',variant_id:'123a'},{country:'CA',currency:'$'},{country:'CA'}])assert.throws(()=>parseInput(q));
});
function res(){return {headers:{},statusCode:null,body:null,setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;},end(){return this;}};}
function handler(overrides={}){
 const calls=[];const h=createHandler({env:{SHOPIFY_STORE:'test.myshopify.com',VERCEL_GIT_COMMIT_SHA:'abc'},tokenProvider:async()=> 'private-test-token',now:fixed,fetchImpl:async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,headers:{get:()=> '2026-07'},json:async()=>({data:data()})};},...overrides});return {h,calls};
}
test('HTTP handler issues only a GraphQL read, preserves quote identity and prohibits CDN caching',async()=>{
 const {h,calls}=handler();const r=res();await h({method:'GET',query:{sku:'D-1',country:'CA',currency:'CAD'}},r);
 assert.equal(r.statusCode,200);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://test.myshopify.com/admin/api/2026-07/graphql.json');const body=JSON.parse(calls[0].opts.body);assert.match(body.query,/^query /);assert.doesNotMatch(body.query,/mutation/);assert.equal(body.variables.query,'sku:"D-1"');assert.equal(r.body.build,'abc');assert.equal(r.body.effectiveApiVersion,'2026-07');for(const key of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])assert.match(r.headers[key],/no-store/);assert.doesNotMatch(JSON.stringify(r),/private-test-token/);
});
test('POST cannot prepare or mutate products; OPTIONS does not read credentials',async()=>{let reads=0;const {h,calls}=handler({tokenProvider:async()=>{reads++;throw Error();}});for(const [method,status] of [['POST',405],['OPTIONS',204]]){const r=res();await h({method,query:{}},r);assert.equal(r.statusCode,status);}assert.equal(reads,0);assert.equal(calls.length,0);});
test('bad input and wrong target configuration fail before token or HTTP',async()=>{let reads=0;const {h}=handler({env:{SHOPIFY_STORE:'evil.invalid'},tokenProvider:async()=>{reads++;}});const r=res();await h({method:'GET',query:{sku:'D-1',country:'CA'}},r);assert.equal(r.statusCode,503);assert.equal(reads,0);});
test('upstream rejection/GraphQL error/transport failure never masquerade as absence',async()=>{
 for(const fetchImpl of [async()=>({ok:false,status:429}),async()=>({ok:true,json:async()=>({errors:[{message:'secret'}]})}),async()=>{throw Error('private-test-token');}]){const {h}=handler({fetchImpl});const r=res();await h({method:'GET',query:{sku:'D-1',country:'CA'}},r);assert.equal(r.statusCode,503);assert.doesNotMatch(JSON.stringify(r.body),/secret|private-test-token/);}
});
test('quoted SKU query escapes search syntax while exact comparison remains authoritative',async()=>{const {h,calls}=handler();const r=res();await h({method:'GET',query:{sku:'D-"1\\2',country:'CA'}},r);assert.equal(JSON.parse(calls[0].opts.body).variables.query,'sku:"D-\\"1\\\\2"');assert.equal(r.statusCode,404);});
