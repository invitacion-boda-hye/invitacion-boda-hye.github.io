(() => {
  const form = document.getElementById('rsvp');
  if (!form) return;

  const elements = {
    loading: document.getElementById('rsvpLoading'), noLink: document.getElementById('rsvpNoLink'),
    error: document.getElementById('rsvpError'), experience: document.getElementById('rsvpExperience'),
    groupName: document.getElementById('rsvpGroupName'), passes: document.getElementById('rsvpPasses'),
    attendingFields: document.getElementById('rsvpAttendingFields'), people: document.getElementById('people'),
    attendees: document.getElementById('attendeeFields'), comment: document.getElementById('message'),
    warning: document.getElementById('rsvpCommentWarning'), submit: document.getElementById('rsvpSubmit'),
    help: document.getElementById('rsvpHelp'), thanks: document.getElementById('rsvpThanks')
  };
  let invitation = null;
  let token = '';

  const messages = {
    INVITATION_INVALID: 'Este enlace de invitación no es válido o fue revocado.',
    RSVP_DEADLINE_PASSED: 'El plazo de confirmación ya finalizó. Si necesitas ayuda, comunícate con los novios.',
    RSVP_CAPACITY_EXCEEDED: 'Por el momento no quedan cupos suficientes para esta confirmación.',
    RSVP_PASSES_EXCEEDED: 'La cantidad indicada supera los pases asignados a tu familia.',
    RSVP_COUNT_MISMATCH: 'Revisa que la cantidad elegida coincida con los nombres ingresados.',
    RSVP_ATTENDEE_NAME_INVALID: 'Ingresa nombre y apellido para cada asistente.',
    RATE_LIMITED: 'Hiciste varios intentos. Espera unos minutos antes de volver a intentarlo.',
    RSVP_NOT_CONFIGURED: 'La confirmación estará disponible muy pronto.'
  };

  function pauseTourForRsvp() {
    if (typeof pauseAutoTour === 'function') pauseAutoTour();
  }

  function showError(code) {
    elements.error.textContent = messages[code] || 'No pudimos procesar tu confirmación. Intenta nuevamente.';
    elements.error.hidden = false;
  }

  function selectedAttendance() {
    return form.querySelector('input[name="attendance"]:checked')?.value || '';
  }

  function populatePeople(count) {
    elements.people.innerHTML = '';
    for (let amount = 1; amount <= count; amount += 1) {
      const option = document.createElement('option');
      option.value = String(amount);
      option.textContent = `${amount} ${amount === 1 ? 'persona' : 'personas'}`;
      elements.people.append(option);
    }
  }

  function renderAttendees(count, saved = []) {
    elements.attendees.innerHTML = '';
    for (let index = 0; index < count; index += 1) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `attendee-${index}`;
      input.maxLength = 160;
      input.required = true;
      input.autocomplete = 'name';
      input.placeholder = 'Nombre y apellido';
      input.value = saved[index]?.fullName || '';
      label.textContent = `Asistente ${index + 1}`;
      label.append(input);
      elements.attendees.append(label);
    }
  }

  function applyAttendanceState() {
    const attending = selectedAttendance() === 'yes';
    elements.attendingFields.hidden = !attending;
    elements.submit.textContent = attending ? 'Confirmar nuestra asistencia' : 'Enviar respuesta';
    if (attending && !elements.attendees.children.length) renderAttendees(Number(elements.people.value || 1));
  }

  function applyInvitation(data) {
    invitation = data;
    const { invitation: group, response } = data;
    elements.groupName.textContent = group.groupName;
    elements.passes.textContent = `Esta invitación incluye hasta ${group.maxPasses} ${group.maxPasses === 1 ? 'persona' : 'personas'}.`;
    populatePeople(group.maxPasses);
    if (response) {
      const choice = form.querySelector(`input[name="attendance"][value="${response.isAttending ? 'yes' : 'no'}"]`);
      if (choice) choice.checked = true;
      elements.people.value = String(response.confirmedCount || 1);
      elements.comment.value = response.comment || '';
      renderAttendees(response.confirmedCount || 1, response.attendees || []);
    } else {
      renderAttendees(1);
    }
    applyAttendanceState();
    if (!group.canModify) {
      form.querySelectorAll('input, select, textarea, button').forEach((field) => { field.disabled = true; });
      elements.help.textContent = 'El plazo de confirmación ya finalizó.';
    }
    elements.loading.hidden = true;
    elements.experience.hidden = false;
  }

  function commentNeedsReview(comment, count) {
    const numbers = [...comment.matchAll(/\b(?:[0-9]{1,3}|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/giu)]
      .map((match) => match[0].toLowerCase());
    return numbers.some((value) => value !== String(count) && value !== (count === 1 ? 'uno' : ''));
  }

  async function loadInvitation() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    token = fragment.get('i') || '';
    if (!token) {
      elements.loading.hidden = true;
      elements.noLink.hidden = false;
      return;
    }
    try {
      const result = await RSVP_API.publicRequest({ action: 'resolve', token });
      applyInvitation(result.invitation);
    } catch (error) {
      elements.loading.hidden = true;
      showError(error.message);
    }
  }

  form.addEventListener('change', (event) => {
    pauseTourForRsvp();
    if (event.target.name === 'attendance') applyAttendanceState();
    if (event.target === elements.people) renderAttendees(Number(elements.people.value));
  });
  form.addEventListener('focusin', pauseTourForRsvp);
  form.addEventListener('pointerdown', pauseTourForRsvp);

  elements.comment.addEventListener('input', () => {
    const count = Number(elements.people.value || 0);
    const needsReview = selectedAttendance() === 'yes' && commentNeedsReview(elements.comment.value, count);
    elements.warning.hidden = !needsReview;
    elements.warning.textContent = needsReview
      ? `La cantidad oficial será ${count}. Revisa el comentario antes de enviar si menciona otro número.`
      : '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    pauseTourForRsvp();
    elements.error.hidden = true;
    const isAttending = selectedAttendance() === 'yes';
    if (!selectedAttendance()) return showError('RSVP_PAYLOAD_INVALID');
    const confirmedCount = isAttending ? Number(elements.people.value) : 0;
    const attendees = isAttending
      ? [...elements.attendees.querySelectorAll('input')].map((input) => ({ full_name: input.value.trim() }))
      : [];
    if (isAttending && attendees.some((attendee) => !/\S+\s+\S+/.test(attendee.full_name))) {
      return showError('RSVP_ATTENDEE_NAME_INVALID');
    }
    elements.submit.disabled = true;
    elements.submit.textContent = 'Guardando…';
    try {
      const result = await RSVP_API.publicRequest({
        action: 'submit', token, isAttending, confirmedCount, attendees, comment: elements.comment.value.trim() || null
      });
      applyInvitation(result.invitation);
      const response = result.invitation.response;
      const title = document.createElement('strong');
      const detail = document.createElement('span');
      if (response.isAttending) {
        title.textContent = '¡Gracias por confirmar!';
        detail.textContent = `Nos llena de alegría saber que nos acompañarán. Registramos: ${response.attendees.map((item) => item.fullName).join(', ')}.`;
      } else {
        title.textContent = 'Gracias por responder.';
        detail.textContent = 'Los llevaremos con cariño en este día tan especial.';
      }
      elements.thanks.replaceChildren(title, detail);
      elements.thanks.hidden = false;
    } catch (error) {
      showError(error.message);
    } finally {
      elements.submit.disabled = false;
      applyAttendanceState();
    }
  });

  loadInvitation();
})();
