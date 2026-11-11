import {
  AppError,
  newInvitationToken,
  requireInvitationToken,
  sha256Hex,
} from "./security.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("los enlaces usan 32 bytes base64url sin relleno", () => {
  const first = newInvitationToken();
  const second = newInvitationToken();
  assert(/^[A-Za-z0-9_-]{43}$/.test(first), "el primer token no tiene formato seguro");
  assert(/^[A-Za-z0-9_-]{43}$/.test(second), "el segundo token no tiene formato seguro");
  assert(first !== second, "dos tokens consecutivos no deben coincidir");
});

Deno.test("el hash SHA-256 del token es determinista y no reversible en la base", async () => {
  const hash = await sha256Hex("token-de-prueba");
  assert(hash === "6f01606f61af728b4309e0e78f0c9a7c35f76c1e02b3c892f245a9cfc9bc8314", "hash SHA-256 inesperado");
});

Deno.test("los formatos de enlace que no son de 32 bytes se rechazan", () => {
  try {
    requireInvitationToken("no-es-un-token");
    throw new Error("se aceptó un token corto");
  } catch (error) {
    assert(error instanceof AppError && error.code === "INVITATION_INVALID", "se devolvió un error incorrecto");
  }
});
