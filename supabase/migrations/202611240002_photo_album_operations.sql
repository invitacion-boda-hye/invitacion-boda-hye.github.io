-- Operaciones del álbum: solo el servicio puede ejecutar estas funciones.
begin;
grant select on public.photo_album_settings, public.photo_album_uploads to service_role;
create function public.photo_album_configure(p_enabled boolean, p_opens_at timestamptz, p_closes_at timestamptz, p_quota_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare used_bytes bigint;
begin
  perform 1 from public.photo_album_settings where id for update;
  select coalesce(sum(coalesce(actual_bytes, reserved_bytes)), 0) into used_bytes from public.photo_album_uploads;
  if p_enabled is null or p_opens_at is null or p_closes_at is null or p_closes_at <= p_opens_at
     or p_quota_bytes is null or p_quota_bytes < greatest(2097152, used_bytes) then raise exception 'ALBUM_INVALID_SETTINGS'; end if;
  update public.photo_album_settings set enabled=p_enabled, opens_at=p_opens_at, closes_at=p_closes_at, quota_bytes=p_quota_bytes where id;
end $$;
create function public.photo_album_confirm(p_id uuid, p_bytes bigint, p_sha256 text)
returns text language plpgsql security definer set search_path = '' as $$
declare u public.photo_album_uploads%rowtype;
begin
  select * into u from public.photo_album_uploads where id=p_id for update;
  if not found or u.state = 'cleanup' then raise exception 'ALBUM_RESERVATION_EXPIRED'; end if;
  if u.state = 'ready' then
    if u.actual_bytes != p_bytes or u.sha256 != p_sha256 then raise exception 'ALBUM_ID_CONFLICT'; end if;
    return 'ready';
  end if;
  if u.expires_at <= clock_timestamp() or p_bytes not between 1 and 2097152 or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'ALBUM_INVALID'; end if;
  update public.photo_album_uploads set state='ready', actual_bytes=p_bytes, sha256=p_sha256, confirmed_at=clock_timestamp() where id=p_id;
  return 'ready';
end $$;
create function public.photo_album_mark_delete(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare result text;
begin
 update public.photo_album_uploads set state='cleanup' where id=p_id and state in ('ready', 'cleanup') returning object_path into result;
 return result;
end $$;
create function public.photo_album_finish_delete(p_id uuid)
returns void language sql security definer set search_path = '' as $$
 delete from public.photo_album_uploads where id=p_id and state='cleanup';
$$;
revoke all on function public.photo_album_configure(boolean,timestamptz,timestamptz,bigint), public.photo_album_confirm(uuid,bigint,text), public.photo_album_mark_delete(uuid), public.photo_album_finish_delete(uuid) from public, anon, authenticated;
grant execute on function public.photo_album_configure(boolean,timestamptz,timestamptz,bigint), public.photo_album_confirm(uuid,bigint,text), public.photo_album_mark_delete(uuid), public.photo_album_finish_delete(uuid) to service_role;
commit;
