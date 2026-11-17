-- Solo para Supabase local. Todos los datos ficticios se revierten al final.
begin;
do $$
declare admin_id uuid := '11111111-1111-4111-8111-111111111111'; outsider_id uuid := '22222222-2222-4222-8222-222222222222';
  v_invitation_id uuid; v_response_id uuid; v_attendee_id uuid; ana_id uuid; beto_id uuid; clara_id uuid;
  table_one uuid; table_two uuid; original_hash char(64) := repeat('a',64); current_hash char(64);
  planned_table uuid; active_seats integer; rejected boolean := false;
  planned_attending integer; planned_pending integer; planned_declined integer;
begin
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values('00000000-0000-0000-0000-000000000000',admin_id,'authenticated','authenticated','admin.local@example.test','',now(),'{}','{}',now(),now());
  insert into public.rsvp_admins(user_id) values(admin_id);
  select id into table_one from public.event_tables where table_number=1 and is_active;
  select id into table_two from public.event_tables where table_number=2 and is_active;
  if table_one is null or table_two is null then raise exception 'LOCAL_TEST_TABLES_MISSING'; end if;

  insert into public.invitations(group_name,max_passes,token_hash,rsvp_state)
  values('Familia Prueba Local',3,original_hash,'pending') returning id into v_invitation_id;
  insert into public.invitation_members(invitation_id,full_name,attendee_type,initial_table_id,member_state,is_active,is_family_head)
  values(v_invitation_id,'Ana Prueba','adult',table_one,'attending',true,true) returning id into ana_id;
  insert into public.invitation_members(invitation_id,full_name,attendee_type,initial_table_id,member_state,is_active)
  values(v_invitation_id,'Beto Prueba','adult',table_one,'pending',true) returning id into beto_id;
  insert into public.invitation_members(invitation_id,full_name,attendee_type,initial_table_id,member_state,is_active)
  values(v_invitation_id,'Clara Prueba','adult',table_one,'declined',true) returning id into clara_id;
  insert into public.rsvp_responses(invitation_id,is_attending,confirmed_count,comment)
  values(v_invitation_id,true,1,'Respuesta ficticia') returning id into v_response_id;
  insert into public.rsvp_attendees(response_id,full_name,attendee_type)
  values(v_response_id,'Ana Prueba','adult') returning id into v_attendee_id;

  perform public.rsvp_admin_set_invitation_delivery(v_invitation_id,true,admin_id);
  if not exists(select 1 from public.invitations i where i.id=v_invitation_id and i.invitation_delivery_status='sent' and i.invitation_sent_at is not null) then raise exception 'LOCAL_TEST_DELIVERY_FAILED'; end if;
  perform public.rsvp_admin_record_reminder(v_invitation_id,admin_id);
  if not exists(select 1 from public.rsvp_reminders rr where rr.invitation_id=v_invitation_id) then raise exception 'LOCAL_TEST_REMINDER_FAILED'; end if;

  -- Mesa planificada: no crea una silla ni modifica RSVP/tokens/pases.
  perform public.rsvp_admin_move_member_planned_table(beto_id,table_two,admin_id);
  select initial_table_id into planned_table from public.invitation_members where id=beto_id;
  select token_hash into current_hash from public.invitations i where i.id=v_invitation_id;
  if planned_table<>table_two or current_hash<>original_hash or not exists(select 1 from public.rsvp_responses r where r.id=v_response_id and r.confirmed_count=1) then raise exception 'LOCAL_TEST_PLANNED_MOVE_FAILED'; end if;

  -- Movimiento físico: conserva respuesta y deja trazabilidad de silla.
  perform public.rsvp_admin_move_attendee(v_attendee_id,table_two,1,admin_id);
  if not exists(select 1 from public.rsvp_seat_assignments sa join public.event_table_seats s on s.id=sa.seat_id where sa.attendee_id=v_attendee_id and sa.released_at is null and s.table_id=table_two and s.seat_number=1) then raise exception 'LOCAL_TEST_SEAT_MOVE_FAILED'; end if;
  if not exists(select 1 from public.rsvp_table_moves tm where tm.attendee_id=v_attendee_id) then raise exception 'LOCAL_TEST_MOVE_AUDIT_FAILED'; end if;
  if not exists(select 1 from public.invitations i where i.id=v_invitation_id and i.max_passes=3 and i.token_hash=original_hash) then raise exception 'LOCAL_TEST_INVITATION_PRESERVATION_FAILED'; end if;

  -- Contadores/imprenta: tres integrantes sin duplicación y estados separados por mesa planificada.
  select count(*) filter(where m.initial_table_id=table_two and m.member_state='attending'), count(*) filter(where m.initial_table_id=table_two and m.member_state='pending'), count(*) filter(where m.initial_table_id=table_one and m.member_state='declined') into planned_attending,planned_pending,planned_declined from public.invitation_members m where m.invitation_id=v_invitation_id;
  if planned_attending<>1 or planned_pending<>1 or planned_declined<>1 then raise exception 'LOCAL_TEST_PLANNED_COUNTERS_FAILED (%/%/%)',planned_attending,planned_pending,planned_declined; end if;
  perform public.gift_submit(original_hash,'33333333-3333-4333-8333-333333333333','Regalo Local','Dedicatoria ficticia',null,null,'message');
  if not exists(select 1 from public.gift_submissions g where g.invitation_id=v_invitation_id and g.dedication='Dedicatoria ficticia') then raise exception 'LOCAL_TEST_GIFT_FAILED'; end if;

  begin perform public.rsvp_admin_move_member_planned_table(beto_id,table_one,outsider_id); exception when others then rejected := sqlerrm='ADMIN_UNAUTHORIZED'; end;
  if not rejected then raise exception 'LOCAL_TEST_UNAUTHORIZED_NOT_REJECTED'; end if;
  select count(*) into active_seats from public.rsvp_seat_assignments sa where sa.attendee_id=v_attendee_id and sa.released_at is null;
  if active_seats<>1 then raise exception 'LOCAL_TEST_DUPLICATE_SEAT'; end if;
end $$;
rollback;
select 'LOCAL_FINAL_INTEGRATION_PASSED' as result;
