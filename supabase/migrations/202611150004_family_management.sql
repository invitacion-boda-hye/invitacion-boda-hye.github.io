-- Gestión segura de familias. Aplicar después de 202611150003.
begin;
alter table public.invitation_members add column if not exists is_family_head boolean not null default false;
create unique index if not exists invitation_members_one_head_per_invitation
on public.invitation_members(invitation_id) where is_family_head;

create or replace function public.rsvp_admin_group_members_v2(
 p_member_ids uuid[], p_head_member_id uuid, p_group_name text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_name text := regexp_replace(btrim(p_group_name), E'\s+', ' ', 'g');
 v_target uuid; v_previous uuid[]; v_count integer;
begin
 perform private.assert_rsvp_admin(p_actor_user_id);
 select array_agg(distinct x order by x) into v_ids from unnest(p_member_ids) x where x is not null;
 v_count := coalesce(array_length(v_ids,1),0);
 if v_count<1 or v_count>1000 or p_head_member_id is null or not(p_head_member_id=any(v_ids))
 or v_name is null or char_length(v_name) not between 1 and 160 then
  raise exception using errcode='P0001',message='ADMIN_GROUP_ARGUMENT_INVALID'; end if;
 -- Lock all invitations consistently; reject changes to any already-responded group.
 perform 1 from public.invitations i where i.id in
  (select m.invitation_id from public.invitation_members m where m.id=any(v_ids)) order by i.id for update;
 perform 1 from public.invitation_members where id=any(v_ids) order by id for update;
 if (select count(*) from public.invitation_members where id=any(v_ids))<>v_count then
  raise exception using errcode='P0001',message='ADMIN_MEMBER_NOT_FOUND'; end if;
 if exists(select 1 from public.invitation_members m join public.invitations i on i.id=m.invitation_id
  where m.id=any(v_ids) and (m.member_state<>'pending' or not i.is_active
  or exists(select 1 from public.rsvp_responses r where r.invitation_id=i.id))) then
  raise exception using errcode='P0001',message='ADMIN_GROUP_HAS_RESPONSES'; end if;
 select invitation_id into v_target from public.invitation_members where id=p_head_member_id;
 select array_agg(distinct invitation_id) into v_previous from public.invitation_members where id=any(v_ids);
 -- Prevent a second head when merging into the head's invitation.
 update public.invitation_members set is_family_head=false where invitation_id=v_target;
 update public.invitation_members set invitation_id=v_target,is_family_head=(id=p_head_member_id),updated_at=clock_timestamp()
 where id=any(v_ids);
 update public.invitations set group_name=v_name,
  max_passes=(select count(*) from public.invitation_members where invitation_id=v_target),
  updated_at=clock_timestamp() where id=v_target;
 -- Preserve source invitations that still contain unselected members.
 update public.invitations i set
  max_passes=(select count(*) from public.invitation_members m where m.invitation_id=i.id),
  is_active=exists(select 1 from public.invitation_members m where m.invitation_id=i.id),
  updated_at=clock_timestamp()
 where i.id=any(v_previous) and i.id<>v_target;
 insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata)
 values(v_target,'admin',p_actor_user_id,'members_grouped',jsonb_build_object('memberIds',v_ids,'headMemberId',p_head_member_id));
 return public.rsvp_admin_get_members(p_actor_user_id);
end; $$;

create or replace function public.rsvp_admin_ungroup_member(
 p_member_id uuid, p_token_hash text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_member public.invitation_members%rowtype; v_old public.invitations%rowtype;
 v_new uuid; v_remaining integer;
begin
 perform private.assert_rsvp_admin(p_actor_user_id);
 if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
  raise exception using errcode='P0001',message='ADMIN_MEMBER_ARGUMENT_INVALID'; end if;
 select * into v_member from public.invitation_members where id=p_member_id for update;
 if not found then raise exception using errcode='P0001',message='ADMIN_MEMBER_NOT_FOUND'; end if;
 select * into v_old from public.invitations where id=v_member.invitation_id for update;
 if not v_old.is_active or v_member.member_state<>'pending' or
 exists(select 1 from public.rsvp_responses where invitation_id=v_old.id) then
  raise exception using errcode='P0001',message='ADMIN_GROUP_HAS_RESPONSES'; end if;
 select count(*) into v_remaining from public.invitation_members where invitation_id=v_old.id;
 if v_remaining<2 then raise exception using errcode='P0001',message='ADMIN_MEMBER_ALREADY_INDIVIDUAL'; end if;
 insert into public.invitations(group_name,max_passes,token_hash,rsvp_state)
 values(v_member.full_name,1,p_token_hash,'pending'::public.rsvp_state) returning id into v_new;
 update public.invitation_members set invitation_id=v_new,is_family_head=true,updated_at=clock_timestamp()
 where id=p_member_id;
 -- If the previous head was separated, elect a remaining member as head.
 if v_member.is_family_head then
  update public.invitation_members set is_family_head=true where id=(
   select id from public.invitation_members where invitation_id=v_old.id order by created_at,id limit 1);
 end if;
 update public.invitations set max_passes=v_remaining-1,updated_at=clock_timestamp() where id=v_old.id;
 insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata)
 values(v_old.id,'admin',p_actor_user_id,'member_ungrouped',jsonb_build_object('memberId',p_member_id,'newInvitationId',v_new));
 return public.rsvp_admin_get_members(p_actor_user_id);
end; $$;

-- Recreate getter to expose the head flag.
create or replace function public.rsvp_admin_get_members(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 perform private.assert_rsvp_admin(p_actor_user_id);
 return coalesce((select jsonb_agg(jsonb_build_object(
 'id',m.id,'guestId',m.guest_id,'fullName',m.full_name,'namePending',m.name_pending,
 'attendeeType',m.attendee_type,'memberState',m.member_state,'invitationId',i.id,
 'groupName',i.group_name,'isFamilyHead',m.is_family_head,'tableId',t.id,'tableNumber',t.table_number
 ) order by t.table_number nulls last,m.full_name,m.id)
 from public.invitation_members m join public.invitations i on i.id=m.invitation_id
 left join public.event_tables t on t.id=m.initial_table_id),'[]'::jsonb);
end; $$;
revoke all on function public.rsvp_admin_group_members_v2(uuid[],uuid,text,uuid),
 public.rsvp_admin_ungroup_member(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.rsvp_admin_group_members_v2(uuid[],uuid,text,uuid),
 public.rsvp_admin_ungroup_member(uuid,text,uuid) to service_role;
commit;
