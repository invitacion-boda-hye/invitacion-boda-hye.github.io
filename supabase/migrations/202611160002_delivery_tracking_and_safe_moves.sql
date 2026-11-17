-- Aditiva. No regenera tokens ni modifica RSVP, cupos o asignaciones existentes.
begin;

alter table public.invitations add column if not exists invitation_sent_at timestamptz;
alter table public.invitations add column if not exists invitation_delivery_status text not null default 'unregistered'
  check (invitation_delivery_status in ('unregistered','sent','pending'));

create or replace function public.rsvp_admin_set_invitation_delivery(
  p_invitation_id uuid, p_sent boolean, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sent_at timestamptz;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  update public.invitations set invitation_sent_at = case when p_sent then clock_timestamp() else null end,
    invitation_delivery_status = case when p_sent then 'sent' else 'pending' end,
    updated_at=clock_timestamp() where id=p_invitation_id and is_active returning invitation_sent_at into v_sent_at;
  if not found then raise exception using errcode='P0001',message='ADMIN_INVITATION_NOT_FOUND'; end if;
  insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata)
  values(p_invitation_id,'admin',p_actor_user_id,case when p_sent then 'invitation_marked_sent' else 'invitation_marked_pending' end,'{}');
  return jsonb_build_object('invitationId',p_invitation_id,'sentAt',v_sent_at);
end; $$;

create or replace function public.rsvp_admin_list_invitation_tracking(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'invitationId',i.id,'groupName',i.group_name,'maxPasses',i.max_passes,'sentAt',i.invitation_sent_at,'deliveryStatus',i.invitation_delivery_status,
    'state',i.rsvp_state,'members',coalesce(m.members,'[]'::jsonb),'lastReminderAt',r.sent_at
  ) order by i.group_name) from public.invitations i
  left join lateral (select jsonb_agg(jsonb_build_object('fullName',im.full_name,'state',im.member_state) order by im.full_name) members
    from public.invitation_members im where im.invitation_id=i.id and coalesce(im.is_active,true)) m on true
  left join lateral (select max(sent_at) sent_at from public.rsvp_reminders rr where rr.invitation_id=i.id) r on true
  where i.is_active),'[]'::jsonb);
end; $$;

create or replace function public.rsvp_admin_record_reminder(p_invitation_id uuid,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  if not exists(select 1 from public.invitations where id=p_invitation_id and is_active and invitation_sent_at is not null) then
    raise exception using errcode='P0001',message='ADMIN_REMINDER_NOT_ELIGIBLE'; end if;
  insert into public.rsvp_reminders(invitation_id,sent_by,channel) values(p_invitation_id,p_actor_user_id,'whatsapp');
  insert into public.rsvp_audit_log(invitation_id,actor_kind,actor_admin_id,action,metadata) values(p_invitation_id,'admin',p_actor_user_id,'reminder_marked_sent','{}');
  return public.rsvp_admin_list_invitation_tracking(p_actor_user_id);
end; $$;

revoke all on function public.rsvp_admin_set_invitation_delivery(uuid,boolean,uuid),public.rsvp_admin_list_invitation_tracking(uuid),public.rsvp_admin_record_reminder(uuid,uuid) from public,anon,authenticated;
grant execute on function public.rsvp_admin_set_invitation_delivery(uuid,boolean,uuid),public.rsvp_admin_list_invitation_tracking(uuid),public.rsvp_admin_record_reminder(uuid,uuid) to service_role;
commit;
