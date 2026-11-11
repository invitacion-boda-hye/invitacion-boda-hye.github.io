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
