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

Deno.serve(async (request) => {
  let headers: HeadersInit = { "Content-Type": "application/json; charset=utf-8" };
  try {
    headers = allowedCorsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new AppError(405, "METHOD_NOT_ALLOWED");

    const body = await readJson(request);
    const action = body.action;
    if (action !== "resolve" && action !== "submit") {
      throw new AppError(400, "REQUEST_INVALID");
    }

    const token = requireInvitationToken(body.token);
    const tokenHash = await sha256Hex(token);
    const config = loadRuntimeConfig();

    // La clave de límite se hashea antes de llegar a PostgreSQL. No persiste la
    // IP ni el token en texto plano, y los registros de función no reciben el body.
    const rateKey = await sha256Hex(`${action}:${clientIdentifier(request)}:${tokenHash}`);
    const allowed = await rpc<boolean>(config, "rsvp_take_rate_limit", {
      p_scope: `public_rsvp:${action}`,
      p_key_hash: rateKey,
      p_limit: action === "resolve" ? RESOLVE_LIMIT : SUBMIT_LIMIT,
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
