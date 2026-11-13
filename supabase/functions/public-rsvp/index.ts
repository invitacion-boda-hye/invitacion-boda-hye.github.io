import { loadRuntimeConfig } from "../_shared/config.ts";
import {
  allowedCorsHeaders,
  AppError,
  clientIdentifier,
  isJsonRecord,
  json,
  publicErrorResponse,
  readJson,
  requireInvitationToken,
  sha256Hex,
} from "../_shared/security.ts";
import { databaseErrorResponse, rpc } from "../_shared/supabase.ts";

const RESOLVE_LIMIT = 30;
const SUBMIT_LIMIT = 8;
const GIFT_LIMIT = 6;
const RATE_WINDOW_SECONDS = 600;

function validateSubmission(body: Record<string, unknown>): {
  isAttending: boolean;
  confirmedCount: number;
  attendees: unknown[];
  comment: string | null;
} {
  if (typeof body.isAttending !== "boolean"
    || typeof body.confirmedCount !== "number"
    || !Number.isInteger(body.confirmedCount)
    || body.confirmedCount < 0
    || body.confirmedCount > 1000
    || !Array.isArray(body.attendees)
    || body.attendees.length > 1000
    || (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string")) {
    throw new AppError(400, "RSVP_PAYLOAD_INVALID");
  }

  for (const attendee of body.attendees) {
    if (!isJsonRecord(attendee) || typeof attendee.full_name !== "string") {
      throw new AppError(400, "RSVP_PAYLOAD_INVALID");
    }
  }

  return {
    isAttending: body.isAttending,
    confirmedCount: body.confirmedCount,
    attendees: body.attendees,
    comment: body.comment ?? null,
  };
}

function validateGift(body: Record<string, unknown>, kind: "message" | "transfer") {
  if (body.token !== null && body.token !== undefined && typeof body.token !== "string"
    || typeof body.submissionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submissionId)
    || (body.giverName !== null && body.giverName !== undefined && typeof body.giverName !== "string")) {
    throw new AppError(400, "GIFT_PAYLOAD_INVALID");
  }
  if (kind === "message" && typeof body.message !== "string") throw new AppError(400, "GIFT_MESSAGE_INVALID");
  if (kind === "transfer" && (typeof body.transferSender !== "string" || typeof body.transferDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.transferDate))) {
    throw new AppError(400, "GIFT_TRANSFER_INVALID");
  }
  return {
    token: typeof body.token === "string" ? body.token : null,
    submissionId: body.submissionId,
    giverName: typeof body.giverName === "string" ? body.giverName : null,
    message: kind === "message" ? body.message as string : null,
    transferSender: kind === "transfer" ? body.transferSender as string : null,
    transferDate: kind === "transfer" ? body.transferDate as string : null,
  };
}

Deno.serve(async (request) => {
  let headers: HeadersInit = { "Content-Type": "application/json; charset=utf-8" };
  try {
    headers = allowedCorsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");

    const body = await readJson(request);
    const action = body.action;
    if (action !== "resolve" && action !== "submit" && action !== "giftMessage" && action !== "giftTransfer") {
      throw new AppError(400, "REQUEST_INVALID");
    }

    const giftAction = action === "giftMessage" || action === "giftTransfer";
    const gift = giftAction ? validateGift(body, action === "giftMessage" ? "message" : "transfer") : null;
    const token = giftAction ? gift?.token : requireInvitationToken(body.token);
    const tokenHash = token ? await sha256Hex(token) : null;
    const config = loadRuntimeConfig();

    // La clave de límite se hashea antes de llegar a PostgreSQL. No persiste la
    // IP ni el token en texto plano, y los registros de función no reciben el body.
    const rateKey = await sha256Hex(`${action}:${clientIdentifier(request)}:${tokenHash ?? "anonymous"}`);
    const allowed = await rpc<boolean>(config, "rsvp_take_rate_limit", {
      p_scope: `public_rsvp:${action}`,
      p_key_hash: rateKey,
      p_limit: action === "resolve" ? RESOLVE_LIMIT : giftAction ? GIFT_LIMIT : SUBMIT_LIMIT,
      p_window_seconds: RATE_WINDOW_SECONDS,
    });
    if (allowed !== true) {
      return json({ error: "RATE_LIMITED" }, 429, { ...headers, "Retry-After": String(RATE_WINDOW_SECONDS) });
    }

    if (action === "resolve") {
      const invitation = await rpc<unknown>(config, "rsvp_resolve_invitation", { p_token_hash: tokenHash });
      if (invitation === null) throw new AppError(404, "INVITATION_INVALID");
      return json({ invitation }, 200, headers);
    }

    if (giftAction && gift) {
      if (gift.token) requireInvitationToken(gift.token);
      const result = await rpc<{ status: string }>(config, "gift_submit", {
        p_token_hash: tokenHash, p_submission_id: gift.submissionId, p_giver_name: gift.giverName,
        p_message: gift.message, p_transfer_sender: gift.transferSender, p_transfer_date: gift.transferDate,
        p_kind: action === "giftMessage" ? "message" : "transfer",
      });
      return json(result, 200, headers);
    }

    const submission = validateSubmission(body);
    const invitation = await rpc<unknown>(config, "rsvp_submit", {
      p_token_hash: tokenHash,
      p_is_attending: submission.isAttending,
      p_confirmed_count: submission.confirmedCount,
      p_attendees: submission.attendees,
      p_comment: submission.comment,
    });
    return json({ invitation }, 200, headers);
  } catch (error) {
    const mapped = databaseErrorResponse(error);
    return publicErrorResponse(mapped ?? error, headers);
  }
});
