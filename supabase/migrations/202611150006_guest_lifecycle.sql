-- Operaciones administrativas seguras; requiere M3, M4 y M5.
begin;
create table if not exists public.guest_directory (
  guest_id text primary key check (guest_id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  full_name text not null check (char_length(btrim(full_name)) between 1 and 160),
  planned_table_number integer not null check (planned_table_number between 1 and 99),
  name_pending boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.invitation_members add column if not exists is_active boolean not null default true;
insert into public.guest_directory(guest_id,full_name,planned_table_number,name_pending)
select m.guest_id,m.full_name,t.table_number,m.name_pending from public.invitation_members m join public.event_tables t on t.id=m.initial_table_id
where m.guest_id is not null on conflict(guest_id) do nothing;
insert into public.guest_directory(guest_id,full_name,planned_table_number,name_pending) values
 ('guest-m3-08','Armando Pérez',3,false),('guest-m3-09','Esposa de Armando Pérez',3,true)
on conflict(guest_id) do nothing;

create or replace function public.rsvp_admin_recover_guest(p_guest_id text,p_token_hash text,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.guest_directory%rowtype; m public.invitation_members%rowtype; i uuid; t uuid;
begin
 perform private.assert_rsvp_admin(p_actor_user_id); select * into d from public.guest_directory where guest_id=lower(btrim(p_guest_id)) for update;
 if not found then raise exception using errcode='P0001',message='ADMIN_GUEST_SOURCE_NOT_FOUND'; end if;
 if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0001',message='ADMIN_MEMBER_ARGUMENT_INVALID'; end if;
 select * into m from public.invitation_members where guest_id=d.guest_id for update;
 if found and m.is_active then raise exception using errcode='P0001',message='ADMIN_GUEST_ALREADY_ACTIVE'; end if;
 select id into t from public.event_tables where table_number=d.planned_table_number and is_active; if not found then raise exception using errcode='P0001',message='ADMIN_TABLE_NOT_FOUND'; end if;
 insert into public.invitations(group_name,max_passes,token_hash,rsvp_state) values(d.full_name,1,p_token_hash,'pending'::public.rsvp_state) returning id into i;
 if found then update public.invitation_members set invitation_id=i,full_name=d.full_name,name_pending=d.name_pending,initial_table_id=t,is_active=true,is_family_head=true,member_state='pending',updated_at=clock_timestamp() where id=m.id;
 else insert into public.invitation_members(invitation_id,guest_id,full_name,name_pending,initial_table_id,attendee_type,member_state,is_active,is_family_head) values(i,d.guest_id,d.full_name,d.name_pending,t,'adult','pending',true,true); end if;
 insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata) values(i,'admin',p_actor_user_id,'guest_recovered',jsonb_build_object('guestId',d.guest_id));
 return jsonb_build_object('invitationId',i,'guestId',d.guest_id,'groupName',d.full_name);
end; $$;

create or replace function public.rsvp_admin_deactivate_member(p_member_id uuid,p_replacement_id uuid,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.invitation_members%rowtype; remaining integer;
begin
 perform private.assert_rsvp_admin(p_actor_user_id); select * into m from public.invitation_members where id=p_member_id and is_active for update;
 if not found then raise exception using errcode='P0001',message='ADMIN_MEMBER_NOT_FOUND'; end if;
 if m.member_state<>'pending' or exists(select 1 from public.rsvp_responses where invitation_id=m.invitation_id) then raise exception using errcode='P0001',message='ADMIN_GROUP_HAS_RESPONSES'; end if;
 select count(*) into remaining from public.invitation_members where invitation_id=m.invitation_id and is_active and id<>m.id;
 if m.is_family_head and remaining>0 then
  if p_replacement_id is null or not exists(select 1 from public.invitation_members where id=p_replacement_id and invitation_id=m.invitation_id and is_active and id<>m.id) then raise exception using errcode='P0001',message='ADMIN_HEAD_REPLACEMENT_REQUIRED'; end if;
  update public.invitation_members set is_family_head=false where invitation_id=m.invitation_id; update public.invitation_members set is_family_head=true where id=p_replacement_id;
 end if;
 update public.invitation_members set is_active=false,is_family_head=false,updated_at=clock_timestamp() where id=m.id;
 if remaining=0 then update public.invitations set is_active=false,updated_at=clock_timestamp() where id=m.invitation_id; else update public.invitations set max_passes=greatest(1,remaining),updated_at=clock_timestamp() where id=m.invitation_id; end if;
 insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata) values(m.invitation_id,'admin',p_actor_user_id,'member_deactivated',jsonb_build_object('memberId',m.id));
 return public.rsvp_admin_get_members(p_actor_user_id);
end; $$;
create or replace function public.rsvp_admin_get_members(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.assert_rsvp_admin(p_actor_user_id);
 return coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'guestId',m.guest_id,'fullName',m.full_name,'namePending',m.name_pending,'attendeeType',m.attendee_type,'memberState',m.member_state,'invitationId',i.id,'groupName',i.group_name,'isFamilyHead',m.is_family_head,'tableId',t.id,'tableNumber',t.table_number) order by t.table_number,m.full_name)
 from public.invitation_members m join public.invitations i on i.id=m.invitation_id left join public.event_tables t on t.id=m.initial_table_id where m.is_active and i.is_active),'[]'::jsonb);
end; $$;
alter table public.guest_directory enable row level security;
revoke all on table public.guest_directory from public,anon,authenticated;
revoke all on function public.rsvp_admin_recover_guest(text,text,uuid),public.rsvp_admin_deactivate_member(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rsvp_admin_recover_guest(text,text,uuid),public.rsvp_admin_deactivate_member(uuid,uuid,uuid) to service_role;
commit;
