-- Extensiones aditivas para gestión de invitados y mesas.
-- Preparada para revisión: NO ejecutar hasta validar contra el esquema remoto.
begin;

-- Se mantiene rsvp_state existente para no romper las RPC públicas actuales.
-- response_intent permite registrar "indeciso" sin reinterpretar respuestas guardadas.
alter table public.invitations
  add column if not exists response_intent text not null default 'pending'
  check (response_intent in ('pending', 'attending', 'declined', 'uncertain'));

-- rsvp_state es un enum base. Validamos sus etiquetas antes de copiarlo para
-- no convertir silenciosamente un valor agregado en un estado equivocado.
do $$
begin
  if exists (
    select 1 from public.invitations
    where rsvp_state::text not in ('pending', 'attending', 'declined')
  ) then
    raise exception 'rsvp_state contiene una etiqueta no compatible con response_intent';
  end if;
end;
$$;

update public.invitations
set response_intent = case rsvp_state
  when 'pending'::public.rsvp_state then 'pending'
  when 'attending'::public.rsvp_state then 'attending'
  when 'declined'::public.rsvp_state then 'declined'
end
where response_intent = 'pending';

-- Compatibilidad con las RPC actuales: cada cambio de rsvp_state actualiza
-- response_intent. Para el único estado nuevo, "uncertain", rsvp_state queda
-- en pending, que es su equivalente seguro para las RPC heredadas.
create or replace function private.sync_rsvp_response_intent()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.response_intent = 'uncertain' then
      new.rsvp_state := 'pending'::public.rsvp_state;
    elsif new.response_intent in ('attending', 'declined') then
      new.rsvp_state := new.response_intent::public.rsvp_state;
    else
      new.response_intent := new.rsvp_state::text;
    end if;
  elsif new.rsvp_state is distinct from old.rsvp_state then
    new.response_intent := new.rsvp_state::text;
  elsif new.response_intent is distinct from old.response_intent then
    if new.response_intent = 'uncertain' then
      new.rsvp_state := 'pending'::public.rsvp_state;
    else
      new.rsvp_state := new.response_intent::public.rsvp_state;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invitations_sync_rsvp_response_intent on public.invitations;
create trigger invitations_sync_rsvp_response_intent
before insert or update of rsvp_state, response_intent on public.invitations
for each row execute function private.sync_rsvp_response_intent();

revoke all on function private.sync_rsvp_response_intent() from public;

alter table public.rsvp_attendees
  add column if not exists attendee_type text not null default 'adult'
  check (attendee_type in ('adult', 'child'));

-- Integrantes previstos: no equivalen a una confirmación ni crean asistentes.
create table if not exists public.invitation_members (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  invitation_id uuid not null references public.invitations(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 3 and 160),
  attendee_type text not null default 'adult' check (attendee_type in ('adult', 'child')),
  initial_table_id uuid references public.event_tables(id) on delete set null,
  phone text check (phone is null or char_length(btrim(phone)) between 3 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invitation_id, full_name)
);

create index if not exists invitation_members_invitation_idx
  on public.invitation_members (invitation_id);

drop trigger if exists invitation_members_set_updated_at on public.invitation_members;
create trigger invitation_members_set_updated_at before update on public.invitation_members
for each row execute function private.set_updated_at();

-- Registro de recordatorios manuales: no envía WhatsApp ni guarda mensajes.
create table if not exists public.rsvp_reminders (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  invitation_id uuid not null references public.invitations(id) on delete cascade,
  sent_at timestamptz not null default clock_timestamp(),
  sent_by uuid not null references auth.users(id) on delete restrict,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'manual')),
  created_at timestamptz not null default now()
);

create index if not exists rsvp_reminders_invitation_sent_idx
  on public.rsvp_reminders (invitation_id, sent_at desc);

-- Historial explícito para movimientos y futura acción de deshacer.
create table if not exists public.rsvp_table_move_batches (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('move_attendee', 'move_family', 'swap')),
  created_at timestamptz not null default clock_timestamp(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  check ((undone_at is null and undone_by is null) or (undone_at is not null and undone_by is not null))
);

create table if not exists public.rsvp_table_moves (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  batch_id uuid not null references public.rsvp_table_move_batches(id) on delete restrict,
  attendee_id uuid not null references public.rsvp_attendees(id) on delete restrict,
  invitation_id uuid not null references public.invitations(id) on delete restrict,
  from_assignment_id uuid references public.rsvp_seat_assignments(id) on delete restrict,
  -- NULL representa explícitamente un movimiento hacia «Sin mesa asignada».
  to_assignment_id uuid references public.rsvp_seat_assignments(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (batch_id, attendee_id),
  check (from_assignment_id is not null or to_assignment_id is not null)
);

create index if not exists rsvp_table_moves_batch_idx on public.rsvp_table_moves (batch_id);

alter table public.invitation_members enable row level security;
alter table public.rsvp_reminders enable row level security;
alter table public.rsvp_table_move_batches enable row level security;
alter table public.rsvp_table_moves enable row level security;
revoke all on table public.invitation_members, public.rsvp_reminders,
  public.rsvp_table_move_batches, public.rsvp_table_moves from public, anon, authenticated;

-- La capa pública/administrativa seguirá usando Edge Functions con service_role.
-- Las RPC futuras deberán validar private.assert_rsvp_admin antes de escribir.
commit;
