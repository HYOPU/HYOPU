import {it,expect} from 'vitest';import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';
it('historical baseline rows do not send NEW while current rows still notify',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create table hpbot_control(id bool primary key,bootstrap_done bool);insert into hpbot_control values(true,false);create function hpbot_filter_notifications(changes jsonb) returns jsonb language sql as $$select changes$$;`);
  await db.exec(readFileSync('supabase/migrations/20260922002800_hpbot_bootstrap_notifications.sql','utf8'));
  const changes=[{type:'NEW',new:{application_id:'old',pilot_date:'2019-01-17'}},{type:'NEW',new:{application_id:'future',pilot_date:'2099-01-01'}},{type:'TIME_CHANGED',new:{application_id:'old',pilot_date:'2019-01-17'}}];
  const get=async()=>(await db.query<{v:any[]}>('select hpbot_filter_notifications($1::jsonb) v',[JSON.stringify(changes)])).rows[0].v;
  expect((await get()).map(c=>c.new.application_id)).toEqual(['future','old']);
  await db.exec('update hpbot_control set bootstrap_done=true');expect(await get()).toEqual(changes);
 }finally{await db.close();}
},30000);
