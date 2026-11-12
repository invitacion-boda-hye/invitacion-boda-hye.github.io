import { AppError, isJsonRecord } from "./security.ts";

export interface RuntimeConfig {
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
  publicInvitationUrl: string;
}

function requireEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new AppError(500, "SERVER_CONFIGURATION_ERROR");
  return value;
}

function readSupabaseKey(pluralName: string, singularName: string, legacyName: string): string {
  const plural = Deno.env.get(pluralName);
  if (plural) {
    try {
      const parsed: unknown = JSON.parse(plural);
      if (isJsonRecord(parsed) && typeof parsed.default === "string" && parsed.default.trim()) {
        return parsed.default.trim();
      }
    } catch {
      throw new AppError(500, "SERVER_CONFIGURATION_ERROR");
    }
  }

  // El runtime reciente admite esta variante singular al ejecutar funciones
  // fuera de la plataforma. No la configuramos como secreto del proyecto.
  const singular = Deno.env.get(singularName)?.trim();
  if (singular) return singular;

  // Compatibilidad para desarrollo local con proyectos Supabase antiguos.
  return requireEnvironment(legacyName);
}

export function loadRuntimeConfig(requirePublicInvitationUrl = false): RuntimeConfig {
  const publicInvitationUrl = Deno.env.get("PUBLIC_INVITATION_URL")?.trim() ?? "";
  if (requirePublicInvitationUrl && !publicInvitationUrl) {
    throw new AppError(500, "SERVER_CONFIGURATION_ERROR");
  }

  return {
    supabaseUrl: requireEnvironment("SUPABASE_URL").replace(/\/+$/u, ""),
    publishableKey: readSupabaseKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"),
    secretKey: readSupabaseKey("SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
    publicInvitationUrl: publicInvitationUrl.replace(/\/+$/u, ""),
  };
}
