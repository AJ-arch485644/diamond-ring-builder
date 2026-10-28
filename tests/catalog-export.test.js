'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {catalogBatches}=require('../lib/catalog-export');
function catalog(rows,{cap=Infinity,failures=0,noCount=false}={}){
  const log=[];let left=failures;
  return{log,from(table){assert.equal(table,'public_diamonds');let selected,limit,exact=false;const filters=[];const q={
    select(columns,options){selected=columns;exact=options?.count==='exact';return q;},
    eq(k,v){filters.push(row=>row[k]===v);return q;},
    gt(k,v){filters.push(row=>row[k]>v);return q;},
    not(k,op,v){assert.equal(op,'is');assert.equal(v,null);filters.push(row=>row[k]!=null);return q;},
    neq(k,v){filters.push(row=>row[k]!==v);return q;},
    order(){return q;},limit(n){limit=n;return q;},
    then(yes,no){log.push({exact,selected,limit});if(left-->0)return Promise.resolve({data:null,error:{message:'transient'}}).then(yes,no);const found=rows.filter(r=>filters.every(f=>f(r))).sort((a,b)=>a.sku<b.sku?-1:a.sku>b.sku?1:0);return Promise.resolve({data:found.slice(0,Math.min(cap,limit)),count:exact&&!noCount?found.length:null,error:null}).then(yes,no);},
  };return q;}};
}
const row=(id,sku,owned=false)=>({id,sku,is_diyona_select:owned});
async function collect(db,options){const all=[];for await(const batch of catalogBatches(db,options))all.push(...batch);return all;}

test('export keeps Select first and preserves duplicate SKUs crossing every page boundary',async()=>{
  const rows=[row(1,'S',true),row(2,'T',true),row(3,'A'),row(4,'B'),row(5,'B'),row(6,'B'),row(7,'C'),row(8,'D'),row(9,'D')];
  const db=catalog(rows);assert.deepEqual((await collect(db,{batchSize:3})).map(r=>r.id),[1,2,3,4,5,6,7,8,9]);
  assert.ok(db.log.some(q=>q.exact));assert.ok(db.log.filter(q=>!q.exact).length>=4);
});
test('short responses from a lower server cap never truncate the catalog',async()=>{
  const rows=Array.from({length:9},(_,i)=>row(i,String(i)));const result=await collect(catalog(rows,{cap:2}),{batchSize:10});assert.deepEqual(result.map(r=>r.id),rows.map(r=>r.id));
});
test('oversized duplicate group fails closed rather than skipping or looping',async()=>{
  const rows=[row(1,'A'),row(2,'B'),row(3,'B'),row(4,'B')];
  await assert.rejects(collect(catalog(rows,{cap:2}),{batchSize:10}),/SKU_GROUP_INCOMPLETE/);
  await assert.rejects(collect(catalog(rows),{batchSize:2}),/SKU_GROUP_INCOMPLETE/);
});
test('empty catalogs, exact-size last pages and invalid identifiers terminate honestly',async()=>{
  assert.deepEqual(await collect(catalog([]),{batchSize:2}),[]);
  const rows=[row(1,'A'),row(2,'B'),row(3,''),row(4,null)];assert.deepEqual((await collect(catalog(rows),{batchSize:2})).map(r=>r.id),[1,2]);
});
test('query retries are bounded and no result is yielded after an exhausted or unverifiable group read',async()=>{
  const sleeps=[];assert.equal((await collect(catalog([row(1,'A')],{failures:2}),{batchSize:2,sleep:async n=>sleeps.push(n)})).length,1);assert.deepEqual(sleeps,[3000,6000]);
  await assert.rejects(collect(catalog([row(1,'A')],{failures:3}),{sleep:async()=>{}}),/QUERY_FAILED/);
  await assert.rejects(collect(catalog([row(1,'A')],{noCount:true})),/SKU_GROUP_INCOMPLETE/);
});
test('actual PostgREST requests use bounded key predicates and exact counts only on one SKU',async()=>{
  const {createClient}=require('@supabase/supabase-js');const urls=[];
  const client=createClient('https://catalog.invalid','fixture',{auth:{persistSession:false},global:{fetch:async(url,options)=>{const u=new URL(url);urls.push({u,prefer:new Headers(options.headers).get('prefer')});return new Response('[]',{headers:{'content-type':'application/json','content-range':'*/0'}});}}});
  await collect(client);assert.equal(urls.length,2);for(const{u,prefer}of urls){assert.equal(u.searchParams.has('offset'),false);assert.equal(u.searchParams.get('order'),'is_diyona_select.desc,sku.asc');assert.equal(u.searchParams.get('limit'),'10000');assert.doesNotMatch(prefer||'',/count=exact/);}
});
