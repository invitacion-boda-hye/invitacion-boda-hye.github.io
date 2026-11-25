-- Álbum inicialmente cerrado; cuota de 800 MB decimales (800.000.000 bytes).
-- La función de fase 2 deberá verificar los bytes almacenados antes de confirmar.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wedding-photos', 'wedding-photos', false, 2097152, array['image/jpeg']);

create table public.photo_album_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  opens_at timestamptz not null default (timestamp '2027-01-09 00:00:00' at time zone 'America/Santiago'),
  closes_at timestamptz not null default (timestamp '2027-01-17 00:00:00' at time zone 'America/Santiago'),
  quota_bytes bigint not null default 800000000 check (quota_bytes > 0),
  check (closes_at > opens_at)
);
insert into public.photo_album_settings (id) values (true);

create table public.photo_album_uploads (
  id uuid primary key,
  object_path text not null unique check (object_path = id::text || '.jpg'),
  guest_name text check (guest_name is null or char_length(btrim(guest_name)) between 1 and 160),
  -- Una URL firmada no impone el tamaño declarado por el cliente: reservar
  -- siempre el máximo aceptado por el bucket evita rebasar la cuota.
  reserved_bytes bigint not null check (reserved_bytes = 2097152),
  actual_bytes bigint check (actual_bytes between 1 and 2097152),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'reserved' check (state in ('reserved', 'ready', 'cleanup')),
  created_at timestamptz not null default clock_timestamp(),
  -- Conservar la reserva más tiempo que la validez de la URL firmada.
  expires_at timestamptz not null default (clock_timestamp() + interval '3 hours'),
  confirmed_at timestamptz,
  check (state <> 'ready' or (actual_bytes is not null and sha256 is not null and confirmed_at is not null)),
  check (actual_bytes is null or actual_bytes <= reserved_bytes)
);
create index photo_album_cleanup_idx on public.photo_album_uploads (expires_at) where state = 'reserved';
create index photo_album_ready_idx on public.photo_album_uploads (confirmed_at desc) where state = 'ready';

alter table public.photo_album_settings enable row level security;
alter table public.photo_album_uploads enable row level security;
revoke all on public.photo_album_settings, public.photo_album_uploads from public, anon, authenticated;

-- El bloqueo de la única fila de configuración serializa reservas y cambios de cuota.
-- Las reservas y los objetos pendientes de limpieza consumen cuota hasta borrarse.
create function public.photo_album_reserve(p_id uuid, p_bytes bigint, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.photo_album_settings%rowtype; existing public.photo_album_uploads%rowtype; used_bytes bigint;
begin
  select * into s from public.photo_album_settings where id for update;
  select * into existing from public.photo_album_uploads where id = p_id;
  if found then
    if existing.guest_name is distinct from nullif(btrim(p_name), '') then
      raise exception 'ALBUM_ID_CONFLICT';
    end if;
    return existing.state;
  end if;
  if not s.enabled or clock_timestamp() < s.opens_at or clock_timestamp() >= s.closes_at then raise exception 'ALBUM_CLOSED'; end if;
  if s.quota_bytes is null then raise exception 'ALBUM_QUOTA_UNCONFIGURED'; end if;
  if p_id is null or p_bytes is null or p_bytes not between 1 and 2097152 or char_length(coalesce(btrim(p_name), '')) > 160 then raise exception 'ALBUM_INVALID'; end if;
  select coalesce(sum(coalesce(actual_bytes, reserved_bytes)), 0) into used_bytes from public.photo_album_uploads;
  if used_bytes + 2097152 > s.quota_bytes then raise exception 'ALBUM_QUOTA_EXCEEDED'; end if;
  insert into public.photo_album_uploads (id, object_path, guest_name, reserved_bytes)
  values (p_id, p_id::text || '.jpg', nullif(btrim(p_name), ''), 2097152);
  return 'reserved';
end $$;
revoke all on function public.photo_album_reserve(uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.photo_album_reserve(uuid,bigint,text) to service_role;

-- La limpieza marca filas primero; solo se liberan tras borrar el objeto desde
-- Storage. SKIP LOCKED permite que varios procesos cooperen sin duplicarse.
create function public.photo_album_claim_expired(p_limit integer default 50)
returns table(id uuid, object_path text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 100 then raise exception 'ALBUM_INVALID'; end if;
  return query
    with candidates as (
      select u.id from public.photo_album_uploads u
      where u.state = 'reserved' and u.expires_at <= clock_timestamp()
      order by u.expires_at for update skip locked limit p_limit
    )
    update public.photo_album_uploads u set state = 'cleanup'
    from candidates c where u.id = c.id returning u.id, u.object_path;
end $$;
revoke all on function public.photo_album_claim_expired(integer) from public, anon, authenticated;
grant execute on function public.photo_album_claim_expired(integer) to service_role;

-- No se crean políticas de acceso directo al bucket.
commit;
