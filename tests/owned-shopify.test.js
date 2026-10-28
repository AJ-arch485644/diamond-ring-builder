'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createOwnedShopifyClient,setOwnedInventoryHSCode,SHOP}=require('../lib/owned-shopify');
const {createHandler}=require('../api/create-product');
const env=()=>({OWNED_SHOPIFY_CLIENT_ID:'owned-client',OWNED_SHOPIFY_CLIENT_SECRET:'private-owned-secret'});
const ok=data=>({ok:true,status:200,json:async()=>data});
test('owned authentication pins the shop, coalesces refreshes and caches until shortly before expiry',async()=>{
  let now=100000,auth=0,reads=0;const client=createOwnedShopifyClient({env:env(),now:()=>now,fetchImpl:async(url,options)=>{
    assert.equal(new URL(url).hostname,SHOP);assert.equal(options.redirect,'error');
    if(url.endsWith('access_token')){auth++;assert.equal(options.body.get('client_id'),'owned-client');assert.equal(options.body.get('grant_type'),'client_credentials');return ok({access_token:'dedicated-'+auth,expires_in:120});}
    reads++;assert.equal(options.headers['X-Shopify-Access-Token'],'dedicated-'+auth);return ok({data:{ok:true}});
  }});
  await Promise.all([client.graphql('query{}'),client.graphql('query{}')]);assert.equal(auth,1);assert.equal(reads,2);
  now+=100000;await client.graphql('query{}');assert.equal(auth,1);
  now+=9000;await client.graphql('query{}');assert.equal(auth,2);
});
test('a revoked token refreshes once on 401; repeated rejection is bounded and sanitized',async()=>{
  let auth=0,reads=0;const client=createOwnedShopifyClient({env:env(),fetchImpl:async url=>{
    if(url.endsWith('access_token'))return ok({access_token:'secret-'+(++auth),expires_in:3600});
    reads++;return{ok:false,status:401,json:async()=>({token:'secret-upstream-body'})};
  }});
  await assert.rejects(client.graphql('query{}'),error=>error.code==='OWNED_COMMERCE_UNAVAILABLE'&&error.status===503&&!error.message.includes('secret'));
  assert.equal(auth,2);assert.equal(reads,2);
});
test('one 401 can recover with the fresh dedicated credential',async()=>{
  let auth=0;const client=createOwnedShopifyClient({env:env(),fetchImpl:async(url,options)=>{
    if(url.endsWith('access_token'))return ok({access_token:'dedicated-'+(++auth),expires_in:3600});
    return options.headers['X-Shopify-Access-Token']==='dedicated-1'?{ok:false,status:401}:ok({data:{recovered:true}});
  }});assert.deepEqual(await client.graphql('query{}'),{recovered:true});assert.equal(auth,2);
});
test('missing credentials, malformed expiry and scope denial fail closed without token-table fallback',async()=>{
  let calls=0;await assert.rejects(createOwnedShopifyClient({env:{},fetchImpl:async()=>{calls++;}}).graphql('query{}'),/OWNED_COMMERCE_UNAVAILABLE/);assert.equal(calls,0);
  for(const result of [{access_token:'secret',expires_in:0},{access_token:'secret'},{access_token:'secret',expires_in:Infinity}])await assert.rejects(createOwnedShopifyClient({env:env(),fetchImpl:async()=>ok(result)}).graphql('query{}'),/OWNED_COMMERCE_UNAVAILABLE/);
  const client=createOwnedShopifyClient({env:env(),fetchImpl:async url=>url.endsWith('access_token')?ok({access_token:'secret',expires_in:3600}):ok({errors:[{message:'private scope detail'}]})});await assert.rejects(client.graphql('query{}'),/OWNED_COMMERCE_UNAVAILABLE/);
});
test('owned customs classification writes only validated HS/origin through the dedicated client',async()=>{
  let calls=0;await setOwnedInventoryHSCode(30,'7104.91',{graphql:async(query,variables)=>{calls++;assert.match(query,/inventoryItemUpdate/);assert.deepEqual(variables,{id:'gid://shopify/InventoryItem/30',input:{harmonizedSystemCode:'710491',countryCodeOfOrigin:'IN'}});return{inventoryItemUpdate:{inventoryItem:{id:variables.id},userErrors:[]}};}});assert.equal(calls,1);
  await assert.rejects(setOwnedInventoryHSCode(30,'7113.19',{graphql:async()=>({inventoryItemUpdate:{userErrors:[{message:'private failure'}]}})}),/OWNED_COMMERCE_UNAVAILABLE/);
});
test('owned OAuth or customs failures never fall through to supplier creation',async()=>{
  for(const stage of ['resolve','customs']){
    const unavailable=async()=>{const e=Error('private-token');e.code='OWNED_COMMERCE_UNAVAILABLE';e.status=503;throw e;};
    const handler=createHandler({getClient:()=>({from:()=>assert.fail('supplier table must not be read')}),resolveOwned:stage==='resolve'?unavailable:async()=>({inventory_item_id:30,inventory_source:'owned'}),setOwnedHS:unavailable,findSupplierVariant:()=>assert.fail('no supplier fallback'),createSupplier:()=>assert.fail('no supplier creation'),env:{SHOPIFY_STORE:SHOP}});
    const res={setHeader(){},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
    await handler({method:'POST',body:{sku:'OWNED',type:'Loose'}},res);assert.equal(res.statusCode,503);assert.deepEqual(res.body,{error:'OWNED_COMMERCE_UNAVAILABLE'});
  }
});
