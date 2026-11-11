/**
 * Lógica funcional de la invitación
 * Elisbe & Hector
 */

// ============================================================================
// EXPERIENCIA DEL SOBRE ANIMADO DE BIENVENIDA (ETAPA 2)
// ============================================================================
const envelopeScreen = document.getElementById('envelopeScreen');
const envelopeTrigger = document.getElementById('envelopeTrigger');
const envelopePrompt = document.getElementById('envelopePrompt');

let isEnvelopeOpening = false;
const reduceEnvelopeMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function openEnvelopeSequence() {
  if (isEnvelopeOpening) return;
  isEnvelopeOpening = true;
  envelopeTrigger?.setAttribute('disabled', '');
  envelopePrompt?.setAttribute('tabindex', '-1');

  // Se ejecuta directamente desde el gesto del invitado para que los navegadores
  // móviles permitan la reproducción. Si falla, el sobre continúa y el botón
  // flotante queda disponible para iniciar la música manualmente.
  if (audio?.paused) {
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(() => {});
    }
  }

  // Secuencia cinematográfica (6,5 s): magia, solapa, tarjeta y portada.
  // Para quien prefiere menos movimiento se mantienen los mismos estados,
  // pero se presentan casi de inmediato.
  const timing = reduceEnvelopeMotion
    ? { release: 20, flap: 30, letter: 45, focus: 60, reveal: 75, finish: 90 }
    : { release: 800, flap: 1000, letter: 2500, focus: 4500, reveal: 5450, finish: 6500 };

  envelopeScreen.classList.add('step-magic');

  setTimeout(() => {
    envelopeScreen.classList.add('step-seal-release');
  }, timing.release);

  setTimeout(() => {
    envelopeScreen.classList.add('step-flap-open');
  }, timing.flap);

  setTimeout(() => {
    envelopeScreen.classList.add('step-letter-out');
  }, timing.letter);

  setTimeout(() => {
    envelopeScreen.classList.add('step-card-focus');
  }, timing.focus);

  setTimeout(() => {
    document.body.classList.add('invitation-revealed');
    envelopeScreen.classList.add('step-hero-reveal', 'opened');
  }, timing.reveal);

  setTimeout(() => {
    envelopeScreen.classList.add('opened');
    document.body.classList.remove('envelope-active');

    // Desactivamos completamente de accesibilidad para que no interfiera en la navegación
    envelopeScreen.setAttribute('aria-hidden', 'true');
    envelopeTrigger?.setAttribute('tabindex', '-1');
  }, 2920);
}

if (envelopeTrigger) {
  envelopeTrigger.addEventListener('click', openEnvelopeSequence);
  envelopeTrigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEnvelopeSequence();
    }
  });
}

if (envelopePrompt) {
  envelopePrompt.addEventListener('click', openEnvelopeSequence);
  envelopePrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEnvelopeSequence();
    }
  });
}

// Ruta de previsualización para control visual local: no altera la experiencia
// normal de los invitados ni intenta reproducir audio sin un gesto del usuario.
if (new URLSearchParams(window.location.search).get('preview') === 'open') {
  envelopeScreen?.classList.add('opened');
  envelopeScreen?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('envelope-active');
  document.body.classList.add('invitation-revealed');
  document.body.classList.add('qa-preview-open');
}

// ============================================================================
// CUENTA REGRESIVA
// ============================================================================
function tick() {
  const targetDate = new Date(CONFIG.fecha);
  const now = new Date();
  const diff = Math.max(0, targetDate - now);

  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000) % 24;
  const m = Math.floor(diff / 60000) % 60;
  const s = Math.floor(diff / 1000) % 60;

  const units = { days: d, hours: h, minutes: m, seconds: s };
  for (const [id, v] of Object.entries(units)) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = String(v).padStart(2, '0');
    }
  }
}
tick();
setInterval(tick, 1000);

// ============================================================================
// ANIMACIÓN DE APARICIÓN AL HACER SCROLL (IntersectionObserver)
// ============================================================================
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  },
  { threshold: 0.1 }
);

document.querySelectorAll('.reveal').forEach((e) => observer.observe(e));

// ============================================================================
// ENLACES A GOOGLE MAPS CONDICIONALES
// ============================================================================
const mapLinks = [
  ['ceremonyMap', CONFIG.ceremoniaMaps],
  ['partyMap', CONFIG.recepcionMaps]
];

for (const [id, url] of mapLinks) {
  if (url) {
    const el = document.getElementById(id);
    if (el) {
      el.href = url;
      el.hidden = false;
    }
  }
}

// ============================================================================
// DATOS BANCARIOS Y FUNCIÓN DE COPIADO
// ============================================================================
if (CONFIG.datosBancarios) {
  const bankDetailsEl = document.getElementById('bankDetails');
  const copyBtn = document.getElementById('copyBank');
  if (bankDetailsEl) {
    bankDetailsEl.textContent = CONFIG.datosBancarios;
  }
  if (copyBtn) {
    copyBtn.disabled = false;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(CONFIG.datosBancarios);
        copyBtn.textContent = '¡Datos copiados!';
      } catch {
        alert('Selecciona los datos para copiarlos.');
      }
    };
  }
}

// ============================================================================
// AGREGAR AL CALENDARIO DE GOOGLE
// ============================================================================
const calendarBtn = document.getElementById('calendar');
if (calendarBtn) {
  calendarBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const title = encodeURIComponent('Matrimonio de Elisbe y Hector');
    const dates = '20270109/20270110';
    const details = encodeURIComponent('Celebración de nuestro matrimonio. Horarios por confirmar.');
    const location = encodeURIComponent('Capilla Inmaculada Corazón de María / Quincho Ayuwun, Puerto Montt');
    const calendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&details=${details}&location=${location}`;
    window.open(calendarUrl, '_blank', 'noopener');
  });
}

// ============================================================================
// FORMULARIO DE CONFIRMACIÓN (RSVP) VÍA WHATSAPP
// ============================================================================
const rsvpForm = document.getElementById('rsvp');
if (rsvpForm) {
  rsvpForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('guest').value.trim();
    const attendance = document.getElementById('attendance').value;
    const people = document.getElementById('people').value;
    const message = document.getElementById('message').value.trim();

    if (!name || !attendance) return;

    const txt = `Confirmación de matrimonio - Elisbe y Hector\nNombre: ${name}\nAsistencia: ${attendance}\nNúmero de personas: ${attendance === 'Sí' ? people : '0'}\nMensaje: ${message || 'Sin mensaje'}`;

    if (!CONFIG.telefonoWhatsApp) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(txt)
          .then(() => alert('Confirmación copiada. Configura el número de WhatsApp para habilitar el envío directo.'))
          .catch(() => prompt('Copia este mensaje:', txt));
      } else {
        prompt('Copia este mensaje:', txt);
      }
      return;
    }

    const cleanPhone = CONFIG.telefonoWhatsApp.replace(/\D/g, '');
    window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(txt)}`, '_blank', 'noopener');
  });
}

// ============================================================================
// REPRODUCCIÓN DE MÚSICA DE FONDO (Requiere interacción explícita)
// ============================================================================
const audio = document.getElementById('music');
const mb = document.getElementById('musicButton');
const toastEl = document.getElementById('musicToast');
let toastTimer = null;

function showToast(message, duration = 3200) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, duration);
}

if (audio && mb) {
  // Volumen suave inicial (aprox. 35%)
  audio.volume = 0.35;

  // Ruta desde configuración
  if (CONFIG.musica) {
    const source = audio.querySelector('source');
    if (source) {
      source.src = CONFIG.musica;
      audio.load();
    }
  }

  // Sincronización de estado cuando se reproduce
  audio.addEventListener('play', () => {
    mb.classList.add('is-playing');
    mb.setAttribute('aria-label', 'Pausar música');
    mb.setAttribute('title', 'Pausar música');
    showToast('♫ Reproduciendo música');
  });

  // Sincronización de estado cuando se pausa
  audio.addEventListener('pause', () => {
    mb.classList.remove('is-playing');
    mb.setAttribute('aria-label', 'Reproducir música');
    mb.setAttribute('title', 'Reproducir música');
    showToast('❚❚ Música pausada');
  });

  // Manejo de error si el archivo no existe o no se puede cargar
  audio.addEventListener('error', () => {
    mb.classList.remove('is-playing');
    showToast('Archivo de música no encontrado en assets/musica.mp3');
  });

  // Alternar reproducción y pausa al tocar el botón
  mb.addEventListener('click', async () => {
    if (!audio.paused) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch (err) {
        showToast('Coloca tu canción en assets/musica.mp3');
      }
    }
  });
}


