import { loadRuntimeConfig, type RuntimeConfig } from '../_shared/config.ts';
import { allowedCorsHeaders, AppError, clientIdentifier, json, publicErrorResponse, readJson, requireUuid, sha256Hex } from '../_shared/security.ts';
import { adminRead, DatabaseError, databaseErrorResponse, requireAuthenticatedAdmin, rpc } from '../_shared/supabase.ts';
import { inspectJpeg } from '../_shared/album_jpeg.ts';

const MAX = 2097152;
const bucket = 'wedding-photos';
type Upload = { id: string; object_path: string; guest_name: string | null; state: string; actual_bytes: number | null; sha256: string | null; confirmed_at: string | null };
type Settings = { enabled: boolean; opens_at: string; closes_at: string; quota_bytes: number | null };
function storageHeaders(config: RuntimeConfig): Record<string, string> {
  return { apikey: config.secretKey, Authorization: `Bearer ${config.secretKey}` };
}
async function storage(config: RuntimeConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${config.supabaseUrl}/storage/v1/${path}`, { ...init, headers: { ...storageHeaders(config), ...(init.headers as Record<string, string> || {}) } });
}
async function storedPhoto(config: RuntimeConfig, id: string): Promise<Uint8Array> {
  const response = await storage(config, `object/authenticated/${bucket}/${id}.jpg`);
  if (!response.ok) throw new AppError(503, 'ALBUM_STORAGE_ERROR');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX) throw new AppError(503, 'ALBUM_STORAGE_ERROR');
  return bytes;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
function decode(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new AppError(400, 'ALBUM_INVALID');
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { throw new AppError(400, 'ALBUM_INVALID'); }
}
async function removeObject(config: RuntimeConfig, id: string): Promise<void> {
  const response = await storage(config, `object/${bucket}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [`${id}.jpg`] }) });
  if (!response.ok) throw new AppError(503, 'ALBUM_STORAGE_ERROR');
  await rpc(config, 'photo_album_finish_delete', { p_id: id });
}
Deno.serve(async request => {
  let headers: HeadersInit = { 'Content-Type': 'application/json; charset=utf-8' };
  try {
    headers = allowedCorsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(request, 2_900_000);
    const config = loadRuntimeConfig();
    if (body.action === 'status' || body.action === 'upload') {
      const allowed = await rpc<boolean>(config, 'rsvp_take_rate_limit', { p_scope: `photo_album:${body.action}`, p_key_hash: await sha256Hex(`${body.action}:${clientIdentifier(request)}`), p_limit: body.action === 'upload' ? 40 : 120, p_window_seconds: 600 });
      if (!allowed) throw new AppError(429, 'RATE_LIMITED');
      if (body.action === 'status') {
        const settings = await adminRead<Settings[]>(config, 'photo_album_settings?select=enabled,opens_at,closes_at,quota_bytes&id=eq.true');
        const s = settings[0]; const now = Date.now();
        return json({ open: !!s && s.enabled && s.quota_bytes !== null && now >= Date.parse(s.opens_at) && now < Date.parse(s.closes_at) }, 200, headers);
      }
      const id = requireUuid(body.id, 'ALBUM_INVALID').toLowerCase();
      const name = body.name == null ? '' : typeof body.name === 'string' ? body.name.trim() : (() => { throw new AppError(400, 'ALBUM_INVALID'); })();
      if (name.length > 160) throw new AppError(400, 'ALBUM_INVALID');
      const bytes = decode(body.jpeg);
      if (!inspectJpeg(bytes)) throw new AppError(400, 'ALBUM_INVALID_IMAGE');
      const hash = await digest(bytes);
      const state = await rpc<string>(config, 'photo_album_reserve', { p_id: id, p_bytes: bytes.length, p_name: name });
      if (state === 'cleanup') throw new AppError(409, 'ALBUM_RESERVATION_EXPIRED');
      if (state === 'reserved') {
        const response = await storage(config, `object/${bucket}/${id}.jpg`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: bytes });
        // Una repetición puede encontrar el objeto de un intento interrumpido.
        if (!response.ok && response.status !== 409 && response.status !== 400) throw new AppError(503, 'ALBUM_STORAGE_ERROR');
      }
      const saved = await storedPhoto(config, id);
      if (!inspectJpeg(saved) || saved.length !== bytes.length || await digest(saved) !== hash) throw new AppError(409, 'ALBUM_ID_CONFLICT');
      await rpc(config, 'photo_album_confirm', { p_id: id, p_bytes: saved.length, p_sha256: hash });
      return json({ ok: true }, 200, headers);
    }
    await requireAuthenticatedAdmin(request, config);
    if (body.action === 'list') {
      const offset = Number(body.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new AppError(400, 'ALBUM_INVALID');
      const [settings, photos] = await Promise.all([
        adminRead<Settings[]>(config, 'photo_album_settings?select=enabled,opens_at,closes_at,quota_bytes&id=eq.true'),
        adminRead<Upload[]>(config, `photo_album_uploads?select=id,guest_name,actual_bytes,confirmed_at&state=eq.ready&order=confirmed_at.desc,id.desc&limit=100&offset=${offset}`),
      ]);
      return json({ settings: settings[0], photos }, 200, headers);
    }
    if (body.action === 'configure') {
      if (typeof body.enabled !== 'boolean' || typeof body.opensAt !== 'string' || typeof body.closesAt !== 'string' || !Number.isSafeInteger(body.quotaBytes)) throw new AppError(400, 'ALBUM_INVALID_SETTINGS');
      await rpc(config, 'photo_album_configure', { p_enabled: body.enabled, p_opens_at: body.opensAt, p_closes_at: body.closesAt, p_quota_bytes: body.quotaBytes });
      return json({ ok: true }, 200, headers);
    }
    if (body.action === 'download') {
      const id = requireUuid(body.id, 'ALBUM_INVALID').toLowerCase();
      const rows = await adminRead<Upload[]>(config, `photo_album_uploads?select=id,sha256,actual_bytes&state=eq.ready&id=eq.${id}`);
      if (rows.length !== 1) throw new AppError(404, 'ALBUM_NOT_FOUND');
      const bytes = await storedPhoto(config, id);
      if (bytes.length !== rows[0].actual_bytes || await digest(bytes) !== rows[0].sha256) throw new AppError(503, 'ALBUM_STORAGE_ERROR');
      let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return json({ jpeg: btoa(binary) }, 200, headers);
    }
    if (body.action === 'delete') {
      const id = requireUuid(body.id, 'ALBUM_INVALID').toLowerCase();
      const path = await rpc<string | null>(config, 'photo_album_mark_delete', { p_id: id });
      if (path) await removeObject(config, id);
      return json({ ok: true }, 200, headers);
    }
    if (body.action === 'cleanup') {
      await rpc(config, 'photo_album_claim_expired', { p_limit: 100 });
      const rows = await adminRead<Upload[]>(config, 'photo_album_uploads?select=id&state=eq.cleanup&limit=100');
      let removed = 0; for (const row of rows) { try { await removeObject(config, row.id); removed++; } catch { /* se conserva la reserva para reintentar */ } }
      return json({ removed, pending: rows.length - removed }, 200, headers);
    }
    throw new AppError(400, 'REQUEST_INVALID');
  } catch (error) {
    if (error instanceof DatabaseError && /^ALBUM_[A-Z_]+$/.test(error.message)) {
      const status = error.message === 'ALBUM_CLOSED' ? 423 : error.message === 'ALBUM_INVALID' || error.message === 'ALBUM_INVALID_SETTINGS' ? 400 : 409;
      return publicErrorResponse(new AppError(status, error.message), headers);
    }
    return publicErrorResponse(databaseErrorResponse(error) ?? error, headers);
  }
});
