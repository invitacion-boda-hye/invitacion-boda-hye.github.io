-- Los asistentes pueden confirmar con un solo nombre. Se mantienen nombres
-- no vacíos, sin espacios de borde, y el límite existente de 160 caracteres.
begin;

alter table public.rsvp_attendees
  drop constraint if exists rsvp_attendees_full_name_check;
alter table public.rsvp_attendees
  add constraint rsvp_attendees_full_name_check
  check (
    char_length(full_name) between 1 and 160
    and full_name = btrim(full_name)
  );

-- La fuente de miembros debe aceptar la misma forma de nombre que el RSVP.
alter table public.invitation_members
  drop constraint if exists invitation_members_full_name_check;
alter table public.invitation_members
  add constraint invitation_members_full_name_check
  check (char_length(btrim(full_name)) between 1 and 160);

create or replace function public.rsvp_submit(
  p_token_hash text,
  p_is_attending boolean,
  p_confirmed_count integer,
  p_attendees jsonb,
  p_comment text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.event_settings%rowtype;
  v_invitation public.invitations%rowtype;
  v_existing public.rsvp_responses%rowtype;
  v_response_id uuid;
  v_previous_count integer := 0;
  v_total_confirmed integer := 0;
  v_attendee_count integer;
  v_name text;
  v_names text[] := array[]::text[];
  v_item jsonb;
  v_comment text;
  v_had_response boolean := false;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;
  if p_is_attending is null or jsonb_typeof(p_attendees) <> 'array' then
    raise exception using errcode = 'P0001', message = 'RSVP_PAYLOAD_INVALID';
  end if;
  v_attendee_count := jsonb_array_length(p_attendees);
  if p_confirmed_count is null or p_confirmed_count <> v_attendee_count then
    raise exception using errcode = 'P0001', message = 'RSVP_COUNT_MISMATCH';
  end if;
  v_comment := nullif(btrim(p_comment), '');
  if v_comment is not null and char_length(v_comment) > 500 then
    raise exception using errcode = 'P0001', message = 'RSVP_COMMENT_TOO_LONG';
  end if;

  select * into v_settings from public.event_settings where id = true for update;
  if not found then raise exception using errcode = 'P0001', message = 'EVENT_SETTINGS_MISSING'; end if;
  select * into v_invitation from public.invitations where token_hash = p_token_hash and is_active = true for update;
  if not found then raise exception using errcode = 'P0001', message = 'INVITATION_INVALID'; end if;
  if v_settings.rsvp_deadline is not null and clock_timestamp() >= v_settings.rsvp_deadline then
    raise exception using errcode = 'P0001', message = 'RSVP_DEADLINE_PASSED';
  end if;

  if p_is_attending then
    if p_confirmed_count < 1 or p_confirmed_count > v_invitation.max_passes then
      raise exception using errcode = 'P0001', message = 'RSVP_PASSES_EXCEEDED';
    end if;
    for v_item in select value from jsonb_array_elements(p_attendees)
    loop
      v_name := regexp_replace(btrim(v_item ->> 'full_name'), E'\\s+', ' ', 'g');
      if v_name is null or char_length(v_name) not between 1 and 160 then
        raise exception using errcode = 'P0001', message = 'RSVP_ATTENDEE_NAME_INVALID';
      end if;
      v_names := array_append(v_names, v_name);
    end loop;
  elsif p_confirmed_count <> 0 then
    raise exception using errcode = 'P0001', message = 'RSVP_DECLINE_MUST_BE_ZERO';
  end if;

  select * into v_existing from public.rsvp_responses where invitation_id = v_invitation.id for update;
  v_had_response := found;
  if v_had_response then v_previous_count := v_existing.confirmed_count; end if;
  select coalesce(sum(response.confirmed_count) filter (where response.is_attending), 0)::integer
  into v_total_confirmed
  from public.rsvp_responses as response
  join public.invitations as invitation on invitation.id = response.invitation_id
  where invitation.is_active = true;
  if p_confirmed_count > v_previous_count
    and v_total_confirmed - v_previous_count + p_confirmed_count > v_settings.capacity then
    raise exception using errcode = 'P0001', message = 'RSVP_CAPACITY_EXCEEDED';
  end if;

  insert into public.rsvp_responses (invitation_id, is_attending, confirmed_count, comment, responded_at)
  values (v_invitation.id, p_is_attending, p_confirmed_count, v_comment, clock_timestamp())
  on conflict (invitation_id) do update
    set is_attending = excluded.is_attending,
        confirmed_count = excluded.confirmed_count,
        comment = excluded.comment
  returning id into v_response_id;
  delete from public.rsvp_attendees where response_id = v_response_id;
  if p_is_attending then
    insert into public.rsvp_attendees (response_id, full_name)
    select v_response_id, name from unnest(v_names) as name;
  end if;
  update public.invitations
  set rsvp_state = case when p_is_attending then 'attending'::public.rsvp_state else 'declined'::public.rsvp_state end
  where id = v_invitation.id;
  insert into public.rsvp_audit_log (
    invitation_id, response_id, actor_kind, action, previous_confirmed_count, new_confirmed_count, metadata
  ) values (
    v_invitation.id, v_response_id, 'guest',
    case when v_had_response then 'response_updated' else 'response_created' end,
    v_previous_count, p_confirmed_count, jsonb_build_object('source', 'public_rsvp')
  );
  return public.rsvp_resolve_invitation(p_token_hash);
end;
$$;

revoke all on function public.rsvp_submit(text, boolean, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.rsvp_submit(text, boolean, integer, jsonb, text) to service_role;

commit;
