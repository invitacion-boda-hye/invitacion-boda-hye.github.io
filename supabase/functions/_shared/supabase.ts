import { AppError, isJsonRecord, requireUuid, type JsonRecord } from "./security.ts";
import type { RuntimeConfig } from "./config.ts";

export class DatabaseError extends Error {
  constructor(
    public readonly status: number,
    public readonly databaseCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function rpc<T>(
  config: RuntimeConfig,
  functionName: string,
  parameters: JsonRecord,
): Promise<T> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.secretKey,
    },
    body: JSON.stringify(parameters),
  });
  const body = await parseResponseBody(response);

  if (!response.ok) {
    const message = isJsonRecord(body) && typeof body.message === "string" ? body.message : "DATABASE_ERROR";
    const code = isJsonRecord(body) && typeof body.code === "string" ? body.code : undefined;
    throw new DatabaseError(response.status, code, message);
  }

  return body as T;
}

// Esta lectura se usa solo después de validar sesión y membresía administrativa.
// La ruta es interna y fijada en código, nunca procede del navegador.
export async function adminRead<T>(config: RuntimeConfig, path: string): Promise<T> {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    headers: { "apikey": config.secretKey },
  });
  const body = await parseResponseBody(response);
  if (!response.ok) throw new AppError(503, "ADMIN_DATA_READ_FAILED");
  return body as T;
}

export async function requireAuthenticatedAdmin(
  request: Request,
  config: RuntimeConfig,
): Promise<string> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "ADMIN_AUTH_REQUIRED");
  }

  const userResponse = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: {
      "apikey": config.publishableKey,
      "Authorization": authorization,
    },
  });
  const user = await parseResponseBody(userResponse);
  if (!userResponse.ok || !isJsonRecord(user)) {
    throw new AppError(401, "ADMIN_AUTH_REQUIRED");
  }

  const userId = requireUuid(user.id, "ADMIN_AUTH_REQUIRED");
  const membershipResponse = await fetch(
    `${config.supabaseUrl}/rest/v1/rsvp_admins?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: { "apikey": config.secretKey } },
  );
  const membership = await parseResponseBody(membershipResponse);

  // No convertir un fallo de infraestructura o de la clave de servidor en un
  // falso "no autorizado": eso ocultaba la causa real detrás de un 403.
  if (!membershipResponse.ok || !Array.isArray(membership)) {
    throw new AppError(503, "ADMIN_MEMBERSHIP_CHECK_FAILED");
  }
  if (membership.length !== 1) {
    throw new AppError(403, "ADMIN_FORBIDDEN");
  }

  return userId;
}

export function databaseErrorResponse(error: unknown): AppError | null {
  if (!(error instanceof DatabaseError)) return null;

  const known: Record<string, [number, string]> = {
    INVITATION_INVALID: [404, "INVITATION_INVALID"],
    RSVP_DEADLINE_PASSED: [423, "RSVP_DEADLINE_PASSED"],
    RSVP_CAPACITY_EXCEEDED: [409, "RSVP_CAPACITY_EXCEEDED"],
    RSVP_PASSES_EXCEEDED: [400, "RSVP_PASSES_EXCEEDED"],
    RSVP_COUNT_MISMATCH: [400, "RSVP_COUNT_MISMATCH"],
    RSVP_ATTENDEE_NAME_INVALID: [400, "RSVP_ATTENDEE_NAME_INVALID"],
    RSVP_DECLINE_MUST_BE_ZERO: [400, "RSVP_DECLINE_MUST_BE_ZERO"],
    RSVP_COMMENT_TOO_LONG: [400, "RSVP_COMMENT_TOO_LONG"],
    RSVP_PAYLOAD_INVALID: [400, "RSVP_PAYLOAD_INVALID"],
    ADMIN_UNAUTHORIZED: [403, "ADMIN_FORBIDDEN"],
    ADMIN_MEMBERSHIP_CHECK_FAILED: [503, "ADMIN_MEMBERSHIP_CHECK_FAILED"],
    ADMIN_DATA_READ_FAILED: [503, "ADMIN_DATA_READ_FAILED"],
    ADMIN_INVITATION_NOT_FOUND: [404, "ADMIN_INVITATION_NOT_FOUND"],
    ADMIN_PASSES_EXCEED_CAPACITY: [400, "ADMIN_PASSES_EXCEED_CAPACITY"],
    ADMIN_REACTIVATION_CAPACITY_EXCEEDED: [409, "ADMIN_REACTIVATION_CAPACITY_EXCEEDED"],
    ADMIN_CAPACITY_INVALID: [400, "ADMIN_CAPACITY_INVALID"],
    ADMIN_CAPACITY_BELOW_CONFIRMED: [409, "ADMIN_CAPACITY_BELOW_CONFIRMED"],
    ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES: [409, "ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES"],
    ADMIN_INVITATION_ARGUMENT_INVALID: [400, "ADMIN_INVITATION_ARGUMENT_INVALID"],
  };

  const mapped = known[error.message];
  return mapped ? new AppError(mapped[0], mapped[1]) : new AppError(500, "DATABASE_ERROR");
}
