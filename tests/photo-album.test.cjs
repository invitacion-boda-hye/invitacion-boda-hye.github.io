const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const dir = mkdtempSync(path.join(tmpdir(), 'album-test-'));
execFileSync(path.resolve('album/node_modules/.bin/esbuild'), ['supabase/functions/photo-album/index.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${dir}/handler.cjs`], { stdio: 'ignore' });
let handler;
const env = { SUPABASE_URL: 'http://isolated.invalid', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', ALLOWED_ORIGINS: 'https://wedding.test' };
global.Deno = { env: { get: key => env[key] }, serve: fn => { handler = fn; } };
const originalFetch = global.fetch;
let objects = new Map(), reservations = new Map(), settings = { enabled: true, opens_at: '2020-01-01T00:00:00Z', closes_at: '2099-01-01T00:00:00Z', quota_bytes: 20971520 }, writes = 0, failDelete = false, failUpload = false;
const ok = value => Response.json(value);
global.fetch = async (input, options = {}) => {
  const url = new URL(input); assert.equal(url.hostname, 'isolated.invalid');
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
  if (url.pathname === '/auth/v1/user') return options.headers.Authorization === 'Bearer valid' ? ok({ id: '11111111-1111-4111-8111-111111111111' }) : Response.json({}, { status: 401 });
  if (url.pathname === '/rest/v1/rsvp_admins') return ok([{ user_id: '11111111-1111-4111-8111-111111111111' }]);
  if (url.pathname === '/rest/v1/photo_album_settings') return ok([settings]);
  if (url.pathname === '/rest/v1/photo_album_uploads') { const id = url.searchParams.get('id')?.replace('eq.', ''); return ok([...reservations.values()].filter(row => (!id || row.id === id) && (!url.searchParams.has('state') || url.searchParams.get('state') === `eq.${row.state}`))); }
  if (url.pathname === '/rest/v1/rpc/rsvp_take_rate_limit') return ok(true);
  if (url.pathname === '/rest/v1/rpc/photo_album_reserve') { let row = reservations.get(body.p_id); if (!row) { if (!settings.enabled) return Response.json({ message: 'ALBUM_CLOSED' }, { status: 400 }); row = { id: body.p_id, guest_name: body.p_name || null, state: 'reserved' }; reservations.set(row.id, row); } return ok(row.state); }
  if (url.pathname === '/rest/v1/rpc/photo_album_confirm') { const row = reservations.get(body.p_id); Object.assign(row, { state: 'ready', actual_bytes: body.p_bytes, sha256: body.p_sha256 }); return ok('ready'); }
  if (url.pathname === '/rest/v1/rpc/photo_album_mark_delete') { const row = reservations.get(body.p_id); if (row) row.state = 'cleanup'; return ok(row ? `${row.id}.jpg` : null); }
  if (url.pathname === '/rest/v1/rpc/photo_album_finish_delete') { reservations.delete(body.p_id); return ok(null); }
  if (url.pathname.startsWith('/storage/v1/object/authenticated/')) { const key = url.pathname.split('/').pop(); return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 }); }
  if (url.pathname.startsWith('/storage/v1/object/wedding-photos/') && options.method === 'POST') { const key = url.pathname.split('/').pop(); if (failUpload) return new Response(null, { status: 503 }); if (objects.has(key)) return new Response(null, { status: 409 }); objects.set(key, new Uint8Array(options.body)); writes++; return ok({}); }
  if (url.pathname === '/storage/v1/object/wedding-photos' && options.method === 'DELETE') { if (failDelete) return new Response(null, { status: 503 }); body.prefixes.forEach(key => objects.delete(key)); return ok([]); }
  throw new Error(`unexpected request ${url}`);
};
require(path.join(dir, 'handler.cjs'));
after(() => { global.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Minimal structurally valid JPEG for the bounded marker parser.
const jpeg = Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1,255,218,0,2,42,255,217]).toString('base64');
async function call(body, token, origin = 'https://wedding.test') { const response = await handler(new Request('http://local.test', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })); return { status: response.status, data: await response.json() }; }
test('status and upload validate input, store verified bytes and retry idempotently', async () => {
  assert.deepEqual(await call({ action: 'status' }), { status: 200, data: { open: true } });
  assert.equal((await call({ action: 'upload', id, name: 'Invitado', jpeg: 'YWJj' })).status, 400);
  assert.equal(writes, 0);
  assert.equal((await call({ action: 'upload', id, name: 'Invitado', jpeg })).status, 200);
  assert.equal((await call({ action: 'upload', id, name: 'Invitado', jpeg })).status, 200);
  assert.equal(writes, 1); assert.equal(reservations.get(id).state, 'ready');
  const altered = Buffer.from(jpeg, 'base64'); altered[16] = 43;
  assert.equal((await call({ action: 'upload', id, name: 'Invitado', jpeg: altered.toString('base64') })).status, 409);
});
test('private photos require an administrator and delete removes both object and row', async () => {
  assert.equal((await call({ action: 'download', id })).status, 401);
  assert.equal((await call({ action: 'download', id }, 'valid')).data.jpeg, jpeg);
  assert.equal((await call({ action: 'delete', id }, 'valid')).status, 200);
  assert.equal(objects.size, 0); assert.equal(reservations.size, 0);
  assert.equal((await call({ action: 'download', id }, 'valid')).status, 404);
});
test('UUIDs with uppercase characters use the canonical storage path and can be deleted', async () => {
  const upper = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
  const lower = upper.toLowerCase();
  assert.equal((await call({ action: 'upload', id: upper, jpeg })).status, 200);
  assert.equal(objects.has(`${lower}.jpg`), true);
  assert.equal((await call({ action: 'download', id: upper }, 'valid')).data.jpeg, jpeg);
  assert.equal((await call({ action: 'delete', id: lower }, 'valid')).status, 200);
  assert.equal(objects.size, 0); assert.equal(reservations.size, 0);
});
test('storage failures retain reservations and permit safe retries', async () => {
  const photoId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  failUpload = true;
  assert.equal((await call({ action: 'upload', id: photoId, jpeg })).status, 503);
  assert.equal(reservations.get(photoId).state, 'reserved');
  assert.equal(objects.size, 0);
  failUpload = false;
  assert.equal((await call({ action: 'upload', id: photoId, jpeg })).status, 200);
  failDelete = true;
  assert.equal((await call({ action: 'delete', id: photoId }, 'valid')).status, 503);
  assert.equal(reservations.get(photoId).state, 'cleanup');
  assert.equal(objects.has(`${photoId}.jpg`), true);
  failDelete = false;
  assert.equal((await call({ action: 'delete', id: photoId }, 'valid')).status, 200);
  assert.equal(objects.size, 0); assert.equal(reservations.size, 0);
});
test('download refuses data altered after confirmation', async () => {
  const photoId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.equal((await call({ action: 'upload', id: photoId, jpeg })).status, 200);
  const corrupt = Buffer.from(jpeg, 'base64'); corrupt[16] ^= 1;
  objects.set(`${photoId}.jpg`, corrupt);
  const response = await call({ action: 'download', id: photoId }, 'valid');
  assert.equal(response.status, 503); assert.equal(response.data.error, 'ALBUM_STORAGE_ERROR');
  assert.equal((await call({ action: 'delete', id: photoId }, 'valid')).status, 200);
});
test('disallowed origin and closed album are rejected', async () => {
  assert.equal((await call({ action: 'status' }, null, 'https://bad.test')).status, 403);
  settings.enabled = false;
  assert.equal((await call({ action: 'upload', id, jpeg })).status, 423);
});
