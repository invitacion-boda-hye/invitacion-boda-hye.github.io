(() => {
  const box = document.getElementById('giftBox');
  if (!box || typeof RSVP_API === 'undefined') return;

  const experience = document.getElementById('giftExperience');
  const card = document.getElementById('giftCard');
  const backdrop = document.getElementById('giftBackdrop');
  const close = document.getElementById('giftClose');
  const form = document.getElementById('giftForm');
  const name = document.getElementById('giftGiverName');
  const message = document.getElementById('giftMessage');
  const sendMessage = document.getElementById('giftMessageSubmit');
  const status = document.getElementById('giftStatus');
  const bank = document.getElementById('giftBank');
  const copy = document.getElementById('copyBank');
  const copyStatus = document.getElementById('copyBankStatus');
  const transferSender = document.getElementById('transferSender');
  const transferDate = document.getElementById('transferDate');
  const reportTransfer = document.getElementById('reportTransfer');
  const transferStatus = document.getElementById('transferStatus');
  const token = new URLSearchParams(location.hash.slice(1)).get('i') || null;
  const bankText = 'Titular: Elisbe Sanchez\nBanco: BancoEstado\nTipo de cuenta: CuentaRUT\nNúmero de cuenta: 27299305\nRUT: 27.299.305-K\nCorreo: elisbesanchez@gmail.com';
  const errorMessages = { RATE_LIMITED: 'Espera unos minutos antes de intentar nuevamente.', GIFT_MESSAGE_INVALID: 'Escribe un mensaje de hasta 500 caracteres para enviarlo.', GIFT_TRANSFER_INVALID: 'Indica el nombre del remitente y la fecha de transferencia.', INVITATION_INVALID: 'El enlace de invitación ya no está disponible.' };
  const idKey = `gift-submission:${token || 'public'}`;
  const submissionId = (() => {
    const saved = sessionStorage.getItem(idKey);
    if (saved) return saved;
    const value = crypto.randomUUID();
    sessionStorage.setItem(idKey, value);
    return value;
  })();
  let returnFocus = null;

  function announce(target, value, isError = false) {
    target.textContent = value;
    target.classList.toggle('is-error', isError);
  }
  function openGift() {
    returnFocus = document.activeElement;
    experience.classList.add('is-open');
    box.setAttribute('aria-expanded', 'true');
    card.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('gift-dialog-open');
    name.focus({ preventScroll: true });
  }
  function closeGift() {
    experience.classList.remove('is-open');
    box.setAttribute('aria-expanded', 'false');
    card.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('gift-dialog-open');
    document.getElementById('giftIntro').hidden = false;
    bank.hidden = true;
    form.reset();
    [status, copyStatus, transferStatus].forEach((item) => announce(item, ''));
    (returnFocus instanceof HTMLElement ? returnFocus : box).focus({ preventScroll: true });
  }
  function openBank() {
    document.getElementById('giftIntro').hidden = true;
    bank.hidden = false;
    close.focus({ preventScroll: true });
  }
  async function submit(action, body, button, target) {
    button.disabled = true;
    try {
      const response = await RSVP_API.publicRequest({ action, token, submissionId, giverName: name.value.trim() || null, ...body });
      announce(target, response.status === 'transfer_reported' ? 'Gracias. Tu aviso quedó pendiente de verificación.' : 'Gracias por dejar tu dedicatoria.');
      return response;
    } catch (error) {
      announce(target, errorMessages[error.message] || 'No pudimos guardar tu información. Intenta nuevamente.', true);
      return null;
    } finally { button.disabled = false; }
  }

  box.addEventListener('click', openGift);
  close.addEventListener('click', closeGift);
  backdrop.addEventListener('click', closeGift);
  document.addEventListener('keydown', (event) => {
    if (card.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeGift(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary')]
      .filter((item) => item.getClientRects().length > 0);
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); openBank(); });
  sendMessage.addEventListener('click', async () => {
    const dedication = message.value.trim();
    if (!dedication) return announce(status, 'Escribe una dedicatoria antes de enviarla.', true);
    await submit('giftMessage', { message: dedication }, sendMessage, status);
  });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(bankText); announce(copyStatus, 'Datos bancarios copiados.'); }
    catch { announce(copyStatus, 'Selecciona los datos para copiarlos manualmente.', true); }
  });
  reportTransfer.addEventListener('click', async () => {
    const sender = transferSender.value.trim(); const date = transferDate.value;
    if (!sender || !date) return announce(transferStatus, errorMessages.GIFT_TRANSFER_INVALID, true);
    await submit('giftTransfer', { transferSender: sender, transferDate: date }, reportTransfer, transferStatus);
  });
})();
