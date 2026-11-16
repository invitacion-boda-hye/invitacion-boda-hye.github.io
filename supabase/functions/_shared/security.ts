export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "AppError";
  }
}

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, code = "REQUEST_INVALID"): string {
  if (typeof value !== "string") throw new AppError(400, code);
  return value;
}

export function requireUuid(value: unknown, code = "REQUEST_INVALID"): string {
  const id = requireString(value, code);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError(400, code);
  }
  return id;
}

export function requireInvitationToken(value: unknown): string {
  const token = requireString(value, "INVITATION_INVALID");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, "INVITATION_INVALID");
  return token;
}

export function newInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cleanGroupName(value: unknown): string {
  const name = requireString(value, "ADMIN_INVITATION_ARGUMENT_INVALID").trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 160) throw new AppError(400, "ADMIN_INVITATION_ARGUMENT_INVALID");
  return name;
}

export function requirePassCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new AppError(400, "ADMIN_INVITATION_ARGUMENT_INVALID");
  }
  return value;
}

export async function readJson(request: Request, maxBytes = 32_768): Promise<JsonRecord> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new AppError(413, "REQUEST_TOO_LARGE");
  const value = await request.text();
  if (value.length > maxBytes) throw new AppError(413, "REQUEST_TOO_LARGE");
  try {
    const body: unknown = JSON.parse(value);
    if (!isJsonRecord(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new AppError(400, "REQUEST_INVALID");
  }
}

export function allowedCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (origin && !allowedOrigins.includes(origin)) throw new AppError(403, "ORIGIN_NOT_ALLOWED");
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "apikey, authorization, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

export function json(data: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

export function clientIdentifier(request: Request): string {
  const candidate = request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return candidate.length <= 128 ? candidate : "unknown";
}

export function publicErrorResponse(error: unknown, headers: HeadersInit): Response {
  if (error instanceof AppError) return json({ error: error.code }, error.status, headers);
  return json({ error: "INTERNAL_ERROR" }, 500, headers);
}
