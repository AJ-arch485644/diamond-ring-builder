'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseFilters,queryCatalog,createHandler,COLUMNS}=require('../lib/catalog-search');
function catalog(rows,log=[]) {
  return {from(name){assert.equal(name,'public_diamonds');const filters=[],orders=[];let range;const q={
    select(columns){assert.equal(columns,COLUMNS);return q;},
    eq(key,value){filters.push(row=>row[key]===value);return q;},
    in(key,values){filters.push(row=>values.includes(row[key]));return q;},
    gte(key,value){filters.push(row=>row[key]>=value);return q;},
    lte(key,value){filters.push(row=>row[key]<=value);return q;},
    order(key,options){log.push(['order',key]);orders.push([key,options.ascending]);return q;},
    range(start,end){log.push(['range',start,end]);range=[start,end];return q;},
    then(yes,no){let data=rows.filter(row=>filters.every(filter=>filter(row)));const count=data.length;data.sort((a,b)=>{for(const [key,asc]of orders){if(a[key]===b[key])continue;return(a[key]<b[key]?-1:1)*(asc?1:-1);}return 0;});return Promise.resolve({data:data.slice(range[0],range[1]+1),count,error:null}).then(yes,no);}
  };return q;}};
}
test('owned prioritization is global before page limit while retaining all requested criteria',async()=>{
  const rows=Array.from({length:60},(_,i)=>({sku:'SUP-'+String(i).padStart(2,'0'),inventory_source:'supplier',is_diyona_select:false,price_usd:100+i,shape:'Radiant',carat:3.05,color:'G',clarity:'VVS2',ratio:1.45}));
  rows.push({sku:'OWN-1',inventory_source:'owned',is_diyona_select:true,price_usd:500,shape:'Radiant',carat:3.05,color:'G',clarity:'VVS2',ratio:1.45});
  rows.push({...rows.at(-1),sku:'OWN-WRONG',shape:'Oval',price_usd:50});
  const log=[];const input=parseFilters({shape:'Radiant',carat_min:'3',carat_max:'3.1',color:'G',clarity:'VVS2',price_max:'600',ratio_min:'1.4',ratio_max:'1.5'});
  const result=await queryCatalog(catalog(rows,log),input);
  assert.equal(result.data[0].sku,'OWN-1');assert.equal(result.data.length,20);assert.equal(result.count,61);assert.equal(result.data.some(x=>x.sku==='OWN-WRONG'),false);
  assert.deepEqual(log,[['order','is_diyona_select'],['order','price_usd'],['order','sku'],['range',0,19]]);
  const second=await queryCatalog(catalog(rows),parseFilters({...{shape:'Radiant'},page:'2'}));assert.equal(second.data.some(x=>x.sku==='OWN-1'),false);
});
test('filter validation rejects expressions, malformed numbers, invalid pagination and contradictory ranges',()=>{
  for(const input of [{page:'-1'},{per_page:'20x'},{price_min:'NaN'},{price_min:'1e4'},{shape:['Round']},{sort:'price_usd;DROP TABLE'},{source:'curated'},{select_only:'yes'},{price_min:'200',price_max:'100'},{sku:'x\n'}])assert.throws(()=>parseFilters(input));
  assert.equal(parseFilters({per_page:'100'}).perPage,50);
  assert.deepEqual(parseFilters({select_only:'true'}).filters,[['eq','is_diyona_select',true]]);
});

test('PostgREST sort requests match storefront catalog index null ordering for every supported sort',async()=>{
  const {createClient}=require('@supabase/supabase-js');
  let requestUrl;
  const client=createClient('https://catalog.invalid','test-key',{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async url=>{requestUrl=new URL(url);return new Response('[]',{status:200,headers:{'content-type':'application/json','content-range':'*/0'}});}}
  });
  for(const [sort,column,direction] of [['price_asc','price_usd','asc'],['price_desc','price_usd','desc'],['carat_asc','carat','asc'],['carat_desc','carat','desc']]){
    const result=await queryCatalog(client,parseFilters({sort,per_page:'3'}));
    assert.equal(result.error,null);
    assert.equal(requestUrl.searchParams.get('order'),`is_diyona_select.desc,${column}.${direction},sku.asc`);
    assert.equal(requestUrl.searchParams.get('limit'),'3');
  }
});
test('search returns actual total and no cache; private errors remain hidden',async()=>{
  const handler=createHandler({getClient:()=>catalog([{sku:'OWN',is_diyona_select:true,price_usd:200}])});
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;},end(){}};
  await handler({method:'GET',query:{}},res);assert.equal(res.code,200);assert.equal(res.body.Diamonds.total,1);assert.equal(res.body.Diamonds.has_more,false);assert.equal(res.headers['Vercel-CDN-Cache-Control'],'no-store');
  await createHandler({getClient(){throw Error('postgres://private');}})({method:'GET',query:{}},res);assert.equal(res.code,503);assert.deepEqual(res.body,{error:'CATALOG_UNAVAILABLE'});
});
