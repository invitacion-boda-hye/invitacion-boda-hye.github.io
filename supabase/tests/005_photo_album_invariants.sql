-- Ejecutar exclusivamente contra PostgreSQL/Supabase local, después de las migraciones.
begin;
do $$
declare first_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; second_id uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; result text;
begin
  if not exists (select 1 from public.photo_album_settings where id and enabled = false and quota_bytes = 800000000
    and opens_at = (timestamp '2027-01-09 00:00:00' at time zone 'America/Santiago')
    and closes_at = (timestamp '2027-01-17 00:00:00' at time zone 'America/Santiago')) then
    raise exception 'Configuración inicial de producción incorrecta';
  end if;
  if has_table_privilege('anon', 'public.photo_album_uploads', 'select') or has_function_privilege('anon', 'public.photo_album_reserve(uuid,bigint,text)', 'execute') then raise exception 'Acceso anónimo inesperado'; end if;
  begin
    perform public.photo_album_reserve(first_id, 100, null);
    raise exception 'Reserva aceptada con álbum cerrado';
  exception when raise_exception then if sqlerrm <> 'ALBUM_CLOSED' then raise; end if; end;
  perform public.photo_album_configure(true, clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', 2097152);
  result := public.photo_album_reserve(first_id, 100, 'Invitado');
  if result <> 'reserved' then raise exception 'No se reservó'; end if;
  if public.photo_album_reserve(first_id, 100, 'Invitado') <> 'reserved' then raise exception 'Reintento no idempotente'; end if;
  begin
    perform public.photo_album_reserve(second_id, 100, null);
    raise exception 'Cuota excedida aceptada';
  exception when raise_exception then if sqlerrm <> 'ALBUM_QUOTA_EXCEEDED' then raise; end if; end;
  perform public.photo_album_confirm(first_id, 100, repeat('a',64));
  if public.photo_album_confirm(first_id, 100, repeat('a',64)) <> 'ready' then raise exception 'Confirmación no idempotente'; end if;
  begin
    perform public.photo_album_confirm(first_id, 101, repeat('b',64));
    raise exception 'Conflicto de contenido aceptado';
  exception when raise_exception then if sqlerrm <> 'ALBUM_ID_CONFLICT' then raise; end if; end;
  if public.photo_album_mark_delete(first_id) <> first_id::text || '.jpg' then raise exception 'No se marcó para eliminación'; end if;
  perform public.photo_album_finish_delete(first_id);
  if exists(select 1 from public.photo_album_uploads where id = first_id) then raise exception 'Registro no eliminado'; end if;
end $$;
rollback;
