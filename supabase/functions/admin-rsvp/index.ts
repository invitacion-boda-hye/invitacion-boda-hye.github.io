import { loadRuntimeConfig } from "../_shared/config.ts";
import {
  allowedCorsHeaders,
  AppError,
  cleanGroupName,
  json,
  newInvitationToken,
  publicErrorResponse,
  readJson,
  requirePassCount,
  requireString,
  requireUuid,
  sha256Hex,
} from "../_shared/security.ts";
import { DatabaseError, databaseErrorResponse, requireAuthenticatedAdmin, rpc } from "../_shared/supabase.ts";

function invitationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/#i=${encodeURIComponent(token)}`;
}

async function withFreshToken<T>(
  operation: (tokenHash: string) => Promise<T>,
): Promise<{ value: T; token: string }> {
  // Una colisión de 256 bits es extraordinariamente improbable, pero se vuelve
  // manejable y sin filtrar detalles si el índice único llegara a detectarla.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = newInvitationToken();
    try {
      return { value: await operation(await sha256Hex(token)), token };
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.databaseCode !== "23505") {
        throw error;
      }
    }
  }
  throw new AppError(500, "TOKEN_GENERATION_FAILED");
}

Deno.serve(async (request) => {
  let headers: HeadersInit = { "Content-Type": "application/json; charset=utf-8" };
  try {
    headers = allowedCorsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");

    const body = await readJson(request);
    const action = body.action;
    if (typeof action !== "string") throw new AppError(400, "REQUEST_INVALID");

    const config = loadRuntimeConfig(action === "createInvitation" || action === "regenerateInvitation" || action === "importProvisionalGuest" || action === "ungroupMember" || action === "recoverGuest");
    const adminUserId = await requireAuthenticatedAdmin(request, config);

    if (action === "createInvitation") {
      const groupName = cleanGroupName(body.groupName);
      const maxPasses = requirePassCount(body.maxPasses);
      const created = await withFreshToken((tokenHash) => rpc<unknown>(config, "rsvp_admin_create_invitation", {
        p_group_name: groupName,
        p_max_passes: maxPasses,
        p_token_hash: tokenHash,
        p_actor_user_id: adminUserId,
      }));
      return json({ invitation: created.value, invitationUrl: invitationUrl(config.publicInvitationUrl, created.token) }, 201, headers);
    }

    if (action === "importProvisionalGuest") {
      const guestId = requireString(body.guestId, "ADMIN_GUEST_IMPORT_ARGUMENT_INVALID").trim().toLowerCase();
      const fullName = cleanGroupName(body.fullName);
      if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(guestId)
        || !Number.isInteger(body.tableNumber) || body.tableNumber < 1 || body.tableNumber > 99
        || typeof body.namePending !== "boolean") {
        throw new AppError(400, "ADMIN_GUEST_IMPORT_ARGUMENT_INVALID");
      }
      const imported = await withFreshToken((tokenHash) => rpc<unknown>(config, "rsvp_admin_import_provisional_guest", {
        p_guest_id: guestId, p_full_name: fullName, p_table_number: body.tableNumber,
        p_name_pending: body.namePending, p_token_hash: tokenHash, p_actor_user_id: adminUserId,
      }));
      const result = imported.value as { status?: string };
      return json({ guest: result, invitationUrl: result.status === "created" ? invitationUrl(config.publicInvitationUrl, imported.token) : null }, 201, headers);
    }

    if (action === "regenerateInvitation") {
      const invitationId = requireUuid(body.invitationId, "ADMIN_INVITATION_ARGUMENT_INVALID");
      const regenerated = await withFreshToken((tokenHash) => rpc<unknown>(config, "rsvp_admin_regenerate_token", {
        p_invitation_id: invitationId,
        p_token_hash: tokenHash,
        p_actor_user_id: adminUserId,
      }));
      return json({ invitation: regenerated.value, invitationUrl: invitationUrl(config.publicInvitationUrl, regenerated.token) }, 200, headers);
    }

    if (action === "revokeInvitation") {
      const invitationId = requireUuid(body.invitationId, "ADMIN_INVITATION_ARGUMENT_INVALID");
      const invitation = await rpc<unknown>(config, "rsvp_admin_revoke_invitation", {
        p_invitation_id: invitationId,
        p_actor_user_id: adminUserId,
      });
      return json({ invitation }, 200, headers);
    }

    if (action === "resetInvitation" || action === "deleteInvitation") {
      const invitationId = requireUuid(body.invitationId, "ADMIN_INVITATION_ARGUMENT_INVALID");
      const result = await rpc<unknown>(config, action === "resetInvitation" ? "rsvp_admin_reset_invitation" : "rsvp_admin_delete_invitation", {
        p_invitation_id: invitationId, p_actor_user_id: adminUserId,
      });
      return json({ result }, 200, headers);
    }

    if (action === "updateSettings") {
      if (typeof body.capacity !== "number" || !Number.isInteger(body.capacity)) {
        throw new AppError(400, "ADMIN_CAPACITY_INVALID");
      }
      if (body.rsvpDeadline !== null && body.rsvpDeadline !== undefined && typeof body.rsvpDeadline !== "string") {
        throw new AppError(400, "REQUEST_INVALID");
      }
      const settings = await rpc<unknown>(config, "rsvp_admin_update_event_settings", {
        p_capacity: body.capacity,
        p_rsvp_deadline: body.rsvpDeadline ?? null,
        p_actor_user_id: adminUserId,
      });
      return json({ settings }, 200, headers);
    }

    if (action === "summary") {
      const summary = await rpc<unknown>(config, "rsvp_admin_dashboard_summary", {
        p_actor_user_id: adminUserId,
      });
      return json({ summary }, 200, headers);
    }

    if (action === "listInvitations") {
      const data = await rpc<unknown>(config, "rsvp_admin_get_guest_data", { p_actor_user_id: adminUserId });
      return json({ data }, 200, headers);
    }

    if (action === "listMembers") {
      const members = await rpc<unknown>(config, "rsvp_admin_get_members", { p_actor_user_id: adminUserId });
      return json({ members }, 200, headers);
    }

    if (action === "updateMember") {
      const memberId = requireUuid(body.memberId, "ADMIN_MEMBER_ARGUMENT_INVALID");
      const fullName = cleanGroupName(body.fullName);
      if ((body.attendeeType !== "adult" && body.attendeeType !== "child")
        || typeof body.namePending !== "boolean"
        || (body.tableNumber !== null && (!Number.isInteger(body.tableNumber) || body.tableNumber < 1 || body.tableNumber > 99))) {
        throw new AppError(400, "ADMIN_MEMBER_ARGUMENT_INVALID");
      }
      const members = await rpc<unknown>(config, "rsvp_admin_update_member", {
        p_member_id: memberId, p_full_name: fullName, p_attendee_type: body.attendeeType,
        p_table_number: body.tableNumber, p_name_pending: body.namePending, p_actor_user_id: adminUserId,
      });
      return json({ members }, 200, headers);
    }

    if (action === "groupMembers") {
      if (!Array.isArray(body.memberIds) || body.memberIds.length < 1 || body.memberIds.length > 1000) {
        throw new AppError(400, "ADMIN_GROUP_ARGUMENT_INVALID");
      }
      const memberIds = body.memberIds.map((id) => requireUuid(id, "ADMIN_GROUP_ARGUMENT_INVALID"));
      const headMemberId = requireUuid(body.headMemberId, "ADMIN_GROUP_ARGUMENT_INVALID");
      if (!memberIds.includes(headMemberId)) throw new AppError(400, "ADMIN_GROUP_ARGUMENT_INVALID");
      const members = await rpc<unknown>(config, "rsvp_admin_group_members_v2", {
        p_member_ids: memberIds, p_head_member_id: headMemberId,
        p_group_name: cleanGroupName(body.groupName), p_actor_user_id: adminUserId,
      });
      return json({ members }, 200, headers);
    }

    if (action === "ungroupMember") {
      const memberId = requireUuid(body.memberId, "ADMIN_MEMBER_ARGUMENT_INVALID");
      const separated = await withFreshToken((tokenHash) => rpc<unknown>(config, "rsvp_admin_ungroup_member", {
        p_member_id: memberId, p_token_hash: tokenHash, p_actor_user_id: adminUserId,
      }));
      return json({ members: separated.value, invitationUrl: invitationUrl(config.publicInvitationUrl, separated.token) }, 200, headers);
    }

    if (action === "recoverGuest") {
      const guestId = requireString(body.guestId, "ADMIN_MEMBER_ARGUMENT_INVALID").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(guestId)) throw new AppError(400, "ADMIN_MEMBER_ARGUMENT_INVALID");
      const recovered = await withFreshToken((tokenHash) => rpc<unknown>(config, "rsvp_admin_recover_guest", {
        p_guest_id: guestId, p_token_hash: tokenHash, p_actor_user_id: adminUserId,
      }));
      return json({ guest: recovered.value, invitationUrl: invitationUrl(config.publicInvitationUrl, recovered.token) }, 200, headers);
    }

    if (action === "deactivateMember") {
      const members = await rpc<unknown>(config, "rsvp_admin_deactivate_member", {
        p_member_id: requireUuid(body.memberId, "ADMIN_MEMBER_ARGUMENT_INVALID"),
        p_replacement_id: body.replacementId === null ? null : requireUuid(body.replacementId, "ADMIN_MEMBER_ARGUMENT_INVALID"),
        p_actor_user_id: adminUserId,
      });
      return json({ members }, 200, headers);
    }

    if (action === "listGifts") {
      const gifts = await rpc<unknown>(config, "gift_admin_list", { p_actor_user_id: adminUserId });
      return json({ gifts }, 200, headers);
    }

    if (action === "verifyGift") {
      const giftId = requireUuid(body.giftId, "ADMIN_GIFT_ARGUMENT_INVALID");
      const gifts = await rpc<unknown>(config, "gift_admin_verify", { p_gift_id: giftId, p_actor_user_id: adminUserId });
      return json({ gifts }, 200, headers);
    }

    if (action === "assignSeat") {
      const tableId = requireUuid(body.tableId, "ADMIN_TABLE_ARGUMENT_INVALID");
      const attendeeId = requireUuid(body.attendeeId, "ADMIN_ATTENDEE_ARGUMENT_INVALID");
      if (typeof body.seatNumber !== "number" || !Number.isInteger(body.seatNumber)) {
        throw new AppError(400, "ADMIN_SEAT_ARGUMENT_INVALID");
      }
      const data = await rpc<unknown>(config, "rsvp_admin_assign_seat", {
        p_table_id: tableId, p_seat_number: body.seatNumber, p_attendee_id: attendeeId, p_actor_user_id: adminUserId,
      });
      return json({ data }, 200, headers);
    }

    if (action === "releaseSeat") {
      const tableId = requireUuid(body.tableId, "ADMIN_TABLE_ARGUMENT_INVALID");
      if (typeof body.seatNumber !== "number" || !Number.isInteger(body.seatNumber)) {
        throw new AppError(400, "ADMIN_SEAT_ARGUMENT_INVALID");
      }
      const data = await rpc<unknown>(config, "rsvp_admin_release_seat", {
        p_table_id: tableId, p_seat_number: body.seatNumber, p_actor_user_id: adminUserId,
      });
      return json({ data }, 200, headers);
    }

    if (action === "updateTableCapacity") {
      const tableId = requireUuid(body.tableId, "ADMIN_TABLE_ARGUMENT_INVALID");
      if (typeof body.capacity !== "number" || !Number.isInteger(body.capacity)) {
        throw new AppError(400, "ADMIN_TABLE_CAPACITY_INVALID");
      }
      const data = await rpc<unknown>(config, "rsvp_admin_update_table_capacity", {
        p_table_id: tableId, p_capacity: body.capacity, p_actor_user_id: adminUserId,
      });
      return json({ data }, 200, headers);
    }

    if (action === "exportGuestData") {
      const rows = await rpc<unknown>(config, "rsvp_admin_export_guest_data", { p_actor_user_id: adminUserId });
      return json({ rows }, 200, headers);
    }

    throw new AppError(400, "REQUEST_INVALID");
  } catch (error) {
    const mapped = databaseErrorResponse(error);
    return publicErrorResponse(mapped ?? error, headers);
  }
});
