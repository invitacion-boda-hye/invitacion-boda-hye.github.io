/*
 * Regresión Android: tras abrir el sobre, el documento vuelve a poder
 * desplazarse con un gesto táctil. No requiere dependencias de npm; usa el
 * Chrome local mediante el protocolo DevTools.
 */
const assert = require('node:assert/strict');
const { createReadStream, existsSync } = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { join, normalize, extname } = require('node:path');

const root = process.cwd();
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.mp3': 'audio/mpeg', '.png': 'image/png', '.webp': 'image/webp' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serve() {
  const server = http.createServer((request, response) => {
    const pathname = normalize(new URL(request.url, 'http://localhost').pathname).replace(/^([/\\])+/, '');
    const file = join(root, pathname || 'index.html');
    if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const messageId = ++id;
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function chromeEndpoint(port) {
  for (let attempts = 0; attempts < 80; attempts += 1) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await wait(50); }
  }
  throw new Error('Chrome no inició el protocolo DevTools');
}

async function main() {
  const server = await serve();
  const site = `http://127.0.0.1:${server.address().port}/index.html`;
  const debugPort = 9333;
  const chrome = spawn('google-chrome', [
    '--headless=new', `--remote-debugging-port=${debugPort}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--user-data-dir=/tmp/invitacion-envelope-scroll-${process.pid}`,
  ], { stdio: 'ignore' });

  let client;
  try {
    const [target] = await chromeEndpoint(debugPort);
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.75, mobile: true });
    await client.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' });
    await client.send('Page.navigate', { url: site });
    await wait(700);
    await client.send('Runtime.evaluate', { expression: "document.getElementById('envelopeTrigger').click()" });
    await wait(3700); // Mantiene los 3,5 s de la apertura aprobada.

    const state = await client.send('Runtime.evaluate', { expression: `JSON.stringify((() => ({
      bodyLocked: document.body.classList.contains('envelope-active'),
      htmlLocked: document.documentElement.classList.contains('envelope-animating'),
      overlayDisplay: getComputedStyle(document.getElementById('envelopeScreen')).display,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
      canScroll: document.documentElement.scrollHeight > innerHeight
    }))())`, returnByValue: true });
    const afterOpen = JSON.parse(state.result.value);
    assert.equal(afterOpen.bodyLocked, false, 'la clase que bloquea el body debe retirarse');
    assert.equal(afterOpen.htmlLocked, false, 'la clase que bloquea html debe retirarse');
    assert.equal(afterOpen.overlayDisplay, 'none', 'la capa fija invisible no debe capturar el gesto');
    assert.notEqual(afterOpen.bodyOverflowY, 'hidden', 'body no debe seguir con overflow oculto');
    assert.notEqual(afterOpen.htmlOverflowY, 'hidden', 'html no debe seguir con overflow oculto');
    assert.equal(afterOpen.canScroll, true, 'la invitación debe tener contenido desplazable');

    await wait(2200); // El recorrido automático ya está activo: reproduce el caso Android real.
    await client.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 720, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 180, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(300);
    const scroll = await client.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true });
    assert.ok(scroll.result.value > 100, `el gesto táctil debe desplazar la página (scrollY=${scroll.result.value})`);
    console.log('OK: Android emulado abre el sobre y permite desplazar con el dedo.');
  } finally {
    client?.close();
    chrome.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
