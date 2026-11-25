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
  const port = 19334 + (process.pid % 10000);
  const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=/tmp/album-browser-${process.pid}`], { stdio: 'ignore' });
  let client;
  try {
    const [target] = await chromeEndpoint(port); client = connect(target.webSocketDebuggerUrl); await client.ready;
    await client.send('Page.enable'); await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.albumRequests=[]; window.fetch=async (url, options)=> { const body=JSON.parse(options.body); window.albumRequests.push(body); if (body.action==='status') return new Response(JSON.stringify({open:true}),{status:200}); if (body.action==='upload' || body.action==='configure') return new Response(JSON.stringify({ok:true}),{status:200}); if(body.action==='download') return new Response(JSON.stringify({jpeg:document.createElement('canvas').toDataURL('image/jpeg').split(',')[1]}),{status:200}); if(body.action==='list') return new Response(JSON.stringify({settings:{enabled:true,opens_at:'2027-01-09T03:00:00Z',closes_at:'2027-01-17T03:00:00Z',quota_bytes:800000000},photos:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',guest_name:'Invitado',confirmed_at:'2027-01-10T03:00:00Z',actual_bytes:100}]}),{status:200}); throw Error('unexpected'); };` });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/album/index.html` });
    await wait(1200);
    let state = await client.send('Runtime.evaluate', { expression: `JSON.stringify({disabled:document.querySelector('#photos').disabled, message:document.querySelector('#message').textContent})`, returnByValue: true });
    assert.equal(JSON.parse(state.result.value).disabled, false);
    await client.send('Runtime.evaluate', { expression: `(async()=> { const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,40,40);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'prueba.png',{type:'image/png'}));const input=document.querySelector('#photos');input.files=transfer.files;input.dispatchEvent(new Event('change')); })()`, awaitPromise: true });
    await wait(500);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify({count:document.querySelectorAll('.preview').length,disabled:document.querySelector('button[type=submit]').disabled})`, returnByValue: true });
    assert.deepEqual(JSON.parse(state.result.value), { count: 1, disabled: false });
    await client.send('Runtime.evaluate', { expression: `window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));` });
    state = await client.send('Runtime.evaluate', { expression: `(async()=>{const image=new Image();image.src=document.querySelector('.preview img').src;try{await image.decode();return image.naturalWidth>0}catch{return false}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(state.result.value, true);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('#albumForm').requestSubmit()` }); await wait(500);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify({count:document.querySelectorAll('.preview').length,message:document.querySelector('#message').textContent,uploads:window.albumRequests.filter(r=>r.action==='upload').length,jpeg:window.albumRequests.find(r=>r.action==='upload')?.jpeg.startsWith('/9j/')})`, returnByValue: true });
    const result=JSON.parse(state.result.value); assert.equal(result.count,0); assert.match(result.message,/Gracias/); assert.equal(result.uploads,1); assert.equal(result.jpeg,true);
    await client.send('Runtime.evaluate', { expression: `sessionStorage.setItem('rsvp-admin-access-token','test-admin')` });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/album/admin.html` });
    await wait(800);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify({panel:!document.querySelector('#panel').hidden,quota:document.querySelector('#quota').value})`, returnByValue: true });
    assert.deepEqual(JSON.parse(state.result.value), {panel:true,quota:'800'});
    await client.send('Runtime.evaluate', { expression: `document.querySelector('#photosList button').click()` });
    await wait(300);
    state = await client.send('Runtime.evaluate', { expression: `(async()=>{const image=document.querySelector('.admin-photo-preview');if(!image)return false;try{await image.decode();return image.naturalWidth>0}catch{return false}})()`, awaitPromise:true, returnByValue:true });
    assert.equal(state.result.value, true);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('#photosList button').click()` });
    state = await client.send('Runtime.evaluate', { expression: `document.querySelector('.admin-photo-preview')===null`, returnByValue:true });
    assert.equal(state.result.value, true);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('#albumUrl').value='https://example.test/album/'; document.querySelector('#makeQr').click();` });
    await wait(300);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify({visible:!document.querySelector('#downloadQr').hidden,image:document.querySelector('#downloadQr').href.startsWith('data:image/png')})`, returnByValue:true });
    assert.deepEqual(JSON.parse(state.result.value), {visible:true,image:true});
    if (process.env.ALBUM_QR_DECODER_DIR) {
      const image = await client.send('Runtime.evaluate', { expression: `document.querySelector('#downloadQr').href`, returnByValue:true });
      const {PNG} = require(process.env.ALBUM_QR_DECODER_DIR + '/pngjs');
      const decode = require(process.env.ALBUM_QR_DECODER_DIR + '/jsqr');
      const png = PNG.sync.read(Buffer.from(image.result.value.split(',')[1], 'base64'));
      const decoded = decode(new Uint8ClampedArray(png.data), png.width, png.height);
      assert.equal(decoded?.data, 'https://example.test/album/');
    }

    await client.send('Runtime.evaluate', { expression: `document.querySelector('#settings').requestSubmit();` });
    await wait(300);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify(window.albumRequests.find(x=>x.action==='configure'))`, returnByValue:true });
    assert.equal(JSON.parse(state.result.value).quotaBytes,800000000);
    await client.send('Runtime.evaluate', { expression: `document.querySelector('#quota').value='20';document.querySelector('#settings').requestSubmit();` });
    await wait(300);
    state = await client.send('Runtime.evaluate', { expression: `JSON.stringify(window.albumRequests.filter(x=>x.action==='configure').at(-1))`, returnByValue:true });
    assert.equal(JSON.parse(state.result.value).quotaBytes,20000000);
    console.log('OK: envío móvil, configuración administrativa y QR con servicios simulados.');
  } finally { client?.close(); chrome.kill('SIGTERM'); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
