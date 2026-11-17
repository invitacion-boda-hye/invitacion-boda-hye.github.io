-- Eliminación individual administrativa de mensajes o transferencias de prueba.
begin;
create or replace function public.gift_admin_delete(p_gift_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_deleted uuid;
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  delete from public.gift_submissions where id = p_gift_id returning id into v_deleted;
  if v_deleted is null then
    raise exception using errcode='P0001', message='ADMIN_GIFT_NOT_FOUND';
  end if;
  return public.gift_admin_list(p_actor_user_id);
end;
$$;
revoke all on function public.gift_admin_delete(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gift_admin_delete(uuid,uuid) to service_role;
commit;
