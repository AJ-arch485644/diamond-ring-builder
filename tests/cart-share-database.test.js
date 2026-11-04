'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const url = process.env.CART_SHARE_TEST_DATABASE_URL;

test('private migration, RLS grants, atomic rate limiter and bounded cleanup on disposable PostgreSQL', {skip:!url}, async()=>{
  const target = new URL(url);
  // This suite must never be aimed at merchant Supabase or an arbitrary database.
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  assert.equal(target.pathname,'/cart_share_test');
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:url,max:16});
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;");
    const migration=await fs.readFile(path.join(__dirname,'../db/cart-shares.sql'),'utf8');
    await pool.query(migration);
    await pool.query(migration); // Repeat application preserves isolation and functions.
    const rls=await pool.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('cart_shares','cart_share_rate_limits')");
    assert.equal(rls.rowCount,2);assert.ok(rls.rows.every(x=>x.relrowsecurity));
    for (const role of ['anon','authenticated']) {
      const c=await pool.connect();
      try {await c.query('SET ROLE '+role);
        await assert.rejects(c.query('SELECT * FROM public.cart_shares'),e=>e.code==='42501');
        await assert.rejects(c.query("SELECT public.cart_share_consume_rate($1,10,60)",['a'.repeat(64)]),e=>e.code==='42501');
      } finally {await c.query('RESET ROLE');c.release();}
    }
    const service=await pool.connect();
    try {
      await service.query('SET ROLE service_role');
      await service.query("INSERT INTO public.cart_shares(token_hash,snapshot_hash,payload,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '7 days')",['a'.repeat(64),'b'.repeat(64),{version:1,lines:[]}]);
      assert.equal((await service.query('SELECT * FROM public.cart_shares')).rowCount,1);
      await assert.rejects(service.query("UPDATE public.cart_shares SET payload='{}'"),e=>e.code==='42501');
      await assert.rejects(service.query('DELETE FROM public.cart_shares'),e=>e.code==='42501');
      await assert.rejects(service.query('SELECT * FROM public.cart_share_rate_limits'),e=>e.code==='42501');
    } finally {await service.query('RESET ROLE');service.release();}
    const attempts=await Promise.all(Array.from({length:30},()=>pool.query('SELECT public.cart_share_consume_rate($1,10,60) AS allowed',['c'.repeat(64)])));
    assert.equal(attempts.filter(r=>r.rows[0].allowed).length,10);
    assert.equal((await pool.query('SELECT count FROM public.cart_share_rate_limits WHERE key=$1',['c'.repeat(64)])).rows[0].count,11);
    await pool.query("UPDATE public.cart_share_rate_limits SET expires_at=now()-interval '1 second'");
    assert.equal((await pool.query('SELECT public.cart_share_consume_rate($1,10,60) AS allowed',['c'.repeat(64)])).rows[0].allowed,true);
    await pool.query("INSERT INTO public.cart_shares(token_hash,snapshot_hash,payload,created_at,expires_at) VALUES($1,$2,$3,now()-interval '3 days',now()-interval '2 days')",['d'.repeat(64),'e'.repeat(64),{version:1,lines:[]}]);
    assert.equal((await pool.query('SELECT public.cart_share_cleanup(1) AS removed')).rows[0].removed,1);
    assert.equal((await pool.query('SELECT * FROM public.cart_shares')).rowCount,1);
  } finally {await pool.end();}
});
