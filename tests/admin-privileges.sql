-- SELECT de solo lectura: division_by_zero si alguna garantía no se cumple.
with expected(table_name, columns) as (values
  ('rsvp_admins', array['user_id']),
  ('invitations', array['id','group_name','max_passes','is_active','rsvp_state','updated_at','created_at']),
  ('rsvp_responses', array['invitation_id','confirmed_count','is_attending'])
), checks as (
  select
    (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass)
    and not has_any_column_privilege('anon', 'public.' || table_name, 'SELECT')
    and not has_any_column_privilege('authenticated', 'public.' || table_name, 'SELECT')
    and (select bool_and(has_column_privilege('service_role', 'public.' || table_name, c, 'SELECT')) from unnest(columns) as c)
    as passed
  from expected
)
select 1 / case when bool_and(passed)
  and not has_column_privilege('service_role', 'public.invitations', 'token_hash', 'SELECT')
  and has_function_privilege('service_role', 'public.rsvp_admin_dashboard_summary(uuid)', 'EXECUTE')
  then 1 else 0 end as permissions_regression_passed
from checks;
