import QRCode from 'qrcode';
import JSZip from 'jszip';
(() => {
  const $ = id => document.getElementById(id), notice = $('notice');
  let token = sessionStorage.getItem('rsvp-admin-access-token') || '', photos = [];
  const previewUrls = new Set();
  const endpoint = `${RSVP_CONFIG.supabaseUrl.replace(/\/$/, '')}/functions/v1/photo-album`;
  async function api(action, payload = {}) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: RSVP_CONFIG.publishableKey, Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, ...payload }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'NETWORK_ERROR'); error.status = response.status; throw error; }
    return data;
  }
  const explain = error => { notice.textContent = ({ ALBUM_INVALID_SETTINGS: 'Revisa las fechas y la cuota. La cuota debe cubrir las fotos y reservas existentes.', ADMIN_AUTH_REQUIRED: 'La sesión venció. Vuelve a ingresar.', ADMIN_FORBIDDEN: 'Esta cuenta no tiene acceso administrativo.' })[error.message] || 'No se pudo completar la operación. Revisa la conexión e inténtalo nuevamente.'; };
  const localDate = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
  async function load(reset = true) {
    const result = await api('list', { offset: reset ? 0 : photos.length });
    if (reset) { photos = []; const s = result.settings; $('enabled').checked = s.enabled; $('opens').value = localDate(s.opens_at); $('closes').value = localDate(s.closes_at); $('quota').value = s.quota_bytes ? s.quota_bytes / 1000000 : ''; }
    photos.push(...result.photos); $('more').hidden = result.photos.length < 100; render();
  }
  function bytes(base64) { const binary = atob(base64), output = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i); return output; }
  function save(blob, filename) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function render() {
    const list = $('photosList'); previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls.clear(); list.replaceChildren();
    if (!photos.length) { const p = document.createElement('p'); p.textContent = 'Aún no hay fotos.'; list.append(p); }
    for (const photo of photos) {
      const row = document.createElement('article'); row.className = 'family-row';
      const label = document.createElement('p'); label.textContent = `${photo.guest_name || 'Sin nombre'} · ${new Date(photo.confirmed_at).toLocaleString()} · ${(photo.actual_bytes / 1048576).toFixed(2)} MiB`;
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'mini-btn'; preview.textContent = 'Ver foto';
      let image = null, imageUrl = null;
      preview.onclick = async () => {
        if (image) { image.remove(); image = null; URL.revokeObjectURL(imageUrl); previewUrls.delete(imageUrl); imageUrl = null; preview.textContent = 'Ver foto'; return; }
        preview.disabled = true;
        try {
          const result = await api('download', { id: photo.id });
          if (!row.isConnected) return;
          imageUrl = URL.createObjectURL(new Blob([bytes(result.jpeg)], { type: 'image/jpeg' })); previewUrls.add(imageUrl);
          image = document.createElement('img'); image.src = imageUrl; image.alt = `Foto compartida por ${photo.guest_name || 'un invitado'}`; image.className = 'admin-photo-preview';
          row.append(image); preview.textContent = 'Ocultar foto';
        } catch (e) { explain(e); } finally { preview.disabled = false; }
      };
      const download = document.createElement('button'); download.className = 'mini-btn'; download.textContent = 'Descargar'; download.onclick = async () => { download.disabled = true; try { const result = await api('download', { id: photo.id }); save(new Blob([bytes(result.jpeg)], { type: 'image/jpeg' }), `${photo.id}.jpg`); } catch (e) { explain(e); } finally { download.disabled = false; } };
      const remove = document.createElement('button'); remove.className = 'mini-btn danger'; remove.textContent = 'Eliminar'; remove.onclick = async () => { if (!confirm('¿Eliminar esta foto definitivamente?')) return; remove.disabled = true; try { await api('delete', { id: photo.id }); await load(); notice.textContent = 'Foto eliminada.'; } catch (e) { explain(e); remove.disabled = false; } };
      row.append(label, preview, download, remove); list.append(row);
    }
  }
  async function show() { try { await load(); $('login').hidden = true; $('panel').hidden = false; } catch (e) { if (e.status === 401 || e.status === 403) { $('login').hidden = false; $('panel').hidden = true; } else { $('panel').hidden = false; explain(e); } } }
  $('loginForm').onsubmit = async event => { event.preventDefault(); try { token = (await RSVP_API.signIn($('email').value.trim(), $('password').value)).access_token; sessionStorage.setItem('rsvp-admin-access-token', token); $('loginForm').reset(); await show(); } catch { alert('No se pudo iniciar sesión.'); } };
  $('settings').onsubmit = async event => { event.preventDefault(); try { const quotaBytes = Math.round(Number($('quota').value) * 1000000); await api('configure', { enabled: $('enabled').checked, opensAt: new Date($('opens').value).toISOString(), closesAt: new Date($('closes').value).toISOString(), quotaBytes }); notice.textContent = 'Configuración guardada.'; await load(); } catch (e) { explain(e); } };
  $('refresh').onclick = () => load().catch(explain); $('more').onclick = () => load(false).catch(explain);
  $('cleanup').onclick = async () => { try { const r = await api('cleanup'); notice.textContent = `Limpieza: ${r.removed} cargas eliminadas, ${r.pending} pendientes de reintento.`; } catch (e) { explain(e); } };
  $('zip').onclick = async () => { const button = $('zip'); button.disabled = true; try { const zip = new JSZip(); for (let i = 0; i < photos.length; i++) { notice.textContent = `Preparando ${i + 1} de ${photos.length}…`; const result = await api('download', { id: photos[i].id }); zip.file(`${photos[i].id}.jpg`, bytes(result.jpeg)); } if (!photos.length) throw new Error('EMPTY'); save(await zip.generateAsync({ type: 'blob' }), 'fotos-boda.zip'); notice.textContent = 'Descarga preparada.'; } catch (e) { explain(e); } finally { button.disabled = false; } };
  $('albumUrl').value = new URL('./', location.href).href;
  $('makeQr').onclick = async () => { try { const url = new URL($('albumUrl').value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); await QRCode.toCanvas($('qr'), url.href, { width: 300, margin: 4, errorCorrectionLevel: 'M' }); $('downloadQr').href = $('qr').toDataURL('image/png'); $('downloadQr').hidden = false; } catch { notice.textContent = 'Ingresa una dirección HTTP o HTTPS válida.'; $('downloadQr').hidden = true; } };
  $('albumUrl').oninput = () => { $('downloadQr').hidden = true; };
  window.addEventListener('pagehide', event => { if (!event.persisted) { previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls.clear(); } });
  if (token) show(); else $('login').hidden = false;
})();
