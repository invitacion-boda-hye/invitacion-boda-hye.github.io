const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { URL: NodeURL, URLSearchParams } = require('node:url');
const root = path.resolve(__dirname, '..');

function setup({ failure, response, tracking = [], links = {}, invitations, members, summary, resolvedInvitationId } = {}) {
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
  storage.set('rsvp-invitation-links', JSON.stringify(links));
  let openedUrl = '';
  get('adminDashboard').hidden = true;
  get('familyView').value = 'active'; get('reminderInterval').value = '10';
  class TestURL extends NodeURL {}
  TestURL.createObjectURL = () => 'blob:synthetic'; TestURL.revokeObjectURL = () => {};
  const context = vm.createContext({
    document: { body: { insertAdjacentHTML() {} }, getElementById: get, createElement: element, querySelectorAll: () => [] },
    confirm: () => true, prompt: () => null, window: { print() {}, open: (url) => { openedUrl = url; return {}; } }, URL: TestURL, URLSearchParams, Blob: class {},
    sessionStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    RSVP_API: {
      signIn: async () => ({ access_token: 'synthetic-session' }),
      publicRequest: async () => ({ invitation: { invitation: { id: resolvedInvitationId || '11111111-1111-4111-8111-111111111111' } } }),
      adminRequest: async (action) => {
        calls.push(action);
        if (failure) throw Object.assign(new Error(failure), { status: 403 });
        if (action === 'summary') return { summary: summary || { capacity: 50, confirmedPeople: 2, availableCapacity: 48, pendingFamilies: 1, declinedFamilies: 0, assignedPasses: 3 } };
        if (action === 'createInvitation') return { invitation: { id: '11111111-1111-4111-8111-111111111111' }, invitationUrl: 'https://example.invalid/#i=synthetic' };
        if (action === 'listInvitations') return { data: { invitations: invitations || [{ id: '11111111-1111-4111-8111-111111111111', groupName: 'Familia de prueba', maxPasses: 3, isActive: true, state: 'attending', response: { isAttending: true, confirmedCount: 2, attendees: response ? [{ id: '22222222-2222-4222-8222-222222222222', fullName: 'Ana Prueba' }] : [] } }], tables: [] } };
        if (action === 'listMembers') return { members: members || [] };
        if (action === 'listInvitationTracking') return { tracking };
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
  return { get, calls, submit, storage, openedUrl: () => openedUrl };
}

function findByText(node, value) {
  if (node.textContent === value) return node;
  for (const child of node.children || []) { const found = findByText(child, value); if (found) return found; }
  return null;
}

test('login exitoso carga métricas y familias tras finalizar el despacho del evento', async () => {
  const app = setup();
  await app.submit('loginForm');
  assert.deepEqual(app.calls, ['summary', 'listInvitations', 'listMembers', 'listInvitationTracking', 'listGifts']);
  assert.equal(app.get('adminDashboard').hidden, false);
  assert.equal(app.get('adminLogin').hidden, true);
  assert.equal(app.get('loginMessage').textContent, '');
  assert.equal(app.get('loginForm').resets, 1);
  assert.equal(app.get('adminMetrics').children.length, 4);
});

test('crear familia refresca el panel después del await', async () => {
  const app = setup();
  await app.submit('createInvitationForm');
  assert.deepEqual(app.calls, ['createInvitation', 'summary', 'listInvitations', 'listMembers', 'listInvitationTracking']);
  assert.equal(app.get('createInvitationForm').resets, 1);
  assert.equal(app.get('generatedLink').value, 'https://example.invalid/#i=synthetic');
  assert.equal(app.get('linkResult').hidden, false);
  assert.equal(app.get('dashboardMessage').textContent, '');
});

test('la carga de familias usa la respuesta administrativa normalizada', async () => {
  const app = setup();
  await app.submit('loginForm');
  assert.equal(app.get('familyList').children.length, 1);
});

test('familias muestra vigentes por defecto y mantiene las inactivas solo en historial', async () => {
  const activeId = '11111111-1111-4111-8111-111111111111', inactiveId = '22222222-2222-4222-8222-222222222222';
  const app = setup({ invitations: [
    { id: activeId, groupName: 'Familia actual', maxPasses: 2, isActive: true, state: 'pending', response: null },
    { id: inactiveId, groupName: 'Invitación anterior', maxPasses: 1, isActive: false, state: 'pending', response: null }
  ], members: [{ id: '33333333-3333-4333-8333-333333333333', invitationId: activeId, fullName: 'Ana Actual', isFamilyHead: true, tableNumber: 2, memberState: 'pending' }] });
  await app.submit('loginForm');
  assert.equal(app.get('familyList').children.length, 1);
  assert.equal(app.get('adminMetrics').children[0].children[0].textContent, 1);
  app.get('familyView').value = 'inactive'; app.get('familyView').listeners.change();
  assert.equal(app.get('familyList').children.length, 1);
  assert.ok(findByText(app.get('familyList'), 'Invitación anterior'));
});

test('resumen no mezcla personas, pases, familias ni estados de envío', async () => {
  const pendingIds = [...Array(30)].map((_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const confirmedId = '11111111-1111-4111-8111-111111111111';
  const invitations = [...pendingIds.map((id, index) => ({ id, groupName: `Familia pendiente ${index + 1}`, maxPasses: index < 17 ? 2 : 1, isActive: true, state: 'pending', response: null })), { id: confirmedId, groupName: 'Familia parcial', maxPasses: 25, isActive: true, state: 'attending', response: { confirmedCount: 22 } }, { id: '22222222-2222-4222-8222-222222222222', groupName: 'Histórica', maxPasses: 9, isActive: false, state: 'pending', response: null }];
  const members = [...Array(41)].map((_, index) => ({ id: `p${index}`, invitationId: pendingIds[index % pendingIds.length], fullName: `Pendiente ${index}`, memberState: 'pending' })).concat([...Array(22)].map((_, index) => ({ id: `a${index}`, invitationId: confirmedId, fullName: `Confirmado ${index}`, memberState: 'attending' })), [...Array(3)].map((_, index) => ({ id: `q${index}`, invitationId: confirmedId, fullName: `Parcial ${index}`, memberState: 'pending' })));
  const app = setup({ invitations, members, summary: { capacity: 63, confirmedPeople: 22, availableCapacity: 41, pendingFamilies: 30, declinedFamilies: 0, assignedPasses: 72 }, tracking: [{ deliveryStatus: 'sent' }, { deliveryStatus: 'unregistered' }] });
  await app.submit('loginForm');
  const primary = app.get('adminMetrics').children.map((card) => card.children[0].textContent);
  assert.deepEqual(primary, [66, 22, 0, 44]);
  const secondary = app.get('adminSecondaryMetrics').children.map((card) => card.children[0].textContent);
  assert.equal(secondary[0], 72);
  assert.equal(secondary[1], 0);
  assert.equal(secondary[2], 6);
  assert.equal(secondary[3], 30);
  assert.equal(secondary[4], 1);
  assert.equal(secondary[6], 1);
  app.get('adminMetrics').children[3].listeners.click();
  assert.match(app.get('summaryBreakdownTitle').textContent, /Personas sin responder · 44 personas en 31 familias/);
  assert.equal(app.get('summaryBreakdownList').children.length, 31);
  app.get('summaryBreakdownSearch').value = 'Pendiente 0'; app.get('summaryBreakdownSearch').listeners.input();
  assert.equal(app.get('summaryBreakdownList').children.length, 1);
  app.get('adminSecondaryMetrics').children[3].listeners.click();
  assert.match(app.get('summaryBreakdownTitle').textContent, /Familias pendientes · 30/);
  app.get('adminSecondaryMetrics').children[0].listeners.click();
  assert.match(app.get('summaryBreakdownTitle').textContent, /Pases vigentes · 72 pases en 31 invitaciones/);
});

test('separa invitaciones vacías y pases sin persona de personas pendientes', async () => {
  const liliana = '11111111-1111-4111-8111-111111111111', patricia = '22222222-2222-4222-8222-222222222222', ana = '33333333-3333-4333-8333-333333333333';
  const app = setup({ invitations: [
    { id: liliana, groupName: 'Liliana', maxPasses: 2, isActive: true, state: 'pending', response: null },
    { id: patricia, groupName: 'Patricia', maxPasses: 4, isActive: true, state: 'pending', response: null },
    { id: ana, groupName: 'Ana', maxPasses: 1, isActive: true, state: 'pending', response: null }
  ], members: [{ id: 'member-ana', invitationId: ana, fullName: 'Ana', memberState: 'pending' }], summary: { capacity: 63, confirmedPeople: 0, availableCapacity: 63, pendingFamilies: 3, declinedFamilies: 0, assignedPasses: 7 } });
  await app.submit('loginForm');
  assert.deepEqual(app.get('adminMetrics').children.map((card) => card.children[0].textContent), [1, 0, 0, 1]);
  assert.equal(app.get('adminSecondaryMetrics').children[1].children[0].textContent, 2);
  assert.equal(app.get('adminSecondaryMetrics').children[2].children[0].textContent, 6);
  assert.match(app.get('summaryConsistency').textContent, /2 invitaciones activas tienen 6 pases sin integrantes/);
  app.get('adminSecondaryMetrics').children[1].listeners.click();
  assert.match(app.get('summaryBreakdownTitle').textContent, /Casos que requieren revisión · 2/);
  assert.ok(findByText(app.get('summaryBreakdownList'), 'Liliana'));
  assert.ok(findByText(app.get('summaryBreakdownList'), 'Patricia'));
  app.get('adminSecondaryMetrics').children[2].listeners.click();
  assert.match(app.get('summaryBreakdownTitle').textContent, /Pases sin persona asociada · 6 pases/);
});

test('un 403 de membresía se distingue de un fallo local y cierra el acceso', async () => {
  const app = setup({ failure: 'ADMIN_FORBIDDEN' });
  await app.submit('loginForm');
  assert.match(app.get('loginMessage').textContent, /no está autorizada/);
  assert.equal(app.storage.has('rsvp-admin-access-token'), false);
  assert.equal(app.get('adminDashboard').hidden, true);
});

test('recordatorios abren WhatsApp con enlace recordado y no habilitan registro antes de plazo', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const link = `https://example.invalid/#i=${'A'.repeat(43)}`;
  const app = setup({ links: { [id]: link }, tracking: [{ invitationId: id, groupName: 'Familia de prueba', sentAt: '2026-11-01T12:00:00Z', lastReminderAt: new Date().toISOString(), members: [{ fullName: 'Ana Prueba', state: 'pending' }] }] });
  await app.submit('loginForm');
  const prepare = findByText(app.get('reminderList'), 'Abrir WhatsApp');
  const mark = findByText(app.get('reminderList'), 'Marcar recordatorio como enviado');
  prepare.listeners.click();
  assert.match(app.openedUrl(), /^https:\/\/wa\.me\/\?text=/);
  assert.match(decodeURIComponent(app.openedUrl()), /#i=A{43}/);
  assert.equal(mark.disabled, true);
});

test('recordatorios permiten registrar localmente un enlace original sin regenerarlo', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const link = `https://example.invalid/#i=${'B'.repeat(43)}`;
  const app = setup({ tracking: [{ invitationId: id, groupName: 'Familia de prueba', sentAt: '2026-11-01T12:00:00Z', lastReminderAt: null, members: [{ fullName: 'Ana Prueba', state: 'pending' }] }] });
  await app.submit('loginForm');
  findByText(app.get('reminderList'), 'Abrir WhatsApp').listeners.click();
  assert.equal(app.get('reminderLinkDialog').open, true);
  app.get('reminderOriginalLink').value = link;
  await app.get('reminderLinkForm').listeners.submit({ preventDefault() {} });
  assert.match(app.openedUrl(), /^https:\/\/wa\.me\/\?text=/);
  assert.match(app.storage.get('rsvp-invitation-links'), /B{43}/);
  assert.equal(app.calls.includes('recordReminder'), false);
});

test('preparar envío valida un enlace existente y abre WhatsApp sin cambiar su estado', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const link = `https://example.invalid/#i=${'C'.repeat(43)}`;
  const app = setup({ links: { [id]: link } });
  await app.submit('loginForm');
  await findByText(app.get('familyList'), 'Preparar envío').listeners.click();
  assert.match(app.openedUrl(), /^https:\/\/wa\.me\/\?text=/);
  assert.match(decodeURIComponent(app.openedUrl()), /#i=C{43}/);
  assert.equal(app.calls.includes('setInvitationDelivery'), false);
  assert.equal(app.calls.includes('regenerateInvitation'), false);
});

test('preparar envío no usa un enlace guardado que no corresponde a la familia', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const link = `https://example.invalid/#i=${'D'.repeat(43)}`;
  const app = setup({ links: { [id]: link }, resolvedInvitationId: '22222222-2222-4222-8222-222222222222' });
  await app.submit('loginForm');
  await findByText(app.get('familyList'), 'Preparar envío').listeners.click();
  assert.equal(app.get('reminderLinkDialog').open, true);
  assert.equal(app.openedUrl(), '');
  assert.equal(app.storage.get('rsvp-invitation-links'), '{}');
  assert.match(app.get('reminderLinkError').textContent, /no se regenerará/i);
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
