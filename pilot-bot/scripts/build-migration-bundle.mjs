// Generated deployment artifact, not a replacement for the individual migrations.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
const files = readdirSync('supabase/migrations').filter(n => /^\d+_.+\.sql$/.test(n)).sort();
const quoted = s => "'" + s.replaceAll("'", "''") + "'";
const prefix = `begin;
do $$ begin
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'pilot_%' or p.proname like 'hpbot_%' or p.proname like 'jstt_%')) then raise exception 'BOT_ALREADY_INSTALLED_OR_NAMESPACE_OCCUPIED'; end if;
 if exists(select 1 from public.hyopu_port_calls) is not true then raise exception 'EXPECTED_HYOPU_PROJECT_NOT_FOUND'; end if;
end $$;
create temporary table hpbot_deploy_function_guard on commit drop as select p.oid,pg_get_functiondef(p.oid) definition,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
create temporary table hpbot_deploy_table_guard on commit drop as select c.oid,c.relacl::text acl,c.relrowsecurity,c.reloptions::text opts from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';
`;
const body = files.map(name => {
 const version = name.split('_')[0], title = name.slice(version.length+1,-4);
 const sql = readFileSync('supabase/migrations/'+name,'utf8').replace(/^\s*(begin|commit);\s*$/gmi,'');
 return `-- ${name}\n${sql}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values (${quoted(version)},${quoted(title)},array[${quoted(sql)}]);\n`;
}).join('\n');
const suffix = `
do $$ begin
 if exists(select 1 from hpbot_deploy_function_guard g left join pg_proc p on p.oid=g.oid where p.oid is null or g.definition is distinct from pg_get_functiondef(p.oid) or g.acl is distinct from p.proacl::text) then raise exception 'EXISTING_FUNCTION_CHANGED_ROLLBACK'; end if;
 if exists(select 1 from hpbot_deploy_table_guard g left join pg_class c on c.oid=g.oid where c.oid is null or g.acl is distinct from c.relacl::text or g.relrowsecurity is distinct from c.relrowsecurity or g.opts is distinct from c.reloptions::text) then raise exception 'EXISTING_TABLE_PERMISSIONS_CHANGED_ROLLBACK'; end if;
 if (select enabled from public.pilot_watcher_control where id) or (select create_enabled or update_enabled or copy_enabled from public.pilot_registration_control where id) or (select enabled from public.jstt_monitor_control where id) then raise exception 'EXPECTED_DISABLED_INSTALL'; end if;
end $$;
commit;
select 'INSTALLED_DISABLED' result,${files.length} migration_count;
`;
mkdirSync('reports/private',{recursive:true});
writeFileSync('reports/private/hyopu-install.sql',prefix+body+suffix);
console.log(JSON.stringify({artifact:'reports/private/hyopu-install.sql',migrations:files.length,mode:'disabled',project:'nhujqbqygnhbnvmfmodi'}));
