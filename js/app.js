/**
 * Lógica funcional de la invitación
 * Hector & Elisbe
 */

// ============================================================================
// EXPERIENCIA DEL SOBRE ANIMADO DE BIENVENIDA (ETAPA 2)
// ============================================================================
const envelopeScreen = document.getElementById('envelopeScreen');
const envelopeTrigger = document.getElementById('envelopeTrigger');

let isEnvelopeOpening = false;
const reduceEnvelopeMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function openEnvelopeSequence() {
  if (isEnvelopeOpening) return;
  isEnvelopeOpening = true;
  document.documentElement.classList.add('envelope-animating');
  envelopeTrigger?.setAttribute('disabled', '');

  // Se ejecuta directamente desde el gesto del invitado para que los navegadores
  // móviles permitan la reproducción. Si falla, el sobre continúa y el botón
  // flotante queda disponible para iniciar la música manualmente.
  if (audio?.paused) {
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(() => {});
    }
  }

  // Única secuencia de la apertura: los tiempos coinciden con el prototipo.
  const timing = reduceEnvelopeMotion
    ? { flap: 10, letter: 20, lift: 30, fade: 40, finish: 80 }
    : { flap: 200, letter: 700, lift: 1600, fade: 2300, finish: 3500 };

  envelopeTrigger?.classList.add('is-seal-released');

  setTimeout(() => {
    envelopeTrigger?.classList.add('is-flap-open');
  }, timing.flap);

  setTimeout(() => {
    envelopeTrigger?.classList.add('is-letter-out');
  }, timing.letter);

  setTimeout(() => {
    envelopeTrigger?.classList.add('is-lifting');
    envelopeScreen?.classList.add('is-lifting');
  }, timing.lift);

  setTimeout(() => {
    document.body.classList.add('overlay-fading', 'invitation-revealed');
    envelopeScreen?.classList.add('is-fading');
  }, timing.fade);

  setTimeout(() => {
    document.body.classList.remove('envelope-active');
    document.body.classList.remove('overlay-fading');
    envelopeScreen?.classList.add('is-hidden', 'opened');
    document.documentElement.classList.remove('envelope-animating');
    envelopeScreen?.setAttribute('aria-hidden', 'true');
    envelopeTrigger?.setAttribute('tabindex', '-1');
    startAutoTourAfterReveal();
  }, timing.finish);
}

if (envelopeTrigger) {
  envelopeTrigger.addEventListener('click', openEnvelopeSequence);
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
    const title = encodeURIComponent('Matrimonio de Hector & Elisbe');
    const dates = '20270109T153000/20270110T000000';
    const details = encodeURIComponent('Ceremonia religiosa · 15:30 hrs\nCapilla Inmaculada Corazón de María\nVolcán Michimavida 296–310, Puerto Montt\n\nCelebración · 17:40 hrs\nQuincho Ayuwun\nQuillaipe km 22, Carretera Austral, Puerto Montt');
    const location = encodeURIComponent('Capilla Inmaculada Corazón de María y Quincho Ayuwun, Puerto Montt, Chile');
    const calendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dates}&details=${details}&location=${location}&ctz=America%2FSantiago`;
    window.open(calendarUrl, '_blank', 'noopener');
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

// ============================================================================
// RECORRIDO AUTOMÁTICO — INDEPENDIENTE DE LA MÚSICA
// ============================================================================
let autoTourFrame = 0;
let autoTourStartTimer = 0;
let autoTourLastFrame = 0;
let autoTourActive = false;
let autoTourReady = false;
let autoTourFinished = false;
let autoTourScrolling = false;
let autoTourPosition = 0;
let autoTourHoldPointer = null;
let autoTourHolding = false;

function autoTourLimit() {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

function autoTourSpeed() {
  // La velocidad baja levemente sobre bloques de texto para que se puedan leer.
  const sections = [...document.querySelectorAll('main section, footer')];
  const currentSection = sections.find((section) => {
    const rect = section.getBoundingClientRect();
    return rect.top < window.innerHeight * .6 && rect.bottom > window.innerHeight * .35;
  });
  return currentSection?.classList.contains('alternate') ? 29.64 : 37.44;
}

function pauseAutoTour() {
  if (!autoTourActive) return;
  autoTourActive = false;
  cancelAnimationFrame(autoTourFrame);
  autoTourFrame = 0;
}

function finishAutoTour() {
  autoTourActive = false;
  autoTourFinished = true;
  cancelAnimationFrame(autoTourFrame);
  autoTourFrame = 0;
}

function runAutoTour(now) {
  if (!autoTourActive) return;

  const limit = autoTourLimit();
  if (window.scrollY >= limit - 1) {
    finishAutoTour();
    return;
  }

  const elapsed = Math.min(64, now - autoTourLastFrame) / 1000;
  autoTourLastFrame = now;
  autoTourPosition = Math.min(limit, autoTourPosition + autoTourSpeed() * elapsed);

  autoTourScrolling = true;
  window.scrollTo(0, autoTourPosition);
  requestAnimationFrame(() => { autoTourScrolling = false; });
  autoTourFrame = requestAnimationFrame(runAutoTour);
}

function resumeAutoTour() {
  if (reduceEnvelopeMotion || autoTourFinished || autoTourActive || autoTourHolding) return;
  if (window.scrollY >= autoTourLimit() - 1) {
    finishAutoTour();
    return;
  }
  autoTourActive = true;
  autoTourPosition = window.scrollY;
  autoTourLastFrame = performance.now();
  autoTourFrame = requestAnimationFrame(runAutoTour);
}

function startAutoTourAfterReveal() {
  if (reduceEnvelopeMotion || autoTourReady) return;
  autoTourReady = true;
  clearTimeout(autoTourStartTimer);
  // La portada permanece en calma dos segundos antes de iniciar el recorrido.
  autoTourStartTimer = window.setTimeout(resumeAutoTour, 2000);
}

function isInteractiveTourTarget(target) {
  return target instanceof Element && Boolean(target.closest(
    'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]'
  ));
}

// El recorrido se pausa exclusivamente durante una pulsación sostenida.
// Pointer Events cubre Android Chrome e iPhone Safari modernos; Touch Events
// queda como respaldo sin duplicar eventos cuando Pointer Events existe.
function beginAutoTourHold() {
  if (!autoTourReady || autoTourFinished || autoTourHolding) return;
  autoTourHolding = true;
  pauseAutoTour();
}

function endAutoTourHold() {
  if (!autoTourHolding) return;
  autoTourHolding = false;
  autoTourHoldPointer = null;
  resumeAutoTour();
}

if ('PointerEvent' in window) {
  document.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || isInteractiveTourTarget(event.target)) return;
    autoTourHoldPointer = event.pointerId;
    beginAutoTourHold();
  }, { passive: true });

  const releasePointerHold = (event) => {
    if (autoTourHoldPointer !== null && event.pointerId !== autoTourHoldPointer) return;
    endAutoTourHold();
  };
  window.addEventListener('pointerup', releasePointerHold, { passive: true });
  window.addEventListener('pointercancel', releasePointerHold, { passive: true });
} else {
  document.addEventListener('touchstart', (event) => {
    if (isInteractiveTourTarget(event.target)) return;
    beginAutoTourHold();
  }, { passive: true });
  window.addEventListener('touchend', endAutoTourHold, { passive: true });
  window.addEventListener('touchcancel', endAutoTourHold, { passive: true });
}


