-- Requiere las migraciones 202611150001, 202611150003 y 202611150006.
-- Aditiva: no crea ni regenera invitaciones/tokens y no modifica estados RSVP.
begin;

create or replace function public.rsvp_admin_move_attendee(
  p_attendee_id uuid, p_table_id uuid, p_seat_number integer, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_attendee public.rsvp_attendees%rowtype; v_invitation_id uuid; v_name text;
  v_destination public.event_table_seats%rowtype; v_previous public.rsvp_seat_assignments%rowtype;
  v_new_assignment uuid; v_batch uuid;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if p_seat_number is null or p_seat_number not between 1 and 54 then
    raise exception using errcode='P0001',message='ADMIN_SEAT_ARGUMENT_INVALID'; end if;
  -- Lock the attendee and its invitation first; it must remain a current RSVP attendee.
  select a.* into v_attendee
  from public.rsvp_attendees a join public.rsvp_responses r on r.id=a.response_id
  join public.invitations i on i.id=r.invitation_id
  where a.id=p_attendee_id and r.is_attending and i.is_active for update of a,r,i;
  if not found then raise exception using errcode='P0001',message='ADMIN_ATTENDEE_NOT_ELIGIBLE'; end if;
  v_name:=v_attendee.full_name;
  select invitation_id into v_invitation_id from public.rsvp_responses where id=v_attendee.response_id;
  -- A single destination seat lock makes capacity and vacancy check atomic.
  select s.* into v_destination from public.event_table_seats s join public.event_tables t on t.id=s.table_id
  where s.table_id=p_table_id and s.seat_number=p_seat_number and s.is_active and t.is_active for update of s,t;
  if not found then raise exception using errcode='P0001',message='ADMIN_SEAT_NOT_FOUND'; end if;
  if exists(select 1 from public.rsvp_seat_assignments where seat_id=v_destination.id and released_at is null for update) then
    raise exception using errcode='P0001',message='ADMIN_SEAT_OCCUPIED'; end if;
  select * into v_previous from public.rsvp_seat_assignments where attendee_id=p_attendee_id and released_at is null for update;
  if found and v_previous.seat_id=v_destination.id then return public.rsvp_admin_get_guest_data(p_actor_user_id); end if;
  insert into public.rsvp_table_move_batches(actor_user_id,action) values(p_actor_user_id,'move_attendee') returning id into v_batch;
  if found then update public.rsvp_seat_assignments set released_at=clock_timestamp(),released_by=p_actor_user_id,release_reason='admin_moved' where id=v_previous.id; end if;
  insert into public.rsvp_seat_assignments(seat_id,attendee_id,invitation_id,attendee_name_snapshot,assigned_by)
  values(v_destination.id,p_attendee_id,v_invitation_id,v_name,p_actor_user_id) returning id into v_new_assignment;
  insert into public.rsvp_table_moves(batch_id,attendee_id,invitation_id,from_assignment_id,to_assignment_id)
  values(v_batch,p_attendee_id,v_invitation_id,case when v_previous.id is null then null else v_previous.id end,v_new_assignment);
  -- Persist the individual planned table too; exact name is protected by the per-invitation unique constraint.
  update public.invitation_members set initial_table_id=p_table_id,updated_at=clock_timestamp()
  where invitation_id=v_invitation_id and full_name=v_name and coalesce(is_active,true);
  insert into public.rsvp_audit_log(invitation_id,response_id,actor_kind,actor_admin_id,action,metadata)
  values(v_invitation_id,v_attendee.response_id,'admin',p_actor_user_id,'attendee_moved',jsonb_build_object('attendeeId',p_attendee_id,'toTableId',p_table_id,'seatNumber',p_seat_number));
  return public.rsvp_admin_get_guest_data(p_actor_user_id);
end; $$;

-- Cambio de mesa prevista: no crea una silla ni toca la respuesta RSVP.
create or replace function public.rsvp_admin_move_member_planned_table(
  p_member_id uuid, p_table_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_member public.invitation_members%rowtype;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  select * into v_member from public.invitation_members where id=p_member_id and is_active for update;
  if not found then raise exception using errcode='P0001',message='ADMIN_MEMBER_NOT_FOUND'; end if;
  perform 1 from public.event_tables where id=p_table_id and is_active for share;
  if not found then raise exception using errcode='P0001',message='ADMIN_TABLE_NOT_FOUND'; end if;
  update public.invitation_members set initial_table_id=p_table_id,updated_at=clock_timestamp() where id=v_member.id;
  insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata)
  values(v_member.invitation_id,'admin',p_actor_user_id,'member_planned_table_moved',jsonb_build_object('memberId',v_member.id,'toTableId',p_table_id));
  return public.rsvp_admin_get_members(p_actor_user_id);
end; $$;

revoke all on function public.rsvp_admin_move_attendee(uuid,uuid,integer,uuid),public.rsvp_admin_move_member_planned_table(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.rsvp_admin_move_attendee(uuid,uuid,integer,uuid),public.rsvp_admin_move_member_planned_table(uuid,uuid,uuid) to service_role;
commit;
