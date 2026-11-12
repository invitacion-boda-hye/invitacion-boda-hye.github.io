-- Corrección de HTTP 403 / SQLSTATE 42501 en las lecturas de admin-rsvp.
-- BYPASSRLS no concede privilegios SQL. Solo se habilitan las columnas usadas
-- por las consultas administrativas; no se conceden escrituras ni token_hash.
begin;

grant select (user_id) on public.rsvp_admins to service_role;
grant select (id, group_name, max_passes, is_active, rsvp_state, updated_at, created_at)
  on public.invitations to service_role;
grant select (invitation_id, confirmed_count, is_attending)
  on public.rsvp_responses to service_role;

commit;
