// Integración con Supabase desechable: nunca acepta una dirección remota.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const base = process.env.ALBUM_LOCAL_SUPABASE_URL;
const anon = process.env.ALBUM_LOCAL_ANON_KEY;
const service = process.env.ALBUM_LOCAL_SERVICE_KEY;
const enabled = process.env.ALBUM_DISPOSABLE_SUPABASE === 'yes';
test('Supabase local: subida, autorización, lectura y eliminación del objeto privado', { skip: !enabled }, async () => {
  assert.ok(base && anon && service, 'Configura ALBUM_LOCAL_SUPABASE_URL, ALBUM_LOCAL_ANON_KEY y ALBUM_LOCAL_SERVICE_KEY');
  const url = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Solo se permite Supabase en loopback');
  const root = url.origin;
  async function request(path, { method = 'GET', body, token = service, key = service, expect = [200] } = {}) {
    const response = await fetch(root + path, { method, redirect: 'error', headers: { apikey: key, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    assert.ok(expect.includes(response.status), `${method} ${path.split('?')[0]} devolvió ${response.status}`);
    return data;
  }
  const existing = await request('/rest/v1/photo_album_uploads?select=id&limit=1');
  assert.equal(existing.length, 0, 'La base debe ser desechable y tener el álbum vacío');
  const settings = (await request('/rest/v1/photo_album_settings?select=enabled,opens_at,closes_at,quota_bytes&id=eq.true'))[0];
  assert.ok(settings, 'Aplica primero las migraciones locales del álbum');
  const suffix = randomBytes(8).toString('hex'), email = `album-${suffix}@example.test`, password = `A-${randomBytes(18).toString('hex')}!`;
  let userId, photoId;
  const publicCall = body => request('/functions/v1/photo-album', { method: 'POST', body, token: anon, key: anon });
  try {
    const user = await request('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true }, expect: [200, 201] });
    userId = user.id;
    await request('/rest/v1/rsvp_admins', { method: 'POST', body: { user_id: userId }, expect: [201, 204] });
    const session = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, token: anon, key: anon });
    const adminCall = (body, expect = [200]) => request('/functions/v1/photo-album', { method: 'POST', body, token: session.access_token, key: anon, expect });
    await adminCall({ action: 'configure', enabled: true, opensAt: new Date(Date.now() - 60000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString(), quotaBytes: 4194304 });
    assert.equal((await publicCall({ action: 'status' })).open, true);
    photoId = randomUUID(); const jpeg = readFileSync('tests/fixtures/photo-album.jpg').toString('base64');
    assert.equal((await publicCall({ action: 'upload', id: photoId, name: 'Prueba local', jpeg })).ok, true);
    assert.equal((await publicCall({ action: 'upload', id: photoId, name: 'Prueba local', jpeg })).ok, true);
    const unauthorized = await request('/functions/v1/photo-album', { method: 'POST', body: { action: 'download', id: photoId }, token: anon, key: anon, expect: [401, 403] });
    assert.ok(unauthorized.error);
    assert.ok((await adminCall({ action: 'list' })).photos.some(photo => photo.id === photoId));
    assert.equal((await adminCall({ action: 'download', id: photoId })).jpeg, jpeg);
    assert.equal((await adminCall({ action: 'delete', id: photoId })).ok, true);
    assert.equal((await adminCall({ action: 'download', id: photoId }, [404])).error, 'ALBUM_NOT_FOUND');
    photoId = null;
  } finally {
    if (photoId) {
      // Marcar para limpieza conserva la cuota si no fuera posible borrar el objeto.
      await request('/rest/v1/rpc/photo_album_mark_delete', { method: 'POST', body: { p_id: photoId } });
      await request('/storage/v1/object/wedding-photos', { method: 'DELETE', body: { prefixes: [`${photoId}.jpg`] } });
      await request('/rest/v1/rpc/photo_album_finish_delete', { method: 'POST', body: { p_id: photoId } });
    }
    await request('/rest/v1/photo_album_settings?id=eq.true', { method: 'PATCH', body: settings, expect: [200, 204] });
    if (userId) await request(`/auth/v1/admin/users/${userId}`, { method: 'DELETE', expect: [200, 204] });
  }
});
