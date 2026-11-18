const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function setup({ failure, response } = {}) {
  const elements = new Map();
  function element() {
    return {
      value: '', hidden: false, textContent: '', children: [], listeners: {}, resets: 0,
      style: {}, classList: { toggle() {}, contains() { return false; } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelector() { return this.button ||= element(); },
      reset() { this.resets += 1; }, showModal() { this.open = true; }, close() { this.open = false; }, click() {}
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  const calls = [];
  const storage = new Map();
  get('adminDashboard').hidden = true;
  const context = vm.createContext({
    document: { body: { insertAdjacentHTML() {} }, getElementById: get, createElement: element, querySelectorAll: () => [] },
    confirm: () => true, prompt: () => null, window: { print() {} }, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} }, Blob: class {},
    sessionStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    RSVP_API: {
      signIn: async () => ({ access_token: 'synthetic-session' }),
      adminRequest: async (action) => {
        calls.push(action);
        if (failure) throw Object.assign(new Error(failure), { status: 403 });
        if (action === 'summary') return { summary: { capacity: 50, confirmedPeople: 2, availableCapacity: 48, pendingFamilies: 1, declinedFamilies: 0, assignedPasses: 3 } };
        if (action === 'createInvitation') return { invitation: { id: '11111111-1111-4111-8111-111111111111' }, invitationUrl: 'https://example.invalid/#i=synthetic' };
        if (action === 'listInvitations') return { data: { invitations: [{ id: '11111111-1111-4111-8111-111111111111', groupName: 'Familia de prueba', maxPasses: 3, isActive: true, state: 'attending', response: { isAttending: true, confirmedCount: 2, attendees: response ? [{ id: '22222222-2222-4222-8222-222222222222', fullName: 'Ana Prueba' }] : [] } }], tables: [] } };
        if (action === 'listMembers') return { members: [] };
        if (action === 'listInvitationTracking') return { tracking: [] };
        if (action === 'listGifts') return { gifts: [] };
        return {};
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'admin/admin.js'), 'utf8'), context);
  async function submit(id) {
    const form = get(id);
    const event = { currentTarget: form, preventDefault() {} };
    const pending = form.listeners.submit(event);
    // Browser Event.currentTarget is cleared after synchronous dispatch, before
    // the continuation of the async listener resumes.
    event.currentTarget = null;
    await pending;
  }
  return { get, calls, submit, storage };
}

test('login exitoso carga métricas y familias tras finalizar el despacho del evento', async () => {
  const app = setup();
  await app.submit('loginForm');
  assert.deepEqual(app.calls, ['summary', 'listInvitations', 'listMembers', 'listInvitationTracking']);
  assert.equal(app.get('adminDashboard').hidden, false);
  assert.equal(app.get('adminLogin').hidden, true);
  assert.equal(app.get('loginMessage').textContent, '');
  assert.equal(app.get('loginForm').resets, 1);
  assert.equal(app.get('adminMetrics').children.length, 9);
});

test('crear familia refresca el panel después del await', async () => {
  const app = setup();
  await app.submit('createInvitationForm');
  assert.deepEqual(app.calls, ['createInvitation', 'summary', 'listInvitations', 'listMembers', 'listInvitationTracking']);
  assert.equal(app.get('createInvitationForm').resets, 1);
  assert.equal(app.get('dashboardMessage').textContent, '');
});

test('la carga de familias usa la respuesta administrativa normalizada', async () => {
  const app = setup();
  await app.submit('loginForm');
  assert.equal(app.get('familyList').children.length, 1);
});

test('un 403 de membresía se distingue de un fallo local y cierra el acceso', async () => {
  const app = setup({ failure: 'ADMIN_FORBIDDEN' });
  await app.submit('loginForm');
  assert.match(app.get('loginMessage').textContent, /no está autorizada/);
  assert.equal(app.storage.has('rsvp-admin-access-token'), false);
  assert.equal(app.get('adminDashboard').hidden, true);
});

function client(fetch) {
  const context = vm.createContext({
    fetch,
    RSVP_CONFIG: { supabaseUrl: 'https://example.invalid', publishableKey: 'synthetic-public-key', adminFunction: 'admin-rsvp' }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/rsvp-client.js'), 'utf8'), context);
  return vm.runInContext('RSVP_API', context);
}

test('cliente conserva el cuerpo de error 403 como código seguro', async () => {
  const api = client(async () => new Response(JSON.stringify({ error: 'ADMIN_FORBIDDEN' }), { status: 403 }));
  await assert.rejects(api.adminRequest('summary', {}, 'synthetic-session'), e => e.message === 'ADMIN_FORBIDDEN' && e.status === 403);
});

test('cliente identifica 403 de un proxy sin mostrar cuerpos arbitrarios', async () => {
  const api = client(async () => new Response('private upstream details', { status: 403 }));
  await assert.rejects(api.adminRequest('summary', {}, 'synthetic-session'), e => e.message === 'HTTP_403' && e.status === 403);
});

test('cliente identifica fallos de red o bloqueo CORS', async () => {
  const api = client(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.adminRequest('summary', {}, 'synthetic-session'), /NETWORK_ERROR/);
});

test('cliente envía JWT y clave pública por separado y desactiva caché de datos', async () => {
  let request;
  const api = client(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ summary: { capacity: 50 } }));
  });
  const result = await api.adminRequest('summary', {}, 'synthetic-session');
  assert.equal(result.summary.capacity, 50);
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-session');
  assert.equal(request.options.headers.apikey, 'synthetic-public-key');
  assert.equal(request.options.cache, 'no-store');
});
