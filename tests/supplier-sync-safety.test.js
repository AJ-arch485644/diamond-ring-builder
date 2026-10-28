'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {readReservedSkus,upsertBatch,syncToDatabase}=require('../scripts/sync-nivoda');
function reservationQuery(result) {const q={};for(const key of ['select','not','neq','range'])q[key]=()=>q;q.then=(yes,no)=>Promise.resolve(result).then(yes,no);return q;}
test('partial reservation read failure aborts instead of returning a partial allowlist',async()=>{
  let pages=0;const db={schema(){return{from(){return reservationQuery(++pages===1?{data:Array.from({length:1000},(_,i)=>({diamond_id:'SKU'+i}))}:{error:{message:'timeout'}});}};}};
  await assert.rejects(readReservedSkus(db),/RESERVATION_READ_FAILED/);assert.equal(pages,2);
});
test('idempotent batch retries are bounded and repeat the exact batch, permanent errors fail immediately',async()=>{
  const batch=[{nivoda_id:'id1',updated_at:'generation1',availability:'reserved'}];const inputs=[];const waits=[];
  const db={from(){return{upsert:async(data,options)=>{inputs.push({data,options});return inputs.length<3?{error:{code:'57014'}}:{error:null};}};}};
  await upsertBatch(db,batch,{sleep:async(ms)=>waits.push(ms)});assert.equal(inputs.length,3);assert.ok(inputs.every(row=>row.data===batch));assert.deepEqual(waits,[2000,4000]);
  let calls=0;await assert.rejects(upsertBatch({from(){return{upsert:async()=>{calls++;return{error:{code:'23505'}};}};}},batch,{sleep:async()=>assert.fail()}),/SUPPLIER_BATCH_FAILED/);assert.equal(calls,1);
});
test('failed feed batch never runs stale marking or deletion',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diyona-sync-test-'));const file=path.join(dir,'feed.csv');
  await fs.writeFile(file,'ID,stockId,shape,carats,col,clar,price,markupPrice,lg\nid1,sku1,RD,1,D,VS1,100,200,lab\n');
  let cleanup=0;const db={schema(){return{from(){return reservationQuery({data:[]});}};},from(){return{upsert:async()=>({error:{code:'57014'}}),delete(){cleanup++;throw Error('must not delete');}};},rpc(){cleanup++;throw Error('must not mark stale');}};
  try {await assert.rejects(syncToDatabase(file,{supabase:db,sleep:async()=>{}}),/SUPPLIER_BATCH_FAILED/);assert.equal(cleanup,0);}finally{await fs.unlink(file);await fs.rmdir(dir);}
});
test('empty or invalid feed cannot delete the catalog',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diyona-empty-test-'));const file=path.join(dir,'feed.csv');await fs.writeFile(file,'ID,stockId,shape,carats,col,clar,price,markupPrice,lg\n');
  const db={schema(){return{from(){return reservationQuery({data:[]});}};},from(){assert.fail('must not mutate');},rpc(){assert.fail('must not clean up');}};
  try{await assert.rejects(syncToDatabase(file,{supabase:db}),/EMPTY_SUPPLIER_FEED/);}finally{await fs.unlink(file);await fs.rmdir(dir);}
});
test('retired Select writer has no callable write path',()=>{assert.throws(()=>require('../image-audit/select-refresh').retired(),/SELECT_CURATION_RETIRED/);});
