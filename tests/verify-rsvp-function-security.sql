-- Consultas adicionales de sólo lectura para interpretar
-- function_security_mismatch de verify-rsvp-schema.sql.
-- No ejecutan funciones RSVP ni modifican permisos o datos.

-- 1) Definición real de cada función relevante.
select n.nspname as schema_name,
       p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as actual_arguments,
       p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig, ','), '<sin configuración local>') as function_settings,
       p.prokind,
       p.prorettype::regtype::text as return_type
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='private' and p.proname in ('set_updated_at','assert_rsvp_admin'))
   or (n.nspname='public' and p.proname in (
     'rsvp_take_rate_limit','rsvp_resolve_invitation','rsvp_submit',
     'rsvp_admin_create_invitation','rsvp_admin_regenerate_token',
     'rsvp_admin_revoke_invitation','rsvp_admin_update_event_settings',
     'rsvp_admin_dashboard_summary'))
order by n.nspname,p.proname,actual_arguments;

-- 2) Comprobación corregida: set_updated_at NO es SECURITY DEFINER en la
-- migración; las otras nueve funciones sí lo son.
with expected(schema_name,function_name,arguments,expected_security_definer,expected_path) as (values
 ('private','set_updated_at','',false,'pg_catalog'),
 ('private','assert_rsvp_admin','uuid',true,''),
 ('public','rsvp_take_rate_limit','text,text,integer,integer',true,''),
 ('public','rsvp_resolve_invitation','text',true,''),
 ('public','rsvp_submit','text,boolean,integer,jsonb,text',true,''),
 ('public','rsvp_admin_create_invitation','text,integer,text,uuid',true,''),
 ('public','rsvp_admin_regenerate_token','uuid,text,uuid',true,''),
 ('public','rsvp_admin_revoke_invitation','uuid,uuid',true,''),
 ('public','rsvp_admin_update_event_settings','integer,timestamptz,uuid',true,''),
 ('public','rsvp_admin_dashboard_summary','uuid',true,''))
select 'function_security_mismatch_corrected' as check_name,
       e.schema_name,e.function_name,e.arguments,
       coalesce(p.prosecdef::text,'MISSING') as actual_security_definer,
       coalesce(array_to_string(p.proconfig,','),'<sin configuración local>') as actual_settings
from expected e
left join pg_proc p on p.pronamespace=e.schema_name::regnamespace
  and p.proname=e.function_name
  and replace(replace(pg_get_function_identity_arguments(p.oid),' ',''),'timestampwithtimezone','timestamptz')
      = replace(e.arguments,' ','')
where p.oid is null
   or p.prosecdef is distinct from e.expected_security_definer
   or (e.expected_path='pg_catalog' and coalesce(array_to_string(p.proconfig,','),'') not like '%search_path=pg_catalog%')
   or (e.expected_path='' and coalesce(array_to_string(p.proconfig,','),'') not like '%search_path=%')
order by e.schema_name,e.function_name;

-- 3) Verifica explícitamente que las nueve funciones protegidas tengan
-- search_path vacío (la cadena debe aparecer como search_path=).
select 'protected_function_path' as check_name,n.nspname,p.proname,
       pg_get_function_identity_arguments(p.oid) as actual_arguments,
       p.prosecdef,
       coalesce(array_to_string(p.proconfig,','),'<sin configuración local>') as settings
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.prosecdef
  and ((n.nspname='private' and p.proname='assert_rsvp_admin')
    or (n.nspname='public' and p.proname like 'rsvp_%'))
  and coalesce(array_to_string(p.proconfig,','),'') not like '%search_path=%';

-- 4) El trigger helper debe ser invocable sólo internamente; no debe ser
-- SECURITY DEFINER según la migración y debe usar pg_catalog como search_path.
select 'set_updated_at_definition' as check_name,
       has_function_privilege('public','private.set_updated_at()','EXECUTE') as public_execute,
       p.prosecdef as security_definer,
       coalesce(array_to_string(p.proconfig,','),'<sin configuración local>') as settings,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
where p.oid='private.set_updated_at()'::regprocedure;

-- Resultado esperado: la consulta 2 y la consulta 3 deben devolver cero filas;
-- la consulta 4 debe mostrar public_execute=false, security_definer=false y
-- settings conteniendo search_path=pg_catalog.
