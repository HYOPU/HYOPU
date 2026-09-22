import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
describe('HYOPU production isolation',()=>{
 it('dispatcher accepts only the approved isolated HYOPU collector URL',async()=>{
  const db=new PGlite();try{
   await db.exec(`create function public.jstt_dispatch_before_twenty_minutes(p_manual boolean default false) returns text language plpgsql as $$declare endpoint text:=current_setting('test.endpoint');begin if endpoint!~'^https://[a-z0-9.-]+/api/jstt_berth_watch$' then return 'CONFIG_REQUIRED';end if;return 'RUN';end $$;`);
   await db.exec(readFileSync('supabase/migrations/20260922003100_hpbot_jstt_dispatch_endpoint.sql','utf8'));
   for(const [endpoint,result] of [['https://hyopu-ten.vercel.app/api/hpbot-jstt','RUN'],['https://other.vercel.app/api/hpbot-jstt','CONFIG_REQUIRED'],['http://hyopu-ten.vercel.app/api/hpbot-jstt','CONFIG_REQUIRED'],['https://hyopu-ten.vercel.app/api/jstt_berth_watch','CONFIG_REQUIRED']]){
    await db.query("select set_config('test.endpoint',$1,false)",[endpoint]);
    expect((await db.query<{v:string}>('select jstt_dispatch_before_twenty_minutes() v')).rows[0].v).toBe(result);
   }
  }finally{await db.close();}
 });
 it('never changes pre-existing HYOPU portal function ACLs',async()=>{
  const db=new PGlite();
  try{
   await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create function public.hyopu_portal_sentinel() returns int language sql as $$ select 7 $$;grant execute on function public.hyopu_portal_sentinel() to anon,authenticated;');
   const acl=async()=>(await db.query('select proacl::text from pg_proc where proname=\'hyopu_portal_sentinel\'')).rows;
   const before=await acl();
   for(const name of ['20260920000000_ulsan_pilot_watcher.sql','20260920000300_hpbot_operations.sql','20260920000400_hpbot_telegram.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
   expect(await acl()).toEqual(before);
   await db.exec('set role anon');
   expect((await db.query('select public.hyopu_portal_sentinel() n')).rows[0]).toEqual({n:7});
   await expect(db.query('select public.hpbot_context()')).rejects.toThrow('permission denied');
  }finally{await db.close();}
 },30000);
 it('migrations do not use the portal-wide hyopu prefix for grants or object changes',()=>{
  for(const f of readdirSync('supabase/migrations')){
   const sql=readFileSync('supabase/migrations/'+f,'utf8');
   expect(sql).not.toMatch(/public\.hyopu_/);
   expect(sql).not.toMatch(/proname like 'hyopu/);
  }
 });
 it('miniapp and account guards target HYOPU, never Dongjin',()=>{
  expect(readFileSync('pilot-miniapp/boot.js','utf8')).toContain('nhujqbqygnhbnvmfmodi.supabase.co');
  const source=readFileSync('supabase/functions/ulsan-pilot-watcher/lib/hyopuSource.ts','utf8');
  expect(source).toContain('협운해운 ON');expect(source).toContain("c[21] !== '협운'");expect(source).toContain("!== '1002'");
  expect(source).not.toMatch(/동진|2105|ybkxpwqtgajpgggqczhb/);
 });
});
