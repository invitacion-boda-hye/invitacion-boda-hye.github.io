(() => {
  const loginSection = document.getElementById('adminLogin');
  const dashboard = document.getElementById('adminDashboard');
  const loginMessage = document.getElementById('loginMessage');
  const dashboardMessage = document.getElementById('dashboardMessage');
  const metrics = document.getElementById('adminMetrics');
  const familyList = document.getElementById('adminFamilyList');
  let accessToken = sessionStorage.getItem('rsvp-admin-access-token') || '';

  const errorMessages = {
    ADMIN_NOT_CONFIGURED: 'Falta configurar la clave publishable para habilitar el panel.',
    ADMIN_LOGIN_FAILED: 'No fue posible iniciar sesión con esas credenciales.',
    ADMIN_FORBIDDEN: 'Tu cuenta no está autorizada como administradora.',
    ADMIN_AUTH_REQUIRED: 'Tu sesión no es válida. Vuelve a iniciar sesión.',
    ADMIN_MEMBERSHIP_CHECK_FAILED: 'No fue posible verificar los permisos administrativos. Intenta nuevamente más tarde.',
    ORIGIN_NOT_ALLOWED: 'Este origen no está autorizado para usar el panel.',
    SERVER_CONFIGURATION_ERROR: 'La configuración segura del panel no está disponible todavía.',
    ADMIN_PASSES_EXCEED_CAPACITY: 'Los pases no pueden superar la capacidad total.',
    ADMIN_CAPACITY_BELOW_CONFIRMED: 'La capacidad no puede ser menor que los asistentes confirmados.',
    ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES: 'La capacidad no puede ser menor que los pases de una familia activa.',
    ADMIN_REACTIVATION_CAPACITY_EXCEEDED: 'No se puede reactivar esa invitación: supera la capacidad.'
  };
  const tell = (element, error) => {
    element.textContent = error ? (errorMessages[error.message] || 'No fue posible completar la operación.') : '';
    element.classList.toggle('is-error', Boolean(error));
  };

  function metric(label, value) {
    const card = document.createElement('div');
    const amount = document.createElement('strong');
    const caption = document.createElement('span');
    card.className = 'metric'; amount.textContent = String(value ?? 0); caption.textContent = label;
    card.append(amount, caption); return card;
  }
  function localDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 16);
  }
  function invitationState(invitation, response) {
    if (!invitation.is_active) return 'Revocada';
    if (invitation.rsvp_state === 'declined') return 'No asistirán';
    if (invitation.rsvp_state === 'attending') return 'Confirmada';
    return 'Pendiente';
  }
  function renderInvitations(invitations) {
    if (!invitations.length) {
      familyList.textContent = 'Aún no hay familias creadas.';
      return;
    }
    const rows = invitations.map((invitation) => {
      const response = Array.isArray(invitation.rsvp_responses) ? invitation.rsvp_responses[0] : null;
      const row = document.createElement('div');
      const details = document.createElement('div');
      const name = document.createElement('strong');
      const passes = document.createElement('span');
      const state = document.createElement('span');
      name.textContent = invitation.group_name;
      const confirmed = response?.is_attending ? Number(response.confirmed_count || 0) : 0;
      passes.textContent = `${confirmed} confirmado${confirmed === 1 ? '' : 's'} de ${invitation.max_passes} pase${invitation.max_passes === 1 ? '' : 's'}`;
      state.textContent = invitationState(invitation, response);
      row.className = 'admin-family'; state.className = 'admin-family-state';
      details.append(name, passes); row.append(details, state);
      return row;
    });
    familyList.replaceChildren(...rows);
  }
  async function loadDashboard() {
    const [summaryResult, invitationsResult] = await Promise.all([
      RSVP_API.adminRequest('summary', {}, accessToken),
      RSVP_API.adminRequest('listInvitations', {}, accessToken)
    ]);
    const summary = summaryResult.summary;
    metrics.replaceChildren(...[
      metric('Capacidad máxima', summary.capacity), metric('Pases asignados', summary.assignedPasses),
      metric('Personas confirmadas', summary.confirmedPeople), metric('Cupos disponibles', summary.availableCapacity),
      metric('Familias pendientes', summary.pendingFamilies), metric('Confirmaciones completas', summary.completeFamilies),
      metric('Confirmaciones parciales', summary.partialFamilies), metric('No asistirán', summary.declinedFamilies)
    ]);
    document.getElementById('eventCapacity').value = summary.capacity;
    document.getElementById('rsvpDeadline').value = localDate(summary.rsvpDeadline);
    renderInvitations(invitationsResult.invitations || []);
  }
  async function showDashboard() {
    try {
      await loadDashboard();
      loginSection.hidden = true;
      dashboard.hidden = false;
      tell(loginMessage);
    } catch (error) {
      accessToken = '';
      sessionStorage.removeItem('rsvp-admin-access-token');
      tell(loginMessage, error);
    }
  }

  document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    tell(loginMessage);
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const session = await RSVP_API.signIn(document.getElementById('adminEmail').value.trim(), document.getElementById('adminPassword').value);
      accessToken = session.access_token;
      sessionStorage.setItem('rsvp-admin-access-token', accessToken);
      event.currentTarget.reset();
      await showDashboard();
    } catch (error) { tell(loginMessage, error); }
    finally { button.disabled = false; }
  });
  document.getElementById('logoutButton').addEventListener('click', () => {
    accessToken = ''; sessionStorage.removeItem('rsvp-admin-access-token'); dashboard.hidden = true; loginSection.hidden = false;
  });
  document.getElementById('createInvitationForm').addEventListener('submit', async (event) => {
    event.preventDefault(); tell(dashboardMessage);
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const result = await RSVP_API.adminRequest('createInvitation', {
        groupName: document.getElementById('groupName').value.trim(), maxPasses: Number(document.getElementById('maxPasses').value)
      }, accessToken);
      document.getElementById('generatedLink').value = result.invitationUrl;
      document.getElementById('linkResult').hidden = false;
      event.currentTarget.reset();
      await loadDashboard();
    } catch (error) { tell(dashboardMessage, error); }
    finally { button.disabled = false; }
  });
  document.getElementById('copyLink').addEventListener('click', async () => {
    const field = document.getElementById('generatedLink');
    try { await navigator.clipboard.writeText(field.value); dashboardMessage.textContent = 'Enlace copiado.'; }
    catch { field.select(); dashboardMessage.textContent = 'Selecciona y copia el enlace manualmente.'; }
  });
  document.getElementById('settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault(); tell(dashboardMessage);
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const deadline = document.getElementById('rsvpDeadline').value;
      await RSVP_API.adminRequest('updateSettings', { capacity: Number(document.getElementById('eventCapacity').value), rsvpDeadline: deadline ? new Date(deadline).toISOString() : null }, accessToken);
      dashboardMessage.textContent = 'Configuración actualizada.';
      await loadDashboard();
    } catch (error) { tell(dashboardMessage, error); }
    finally { button.disabled = false; }
  });
  if (accessToken) showDashboard();
})();
