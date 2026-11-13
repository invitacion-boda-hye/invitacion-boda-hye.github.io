(() => {
  const box = document.getElementById('giftBox');
  if (!box || typeof RSVP_API === 'undefined') return;

  const experience = document.getElementById('giftExperience');
  const card = document.getElementById('giftCard');
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
  const familyRef = document.getElementById('giftFamilyRef');
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
  let familyResolved = false;

  function announce(target, value, isError = false) {
    target.textContent = value;
    target.classList.toggle('is-error', isError);
  }
  async function loadFamilyReference() {
    if (familyResolved || !token) return;
    familyResolved = true;
    try {
      const result = await RSVP_API.publicRequest({ action: 'resolve', token });
      const groupName = result?.invitation?.invitation?.groupName;
      if (groupName) { familyRef.textContent = `Invitación asociada a: ${groupName}.`; familyRef.hidden = false; }
    } catch { /* La referencia es opcional y nunca bloquea el regalo. */ }
  }
  function openGift() {
    experience.classList.add('is-open');
    box.setAttribute('aria-expanded', 'true');
    card.hidden = false;
    loadFamilyReference();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) card.querySelector('h3')?.focus?.({ preventScroll: true });
  }
  function openBank() {
    document.getElementById('giftIntro').hidden = true;
    bank.hidden = false;
    bank.querySelector('h3')?.focus?.({ preventScroll: true });
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
