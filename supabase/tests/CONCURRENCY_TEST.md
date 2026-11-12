# Prueba manual de concurrencia y capacidad

Ejecuta esta prueba solamente contra una base local desechable después de
`supabase db reset`. Usa dos terminales conectadas a la misma base local como
un rol con permisos de prueba.

## Preparación única

```sql
update public.event_settings set capacity = 4, rsvp_deadline = null;

insert into public.invitations (group_name, max_passes, token_hash)
values
  ('Familia Concurrente A', 4, repeat('1', 64)),
  ('Familia Concurrente B', 4, repeat('2', 64));
```

## Terminal A

```sql
begin;
select public.rsvp_submit(
  repeat('1', 64), true, 3,
  '[{"full_name":"Ana Concurrente"},{"full_name":"Bruno Concurrente"},{"full_name":"Carla Concurrente"}]'::jsonb,
  null
);
select pg_sleep(5);
commit;
```

## Terminal B, antes de que A confirme

```sql
select public.rsvp_submit(
  repeat('2', 64), true, 2,
  '[{"full_name":"Diego Concurrente"},{"full_name":"Elisa Concurrente"}]'::jsonb,
  null
);
```

El segundo terminal debe esperar el bloqueo de `event_settings` y, una vez que
A confirme, debe recibir `RSVP_CAPACITY_EXCEEDED`. Verifica finalmente:

```sql
select coalesce(sum(confirmed_count) filter (where is_attending), 0) as total_confirmado
from public.rsvp_responses;
```

El resultado no puede superar 4. Limpia la base local con `supabase db reset`.

## Reactivación frente a una modificación concurrente

En una base local limpia, prepara una familia activa con dos asistentes y otra
revocada que conserva dos asistentes. El UUID del administrador debe existir
en `auth.users` y en `public.rsvp_admins`.

```sql
update public.event_settings set capacity = 4, rsvp_deadline = null;

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000020', 'admin-concurrency@example.invalid');
insert into public.rsvp_admins (user_id)
values ('00000000-0000-4000-8000-000000000020');

insert into public.invitations (id, group_name, max_passes, token_hash)
values
  ('00000000-0000-4000-8000-000000000021', 'Familia Activa', 4, repeat('3', 64)),
  ('00000000-0000-4000-8000-000000000022', 'Familia Revocada', 2, repeat('4', 64));

select public.rsvp_submit(
  repeat('3', 64), true, 2,
  '[{"full_name":"Alicia Activa"},{"full_name":"Bastián Activo"}]'::jsonb,
  null
);
select public.rsvp_submit(
  repeat('4', 64), true, 2,
  '[{"full_name":"Camila Revocada"},{"full_name":"Darío Revocado"}]'::jsonb,
  null
);
select public.rsvp_admin_revoke_invitation(
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000020'
);
```

En la terminal A:

```sql
begin;
select public.rsvp_admin_regenerate_token(
  '00000000-0000-4000-8000-000000000022',
  repeat('5', 64),
  '00000000-0000-4000-8000-000000000020'
);
select pg_sleep(5);
commit;
```

Mientras A mantiene el bloqueo, en la terminal B intenta aumentar la familia
activa de dos a tres personas:

```sql
select public.rsvp_submit(
  repeat('3', 64), true, 3,
  '[
    {"full_name":"Alicia Activa"}, {"full_name":"Bastián Activo"},
    {"full_name":"Claudio Activo"}
  ]'::jsonb,
  null
);
```

La terminal B debe esperar y luego devolver `RSVP_CAPACITY_EXCEEDED`. Esto
comprueba que ambas operaciones bloquean primero `event_settings` y no permiten
un total superior a cuatro.
