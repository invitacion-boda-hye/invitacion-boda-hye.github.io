-- Mesa 7 normal: 8 puestos. Migración aditiva e idempotente.
begin;

do $$
declare
  v_table public.event_tables%rowtype;
begin
  select * into v_table
  from public.event_tables
  where table_number = 7 or display_name = 'Mesa 7'
  for update;

  if found then
    if v_table.table_number <> 7
      or v_table.display_name <> 'Mesa 7'
      or v_table.capacity <> 8
      or v_table.is_head_table
      or not v_table.is_active then
      raise exception 'La Mesa 7 existente no coincide con la configuración aprobada';
    end if;
  else
    insert into public.event_tables (table_number, display_name, capacity, is_head_table, is_active)
    values (7, 'Mesa 7', 8, false, true)
    returning * into v_table;
  end if;

  if exists (
    select 1 from public.event_table_seats
    where table_id = v_table.id and seat_number > 8 and is_active
  ) then
    raise exception 'La Mesa 7 existente tiene puestos activos fuera de la capacidad aprobada';
  end if;

  insert into public.event_table_seats (table_id, seat_number, is_active)
  select v_table.id, seat_number, true
  from generate_series(1, 8) as seat_number
  on conflict (table_id, seat_number) do update set is_active = true;
end;
$$;

commit;
