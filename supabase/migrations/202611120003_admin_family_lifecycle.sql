begin;

create or replace function public.rsvp_admin_reset_invitation(p_invitation_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  perform 1 from public.invitations where id=p_invitation_id for update;
  if not found then raise exception using errcode='P0001', message='ADMIN_INVITATION_NOT_FOUND'; end if;
  select coalesce(confirmed_count,0) into v_count from public.rsvp_responses where invitation_id=p_invitation_id for update;
  delete from public.rsvp_responses where invitation_id=p_invitation_id;
  update public.invitations set rsvp_state='pending'::public.rsvp_state where id=p_invitation_id;
  insert into public.rsvp_audit_log (invitation_id,actor_kind,actor_admin_id,action,previous_confirmed_count,new_confirmed_count,metadata)
  values (p_invitation_id,'admin',p_actor_user_id,'admin_reset_to_pending',v_count,0,jsonb_build_object('source','admin_rsvp'));
  return jsonb_build_object('invitationId',p_invitation_id,'releasedCount',v_count);
end;
$$;

create or replace function public.rsvp_admin_delete_invitation(p_invitation_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  perform 1 from public.invitations where id=p_invitation_id for update;
  if not found then raise exception using errcode='P0001', message='ADMIN_INVITATION_NOT_FOUND'; end if;
  select coalesce(confirmed_count,0) into v_count from public.rsvp_responses where invitation_id=p_invitation_id for update;
  delete from public.rsvp_responses where invitation_id=p_invitation_id;
  delete from public.rsvp_seat_assignments where invitation_id=p_invitation_id;
  delete from public.invitations where id=p_invitation_id;
  return jsonb_build_object('invitationId',p_invitation_id,'deletedAttendees',v_count);
end;
$$;

revoke all on function public.rsvp_admin_reset_invitation(uuid,uuid), public.rsvp_admin_delete_invitation(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rsvp_admin_reset_invitation(uuid,uuid), public.rsvp_admin_delete_invitation(uuid,uuid) to service_role;
commit;
