-- Mesas administrativas RSVP. No modifica invitaciones, respuestas ni asistentes.
begin;

create table public.event_tables (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  table_number integer not null unique check (table_number between 1 and 99),
  display_name text not null unique check (char_length(btrim(display_name)) between 1 and 80),
  capacity integer not null check (capacity between 1 and 54),
  is_head_table boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index event_tables_one_head_table_idx on public.event_tables (is_head_table) where is_head_table;

create table public.event_table_seats (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  table_id uuid not null references public.event_tables(id) on delete restrict,
  seat_number integer not null check (seat_number between 1 and 54),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (table_id, seat_number)
);

create table public.rsvp_seat_assignments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  seat_id uuid not null references public.event_table_seats(id) on delete restrict,
  attendee_id uuid references public.rsvp_attendees(id) on delete set null,
  invitation_id uuid not null references public.invitations(id) on delete restrict,
  attendee_name_snapshot text not null check (char_length(btrim(attendee_name_snapshot)) between 3 and 160),
  assigned_by uuid not null references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references auth.users(id) on delete set null,
  release_reason text check (release_reason is null or char_length(release_reason) between 1 and 80),
  -- Las liberaciones automáticas por una modificación RSVP no tienen actor
  -- humano, pero siempre conservan una razón y fecha de historial.
  check (released_at is null or released_by is not null or release_reason = 'rsvp_changed')
);

create unique index rsvp_active_seat_assignment_idx on public.rsvp_seat_assignments (seat_id) where released_at is null;
create unique index rsvp_active_attendee_assignment_idx on public.rsvp_seat_assignments (attendee_id) where released_at is null and attendee_id is not null;
create index rsvp_seat_assignment_invitation_idx on public.rsvp_seat_assignments (invitation_id, released_at);

insert into public.event_tables (table_number, display_name, capacity, is_head_table)
values (1, 'Mesa 1', 8, false), (2, 'Mesa 2', 8, false), (3, 'Mesa 3', 8, false),
       (4, 'Mesa 4', 14, true), (5, 'Mesa 5', 8, false), (6, 'Mesa 6', 8, false);

insert into public.event_table_seats (table_id, seat_number)
select t.id, n.seat_number
from public.event_tables t
cross join lateral generate_series(1, t.capacity) as n(seat_number);

create or replace function private.release_deleted_attendee_seats()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.rsvp_seat_assignments
  set released_at = clock_timestamp(),
      released_by = null,
      release_reason = 'rsvp_changed'
  where attendee_id = old.id and released_at is null;
  return old;
end;
$$;

drop trigger if exists rsvp_attendee_release_seats on public.rsvp_attendees;
create trigger rsvp_attendee_release_seats before delete on public.rsvp_attendees
for each row execute function private.release_deleted_attendee_seats();

create or replace function public.rsvp_admin_get_guest_data(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  select jsonb_build_object(
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'groupName', i.group_name, 'maxPasses', i.max_passes,
        'isActive', i.is_active, 'state', i.rsvp_state, 'updatedAt', i.updated_at,
        'response', case when r.id is null then null else jsonb_build_object(
          'isAttending', r.is_attending, 'confirmedCount', r.confirmed_count,
          'comment', r.comment, 'attendees', coalesce(a.items, '[]'::jsonb)
        ) end
      ) order by i.group_name)
      from public.invitations i
      left join public.rsvp_responses r on r.invitation_id = i.id
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', at.id, 'fullName', at.full_name,
          'seatAssignment', case when sa.id is null then null else jsonb_build_object(
            'tableId', et.id, 'tableNumber', et.table_number, 'seatNumber', es.seat_number
          ) end
        ) order by at.created_at, at.id) as items
        from public.rsvp_attendees at
        left join public.rsvp_seat_assignments sa on sa.attendee_id = at.id and sa.released_at is null
        left join public.event_table_seats es on es.id = sa.seat_id
        left join public.event_tables et on et.id = es.table_id
        where at.response_id = r.id
      ) a on true
    ), '[]'::jsonb),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.table_number, 'name', t.display_name,
        'capacity', t.capacity, 'isHeadTable', t.is_head_table,
        'seats', coalesce(s.items, '[]'::jsonb)
      ) order by t.table_number)
      from public.event_tables t
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'seatId', es.id, 'seatNumber', es.seat_number, 'isActive', es.is_active,
          'assignment', case when sa.id is null then null else jsonb_build_object(
            'id', sa.id, 'attendeeId', sa.attendee_id, 'fullName', sa.attendee_name_snapshot,
            'invitationId', sa.invitation_id, 'assignedAt', sa.assigned_at
          ) end
        ) order by es.seat_number) as items
        from public.event_table_seats es
        left join public.rsvp_seat_assignments sa on sa.seat_id = es.id and sa.released_at is null
        where es.table_id = t.id
      ) s on true where t.is_active
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.rsvp_admin_assign_seat(
  p_table_id uuid, p_seat_number integer, p_attendee_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_seat public.event_table_seats%rowtype; v_invitation_id uuid; v_full_name text;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  -- Mismo primer candado que el ajuste de capacidad: evita que una silla sea
  -- asignada mientras otro administrador la desactiva al reducir una mesa.
  perform 1 from public.event_tables where id = p_table_id and is_active for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_TABLE_NOT_FOUND'; end if;
  select s.* into v_seat from public.event_table_seats s
  where s.table_id = p_table_id and s.seat_number = p_seat_number and s.is_active for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_SEAT_NOT_FOUND'; end if;
  perform 1 from public.rsvp_seat_assignments where seat_id = v_seat.id and released_at is null for update;
  if found then raise exception using errcode = 'P0001', message = 'ADMIN_SEAT_OCCUPIED'; end if;
  select i.id, a.full_name into v_invitation_id, v_full_name
  from public.rsvp_attendees a join public.rsvp_responses r on r.id = a.response_id
  join public.invitations i on i.id = r.invitation_id
  where a.id = p_attendee_id and r.is_attending and i.is_active for update of a, r, i;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_ATTENDEE_NOT_ELIGIBLE'; end if;
  perform 1 from public.rsvp_seat_assignments where attendee_id = p_attendee_id and released_at is null for update;
  if found then raise exception using errcode = 'P0001', message = 'ADMIN_ATTENDEE_ALREADY_SEATED'; end if;
  insert into public.rsvp_seat_assignments (seat_id, attendee_id, invitation_id, attendee_name_snapshot, assigned_by)
  values (v_seat.id, p_attendee_id, v_invitation_id, v_full_name, p_actor_user_id);
  return public.rsvp_admin_get_guest_data(p_actor_user_id);
end;
$$;

create or replace function public.rsvp_admin_release_seat(
  p_table_id uuid, p_seat_number integer, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_seat_id uuid;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  perform 1 from public.event_tables where id = p_table_id and is_active for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_TABLE_NOT_FOUND'; end if;
  select id into v_seat_id from public.event_table_seats
  where table_id = p_table_id and seat_number = p_seat_number for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_SEAT_NOT_FOUND'; end if;
  update public.rsvp_seat_assignments set released_at = clock_timestamp(), released_by = p_actor_user_id, release_reason = 'admin_released'
  where seat_id = v_seat_id and released_at is null;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_SEAT_EMPTY'; end if;
  return public.rsvp_admin_get_guest_data(p_actor_user_id);
end;
$$;

create or replace function public.rsvp_admin_update_table_capacity(
  p_table_id uuid, p_capacity integer, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_table public.event_tables%rowtype;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if p_capacity is null or p_capacity not between 1 and 54 then
    raise exception using errcode = 'P0001', message = 'ADMIN_TABLE_CAPACITY_INVALID'; end if;
  select * into v_table from public.event_tables where id = p_table_id and is_active for update;
  if not found then raise exception using errcode = 'P0001', message = 'ADMIN_TABLE_NOT_FOUND'; end if;
  if exists (select 1 from public.event_table_seats s join public.rsvp_seat_assignments a on a.seat_id=s.id and a.released_at is null
             where s.table_id=p_table_id and s.seat_number > p_capacity) then
    raise exception using errcode = 'P0001', message = 'ADMIN_TABLE_CAPACITY_OCCUPIED'; end if;
  insert into public.event_table_seats (table_id, seat_number, is_active)
  select p_table_id, n, true from generate_series(1, p_capacity) n on conflict (table_id, seat_number) do update set is_active=true;
  update public.event_table_seats set is_active=false where table_id=p_table_id and seat_number > p_capacity;
  update public.event_tables set capacity=p_capacity where id=p_table_id;
  return public.rsvp_admin_get_guest_data(p_actor_user_id);
end;
$$;

create or replace function public.rsvp_admin_export_guest_data(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'family', i.group_name, 'state', i.rsvp_state, 'maxPasses', i.max_passes,
    'fullName', a.full_name, 'tableNumber', t.table_number, 'seatNumber', s.seat_number,
    'observations', r.comment
  ) order by i.group_name, a.full_name)
  from public.invitations i left join public.rsvp_responses r on r.invitation_id=i.id
  left join public.rsvp_attendees a on a.response_id=r.id
  left join public.rsvp_seat_assignments sa on sa.attendee_id=a.id and sa.released_at is null
  left join public.event_table_seats s on s.id=sa.seat_id
  left join public.event_tables t on t.id=s.table_id), '[]'::jsonb);
end;
$$;

alter table public.event_tables enable row level security;
alter table public.event_table_seats enable row level security;
alter table public.rsvp_seat_assignments enable row level security;
revoke all on table public.event_tables, public.event_table_seats, public.rsvp_seat_assignments from anon, authenticated;
revoke all on function private.release_deleted_attendee_seats() from public;
revoke all on function public.rsvp_admin_get_guest_data(uuid), public.rsvp_admin_assign_seat(uuid,integer,uuid,uuid), public.rsvp_admin_release_seat(uuid,integer,uuid), public.rsvp_admin_update_table_capacity(uuid,integer,uuid), public.rsvp_admin_export_guest_data(uuid) from public, anon, authenticated;
grant execute on function public.rsvp_admin_get_guest_data(uuid), public.rsvp_admin_assign_seat(uuid,integer,uuid,uuid), public.rsvp_admin_release_seat(uuid,integer,uuid), public.rsvp_admin_update_table_capacity(uuid,integer,uuid), public.rsvp_admin_export_guest_data(uuid) to service_role;

commit;
