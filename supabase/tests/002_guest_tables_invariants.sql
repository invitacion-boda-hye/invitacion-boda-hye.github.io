-- Ejecutar con `supabase test db` tras aplicar 202611120002.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select is((select count(*)::integer from public.event_tables), 6, 'Se crean seis mesas');
select is((select sum(capacity)::integer from public.event_tables), 54, 'Las seis mesas suman 54 sillas');
select is((select count(*)::integer from public.event_table_seats where is_active), 54, 'Existen 54 sillas activas');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.event_tables'::regclass, 'public.event_table_seats'::regclass, 'public.rsvp_seat_assignments'::regclass)), 'RLS queda activo en las tablas de mesas');
select ok(not has_any_column_privilege('anon', 'public.rsvp_seat_assignments', 'select'), 'anon no lee asignaciones');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000110', 'table-admin@example.invalid');
insert into public.rsvp_admins (user_id) values ('00000000-0000-4000-8000-000000000110');
insert into public.invitations (id, group_name, max_passes, token_hash) values ('00000000-0000-4000-8000-000000000111', 'Familia Mesa Prueba', 2, repeat('e', 64));
insert into public.rsvp_responses (id, invitation_id, is_attending, confirmed_count) values ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000111', true, 2);
insert into public.rsvp_attendees (id, response_id, full_name) values ('00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000112', 'Ana Mesa'), ('00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000112', 'Bruno Mesa');

select lives_ok($$select public.rsvp_admin_assign_seat((select id from public.event_tables where table_number=1),1,'00000000-0000-4000-8000-000000000113','00000000-0000-4000-8000-000000000110')$$, 'Se asigna una silla a asistente confirmado');
select throws_ok($$select public.rsvp_admin_assign_seat((select id from public.event_tables where table_number=1),1,'00000000-0000-4000-8000-000000000114','00000000-0000-4000-8000-000000000110')$$, 'P0001', 'ADMIN_SEAT_OCCUPIED', 'No se duplica una silla');
select throws_ok($$select public.rsvp_admin_assign_seat((select id from public.event_tables where table_number=1),2,'00000000-0000-4000-8000-000000000113','00000000-0000-4000-8000-000000000110')$$, 'P0001', 'ADMIN_ATTENDEE_ALREADY_SEATED', 'No se duplica un asistente');
select lives_ok($$select public.rsvp_admin_release_seat((select id from public.event_tables where table_number=1),1,'00000000-0000-4000-8000-000000000110')$$, 'Liberar una silla conserva RSVP');
select is((select count(*)::integer from public.rsvp_seat_assignments where released_at is null), 0, 'La silla queda libre sin borrar historial');
select lives_ok($$select public.rsvp_admin_assign_seat((select id from public.event_tables where table_number=1),2,'00000000-0000-4000-8000-000000000113','00000000-0000-4000-8000-000000000110')$$, 'El asistente puede moverse a otra silla');
delete from public.rsvp_attendees where id='00000000-0000-4000-8000-000000000113';
select is((select count(*)::integer from public.rsvp_seat_assignments where released_at is null), 0, 'Cambiar RSVP libera automáticamente la silla');
select * from finish();
rollback;
