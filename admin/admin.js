(() => {
  const $ = (id) => document.getElementById(id);
  const login = $('adminLogin'), dashboard = $('adminDashboard'), message = $('dashboardMessage'), loginMessage = $('loginMessage');
  const state = { token: sessionStorage.getItem('rsvp-admin-access-token') || '', summary: null, data: { invitations: [], tables: [] }, gifts: [], members: [], pendingSeat: null, links: new Map(Object.entries(JSON.parse(sessionStorage.getItem('rsvp-invitation-links') || '{}'))) };
  const rememberLink = (id, link) => { if (!id || !link) return; state.links.set(id, link); sessionStorage.setItem('rsvp-invitation-links', JSON.stringify(Object.fromEntries(state.links))); };
  function installGuestDialogs() {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="guestEditorDialog"><form method="dialog" class="seat-dialog" id="guestEditorForm"><button class="dialog-close" value="cancel" aria-label="Cerrar">×</button><h2 id="guestEditorTitle">Invitado</h2><label for="guestEditorName">Nombre</label><input id="guestEditorName" maxlength="160" required><label for="guestEditorTable">Mesa prevista</label><input id="guestEditorTable" type="number" min="1" max="99" required><label for="guestEditorType">Tipo</label><select id="guestEditorType"><option value="adult">Adulto</option><option value="child">Niño</option></select><label><input id="guestEditorPending" type="checkbox"> Nombre pendiente</label><p id="guestEditorError" role="alert"></p><menu><button class="button outline" value="cancel">Cancelar</button><button class="button" value="default">Guardar</button></menu></form></dialog><dialog id="recoverDialog"><form method="dialog" class="seat-dialog" id="recoverForm"><button class="dialog-close" value="cancel" aria-label="Cerrar">×</button><h2>Recuperar invitado</h2><label for="recoverId">guest_id original</label><input id="recoverId" maxlength="80" required placeholder="guest-m3-08"><p class="note">Se recuperará con sus datos y mesa de origen; si ya existe, no se duplicará.</p><p id="recoverError" role="alert"></p><menu><button class="button outline" value="cancel">Cancelar</button><button class="button" value="default">Recuperar</button></menu></form></dialog><dialog id="messagePreviewDialog"><div class="seat-dialog"><button class="dialog-close" type="button" aria-label="Cerrar">×</button><h2>Mensaje para WhatsApp</h2><p id="messagePreviewMeta"></p><textarea id="messagePreviewText" maxlength="1000"></textarea><menu><button class="button outline" id="copyPreviewLink" type="button">Copiar enlace</button><button class="button outline" id="copyPreviewMessage" type="button">Copiar mensaje</button><button class="button" id="openPreviewWhatsApp" type="button">Abrir WhatsApp</button></menu></div></dialog>`);
    document.body.insertAdjacentHTML('beforeend', `<dialog id="tableCapacityDialog"><form method="dialog" class="seat-dialog" id="tableCapacityForm"><h2 id="tableCapacityTitle">Capacidad</h2><label for="tableCapacityValue">Sillas (1–54)</label><input id="tableCapacityValue" type="number" min="1" max="54" required><p id="tableCapacityError" role="alert"></p><menu><button class="button outline" value="cancel">Cancelar</button><button class="button" value="default">Guardar</button></menu></form></dialog>`);
  }
  installGuestDialogs();
  const errorText = { ADMIN_FORBIDDEN: 'Tu cuenta no está autorizada como administradora.', ADMIN_AUTH_REQUIRED: 'Tu sesión no es válida. Vuelve a iniciar sesión.', ORIGIN_NOT_ALLOWED: 'Este origen no está autorizado para usar el panel.', ADMIN_SEAT_OCCUPIED: 'Esa silla acaba de ser ocupada.', ADMIN_ATTENDEE_ALREADY_SEATED: 'Este invitado ya tiene una silla.', ADMIN_ATTENDEE_NOT_ELIGIBLE: 'Este invitado ya no está confirmado.', ADMIN_TABLE_CAPACITY_OCCUPIED: 'No puedes reducir una mesa con sillas ocupadas.', ADMIN_SEAT_EMPTY: 'Esta silla ya está libre.', NETWORK_ERROR: 'No se pudo conectar con el servidor.', DATABASE_ERROR: 'No se pudo consultar el evento.' };
  const tell = (target, error) => { target.textContent = error ? (errorText[error.message] || 'No fue posible completar la operación.') : ''; target.classList.toggle('is-error', Boolean(error)); };
  const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  const metric = (label, value) => { const card = document.createElement('div'); card.className = 'metric'; card.append(text('strong', value), text('span', label)); return card; };
  const dateForInput = (value) => value ? new Date(value).toISOString().slice(0, 16) : '';
  const status = (invitation) => invitation.state === 'declined' ? 'declined' : invitation.state === 'pending' ? 'pending' : (invitation.response?.confirmedCount < invitation.maxPasses ? 'partial' : 'attending');
  const statusName = (value) => ({ attending: 'Confirmada', partial: 'Parcial', pending: 'Pendiente', declined: 'Rechazada' })[value] || 'Pendiente';
  let editingMember = null, previewLink = '';
  let editingTable = null;
  function openGuestEditor(member = null) {
    editingMember = member; $('guestEditorTitle').textContent = member ? 'Editar invitado' : 'Agregar invitado';
    $('guestEditorName').value = member?.fullName || ''; $('guestEditorTable').value = member?.tableNumber || '';
    $('guestEditorType').value = member?.attendeeType || 'adult'; $('guestEditorPending').checked = Boolean(member?.namePending);
    $('guestEditorError').textContent = ''; $('guestEditorDialog').showModal();
  }
  function showMessagePreview(groupName, link, members = [], passes = members.length || 1) {
    previewLink = link; const names = members.map((m) => m.fullName).filter(Boolean).join(', ');
    const dialog = $('messagePreviewDialog'); dialog.querySelector('h2').textContent = 'Preparar invitación';
    $('messagePreviewMeta').textContent = `Personaliza el mensaje antes de compartirlo · ${groupName}${names ? ` · ${names}` : ''} · ${passes} pase${passes === 1 ? '' : 's'} (solo administración)`;
    $('messagePreviewText').value = `✨ Tenemos algo especial que compartir...\n\nPara ${groupName}:\n\nHay momentos que merecen ser compartidos de una manera diferente.\n\nPor eso, hemos preparado una pequeña sorpresa que nos gustaría compartir con ustedes. 💌\n\nLos invitamos a descubrirla aquí:\n\n${link}\n\nEsperamos que les guste. 🤍\n\nHector & Elisbe`;
    dialog.showModal();
  }

  async function api(action, payload = {}) { return RSVP_API.adminRequest(action, payload, state.token); }
  async function refresh() {
    const [summaryResult, guestResult, giftResult, memberResult] = await Promise.all([api('summary'), api('listInvitations'), api('listGifts'), api('listMembers').catch(() => ({ members: [] }))]);
    state.summary = summaryResult.summary; state.data = guestResult.data || { invitations: [], tables: [] };
    state.gifts = giftResult.gifts || [];
    state.members = memberResult.members || [];
    render();
  }
  function render() { renderSummary(); renderFamilies(); renderMembers(); renderTables(); renderGifts(); renderPrintBoards(); }
  function renderSummary() {
    const s = state.summary; if (!s) return;
    $('adminMetrics').replaceChildren(metric('Capacidad RSVP', s.capacity), metric('Confirmados', s.confirmedPeople), metric('Disponibles', s.availableCapacity), metric('Familias pendientes', s.pendingFamilies), metric('Rechazadas', s.declinedFamilies));
    const pct = s.capacity ? Math.min(100, Math.round(s.confirmedPeople * 100 / s.capacity)) : 0;
    $('occupancyText').textContent = `${s.confirmedPeople} de ${s.capacity} personas · ${pct}%`;
    $('occupancyBar').style.width = `${pct}%`; $('eventCapacity').value = s.capacity; $('rsvpDeadline').value = dateForInput(s.rsvpDeadline); $('rsvpCapacity').textContent = s.capacity;
    $('physicalCapacity').textContent = state.data.tables.reduce((sum, table) => sum + Number(table.capacity || 0), 0);
  }
  function renderFamilies() {
    const query = $('familySearch').value.trim().toLocaleLowerCase(); const filter = $('familyFilter').value;
    const rows = state.data.invitations.filter((invitation) => {
      const haystack = [invitation.groupName, ...(invitation.response?.attendees || []).map(a => a.fullName)].join(' ').toLocaleLowerCase();
      return (!query || haystack.includes(query)) && (filter === 'all' || status(invitation) === filter);
    }).map((invitation) => {
      const row = document.createElement('article'); row.className = 'family-row'; const current = status(invitation);
      const main = document.createElement('div'); main.className = 'family-main'; const left = document.createElement('div'); left.append(text('strong', invitation.groupName), text('div', `${invitation.response?.confirmedCount || 0} confirmados de ${invitation.maxPasses} pases`, 'family-meta')); main.append(left, text('span', statusName(current), `status ${current}`));
      const actions = document.createElement('div'); actions.className = 'family-actions'; const view = text('button', 'Ver invitados', 'mini-btn'); view.type = 'button'; const prepare = text('button', 'Preparar invitación', 'mini-btn'); prepare.type = 'button'; const reset = text('button', 'Restablecer confirmación', 'mini-btn'); reset.type = 'button'; const regenerate = text('button', 'Regenerar enlace', 'mini-btn'); regenerate.type = 'button'; const remove = text('button', 'Eliminar familia', 'mini-btn'); remove.type = 'button';
      const detail = document.createElement('div'); detail.className = 'attendee-details'; const list = document.createElement('ul'); (invitation.response?.attendees || []).forEach((attendee) => list.append(text('li', `${attendee.fullName}${attendee.seatAssignment ? ` · Mesa ${attendee.seatAssignment.tableNumber}, silla ${attendee.seatAssignment.seatNumber}` : ' · Sin mesa'}`))); if (!list.children.length) list.append(text('li', 'No hay asistentes confirmados.')); detail.append(list);
      view.addEventListener('click', () => { detail.classList.toggle('open'); view.textContent = detail.classList.contains('open') ? 'Ocultar invitados' : 'Ver invitados'; });
      const regenerateLink = async () => { const result = await api('regenerateInvitation', { invitationId: invitation.id }); rememberLink(invitation.id, result.invitationUrl); $('generatedLink').value = result.invitationUrl; $('linkResult').hidden = false; showMessagePreview(invitation.groupName, result.invitationUrl, invitation.response?.attendees || [], invitation.maxPasses); await refresh(); };
      prepare.addEventListener('click', async () => { const link = state.links.get(invitation.id); if (link) return showMessagePreview(invitation.groupName, link, invitation.response?.attendees || [], invitation.maxPasses); if (!confirm(`No se puede recuperar el enlace vigente de ${invitation.groupName} porque sólo se guarda su hash. ¿Generar uno nuevo? El enlace anterior dejará de funcionar.`)) return; try { await regenerateLink(); } catch (error) { tell(message, error); } });
      regenerate.addEventListener('click', async () => { if (!confirm(`¿Regenerar el enlace de ${invitation.groupName}? El enlace anterior dejará de funcionar.`)) return; try { await regenerateLink(); } catch (error) { tell(message, error); } });
      reset.addEventListener('click', async () => { const count = invitation.response?.confirmedCount || 0; if (!confirm(`¿Restablecer la confirmación de ${invitation.groupName}? Se liberarán ${count} asiento(s), pero se conservarán sus pases y enlace.`)) return; try { await api('resetInvitation', { invitationId: invitation.id }); await refresh(); tell(message); } catch (error) { tell(message, error); } });
      remove.addEventListener('click', async () => { const count = invitation.response?.confirmedCount || 0; if (!confirm(`¿Eliminar la familia ${invitation.groupName} y sus ${count} invitado(s) confirmado(s)? Esta acción no se puede deshacer.`)) return; try { await api('deleteInvitation', { invitationId: invitation.id }); await refresh(); tell(message); } catch (error) { tell(message, error); } });
      actions.append(view, prepare, reset, regenerate, remove); row.append(main, actions, detail); return row;
    });
    $('familyList').replaceChildren(...(rows.length ? rows : [text('p', 'No encontramos familias para este filtro.')]));
  }
  function renderMembers() {
    const query = $('memberSearch')?.value.trim().toLocaleLowerCase() || '';
    const rows = state.members.filter((member) => !query || [member.fullName, member.groupName, member.guestId, member.tableNumber].join(' ').toLocaleLowerCase().includes(query)).map((member) => {
      const row = document.createElement('article'); row.className = 'family-row';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.value = member.id; toggle.className = 'member-select';
      const main = document.createElement('div'); main.className = 'family-main';
      const pending = member.namePending ? ' · nombre pendiente' : ''; const head = member.isFamilyHead ? ' · Cabeza de familia' : '';
      main.append(text('strong', member.fullName), text('span', `Mesa ${member.tableNumber || 'sin asignar'} · ${member.groupName || 'individual'}${head}${pending}`, 'family-meta'));
      const edit = text('button', 'Editar', 'mini-btn'); edit.type = 'button';
      edit.addEventListener('click', () => openGuestEditor(member));
      const actions = document.createElement('div'); actions.className = 'family-actions'; actions.append(edit);
      const deactivate = text('button', 'Desactivar', 'mini-btn'); deactivate.type = 'button';
      deactivate.addEventListener('click', async () => { if (!confirm(`¿Desactivar a ${member.fullName}? Podrás recuperarlo después con ${member.guestId}.`)) return; try { const result = await api('deactivateMember', { memberId: member.id, replacementId: null }); state.members = result.members || []; await refresh(); } catch (error) { tell(message, error); } }); actions.append(deactivate);
      const siblings = state.members.filter((m) => m.invitationId === member.invitationId);
      if (siblings.length > 1) {
        const split = text('button', 'Desagrupar', 'mini-btn'); split.type = 'button';
        split.addEventListener('click', async () => {
          if (!confirm(`¿Separar a ${member.fullName} de ${member.groupName}? Se creará un enlace individual nuevo y el anterior no incluirá a esta persona.`)) return;
          try {
            const result = await api('ungroupMember', { memberId: member.id });
            await refresh();
            $('generatedLink').value = result.invitationUrl;
            $('linkResult').hidden = false;
            activate('summary');
            message.textContent = 'Invitado separado. Guarda su nuevo enlace antes de salir.';
          } catch (error) { tell(message, error); }
        });
        actions.append(split);
      }
      row.append(toggle, main, actions); return row;
    });
    $('memberList').replaceChildren(...(rows.length ? rows : [text('p', 'Aún no hay invitados importados.') ]));
  }
  function confirmedWithoutSeat() { return state.data.invitations.flatMap(i => (i.response?.isAttending ? i.response.attendees.map(a => ({ ...a, family: i.groupName })) : [])).filter(a => !a.seatAssignment); }
  function renderTables() {
    const unassigned = confirmedWithoutSeat(); $('unassignedList').replaceChildren(...(unassigned.length ? unassigned.map(a => text('span', `${a.fullName} · ${a.family}`, 'unassigned-item')) : [text('span', 'Todos los confirmados tienen mesa.', 'unassigned-item')]));
    const tables = state.data.tables.map((table) => { const card = document.createElement('article'); card.className = `table-card${table.isHeadTable ? ' head' : ''}`; const top = document.createElement('div'); top.className = 'table-top'; const capacity = text('button', `${table.capacity} sillas`, 'mini-btn'); capacity.type = 'button'; capacity.addEventListener('click', () => updateTableCapacity(table)); top.append(text('strong', table.name), capacity); const seats = document.createElement('div'); seats.className = 'seat-grid'; table.seats.filter(s => s.isActive).forEach((seat) => { const button = document.createElement('button'); button.type = 'button'; button.className = `seat${seat.assignment ? ' occupied' : ''}`; button.append(text('span', `Silla ${seat.seatNumber}`, 'number'), text('span', seat.assignment?.fullName || 'Libre')); button.addEventListener('click', () => seat.assignment ? releaseSeat(table, seat) : openSeatDialog(table, seat)); seats.append(button); }); card.append(top, seats); return card; }); $('tableLayout').replaceChildren(...tables);
  }
  function giftStatusName(value) { return ({ message_received: 'Mensaje recibido', transfer_reported: 'Transferencia informada', transfer_verified: 'Transferencia verificada' })[value] || 'Mensaje recibido'; }
  function renderGifts() {
    const rows = state.gifts.map((gift) => {
      const row = document.createElement('article'); row.className = 'gift-admin-row';
      const top = document.createElement('div'); top.className = 'gift-admin-top';
      const date = gift.createdAt ? new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(gift.createdAt)) : 'Sin fecha';
      const person = gift.giverName || 'Nombre no indicado'; const family = gift.family ? ` · ${gift.family}` : '';
      top.append(text('strong', person), text('span', giftStatusName(gift.status), `gift-status ${gift.status}`));
      const details = document.createElement('div'); details.className = 'gift-admin-details'; details.append(text('span', `${date}${family}`));
      if (gift.dedication) details.append(text('p', gift.dedication));
      if (gift.status !== 'message_received') details.append(text('span', `Remitente informado: ${gift.transferSender || 'No indicado'} · ${gift.transferDate || 'Sin fecha'}`));
      if (gift.status === 'transfer_reported') { const verify = text('button', 'Marcar como verificada', 'mini-btn'); verify.type = 'button'; verify.addEventListener('click', async () => { if (!confirm('¿Confirmas que revisaste esta transferencia en el banco?')) return; try { const result = await api('verifyGift', { giftId: gift.id }); state.gifts = result.gifts || []; renderGifts(); tell(message); } catch (error) { tell(message, error); } }); details.append(verify); }
      row.append(top, details); return row;
    });
    $('giftAdminList').replaceChildren(...(rows.length ? rows : [text('p', 'Aún no hay mensajes ni transferencias informadas.') ]));
  }
  function openSeatDialog(table, seat) { const available = confirmedWithoutSeat(); if (!available.length) return tell(message, new Error('No hay invitados confirmados sin mesa.')); state.pendingSeat = { table, seat }; $('seatDialogTitle').textContent = `${table.name} · silla ${seat.seatNumber}`; const select = $('seatAttendee'); select.replaceChildren(...available.map(a => { const option = document.createElement('option'); option.value = a.id; option.textContent = `${a.fullName} · ${a.family}`; return option; })); $('seatDialog').showModal(); }
  async function releaseSeat(table, seat) { if (!confirm(`¿Liberar la silla ${seat.seatNumber} de ${seat.assignment.fullName}? La confirmación RSVP no se eliminará.`)) return; try { await api('releaseSeat', { tableId: table.id, seatNumber: seat.seatNumber }); await refresh(); tell(message); } catch (error) { tell(message, error); } }
  function updateTableCapacity(table) { editingTable = table; $('tableCapacityTitle').textContent = `Capacidad de ${table.name}`; $('tableCapacityValue').value = table.capacity; $('tableCapacityError').textContent = ''; $('tableCapacityDialog').showModal(); }
  function safeCell(value) { const raw = String(value ?? ''); return /^[=+\-@]/.test(raw) ? `'${raw}` : raw; }
  function csvValue(value) { return `"${safeCell(value).replaceAll('"', '""')}"`; }
  async function exportCsv() { try { const result = await api('exportGuestData'); const header = ['Nombre completo', 'Familia', 'Estado de confirmación', 'Mesa asignada', 'Número de silla', 'Pases asignados', 'Observaciones']; const rows = result.rows.map(row => [row.fullName || '', row.family, statusName(row.state), row.tableNumber || '', row.seatNumber || '', row.maxPasses, row.observations || '']); const csv = `\uFEFF${[header, ...rows].map(r => r.map(csvValue).join(';')).join('\r\n')}`; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = 'hector-elisbe-rsvp.csv'; link.click(); URL.revokeObjectURL(link.href); } catch (error) { tell(message, error); } }
  function renderPrintBoards() { const container = $('printBoards'); const boards = []; const title = document.createElement('section'); title.className = 'print-board'; title.append(text('h1', 'Hector & Elisbe'), text('h2', 'Distribución de mesas')); state.data.tables.forEach(table => { const line = text('p', `${table.name}: ${table.seats.filter(s => s.assignment).map(s => s.assignment.fullName).join(', ') || 'Sin asignaciones'}`); title.append(line); }); boards.push(title); const alpha = document.createElement('section'); alpha.className = 'print-board'; alpha.append(text('h1', 'Ubicación de invitados'), text('h2', 'Listado alfabético')); const list = document.createElement('ul'); state.data.invitations.flatMap(i => i.response?.attendees || []).sort((a,b) => a.fullName.localeCompare(b.fullName, 'es')).forEach(a => list.append(text('li', `${a.fullName} — ${a.seatAssignment ? `Mesa ${a.seatAssignment.tableNumber}` : 'Sin mesa asignada'}`))); alpha.append(list); boards.push(alpha); state.data.tables.forEach(table => { const board = document.createElement('section'); board.className = 'print-board'; board.append(text('h1', table.name)); const list = document.createElement('ul'); table.seats.filter(s => s.assignment).forEach(s => list.append(text('li', `${s.assignment.fullName} · silla ${s.seatNumber}`))); if (!list.children.length) list.append(text('li', 'Sin asignaciones.')); board.append(list); boards.push(board); }); container.replaceChildren(...boards); }
  function activate(view) { document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === view)); document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view)); }
  async function showDashboard() { try { await refresh(); login.hidden = true; dashboard.hidden = false; tell(loginMessage); } catch (error) { state.token = ''; sessionStorage.removeItem('rsvp-admin-access-token'); tell(loginMessage, error); } }
  $('loginForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; try { state.token = (await RSVP_API.signIn($('adminEmail').value.trim(), $('adminPassword').value)).access_token; sessionStorage.setItem('rsvp-admin-access-token', state.token); form.reset(); await showDashboard(); } catch (error) { tell(loginMessage, error); } finally { button.disabled = false; } });
  $('logoutButton').addEventListener('click', () => { state.token = ''; sessionStorage.removeItem('rsvp-admin-access-token'); dashboard.hidden = true; login.hidden = false; });
  $('createInvitationForm').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; try { const groupName = $('groupName').value.trim(); const result = await api('createInvitation', { groupName, maxPasses: Number($('maxPasses').value) }); rememberLink(result.invitation?.id, result.invitationUrl); $('generatedLink').value = result.invitationUrl; $('linkResult').hidden = false; showMessagePreview(groupName, result.invitationUrl); form.reset(); await refresh(); } catch (error) { tell(message, error); } });
  $('settingsForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const deadline = $('rsvpDeadline').value; await api('updateSettings', { capacity: Number($('eventCapacity').value), rsvpDeadline: deadline ? new Date(deadline).toISOString() : null }); await refresh(); tell(message); } catch (error) { tell(message, error); } });
  $('copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('generatedLink').value); tell(message); message.textContent = 'Enlace copiado.'; } catch { $('generatedLink').select(); message.textContent = 'Selecciona y copia el enlace manualmente.'; } });
  $('addGuest').addEventListener('click', () => openGuestEditor());
  $('recoverGuest').addEventListener('click', () => { $('recoverId').value = ''; $('recoverError').textContent = ''; $('recoverDialog').showModal(); });
  $('guestEditorForm').addEventListener('submit', async (event) => { event.preventDefault(); const name = $('guestEditorName').value.trim(), tableNumber = Number($('guestEditorTable').value); try { if (editingMember) { const result = await api('updateMember', { memberId: editingMember.id, fullName: name, attendeeType: $('guestEditorType').value, tableNumber, namePending: $('guestEditorPending').checked }); state.members = result.members || []; } else { const result = await api('importProvisionalGuest', { guestId: `guest-manual-${crypto.randomUUID().replaceAll('-', '')}`, fullName: name, tableNumber, namePending: $('guestEditorPending').checked }); rememberLink(result.guest?.invitationId, result.invitationUrl); $('generatedLink').value = result.invitationUrl; $('linkResult').hidden = false; showMessagePreview(name, result.invitationUrl); } $('guestEditorDialog').close(); await refresh(); } catch (error) { $('guestEditorError').textContent = errorText[error.message] || 'No fue posible guardar.'; } });
  $('recoverForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('recoverGuest', { guestId: $('recoverId').value.trim() }); $('recoverDialog').close(); rememberLink(result.guest?.invitationId, result.invitationUrl); $('generatedLink').value = result.invitationUrl; $('linkResult').hidden = false; showMessagePreview(result.guest.groupName, result.invitationUrl); await refresh(); } catch (error) { $('recoverError').textContent = errorText[error.message] || 'No se pudo recuperar el invitado.'; } });
  $('copyPreviewLink').addEventListener('click', () => navigator.clipboard.writeText(previewLink));
  $('copyPreviewMessage').addEventListener('click', () => navigator.clipboard.writeText($('messagePreviewText').value));
  $('openPreviewWhatsApp').addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent($('messagePreviewText').value)}`, '_blank', 'noopener'));
  $('messagePreviewDialog').querySelector('.dialog-close').addEventListener('click', () => $('messagePreviewDialog').close());
  $('tableCapacityForm').addEventListener('submit', async (event) => { event.preventDefault(); const capacity = Number($('tableCapacityValue').value); if (!editingTable || !Number.isInteger(capacity) || capacity < 1 || capacity > 54) { $('tableCapacityError').textContent = 'Ingresa una capacidad válida.'; return; } try { await api('updateTableCapacity', { tableId: editingTable.id, capacity }); $('tableCapacityDialog').close(); await refresh(); } catch (error) { $('tableCapacityError').textContent = errorText[error.message] || 'No se pudo actualizar.'; } });
  $('seatDialogConfirm').addEventListener('click', async (event) => { event.preventDefault(); const pending = state.pendingSeat; if (!pending) return; try { await api('assignSeat', { tableId: pending.table.id, seatNumber: pending.seat.seatNumber, attendeeId: $('seatAttendee').value }); $('seatDialog').close(); await refresh(); } catch (error) { $('seatDialog').close(); tell(message, error); } });
  $('groupSelectedMembers').addEventListener('click', async () => {
    const memberIds = [...document.querySelectorAll('.member-select:checked')].map((item) => item.value);
    if (!memberIds.length) { message.textContent = 'Selecciona al menos un invitado.'; return; }
    const headSelect = $('familyHeadSelect');
    headSelect.replaceChildren(...memberIds.map((id) => {
      const member = state.members.find((m) => m.id === id);
      const option = document.createElement('option'); option.value = id; option.textContent = member?.fullName || id; return option;
    }));
    const chosen = state.members.find((m) => m.id === memberIds[0]);
    $('selectedFamilyCount').textContent = `${memberIds.length} personas seleccionadas`;
    $('selectedFamilyName').value = chosen?.groupName && chosen.groupName !== chosen.fullName ? chosen.groupName : `Familia ${chosen?.fullName?.split(' ').slice(-1)[0] || ''}`;
    $('familyGroupDialog').showModal();
  });
  $('confirmFamilyGroup').addEventListener('click', async () => {
    const memberIds = [...document.querySelectorAll('.member-select:checked')].map((item) => item.value);
    const groupName = $('selectedFamilyName').value.trim();
    const headMemberId = $('familyHeadSelect').value;
    if (!groupName || !memberIds.includes(headMemberId)) { $('familyGroupError').textContent = 'Revisa el nombre y el cabeza de familia.'; return; }
    const button = $('confirmFamilyGroup'); button.disabled = true;
    try {
      await api('groupMembers', { memberIds, groupName, headMemberId });
      $('familyGroupDialog').close(); await refresh();
      message.textContent = 'Familia agrupada. Regenera su enlace desde Familias antes de enviarlo.';
    } catch (error) { $('familyGroupError').textContent = errorText[error.message] || error.message || 'No se pudo agrupar.'; }
    finally { button.disabled = false; }
  });
  $('familySearch').addEventListener('input', renderFamilies); $('familyFilter').addEventListener('change', renderFamilies); $('memberSearch').addEventListener('input', renderMembers); document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => activate(button.dataset.view))); $('exportCsv').addEventListener('click', exportCsv); ['printA4','printA3','printA2'].forEach(id => $(id).addEventListener('click', () => window.print()));
  if (state.token) showDashboard();
})();
