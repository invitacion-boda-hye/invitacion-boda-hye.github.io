-- Verificación de sólo lectura para 202611110001_rsvp_schema_and_security.sql
-- Ejecutar en Supabase SQL Editor como propietario/administrador.
-- Todas las consultas devuelven diferencias o controles; no modifican datos.

-- 1) Esquemas y tipo enum
select 'schema_private' as check_name,
       case when exists (select 1 from pg_namespace where nspname='private') then 'OK' else 'FALTA' end as result;

select 'rsvp_state_labels' as check_name,
       coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder)
                 from pg_type t join pg_enum e on e.enumtypid=t.oid
                 where t.typname='rsvp_state' and t.typnamespace='public'::regnamespace), '<FALTA>') as result;

-- 2) Tablas esperadas, sin leer filas personales
with expected(table_name) as (values
  ('event_settings'),('rsvp_admins'),('invitations'),('rsvp_responses'),
  ('rsvp_attendees'),('rsvp_audit_log'),('rsvp_rate_limits'))
select 'missing_table' as check_name, e.table_name
from expected e left join pg_class c on c.relname=e.table_name and c.relnamespace='public'::regnamespace
where c.oid is null order by e.table_name;

-- 3) Columnas y tipos exactos relevantes
with expected(table_name,column_name,data_type,udt_name,is_nullable) as (values
 ('event_settings','id','boolean','bool','NO'),('event_settings','event_name','text','text','NO'),
 ('event_settings','event_date','date','date','NO'),('event_settings','capacity','integer','int4','NO'),
 ('event_settings','rsvp_deadline','timestamp with time zone','timestamptz','YES'),
 ('event_settings','created_at','timestamp with time zone','timestamptz','NO'),('event_settings','updated_at','timestamp with time zone','timestamptz','NO'),
 ('rsvp_admins','user_id','uuid','uuid','NO'),('rsvp_admins','created_at','timestamp with time zone','timestamptz','NO'),('rsvp_admins','created_by','uuid','uuid','YES'),
 ('invitations','id','uuid','uuid','NO'),('invitations','group_name','text','text','NO'),('invitations','max_passes','integer','int4','NO'),('invitations','token_hash','character','bpchar','NO'),('invitations','token_version','integer','int4','NO'),('invitations','token_created_at','timestamp with time zone','timestamptz','NO'),('invitations','is_active','boolean','bool','NO'),('invitations','revoked_at','timestamp with time zone','timestamptz','YES'),('invitations','rsvp_state','USER-DEFINED','rsvp_state','NO'),('invitations','created_at','timestamp with time zone','timestamptz','NO'),('invitations','updated_at','timestamp with time zone','timestamptz','NO'),
 ('rsvp_responses','id','uuid','uuid','NO'),('rsvp_responses','invitation_id','uuid','uuid','NO'),('rsvp_responses','is_attending','boolean','bool','NO'),('rsvp_responses','confirmed_count','integer','int4','NO'),('rsvp_responses','comment','text','text','YES'),('rsvp_responses','responded_at','timestamp with time zone','timestamptz','NO'),('rsvp_responses','updated_at','timestamp with time zone','timestamptz','NO'),
 ('rsvp_attendees','id','uuid','uuid','NO'),('rsvp_attendees','response_id','uuid','uuid','NO'),('rsvp_attendees','full_name','text','text','NO'),('rsvp_attendees','created_at','timestamp with time zone','timestamptz','NO'),
 ('rsvp_audit_log','id','bigint','int8','NO'),('rsvp_audit_log','invitation_id','uuid','uuid','NO'),('rsvp_audit_log','response_id','uuid','uuid','YES'),('rsvp_audit_log','actor_kind','text','text','NO'),('rsvp_audit_log','actor_admin_id','uuid','uuid','YES'),('rsvp_audit_log','action','text','text','NO'),('rsvp_audit_log','previous_confirmed_count','integer','int4','YES'),('rsvp_audit_log','new_confirmed_count','integer','int4','YES'),('rsvp_audit_log','metadata','jsonb','jsonb','NO'),('rsvp_audit_log','created_at','timestamp with time zone','timestamptz','NO'),
 ('rsvp_rate_limits','scope','text','text','NO'),('rsvp_rate_limits','key_hash','character','bpchar','NO'),('rsvp_rate_limits','window_started_at','timestamp with time zone','timestamptz','NO'),('rsvp_rate_limits','attempts','integer','int4','NO'))
select 'column_mismatch' as check_name, e.table_name, e.column_name,
       format('%s/%s/%s',coalesce(c.data_type,'<missing>'),coalesce(c.udt_name,'<missing>'),coalesce(c.is_nullable,'<missing>')) as actual,
       format('%s/%s/%s',e.data_type,e.udt_name,e.is_nullable) as expected
from expected e left join information_schema.columns c on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name
where c.column_name is null or c.data_type<>e.data_type or c.udt_name<>e.udt_name or c.is_nullable<>e.is_nullable
order by e.table_name,e.column_name;

-- 4) Restricciones esenciales: devuelve cualquier restricción ausente.
with expected(table_name,needle) as (values
 ('event_settings','CHECK ((id = true))'),('invitations','char_length(btrim(group_name))'),('invitations','token_hash'),('invitations','max_passes'),
 ('rsvp_responses','rsvp_responses_attendance_count_check'),('rsvp_responses','invitation_id'),('rsvp_attendees','response_id'),
 ('rsvp_audit_log','actor_kind'),('rsvp_audit_log','invitation_id'),('rsvp_rate_limits','PRIMARY KEY'))
select 'constraint_check' as check_name,e.table_name,e.needle
from expected e
where not exists (select 1 from pg_constraint c join pg_class r on r.oid=c.conrelid
                  where r.relnamespace='public'::regnamespace and r.relname=e.table_name
                    and (c.conname ilike '%'||e.needle||'%' or pg_get_constraintdef(c.oid) ilike '%'||e.needle||'%'))
order by e.table_name,e.needle;

-- 5) Funciones, firma, SECURITY DEFINER y search_path vacío/pg_catalog.
with expected(schema_name,function_name,signature) as (values
 ('private','set_updated_at','()'),('private','assert_rsvp_admin','(uuid)'),
 ('public','rsvp_take_rate_limit','(text,text,integer,integer)'),('public','rsvp_resolve_invitation','(text)'),
 ('public','rsvp_submit','(text,boolean,integer,jsonb,text)'),('public','rsvp_admin_create_invitation','(text,integer,text,uuid)'),
 ('public','rsvp_admin_regenerate_token','(uuid,text,uuid)'),('public','rsvp_admin_revoke_invitation','(uuid,uuid)'),
 ('public','rsvp_admin_update_event_settings','(integer,timestamptz,uuid)'),('public','rsvp_admin_dashboard_summary','(uuid)'))
select 'function_security_mismatch' as check_name,e.schema_name,e.function_name,e.signature,
       coalesce(p.prosecdef::text,'MISSING') as security_definer,
       coalesce(array_to_string(p.proconfig,','),'') as settings
from expected e left join pg_proc p on p.pronamespace=e.schema_name::regnamespace and p.proname=e.function_name
  and replace(pg_get_function_identity_arguments(p.oid),' ','')=replace(trim(both '()' from e.signature),' ','')
where p.oid is null or p.prosecdef is not true or not (coalesce(array_to_string(p.proconfig,','),'') like '%search_path=%')
order by e.schema_name,e.function_name;

-- 6) RLS activo en todas las tablas y sin políticas abiertas.
with expected(table_name) as (values ('event_settings'),('rsvp_admins'),('invitations'),('rsvp_responses'),('rsvp_attendees'),('rsvp_audit_log'),('rsvp_rate_limits'))
select 'rls_mismatch' as check_name,e.table_name,coalesce(c.relrowsecurity::text,'MISSING') as rls_enabled
from expected e left join pg_class c on c.relname=e.table_name and c.relnamespace='public'::regnamespace
where c.oid is null or c.relrowsecurity is not true;

select 'unexpected_public_policy' as check_name, schemaname, tablename, policyname
from pg_policies where schemaname='public' and tablename in ('event_settings','rsvp_admins','invitations','rsvp_responses','rsvp_attendees','rsvp_audit_log','rsvp_rate_limits');

-- 7) Permisos: público/anon/authenticated no deben leer tablas ni ejecutar RPC;
-- service_role debe poder ejecutar las funciones protegidas.
with expected(schema_name,function_name,signature) as (values
 ('public','rsvp_take_rate_limit','text,text,integer,integer'),('public','rsvp_resolve_invitation','text'),('public','rsvp_submit','text,boolean,integer,jsonb,text'),('public','rsvp_admin_create_invitation','text,integer,text,uuid'),('public','rsvp_admin_regenerate_token','uuid,text,uuid'),('public','rsvp_admin_revoke_invitation','uuid,uuid'),('public','rsvp_admin_update_event_settings','integer,timestamptz,uuid'),('public','rsvp_admin_dashboard_summary','uuid'))
select 'function_permission_mismatch' as check_name,e.schema_name,e.function_name,e.signature,grantee,
       has_function_privilege(grantee,format('%I.%I(%s)',e.schema_name,e.function_name,e.signature),'EXECUTE') as can_execute
from expected e cross join (values ('public'),('anon'),('authenticated'),('service_role')) g(grantee)
where (g.grantee='service_role' and not has_function_privilege(g.grantee,format('%I.%I(%s)',e.schema_name,e.function_name,e.signature),'EXECUTE'))
   or (g.grantee<>'service_role' and has_function_privilege(g.grantee,format('%I.%I(%s)',e.schema_name,e.function_name,e.signature),'EXECUTE'));

select 'table_public_access' as check_name, table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public' and table_name in ('event_settings','rsvp_admins','invitations','rsvp_responses','rsvp_attendees','rsvp_audit_log','rsvp_rate_limits')
  and grantee in ('public','anon','authenticated')
order by table_name,grantee,privilege_type;

-- 8) Triggers e índices esenciales.
with expected(trigger_name,table_name) as (values
 ('event_settings_set_updated_at','event_settings'),('invitations_set_updated_at','invitations'),('rsvp_responses_set_updated_at','rsvp_responses'))
select 'trigger_missing' as check_name,e.trigger_name,e.table_name
from expected e left join pg_trigger t on t.tgname=e.trigger_name
  and t.tgrelid=('public.'||e.table_name)::regclass and not t.tgisinternal
where t.oid is null;

select 'index_missing' as check_name, expected_name
from (values ('invitations_state_idx'),('invitations_group_name_idx'),('rsvp_responses_attendance_idx'),('rsvp_attendees_response_idx'),('rsvp_audit_log_invitation_idx')) v(expected_name)
where not exists (select 1 from pg_class where relnamespace='public'::regnamespace and relname=expected_name);

-- Interpretación: todas las consultas de diferencias deben devolver cero filas.
