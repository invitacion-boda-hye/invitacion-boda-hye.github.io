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
const { randomUUID, randomBytes } = require('node:crypto');

const root = process.cwd();
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.mp3': 'audio/mpeg', '.png': 'image/png', '.webp': 'image/webp' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serve() {
  const server = http.createServer((request, response) => {
    const pathname = normalize(new URL(request.url, 'http://localhost').pathname).replace(/^([/\\])+/, '');
    if (pathname === 'js/rsvp-config.js') { response.writeHead(200, {'content-type':'text/javascript'}).end(`const RSVP_CONFIG = Object.freeze(${JSON.stringify({supabaseUrl:process.env.ALBUM_LOCAL_SUPABASE_URL,publishableKey:process.env.ALBUM_LOCAL_ANON_KEY,adminFunction:'admin-rsvp'})});`); return; }
    const file = join(root, pathname || 'index.html');
    if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(55555, '127.0.0.1', () => resolve(server)));
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
  if (process.env.ALBUM_DISPOSABLE_SUPABASE !== 'yes') { console.log('SKIP: Supabase local desechable no configurado.'); return; }
  const base = new URL(process.env.ALBUM_LOCAL_SUPABASE_URL);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(base.hostname) && ['http:','https:'].includes(base.protocol) && !base.username && !base.password);
  const anon = process.env.ALBUM_LOCAL_ANON_KEY, service = process.env.ALBUM_LOCAL_SERVICE_KEY; assert.ok(anon && service);
  async function req(path, {method='GET', body, token=service, key=service, expected=[200]} = {}) {
    const response = await fetch(base.origin+path, {method, redirect:'error', headers:{apikey:key,Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text(); let data; try {data=JSON.parse(text)} catch {data=text};
    assert.ok(expected.includes(response.status), `${method} ${path.split('?')[0]}: ${response.status}`); return data;
  }
  const existing=await req('/rest/v1/photo_album_uploads?select=id&limit=1'); assert.equal(existing.length,0, 'Usar un álbum vacío y desechable');
  const settings=(await req('/rest/v1/photo_album_settings?select=enabled,opens_at,closes_at,quota_bytes&id=eq.true'))[0];
  const email=`album-browser-${randomUUID()}@example.test`, password=`A-${randomBytes(18).toString('hex')}!`;
  let userId, token, server, chrome, client;
  try {
    const user=await req('/auth/v1/admin/users',{method:'POST',body:{email,password,email_confirm:true},expected:[200,201]});userId=user.id;
    await req('/rest/v1/rsvp_admins',{method:'POST',body:{user_id:userId},expected:[201,204]});
    token=(await req('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password},token:anon,key:anon})).access_token;
    await req('/functions/v1/photo-album',{method:'POST',token,key:anon,body:{action:'configure',enabled:true,opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString(),quotaBytes:4194304}});
    server=await serve(); const port=19334+(process.pid%10000);
    chrome=spawn('google-chrome',['--headless=new',`--remote-debugging-port=${port}`,'--no-first-run','--no-sandbox','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',`--user-data-dir=/tmp/album-real-browser-${process.pid}`],{stdio:'ignore'});
    const [target]=await chromeEndpoint(port);client=connect(target.webSocketDebuggerUrl);await client.ready;await client.send('Page.enable');await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await client.send('Page.navigate',{url:'http://127.0.0.1:55555/album/index.html'});await wait(1200);
    let state=await client.send('Runtime.evaluate',{expression:`JSON.stringify({disabled:document.querySelector('#photos').disabled,message:document.querySelector('#message').textContent})`,returnByValue:true});
    assert.equal(JSON.parse(state.result.value).disabled,false, state.result.value);
    await client.send('Runtime.evaluate',{expression:`(async()=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,40,40);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'prueba.png',{type:'image/png'}));const input=document.querySelector('#photos');input.files=transfer.files;input.dispatchEvent(new Event('change'));})()`,awaitPromise:true});
    await wait(500);await client.send('Runtime.evaluate',{expression:`document.querySelector('#guestName').value='Prueba navegador';document.querySelector('#albumForm').requestSubmit();`});await wait(1500);
    state=await client.send('Runtime.evaluate',{expression:`document.querySelector('#message').textContent`,returnByValue:true});assert.match(state.result.value,/Gracias/,state.result.value);
    const photos=await req('/rest/v1/photo_album_uploads?select=id,guest_name,state');assert.equal(photos.length,1);assert.equal(photos[0].state,'ready');assert.equal(photos[0].guest_name,'Prueba navegador');
    await client.send('Runtime.evaluate',{expression:`sessionStorage.setItem('rsvp-admin-access-token',${JSON.stringify(token)})`});
    await client.send('Page.navigate',{url:'http://127.0.0.1:55555/album/admin.html'});await wait(1000);
    state=await client.send('Runtime.evaluate',{expression:`JSON.stringify({visible:!document.querySelector('#panel').hidden,items:document.querySelectorAll('#photosList article').length})`,returnByValue:true});assert.deepEqual(JSON.parse(state.result.value),{visible:true,items:1});
    await client.send('Runtime.evaluate',{expression:`document.querySelector('#photosList button').click()`});await wait(500);
    state=await client.send('Runtime.evaluate',{expression:`(async()=>{const img=document.querySelector('.admin-photo-preview');if(!img)return false;try{await img.decode();return img.naturalWidth>0}catch{return false}})()`,awaitPromise:true,returnByValue:true});assert.equal(state.result.value,true);
    await req('/functions/v1/photo-album',{method:'POST',token,key:anon,body:{action:'delete',id:photos[0].id}});
    assert.equal((await req('/rest/v1/photo_album_uploads?select=id')).length,0);
    console.log('OK: navegador móvil, CORS, función, autenticación y Storage locales.');
  } finally {
    client?.close();chrome?.kill('SIGTERM');if(server)await new Promise(resolve=>server.close(resolve));
    const rows=await req('/rest/v1/photo_album_uploads?select=id');
    for(const photo of rows){ await req('/rest/v1/rpc/photo_album_mark_delete',{method:'POST',body:{p_id:photo.id}});await req('/storage/v1/object/wedding-photos',{method:'DELETE',body:{prefixes:[`${photo.id}.jpg`]}});await req('/rest/v1/rpc/photo_album_finish_delete',{method:'POST',body:{p_id:photo.id}}); }
    await req('/rest/v1/photo_album_settings?id=eq.true',{method:'PATCH',body:settings,expected:[200,204]});
    if(userId)await req(`/auth/v1/admin/users/${userId}`,{method:'DELETE',expected:[200,204]});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
