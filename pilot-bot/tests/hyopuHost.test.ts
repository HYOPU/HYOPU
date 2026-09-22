import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertBotHost, botProject, miniAppAssets } from '../scripts/host-boundary.mjs';
import { PGlite } from '@electric-sql/pglite';
describe('dedicated HYOPU bot hosting', () => {
  it('permits local builds and its own project', () => {
    expect(() => assertBotHost({})).not.toThrow();
    expect(() => assertBotHost({ VERCEL_PROJECT_ID: botProject })).not.toThrow();
  });
  it('rejects the operations and Dongjin projects', () => {
    for (const id of ['prj_xUTiRACfyBURBplLBcX3hlrGPx3g', 'prj_ENQoq81WtBAoiDNYiKd1GOibnROb']) {
      expect(() => assertBotHost({ VERCEL_PROJECT_ID: id })).toThrow('WRONG_VERCEL_PROJECT');
    }
  });
  it('rejects operations repository identity', () => {
    expect(() => assertBotHost({ VERCEL_GIT_REPO_SLUG: 'hyopu-operations-workspace' })).toThrow();
  });
  it('publishes only the seven miniapp files', () => {
    expect(miniAppAssets).toHaveLength(7);
    expect(miniAppAssets).not.toContain('dashboard.js');
    const build = readFileSync('scripts/build-host.mjs', 'utf8');
    expect(build).not.toContain('../index.html');
    expect(build).not.toContain('process.env.HPBOT_');
  });
  it('exposes only the bot collector in deployment configuration', () => {
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(Object.keys(cfg.functions)).toEqual(['api/hpbot-jstt.js']);
    expect(cfg.crons).toBeUndefined();
  });
  it('atomically switches only the pinned dispatcher and Vault URL', async () => {
    const db=new PGlite();try{
      await db.exec(`create schema vault; create table vault.decrypted_secrets(id uuid,name text,decrypted_secret text);
        insert into vault.decrypted_secrets values('00000000-0000-0000-0000-000000000001','jstt_berth_url','https://hyopu-ten.vercel.app/api/hpbot-jstt');
        create function vault.update_secret(i uuid,s text) returns void language sql as $$update vault.decrypted_secrets set decrypted_secret=s where id=i$$;
        create function public.jstt_dispatch_before_twenty_minutes(p_manual boolean default false) returns text language plpgsql as $$declare endpoint text:=current_setting('test.endpoint');begin if endpoint<>'https://hyopu-ten.vercel.app/api/hpbot-jstt' then return 'CONFIG_REQUIRED';end if;return 'RUN';end $$;`);
      await db.exec(readFileSync('supabase/migrations/20260922003800_hpbot_dedicated_host.sql','utf8'));
      expect((await db.query('select decrypted_secret from vault.decrypted_secrets')).rows[0]).toEqual({decrypted_secret:'https://hyopu-pilot-bot.vercel.app/api/hpbot-jstt'});
      for(const [url,value] of [['https://hyopu-pilot-bot.vercel.app/api/hpbot-jstt','RUN'],['https://hyopu-ten.vercel.app/api/hpbot-jstt','CONFIG_REQUIRED'],['http://hyopu-pilot-bot.vercel.app/api/hpbot-jstt','CONFIG_REQUIRED']]){
        await db.query("select set_config('test.endpoint',$1,false)",[url]);
        expect((await db.query('select jstt_dispatch_before_twenty_minutes() v')).rows[0]).toEqual({v:value});
      }
    }finally{await db.close();}
  });
});
