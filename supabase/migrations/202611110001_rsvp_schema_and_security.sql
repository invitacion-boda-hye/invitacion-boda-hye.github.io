-- RSVP seguro para Hector & Elisbe.
--
-- Esta migración no contiene credenciales ni tokens de invitación. Los enlaces
-- personalizados se generan en la Edge Function y aquí se almacena solamente
-- su hash SHA-256 irreversible. PostgreSQL aporta gen_random_uuid() en
-- pg_catalog, por lo que no dependemos del esquema de ninguna extensión.

begin;

create schema if not exists private;
revoke all on schema private from public;

do $$
begin
  create type public.rsvp_state as enum ('pending', 'attending', 'declined');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.event_settings (
  id boolean primary key default true check (id),
  event_name text not null default 'Matrimonio de Hector & Elisbe',
  event_date date not null default date '2027-01-09',
  capacity integer not null default 50 check (capacity between 1 and 1000),
  rsvp_deadline timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.event_settings (id, event_name, event_date, capacity)
values (true, 'Matrimonio de Hector & Elisbe', date '2027-01-09', 50)
on conflict (id) do nothing;

create table if not exists public.rsvp_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.invitations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  group_name text not null check (char_length(btrim(group_name)) between 1 and 160),
  max_passes integer not null check (max_passes between 1 and 1000),
  token_hash char(64) not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_version integer not null default 1 check (token_version > 0),
  token_created_at timestamptz not null default now(),
  is_active boolean not null default true,
  revoked_at timestamptz,
  rsvp_state public.rsvp_state not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invitations_state_idx on public.invitations (is_active, rsvp_state);
create index if not exists invitations_group_name_idx on public.invitations using gin (to_tsvector('simple', group_name));

create table if not exists public.rsvp_responses (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  invitation_id uuid not null unique references public.invitations(id) on delete restrict,
  is_attending boolean not null,
  confirmed_count integer not null check (confirmed_count >= 0),
  comment text check (comment is null or char_length(comment) <= 500),
  responded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rsvp_responses_attendance_count_check check (
    (is_attending and confirmed_count >= 1)
    or ((not is_attending) and confirmed_count = 0)
  )
);

create index if not exists rsvp_responses_attendance_idx on public.rsvp_responses (is_attending, confirmed_count);

create table if not exists public.rsvp_attendees (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  response_id uuid not null references public.rsvp_responses(id) on delete cascade,
  full_name text not null check (
    char_length(full_name) between 3 and 160
    and full_name = btrim(full_name)
    and full_name ~ E'\\S+\\s+\\S+'
  ),
  created_at timestamptz not null default now()
);

create index if not exists rsvp_attendees_response_idx on public.rsvp_attendees (response_id);

-- No se guarda el contenido de los comentarios ni los nombres en la bitácora.
create table if not exists public.rsvp_audit_log (
  id bigint generated always as identity primary key,
  invitation_id uuid not null references public.invitations(id) on delete cascade,
  response_id uuid references public.rsvp_responses(id) on delete set null,
  actor_kind text not null check (actor_kind in ('guest', 'admin', 'system')),
  actor_admin_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 80),
  previous_confirmed_count integer,
  new_confirmed_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rsvp_audit_log_invitation_idx on public.rsvp_audit_log (invitation_id, created_at desc);

-- Claves ya hasheadas: nunca se almacenan IPs ni tokens de invitación en claro.
create table if not exists public.rsvp_rate_limits (
  scope text not null check (char_length(scope) between 1 and 80),
  key_hash char(64) not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts >= 0),
  primary key (scope, key_hash)
);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists event_settings_set_updated_at on public.event_settings;
create trigger event_settings_set_updated_at
before update on public.event_settings
for each row execute function private.set_updated_at();

drop trigger if exists invitations_set_updated_at on public.invitations;
create trigger invitations_set_updated_at
before update on public.invitations
for each row execute function private.set_updated_at();

drop trigger if exists rsvp_responses_set_updated_at on public.rsvp_responses;
create trigger rsvp_responses_set_updated_at
before update on public.rsvp_responses
for each row execute function private.set_updated_at();

create or replace function private.assert_rsvp_admin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null
    or not exists (select 1 from public.rsvp_admins where user_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'ADMIN_UNAUTHORIZED';
  end if;
end;
$$;

revoke all on function private.set_updated_at() from public;
revoke all on function private.assert_rsvp_admin(uuid) from public;

create or replace function public.rsvp_take_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  if p_scope is null or char_length(p_scope) not between 1 and 80
    or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_limit < 1 or p_window_seconds < 1 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT_ARGUMENT_INVALID';
  end if;

  insert into public.rsvp_rate_limits as limits (scope, key_hash, window_started_at, attempts)
  values (p_scope, p_key_hash, clock_timestamp(), 1)
  on conflict (scope, key_hash) do update
  set window_started_at = case
        when limits.window_started_at <= clock_timestamp() - (p_window_seconds * interval '1 second')
          then clock_timestamp()
        else limits.window_started_at
      end,
      attempts = case
        when limits.window_started_at <= clock_timestamp() - (p_window_seconds * interval '1 second')
          then 1
        else limits.attempts + 1
      end
  returning attempts into v_attempts;

  return v_attempts <= p_limit;
end;
$$;

create or replace function public.rsvp_resolve_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select jsonb_build_object(
    'event', jsonb_build_object(
      'name', settings.event_name,
      'date', settings.event_date,
      'deadline', settings.rsvp_deadline
    ),
    'invitation', jsonb_build_object(
      'id', invitation.id,
      'groupName', invitation.group_name,
      'maxPasses', invitation.max_passes,
      'canModify', settings.rsvp_deadline is null or clock_timestamp() < settings.rsvp_deadline
    ),
    'response', case when response.id is null then null else jsonb_build_object(
      'isAttending', response.is_attending,
      'confirmedCount', response.confirmed_count,
      'comment', response.comment,
      'respondedAt', response.responded_at,
      'updatedAt', response.updated_at,
      'attendees', attendees.items
    ) end
  )
  into v_result
  from public.invitations as invitation
  cross join public.event_settings as settings
  left join public.rsvp_responses as response on response.invitation_id = invitation.id
  left join lateral (
    select coalesce(
      jsonb_agg(jsonb_build_object('fullName', attendee.full_name) order by attendee.created_at, attendee.id),
      '[]'::jsonb
    ) as items
    from public.rsvp_attendees as attendee
    where attendee.response_id = response.id
  ) as attendees on true
  where invitation.token_hash = p_token_hash
    and invitation.is_active = true
  limit 1;

  return v_result;
end;
$$;

create or replace function public.rsvp_submit(
  p_token_hash text,
  p_is_attending boolean,
  p_confirmed_count integer,
  p_attendees jsonb,
  p_comment text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_invitation public.invitations%rowtype;
  v_existing public.rsvp_responses%rowtype;
  v_response_id uuid;
  v_previous_count integer := 0;
  v_total_confirmed integer := 0;
  v_attendee_count integer;
  v_name text;
  v_names text[] := array[]::text[];
  v_item jsonb;
  v_comment text;
  v_had_response boolean := false;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  if p_is_attending is null or jsonb_typeof(p_attendees) <> 'array' then
    raise exception using errcode = 'P0001', message = 'RSVP_PAYLOAD_INVALID';
  end if;

  v_attendee_count := jsonb_array_length(p_attendees);
  if p_confirmed_count is null or p_confirmed_count <> v_attendee_count then
    raise exception using errcode = 'P0001', message = 'RSVP_COUNT_MISMATCH';
  end if;

  v_comment := nullif(btrim(p_comment), '');
  if v_comment is not null and char_length(v_comment) > 500 then
    raise exception using errcode = 'P0001', message = 'RSVP_COMMENT_TOO_LONG';
  end if;

  -- Este candado serializa todos los cambios que puedan afectar la capacidad.
  select * into v_settings
  from public.event_settings
  where id = true
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;

  select * into v_invitation
  from public.invitations
  where token_hash = p_token_hash
    and is_active = true
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  if v_settings.rsvp_deadline is not null and clock_timestamp() >= v_settings.rsvp_deadline then
    raise exception using errcode = 'P0001', message = 'RSVP_DEADLINE_PASSED';
  end if;

  if p_is_attending then
    if p_confirmed_count < 1 or p_confirmed_count > v_invitation.max_passes then
      raise exception using errcode = 'P0001', message = 'RSVP_PASSES_EXCEEDED';
    end if;

    for v_item in select value from jsonb_array_elements(p_attendees)
    loop
      v_name := regexp_replace(btrim(v_item ->> 'full_name'), E'\\s+', ' ', 'g');
      if v_name is null
        or char_length(v_name) not between 3 and 160
        or array_length(regexp_split_to_array(v_name, E'\\s+'), 1) < 2 then
        raise exception using errcode = 'P0001', message = 'RSVP_ATTENDEE_NAME_INVALID';
      end if;
      v_names := array_append(v_names, v_name);
    end loop;
  elsif p_confirmed_count <> 0 then
    raise exception using errcode = 'P0001', message = 'RSVP_DECLINE_MUST_BE_ZERO';
  end if;

  select * into v_existing
  from public.rsvp_responses
  where invitation_id = v_invitation.id
  for update;

  v_had_response := found;
  if v_had_response then
    v_previous_count := v_existing.confirmed_count;
  end if;

  select coalesce(sum(response.confirmed_count) filter (where response.is_attending), 0)::integer
  into v_total_confirmed
  from public.rsvp_responses as response
  join public.invitations as invitation on invitation.id = response.invitation_id
  where invitation.is_active = true;

  -- Las reducciones y una respuesta ya existente se permiten aunque el
  -- administrador haya corregido temporalmente la capacidad hacia abajo.
  if p_confirmed_count > v_previous_count
    and v_total_confirmed - v_previous_count + p_confirmed_count > v_settings.capacity then
    raise exception using errcode = 'P0001', message = 'RSVP_CAPACITY_EXCEEDED';
  end if;

  insert into public.rsvp_responses (
    invitation_id, is_attending, confirmed_count, comment, responded_at
  )
  values (
    v_invitation.id, p_is_attending, p_confirmed_count, v_comment, clock_timestamp()
  )
  on conflict (invitation_id) do update
  set is_attending = excluded.is_attending,
      confirmed_count = excluded.confirmed_count,
      comment = excluded.comment
  returning id into v_response_id;

  delete from public.rsvp_attendees where response_id = v_response_id;

  if p_is_attending then
    insert into public.rsvp_attendees (response_id, full_name)
    select v_response_id, name
    from unnest(v_names) as name;
  end if;

  update public.invitations
  set rsvp_state = case when p_is_attending then 'attending'::public.rsvp_state else 'declined'::public.rsvp_state end
  where id = v_invitation.id;

  insert into public.rsvp_audit_log (
    invitation_id, response_id, actor_kind, action,
    previous_confirmed_count, new_confirmed_count, metadata
  )
  values (
    v_invitation.id,
    v_response_id,
    'guest',
    case when v_had_response then 'response_updated' else 'response_created' end,
    v_previous_count,
    p_confirmed_count,
    jsonb_build_object('source', 'public_rsvp')
  );

  return public.rsvp_resolve_invitation(p_token_hash);
end;
$$;

create or replace function public.rsvp_admin_create_invitation(
  p_group_name text,
  p_max_passes integer,
  p_token_hash text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_invitation public.invitations%rowtype;
  v_group_name text;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  v_group_name := regexp_replace(btrim(p_group_name), E'\\s+', ' ', 'g');

  if v_group_name is null or char_length(v_group_name) not between 1 and 160
    or p_max_passes is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMIN_INVITATION_ARGUMENT_INVALID';
  end if;

  select * into v_settings from public.event_settings where id = true for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;
  if p_max_passes < 1 or p_max_passes > v_settings.capacity then
    raise exception using errcode = 'P0001', message = 'ADMIN_PASSES_EXCEED_CAPACITY';
  end if;

  insert into public.invitations (group_name, max_passes, token_hash)
  values (v_group_name, p_max_passes, p_token_hash)
  returning * into v_invitation;

  insert into public.rsvp_audit_log (
    invitation_id, actor_kind, actor_admin_id, action, metadata
  )
  values (
    v_invitation.id, 'admin', p_actor_user_id, 'invitation_created',
    jsonb_build_object('maxPasses', p_max_passes)
  );

  return jsonb_build_object(
    'id', v_invitation.id,
    'groupName', v_invitation.group_name,
    'maxPasses', v_invitation.max_passes,
    'state', v_invitation.rsvp_state,
    'createdAt', v_invitation.created_at
  );
end;
$$;

create or replace function public.rsvp_admin_regenerate_token(
  p_invitation_id uuid,
  p_token_hash text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_invitation public.invitations%rowtype;
  v_active_confirmed integer := 0;
  v_reactivation_count integer := 0;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ADMIN_INVITATION_ARGUMENT_INVALID';
  end if;

  -- Mismo orden que rsvp_submit: primero el evento y luego la invitación.
  -- Así una reactivación no puede competir con una confirmación pública.
  select * into v_settings from public.event_settings where id = true for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;

  select * into v_invitation from public.invitations where id = p_invitation_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ADMIN_INVITATION_NOT_FOUND';
  end if;

  if v_invitation.max_passes > v_settings.capacity then
    raise exception using errcode = 'P0001', message = 'ADMIN_PASSES_EXCEED_CAPACITY';
  end if;

  if not v_invitation.is_active then
    select coalesce(max(response.confirmed_count) filter (where response.is_attending), 0)::integer
    into v_reactivation_count
    from public.rsvp_responses as response
    where response.invitation_id = v_invitation.id;

    select coalesce(sum(response.confirmed_count) filter (where response.is_attending), 0)::integer
    into v_active_confirmed
    from public.rsvp_responses as response
    join public.invitations as invitation on invitation.id = response.invitation_id
    where invitation.is_active = true;

    if v_active_confirmed + v_reactivation_count > v_settings.capacity then
      raise exception using errcode = 'P0001', message = 'ADMIN_REACTIVATION_CAPACITY_EXCEEDED';
    end if;
  end if;

  update public.invitations
  set token_hash = p_token_hash,
      token_version = token_version + 1,
      token_created_at = clock_timestamp(),
      is_active = true,
      revoked_at = null
  where id = p_invitation_id
  returning * into v_invitation;

  insert into public.rsvp_audit_log (
    invitation_id, actor_kind, actor_admin_id, action, metadata
  )
  values (
    v_invitation.id, 'admin', p_actor_user_id, 'invitation_link_regenerated',
    jsonb_build_object('tokenVersion', v_invitation.token_version)
  );

  return jsonb_build_object(
    'id', v_invitation.id,
    'groupName', v_invitation.group_name,
    'maxPasses', v_invitation.max_passes,
    'state', v_invitation.rsvp_state,
    'tokenVersion', v_invitation.token_version
  );
end;
$$;

create or replace function public.rsvp_admin_revoke_invitation(
  p_invitation_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_invitation public.invitations%rowtype;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);

  -- Aunque revocar solo libere cupos, adquiere el mismo primer candado que las
  -- demás operaciones de capacidad para evitar órdenes de bloqueo cruzadas.
  select * into v_settings from public.event_settings where id = true for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;

  select * into v_invitation
  from public.invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'ADMIN_INVITATION_NOT_FOUND';
  end if;

  update public.invitations
  set is_active = false,
      revoked_at = clock_timestamp()
  where id = v_invitation.id
  returning * into v_invitation;

  insert into public.rsvp_audit_log (
    invitation_id, actor_kind, actor_admin_id, action
  )
  values (v_invitation.id, 'admin', p_actor_user_id, 'invitation_revoked');

  return jsonb_build_object('id', v_invitation.id, 'isActive', v_invitation.is_active);
end;
$$;

create or replace function public.rsvp_admin_update_event_settings(
  p_capacity integer,
  p_rsvp_deadline timestamptz,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_confirmed integer;
  v_max_active_passes integer;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if p_capacity is null or p_capacity not between 1 and 1000 then
    raise exception using errcode = 'P0001', message = 'ADMIN_CAPACITY_INVALID';
  end if;

  select * into v_settings from public.event_settings where id = true for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;
  select coalesce(sum(response.confirmed_count) filter (where response.is_attending), 0)::integer
  into v_confirmed
  from public.rsvp_responses as response
  join public.invitations as invitation on invitation.id = response.invitation_id
  where invitation.is_active = true;

  select coalesce(max(invitation.max_passes) filter (where invitation.is_active), 0)::integer
  into v_max_active_passes
  from public.invitations as invitation;

  if p_capacity < v_confirmed then
    raise exception using errcode = 'P0001', message = 'ADMIN_CAPACITY_BELOW_CONFIRMED';
  end if;
  if p_capacity < v_max_active_passes then
    raise exception using errcode = 'P0001', message = 'ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES';
  end if;

  update public.event_settings
  set capacity = p_capacity,
      rsvp_deadline = p_rsvp_deadline
  where id = true
  returning * into v_settings;

  return jsonb_build_object(
    'capacity', v_settings.capacity,
    'rsvpDeadline', v_settings.rsvp_deadline,
    'confirmedCount', v_confirmed
  );
end;
$$;

create or replace function public.rsvp_admin_dashboard_summary(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_assigned integer;
  v_confirmed integer;
  v_pending integer;
  v_complete integer;
  v_partial integer;
  v_declined integer;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  select * into v_settings from public.event_settings where id = true;
  if not found then
    raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING';
  end if;

  select
    coalesce(sum(invitation.max_passes) filter (where invitation.is_active), 0)::integer,
    coalesce(sum(response.confirmed_count) filter (where invitation.is_active and response.is_attending), 0)::integer,
    count(*) filter (where invitation.is_active and invitation.rsvp_state = 'pending'),
    count(*) filter (
      where invitation.is_active
        and invitation.rsvp_state = 'attending'
        and response.confirmed_count = invitation.max_passes
    ),
    count(*) filter (
      where invitation.is_active
        and invitation.rsvp_state = 'attending'
        and response.confirmed_count < invitation.max_passes
    ),
    count(*) filter (where invitation.is_active and invitation.rsvp_state = 'declined')
  into v_assigned, v_confirmed, v_pending, v_complete, v_partial, v_declined
  from public.invitations as invitation
  left join public.rsvp_responses as response on response.invitation_id = invitation.id;

  return jsonb_build_object(
    'capacity', v_settings.capacity,
    'assignedPasses', v_assigned,
    'confirmedPeople', v_confirmed,
    'availableCapacity', v_settings.capacity - v_confirmed,
    'pendingFamilies', v_pending,
    'completeFamilies', v_complete,
    'partialFamilies', v_partial,
    'declinedFamilies', v_declined,
    'rsvpDeadline', v_settings.rsvp_deadline
  );
end;
$$;

-- Defensa en profundidad: las aplicaciones web no tienen permisos directos
-- sobre nombres, comentarios, respuestas ni tokens hasheados.
alter table public.event_settings enable row level security;
alter table public.rsvp_admins enable row level security;
alter table public.invitations enable row level security;
alter table public.rsvp_responses enable row level security;
alter table public.rsvp_attendees enable row level security;
alter table public.rsvp_audit_log enable row level security;
alter table public.rsvp_rate_limits enable row level security;

revoke all on table public.event_settings from anon, authenticated;
revoke all on table public.rsvp_admins from anon, authenticated;
revoke all on table public.invitations from anon, authenticated;
revoke all on table public.rsvp_responses from anon, authenticated;
revoke all on table public.rsvp_attendees from anon, authenticated;
revoke all on table public.rsvp_audit_log from anon, authenticated;
revoke all on table public.rsvp_rate_limits from anon, authenticated;
revoke all on sequence public.rsvp_audit_log_id_seq from anon, authenticated;

revoke all on function public.rsvp_take_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.rsvp_resolve_invitation(text) from public, anon, authenticated;
revoke all on function public.rsvp_submit(text, boolean, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.rsvp_admin_create_invitation(text, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.rsvp_admin_regenerate_token(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rsvp_admin_revoke_invitation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rsvp_admin_update_event_settings(integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.rsvp_admin_dashboard_summary(uuid) from public, anon, authenticated;

grant execute on function public.rsvp_take_rate_limit(text, text, integer, integer) to service_role;
grant execute on function public.rsvp_resolve_invitation(text) to service_role;
grant execute on function public.rsvp_submit(text, boolean, integer, jsonb, text) to service_role;
grant execute on function public.rsvp_admin_create_invitation(text, integer, text, uuid) to service_role;
grant execute on function public.rsvp_admin_regenerate_token(uuid, text, uuid) to service_role;
grant execute on function public.rsvp_admin_revoke_invitation(uuid, uuid) to service_role;
grant execute on function public.rsvp_admin_update_event_settings(integer, timestamptz, uuid) to service_role;
grant execute on function public.rsvp_admin_dashboard_summary(uuid) to service_role;

commit;
