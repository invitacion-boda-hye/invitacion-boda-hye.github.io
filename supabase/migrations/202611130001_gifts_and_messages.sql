-- Regalos y dedicatorias. Esta migración es aditiva: no modifica RSVP ni registros existentes.
begin;

do $$ begin
  create type public.gift_status as enum ('message_received', 'transfer_reported', 'transfer_verified');
exception when duplicate_object then null;
end $$;

create table if not exists public.gift_submissions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  submission_id uuid not null unique,
  invitation_id uuid references public.invitations(id) on delete set null,
  giver_name text check (giver_name is null or char_length(btrim(giver_name)) between 1 and 160),
  dedication text check (dedication is null or char_length(dedication) between 1 and 500),
  status public.gift_status not null,
  transfer_sender text check (transfer_sender is null or char_length(btrim(transfer_sender)) between 1 and 160),
  transfer_date date,
  transfer_reported_at timestamptz,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gift_submission_shape check (
    (status = 'message_received' and dedication is not null and transfer_sender is null and transfer_date is null)
    or (status in ('transfer_reported', 'transfer_verified') and transfer_sender is not null and transfer_date is not null)
  ),
  constraint gift_verified_shape check (
    (status = 'transfer_verified' and verified_at is not null and verified_by is not null)
    or (status <> 'transfer_verified' and verified_at is null and verified_by is null)
  )
);

create index if not exists gift_submissions_created_idx on public.gift_submissions (created_at desc);
create index if not exists gift_submissions_invitation_idx on public.gift_submissions (invitation_id, created_at desc);
create index if not exists gift_submissions_status_idx on public.gift_submissions (status, created_at desc);

drop trigger if exists gift_submissions_set_updated_at on public.gift_submissions;
create trigger gift_submissions_set_updated_at before update on public.gift_submissions
for each row execute function private.set_updated_at();

create or replace function public.gift_submit(
  p_token_hash text,
  p_submission_id uuid,
  p_giver_name text,
  p_message text,
  p_transfer_sender text,
  p_transfer_date date,
  p_kind text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_invitation_id uuid; v_existing public.gift_submissions%rowtype; v_name text; v_message text; v_sender text;
begin
  if p_submission_id is null or p_kind not in ('message', 'transfer') then
    raise exception using errcode = 'P0001', message = 'GIFT_PAYLOAD_INVALID'; end if;
  if p_token_hash is not null then
    if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode = 'P0001', message = 'INVITATION_INVALID'; end if;
    select id into v_invitation_id from public.invitations where token_hash=p_token_hash and is_active;
    if not found then raise exception using errcode = 'P0001', message = 'INVITATION_INVALID'; end if;
  end if;
  v_name := nullif(regexp_replace(btrim(coalesce(p_giver_name, '')), E'\\s+', ' ', 'g'), '');
  if v_name is not null and char_length(v_name) > 160 then raise exception using errcode = 'P0001', message = 'GIFT_NAME_INVALID'; end if;
  v_message := nullif(btrim(coalesce(p_message, '')), '');
  v_sender := nullif(regexp_replace(btrim(coalesce(p_transfer_sender, '')), E'\\s+', ' ', 'g'), '');
  if p_kind='message' and (v_message is null or char_length(v_message)>500) then raise exception using errcode = 'P0001', message = 'GIFT_MESSAGE_INVALID'; end if;
  if p_kind='transfer' and (v_sender is null or char_length(v_sender)>160 or p_transfer_date is null or p_transfer_date > current_date) then raise exception using errcode = 'P0001', message = 'GIFT_TRANSFER_INVALID'; end if;
  select * into v_existing from public.gift_submissions where submission_id=p_submission_id for update;
  if found and v_existing.status='transfer_verified' then return jsonb_build_object('status','transfer_verified'); end if;
  if found then
    update public.gift_submissions set invitation_id=coalesce(v_existing.invitation_id,v_invitation_id), giver_name=coalesce(v_name,v_existing.giver_name), dedication=coalesce(v_message,v_existing.dedication),
      transfer_sender=case when p_kind='transfer' then v_sender else v_existing.transfer_sender end,
      transfer_date=case when p_kind='transfer' then p_transfer_date else v_existing.transfer_date end,
      transfer_reported_at=case when p_kind='transfer' then coalesce(v_existing.transfer_reported_at,clock_timestamp()) else v_existing.transfer_reported_at end,
      status=case when p_kind='transfer' or v_existing.status='transfer_reported' then 'transfer_reported'::public.gift_status else 'message_received'::public.gift_status end
    where id=v_existing.id returning * into v_existing;
  elsif p_kind='message' then
    insert into public.gift_submissions(submission_id,invitation_id,giver_name,dedication,status) values(p_submission_id,v_invitation_id,v_name,v_message,'message_received') returning * into v_existing;
  else
    insert into public.gift_submissions(submission_id,invitation_id,giver_name,transfer_sender,transfer_date,transfer_reported_at,status) values(p_submission_id,v_invitation_id,v_name,v_sender,p_transfer_date,clock_timestamp(),'transfer_reported') returning * into v_existing;
  end if;
  return jsonb_build_object('status',v_existing.status);
end $$;

create or replace function public.gift_admin_list(p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'createdAt',g.created_at,'giverName',g.giver_name,'family',i.group_name,'dedication',g.dedication,'status',g.status,'transferSender',g.transfer_sender,'transferDate',g.transfer_date,'verifiedAt',g.verified_at) order by g.created_at desc) from public.gift_submissions g left join public.invitations i on i.id=g.invitation_id),'[]'::jsonb);
end $$;

create or replace function public.gift_admin_verify(p_gift_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_rsvp_admin(p_actor_user_id);
  update public.gift_submissions set status='transfer_verified', verified_at=clock_timestamp(), verified_by=p_actor_user_id where id=p_gift_id and status='transfer_reported';
  if not found then raise exception using errcode='P0001',message='GIFT_NOT_PENDING_VERIFICATION'; end if;
  return public.gift_admin_list(p_actor_user_id);
end $$;

alter table public.gift_submissions enable row level security;
revoke all on table public.gift_submissions from anon, authenticated;
revoke all on function public.gift_submit(text,uuid,text,text,text,date,text), public.gift_admin_list(uuid), public.gift_admin_verify(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gift_submit(text,uuid,text,text,text,date,text), public.gift_admin_list(uuid), public.gift_admin_verify(uuid,uuid) to service_role;

commit;
