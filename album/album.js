import { preparePhoto } from './photo-processing.js';
(() => {
  'use strict';
  const input = document.getElementById('photos'), previews = document.getElementById('previews');
  const message = document.getElementById('message'), form = document.getElementById('albumForm');
  const button = form.querySelector('button[type=submit]');
  let selected = [], open = false, busy = false;
  const endpoint = `${RSVP_CONFIG.supabaseUrl.replace(/\/$/, '')}/functions/v1/photo-album`;
  async function request(payload) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: RSVP_CONFIG.publishableKey }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'NETWORK_ERROR');
    return data;
  }
  function render() {
    previews.replaceChildren(); button.disabled = !open || busy || !selected.length; input.disabled = !open || busy;
    for (const item of selected) {
      const card = document.createElement('div'); card.className = 'preview';
      const img = document.createElement('img'); img.src = item.url; img.alt = item.file.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.disabled = busy; remove.textContent = '×'; remove.setAttribute('aria-label', `Quitar ${item.file.name}`);
      remove.addEventListener('click', () => { URL.revokeObjectURL(item.url); selected = selected.filter(value => value !== item); render(); });
      card.append(img, remove); previews.append(card);
    }
  }
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []); input.value = ''; busy = true; render();
    let failed = 0; const available = Math.max(0, 10 - selected.length);
    for (const file of files.slice(0, available)) {
      try { const blob = await preparePhoto(file); selected.push({ file, blob, id: crypto.randomUUID(), url: URL.createObjectURL(blob) }); }
      catch { failed++; }
    }
    busy = false; render();
    message.textContent = failed ? 'No pudimos preparar algunas fotos. Inténtalo nuevamente.' : files.length > available ? 'Puedes compartir hasta 10 fotos a la vez.' : 'Fotos listas para compartir.';
  });
  function base64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!open || busy || !selected.length) return;
    busy = true; render(); let sent = 0;
    try {
      const name = document.getElementById('guestName').value.trim();
      for (const item of [...selected]) {
        message.textContent = `Compartiendo foto ${sent + 1} de ${selected.length + sent}…`;
        item.name ??= name;
        await request({ action: 'upload', id: item.id, name: item.name, jpeg: await base64(item.blob) });
        URL.revokeObjectURL(item.url); selected = selected.filter(value => value !== item); sent++;
      }
      message.textContent = '¡Gracias! Tus fotos fueron compartidas.';
    } catch (error) {
      message.textContent = error.message === 'RATE_LIMITED' ? 'Has enviado muchas fotos. Espera unos minutos y vuelve a intentarlo.' : 'No pudimos compartir todas las fotos. Las pendientes permanecen aquí para reintentarlas.';
    } finally { busy = false; render(); }
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) selected.forEach(item => URL.revokeObjectURL(item.url)); });
  request({ action: 'status' }).then(result => { open = result.open === true; message.textContent = open ? 'Selecciona hasta 10 fotos para compartir.' : 'El álbum aún no está disponible.'; render(); }).catch(() => { message.textContent = 'No pudimos consultar el álbum. Recarga la página para intentarlo nuevamente.'; render(); });
  render();
})();
