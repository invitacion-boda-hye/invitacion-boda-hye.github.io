-- Etapa 3: identidad estable e invitaciones individuales provisionales.
-- Requiere 202611150001_guest_panel_extensions (invitation_members).
begin;

do $$
begin
  if to_regclass('public.invitation_members') is null then
    raise exception 'GUEST_PANEL_EXTENSIONS_REQUIRED';
  end if;
end $$;

alter table public.invitation_members
  add column if not exists guest_id text,
  add column if not exists name_pending boolean not null default false,
  add column if not exists member_state text not null default 'pending';

alter table public.invitation_members
  drop constraint if exists invitation_members_member_state_check;
alter table public.invitation_members
  add constraint invitation_members_member_state_check
  check (member_state in ('pending', 'attending', 'declined', 'uncertain'));

-- Partial uniqueness keeps existing manually created members compatible while
-- making every imported guest_id immutable and idempotent.
create unique index if not exists invitation_members_guest_id_unique
  on public.invitation_members (guest_id) where guest_id is not null;
create index if not exists invitation_members_invitation_id_idx
  on public.invitation_members (invitation_id);

create or replace function public.rsvp_admin_import_provisional_guest(
  p_guest_id text,
  p_full_name text,
  p_table_number integer,
  p_name_pending boolean,
  p_token_hash text,
  p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_guest_id text := lower(btrim(p_guest_id));
  v_name text := regexp_replace(btrim(p_full_name), E'\\s+', ' ', 'g');
  v_table_id uuid;
  v_existing public.invitation_members%rowtype;
  v_invitation public.invitations%rowtype;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if v_guest_id is null or v_guest_id !~ '^[a-z0-9][a-z0-9-]{2,79}$'
    or v_name is null or char_length(v_name) not between 1 and 160
    or p_table_number is null or p_name_pending is null
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0001', message='ADMIN_GUEST_IMPORT_ARGUMENT_INVALID';
  end if;

  select id into v_table_id from public.event_tables
  where table_number = p_table_number and is_active for share;
  if not found then raise exception using errcode='P0001', message='ADMIN_TABLE_NOT_FOUND'; end if;

  select * into v_existing from public.invitation_members
  where guest_id = v_guest_id for update;
  if found then
    select * into v_invitation from public.invitations where id = v_existing.invitation_id;
    return jsonb_build_object('status','existing','guestId',v_guest_id,
      'memberId',v_existing.id,'invitationId',v_existing.invitation_id,
      'groupName',v_invitation.group_name);
  end if;

  insert into public.invitations (group_name, max_passes, token_hash, rsvp_state)
  values (v_name, 1, p_token_hash, 'pending'::public.rsvp_state)
  returning * into v_invitation;
  insert into public.invitation_members
    (invitation_id, guest_id, full_name, name_pending, initial_table_id, attendee_type, member_state)
  values (v_invitation.id, v_guest_id, v_name, p_name_pending, v_table_id, 'adult', 'pending')
  returning * into v_existing;
  insert into public.rsvp_audit_log (invitation_id, actor_kind, actor_admin_id, action, metadata)
  values (v_invitation.id,'admin',p_actor_user_id,'provisional_guest_imported',
    jsonb_build_object('guestId',v_guest_id,'plannedTable',p_table_number,'namePending',p_name_pending));
  return jsonb_build_object('status','created','guestId',v_guest_id,
    'memberId',v_existing.id,'invitationId',v_invitation.id,'groupName',v_invitation.group_name);
end;
$$;

alter table public.invitation_members enable row level security;
revoke all on table public.invitation_members from public, anon, authenticated;

create or replace function public.rsvp_admin_get_members(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',m.id,'guestId',m.guest_id,'fullName',m.full_name,'namePending',m.name_pending,
    'attendeeType',m.attendee_type,'memberState',m.member_state,'invitationId',i.id,
    'groupName',i.group_name,'tableId',t.id,'tableNumber',t.table_number
  ) order by t.table_number nulls last,m.full_name,m.id)
  from public.invitation_members m join public.invitations i on i.id=m.invitation_id
  left join public.event_tables t on t.id=m.initial_table_id), '[]'::jsonb);
end;
$$;

create or replace function public.rsvp_admin_update_member(
  p_member_id uuid, p_full_name text, p_attendee_type text, p_table_number integer,
  p_name_pending boolean, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text := regexp_replace(btrim(p_full_name), E'\\s+', ' ', 'g'); v_table_id uuid;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if v_name is null or char_length(v_name) not between 1 and 160
    or p_attendee_type not in ('adult','child') or p_name_pending is null then
    raise exception using errcode='P0001', message='ADMIN_MEMBER_ARGUMENT_INVALID'; end if;
  if p_table_number is not null then
    select id into v_table_id from public.event_tables where table_number=p_table_number and is_active;
    if not found then raise exception using errcode='P0001', message='ADMIN_TABLE_NOT_FOUND'; end if;
  end if;
  update public.invitation_members set full_name=v_name, attendee_type=p_attendee_type,
    name_pending=p_name_pending, initial_table_id=v_table_id, updated_at=clock_timestamp()
  where id=p_member_id;
  if not found then raise exception using errcode='P0001', message='ADMIN_MEMBER_NOT_FOUND'; end if;
  return public.rsvp_admin_get_members(p_actor_user_id);
end;
$$;

create or replace function public.rsvp_admin_group_members(
  p_member_ids uuid[], p_group_name text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_target uuid; v_target_invitation uuid; v_previous_invitations uuid[];
  v_name text := regexp_replace(btrim(p_group_name), E'\\s+', ' ', 'g');
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  select array_agg(distinct id order by id) into v_ids from unnest(p_member_ids) id;
  if coalesce(array_length(v_ids,1),0) < 1 or v_name is null or char_length(v_name) not between 1 and 160 then
    raise exception using errcode='P0001', message='ADMIN_GROUP_ARGUMENT_INVALID'; end if;
  perform 1 from public.invitation_members where id=any(v_ids) for update;
  if (select count(*) from public.invitation_members where id=any(v_ids)) <> array_length(v_ids,1) then
    raise exception using errcode='P0001', message='ADMIN_MEMBER_NOT_FOUND'; end if;
  if exists (select 1 from public.invitation_members m join public.invitations i on i.id=m.invitation_id
             left join public.rsvp_responses r on r.invitation_id=i.id
             where m.id=any(v_ids) and (m.member_state <> 'pending' or r.id is not null)) then
    raise exception using errcode='P0001', message='ADMIN_GROUP_HAS_RESPONSES'; end if;
  select array_agg(distinct invitation_id) into v_previous_invitations
  from public.invitation_members where id=any(v_ids);
  select id, invitation_id into v_target, v_target_invitation from public.invitation_members where id=any(v_ids) order by id limit 1;
  update public.invitation_members set invitation_id=v_target_invitation, updated_at=clock_timestamp()
  where id=any(v_ids);
  update public.invitations set group_name=v_name, max_passes=array_length(v_ids,1), updated_at=clock_timestamp()
  where id=v_target_invitation;
  update public.invitations i set is_active=false, updated_at=clock_timestamp()
  where i.id=any(v_previous_invitations) and i.id <> v_target_invitation
    and not exists (select 1 from public.rsvp_responses r where r.invitation_id=i.id);
  insert into public.rsvp_audit_log (invitation_id,actor_kind,actor_admin_id,action,metadata)
  values (v_target_invitation,'admin',p_actor_user_id,'members_grouped',jsonb_build_object('memberIds',v_ids));
  return public.rsvp_admin_get_members(p_actor_user_id);
end;
$$;

-- The existing resolver remains authoritative; this wrapper adds only members
-- for links created by the provisional import without exposing other records.
create or replace function public.rsvp_resolve_invitation_members(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_base jsonb; v_members jsonb;
begin
  v_base := public.rsvp_resolve_invitation(p_token_hash);
  if v_base is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'fullName',m.full_name,
    'namePending',m.name_pending,'attendeeType',m.attendee_type,'state',m.member_state)
    order by m.created_at,m.id),'[]'::jsonb) into v_members
  from public.invitation_members m
  where m.invitation_id=(v_base->'invitation'->>'id')::uuid;
  return v_base || jsonb_build_object('members',v_members);
end;
$$;

create or replace function public.rsvp_submit_member_states(
  p_token_hash text, p_members jsonb, p_comment text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_invitation public.invitations%rowtype; v_settings public.event_settings%rowtype;
  v_existing public.rsvp_responses%rowtype; v_response_id uuid; v_previous_count integer := 0;
  v_attending integer := 0; v_pending integer := 0; v_comment text := nullif(btrim(p_comment),'');
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_members) <> 'array' then
    raise exception using errcode='P0001', message='RSVP_PAYLOAD_INVALID'; end if;
  if v_comment is not null and char_length(v_comment)>500 then
    raise exception using errcode='P0001', message='RSVP_COMMENT_TOO_LONG'; end if;
  select * into v_settings from public.event_settings where id=true for update;
  select * into v_invitation from public.invitations where token_hash=p_token_hash and is_active for update;
  if not found then raise exception using errcode='P0001', message='INVITATION_INVALID'; end if;
  if v_settings.rsvp_deadline is not null and clock_timestamp() >= v_settings.rsvp_deadline then
    raise exception using errcode='P0001', message='RSVP_DEADLINE_PASSED'; end if;
  if jsonb_array_length(p_members) <> (select count(*) from public.invitation_members where invitation_id=v_invitation.id) then
    raise exception using errcode='P0001', message='RSVP_MEMBER_SET_INVALID'; end if;
  if exists (select 1 from jsonb_array_elements(p_members) item
    where (item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or item->>'state' not in ('pending','attending','declined')) then
    raise exception using errcode='P0001', message='RSVP_MEMBER_STATE_INVALID'; end if;
  if (select count(distinct (item->>'id')) from jsonb_array_elements(p_members) item) <> jsonb_array_length(p_members) then
    raise exception using errcode='P0001', message='RSVP_MEMBER_SET_INVALID'; end if;
  if exists (select 1 from jsonb_array_elements(p_members) item
    where not exists (select 1 from public.invitation_members m where m.id=(item->>'id')::uuid and m.invitation_id=v_invitation.id)) then
    raise exception using errcode='P0001', message='RSVP_MEMBER_SET_INVALID'; end if;
  update public.invitation_members m set member_state=item->>'state',updated_at=clock_timestamp()
  from jsonb_array_elements(p_members) item where m.id=(item->>'id')::uuid and m.invitation_id=v_invitation.id;
  select count(*) filter(where member_state='attending'), count(*) filter(where member_state='pending')
  into v_attending,v_pending from public.invitation_members where invitation_id=v_invitation.id;
  select * into v_existing from public.rsvp_responses where invitation_id=v_invitation.id for update;
  if found then v_previous_count:=v_existing.confirmed_count; end if;
  if v_attending > v_previous_count and (select coalesce(sum(confirmed_count) filter(where is_attending),0) from public.rsvp_responses) - v_previous_count + v_attending > v_settings.capacity then
    raise exception using errcode='P0001', message='RSVP_CAPACITY_EXCEEDED'; end if;
  if v_pending=0 or v_attending>0 then
    insert into public.rsvp_responses(invitation_id,is_attending,confirmed_count,comment,responded_at)
    values(v_invitation.id,v_attending>0,v_attending,v_comment,clock_timestamp())
    on conflict(invitation_id) do update set is_attending=excluded.is_attending,confirmed_count=excluded.confirmed_count,comment=excluded.comment
    returning id into v_response_id;
    delete from public.rsvp_attendees where response_id=v_response_id;
    insert into public.rsvp_attendees(response_id,full_name,attendee_type)
    select v_response_id,full_name,attendee_type from public.invitation_members where invitation_id=v_invitation.id and member_state='attending';
  else
    delete from public.rsvp_responses where invitation_id=v_invitation.id;
  end if;
  update public.invitations set response_intent=case when v_pending>0 then 'uncertain' when v_attending>0 then 'attending' else 'declined' end where id=v_invitation.id;
  insert into public.rsvp_audit_log(invitation_id,response_id,actor_kind,action,previous_confirmed_count,new_confirmed_count,metadata)
  values(v_invitation.id,v_response_id,'guest','member_states_updated',v_previous_count,v_attending,jsonb_build_object('source','public_member_rsvp'));
  return public.rsvp_resolve_invitation_members(p_token_hash);
end;
$$;

revoke all on function public.rsvp_admin_import_provisional_guest(text,text,integer,boolean,text,uuid), public.rsvp_admin_get_members(uuid), public.rsvp_admin_update_member(uuid,text,text,integer,boolean,uuid), public.rsvp_admin_group_members(uuid[],text,uuid), public.rsvp_resolve_invitation_members(text), public.rsvp_submit_member_states(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.rsvp_admin_import_provisional_guest(text,text,integer,boolean,text,uuid), public.rsvp_admin_get_members(uuid), public.rsvp_admin_update_member(uuid,text,text,integer,boolean,uuid), public.rsvp_admin_group_members(uuid[],text,uuid), public.rsvp_resolve_invitation_members(text), public.rsvp_submit_member_states(text,jsonb,text) to service_role;
commit;
