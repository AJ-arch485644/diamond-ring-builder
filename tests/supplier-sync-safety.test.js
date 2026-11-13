'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {readReservedSkus,upsertBatch,syncToDatabase,writeWorkflowOutput}=require('../scripts/sync-nivoda');
function reservationQuery(result) {const q={};for(const key of ['select','not','neq','order','range'])q[key]=()=>q;q.then=(yes,no)=>Promise.resolve(result).then(yes,no);return q;}
async function feedFixture(rows) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diyona-timing-test-'));const file=path.join(dir,'feed.csv');
  const lines=Array.from({length:rows},(_,i)=>`id${i},sku${i},RD,1,D,VS1,100,200,lab`);
  await fs.writeFile(file,'ID,stockId,shape,carats,col,clar,price,markupPrice,lg\n'+lines.join('\n')+'\n');
  return {file,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('reservation scan preserves every supplier line in mixed orders and never reserves owned aliases',async()=>{
  const data=[{diamond_id:'OLD'},{diamond_id:'OWNED',diamond_lines:[{sku:'OWNED',inventory_source:'owned',quantity:1},{sku:'SECOND',inventory_source:'supplier',quantity:1},{sku:'THIRD',inventory_source:'supplier',quantity:1}]}];
  const db={schema(){return{from(){return reservationQuery({data});}};}};
  assert.deepEqual([...await readReservedSkus(db)].sort(),['OLD','SECOND','THIRD']);
});
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
test('upsert past its deadline aborts before stale marking or deletion',async()=>{
  const feed=await feedFixture(501);let clock=0,upserts=0,cleanup=0;
  const db={schema(){return{from(){return reservationQuery({data:[]});}};},from(){return{upsert:async()=>{upserts++;clock+=101*60000;return{error:null};},delete(){cleanup++;throw Error('must not delete');}};},rpc(){cleanup++;throw Error('must not mark stale');}};
  try{await assert.rejects(syncToDatabase(feed.file,{supabase:db,sleep:async()=>{},now:()=>clock,reportOutput:()=>assert.fail('must not report an unfinished upsert')}),/SUPPLIER_SYNC_DEADLINE_EXCEEDED/);assert.equal(upserts,1);assert.equal(cleanup,0);}finally{await feed.cleanup();}
});
test('slow but complete upserts are flagged for the workflow and healthy ones are not',async()=>{
  const feed=await feedFixture(1);
  try{for(const [minutes,slow] of [[52,'true'],[15,'false']]){
    let clock=0;const reports=[];
    const db={schema(){return{from(){return reservationQuery({data:[]});}};},from(){return{upsert:async()=>{clock+=minutes*60000;return{error:null};},delete(){return{eq:async()=>({error:null,count:0})};}};},rpc:async()=>({error:null})};
    await syncToDatabase(feed.file,{supabase:db,sleep:async()=>{},now:()=>clock,reportOutput:values=>reports.push(values)});
    assert.deepEqual(reports,[{upsert_minutes:minutes.toFixed(1),slow}]);
  }}finally{await feed.cleanup();}
});
test('workflow outputs are written only when running in Actions',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diyona-output-test-'));const file=path.join(dir,'output');
  try{writeWorkflowOutput({slow:'true',upsert_minutes:'52.0'},{});await assert.rejects(fs.readFile(file));
    writeWorkflowOutput({slow:'true',upsert_minutes:'52.0'},{GITHUB_OUTPUT:file});assert.equal(await fs.readFile(file,'utf8'),'slow=true\nupsert_minutes=52.0\n');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('retired Select writer has no callable write path',()=>{assert.throws(()=>require('../image-audit/select-refresh').retired(),/SELECT_CURATION_RETIRED/);});
