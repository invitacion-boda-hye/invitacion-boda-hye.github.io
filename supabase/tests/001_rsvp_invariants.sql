-- Ejecutar con `supabase test db` después de aplicar la migración.
-- Cada prueba termina en ROLLBACK y no deja familias ni respuestas de ejemplo.

begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

update public.event_settings
set capacity = 4,
    rsvp_deadline = null;

insert into public.invitations (id, group_name, max_passes, token_hash)
values
  ('00000000-0000-4000-8000-000000000001', 'Familia Prueba Cuatro', 4, repeat('a', 64)),
  ('00000000-0000-4000-8000-000000000002', 'Familia Prueba Cupo', 4, repeat('b', 64)),
  ('00000000-0000-4000-8000-000000000003', 'Familia Prueba No Asiste', 2, repeat('c', 64)),
  ('00000000-0000-4000-8000-000000000004', 'Familia Prueba Nombre', 2, repeat('d', 64)),
  ('00000000-0000-4000-8000-000000000005', 'Familia Prueba Reactivación', 2, repeat('e', 64)),
  ('00000000-0000-4000-8000-000000000006', 'Familia Prueba Reemplazo', 2, repeat('f', 64));

-- El usuario de prueba solo existe dentro de esta transacción y permite
-- verificar las funciones administrativas sin omitir su control de permisos.
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000010', 'rsvp-admin-test@example.invalid');

insert into public.rsvp_admins (user_id)
values ('00000000-0000-4000-8000-000000000010');

select lives_ok(
  $$select public.rsvp_submit(
    repeat('a', 64), true, 4,
    '[
      {"full_name":"Ana Prueba"}, {"full_name":"Bruno Prueba"},
      {"full_name":"Carla Prueba"}, {"full_name":"Diego Prueba"}
    ]'::jsonb,
    'Confirmación inicial'
  )$$,
  'Una familia con cuatro pases confirma cuatro asistentes'
);

select is(
  (select confirmed_count from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000001'),
  4,
  'La cantidad confirmada se guarda en cuatro'
);

select is(
  (select count(*)::integer from public.rsvp_attendees where response_id = (
    select id from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000001'
  )),
  4,
  'Cada asistente tiene una fila individual'
);

select lives_ok(
  $$select public.rsvp_submit(
    repeat('a', 64), true, 2,
    '[{"full_name":"Ana Prueba"}, {"full_name":"Bruno Prueba"}]'::jsonb,
    'Ahora asistiremos dos'
  )$$,
  'Una familia puede modificar de cuatro a dos'
);

select is(
  (select count(*)::integer from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000001'),
  1,
  'Modificar no crea una respuesta duplicada'
);

select is(
  (select confirmed_count from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000001'),
  2,
  'La modificación ajusta el total a dos'
);

select throws_ok(
  $$select public.rsvp_submit(
    repeat('b', 64), true, 3,
    '[
      {"full_name":"Elena Prueba"}, {"full_name":"Felipe Prueba"},
      {"full_name":"Gabriela Prueba"}
    ]'::jsonb,
    null
  )$$,
  'P0001',
  'RSVP_CAPACITY_EXCEEDED',
  'No se supera capacidad cuatro después de una modificación'
);

select lives_ok(
  $$select public.rsvp_submit(repeat('c', 64), false, 0, '[]'::jsonb, 'No podremos asistir')$$,
  'Una familia puede declinar con cero asistentes'
);

select is(
  (select rsvp_state::text from public.invitations where id = '00000000-0000-4000-8000-000000000003'),
  'declined',
  'La familia que declina queda correctamente marcada'
);

select throws_ok(
  $$select public.rsvp_submit(
    repeat('d', 64), true, 1, '[{"full_name":"SinApellido"}]'::jsonb, null
  )$$,
  'P0001',
  'RSVP_ATTENDEE_NAME_INVALID',
  'No se aceptan asistentes sin nombre y apellido'
);

select throws_ok(
  $$select public.rsvp_submit(
    repeat('d', 64), true, 2, '[{"full_name":"Iris Prueba"}]'::jsonb, null
  )$$,
  'P0001',
  'RSVP_COUNT_MISMATCH',
  'La cantidad seleccionada debe coincidir con la lista de nombres'
);

-- Una familia revocada conserva su respuesta, pero no cuenta para la
-- capacidad. Al reactivarla se vuelven a contar sus asistentes existentes.
select lives_ok(
  $$select public.rsvp_submit(
    repeat('e', 64), true, 2,
    '[{"full_name":"Julia Reactivación"},{"full_name":"Kevin Reactivación"}]'::jsonb,
    'Confirmamos dos personas'
  )$$,
  'La familia que luego será revocada confirma dos asistentes'
);

select lives_ok(
  $$select public.rsvp_admin_revoke_invitation(
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000010'
  )$$,
  'Revocar una invitación adquiere el bloqueo de capacidad y libera sus cupos'
);

select is(
  (select is_active from public.invitations where id = '00000000-0000-4000-8000-000000000005'),
  false,
  'La invitación revocada queda inactiva'
);

select is(
  (select confirmed_count from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000005'),
  2,
  'Revocar no elimina la respuesta existente'
);

select lives_ok(
  $$select public.rsvp_submit(
    repeat('f', 64), true, 2,
    '[{"full_name":"Laura Reemplazo"},{"full_name":"Mario Reemplazo"}]'::jsonb,
    null
  )$$,
  'Otra familia puede ocupar los cupos liberados'
);

select throws_ok(
  $$select public.rsvp_admin_regenerate_token(
    '00000000-0000-4000-8000-000000000005',
    repeat('g', 64),
    '00000000-0000-4000-8000-000000000010'
  )$$,
  'P0001',
  'ADMIN_REACTIVATION_CAPACITY_EXCEEDED',
  'No se puede reactivar una respuesta que haría superar la capacidad'
);

select is(
  (select is_active from public.invitations where id = '00000000-0000-4000-8000-000000000005'),
  false,
  'Una reactivación rechazada conserva la invitación inactiva'
);

select is(
  (select count(*)::integer from public.rsvp_attendees where response_id = (
    select id from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000005'
  )),
  2,
  'Una reactivación rechazada no pierde asistentes existentes'
);

select lives_ok(
  $$select public.rsvp_admin_revoke_invitation(
    '00000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000010'
  )$$,
  'Revocar la familia de reemplazo vuelve a liberar sus cupos'
);

select throws_ok(
  $$select public.rsvp_admin_update_event_settings(
    3,
    null,
    '00000000-0000-4000-8000-000000000010'
  )$$,
  'P0001',
  'ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES',
  'No se reduce la capacidad bajo los pases de una invitación activa'
);

select lives_ok(
  $$select public.rsvp_admin_regenerate_token(
    '00000000-0000-4000-8000-000000000005',
    repeat('h', 64),
    '00000000-0000-4000-8000-000000000010'
  )$$,
  'La reactivación procede cuando vuelve a haber capacidad'
);

select is(
  (select is_active from public.invitations where id = '00000000-0000-4000-8000-000000000005'),
  true,
  'La invitación regenerada vuelve a quedar activa'
);

select is(
  (select confirmed_count from public.rsvp_responses where invitation_id = '00000000-0000-4000-8000-000000000005'),
  2,
  'La reactivación correcta preserva la respuesta original'
);

update public.event_settings set rsvp_deadline = clock_timestamp() - interval '1 second';

select throws_ok(
  $$select public.rsvp_submit(repeat('b', 64), false, 0, '[]'::jsonb, null)$$,
  'P0001',
  'RSVP_DEADLINE_PASSED',
  'El servidor bloquea cambios después de la fecha límite'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.invitations'::regclass),
  'RLS está activo en invitaciones'
);

select * from finish();

rollback;
