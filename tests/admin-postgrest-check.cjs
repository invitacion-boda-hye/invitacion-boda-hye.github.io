// Diagnóstico explícito de solo lectura. Requiere el CLI autenticado.
// Clave e identificador administrativo solo en memoria; nunca se imprimen.
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ref = 'ldgybrbdbpbfbgarglkt';
function cli(args) {
  return JSON.parse(execFileSync('npx', ['--no-install', 'supabase', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }));
}
async function main() {
  const result = cli(['projects', 'api-keys', `--remote=${ref}`, '--reveal', '--output', 'json']);
  const keys = Array.isArray(result) ? result : result.api_keys;
  const key = keys.find(k => k.name === 'default' && k.api_key?.startsWith('sb_secret_'))?.api_key;
  assert.match(key || '', /^sb_secret_[A-Za-z0-9_-]+$/);
  console.log('Formato de la clave default: válido (valor omitido).');
  const secrets = cli(['secrets', 'list', `--remote=${ref}`, '--output', 'json']);
  const digest = (Array.isArray(secrets) ? secrets : secrets.secrets)
    .find(s => s.name === 'SUPABASE_SECRET_KEYS')?.value;
  const expectedDigest = createHash('sha256').update(JSON.stringify({ default: key })).digest('hex');
  console.log(digest === expectedDigest
    ? 'SUPABASE_SECRET_KEYS: digest coincide con el mapa JSON default usado en esta prueba.'
    : 'SUPABASE_SECRET_KEYS: digest no permite confirmar equivalencia (puede haber más claves o distinto formato JSON).');
  async function request(label, path, body) {
    const response = await fetch(`https://${ref}.supabase.co/rest/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json();
    const code = typeof payload?.code === 'string' && /^[A-Z0-9]{5,12}$/.test(payload.code) ? payload.code : null;
    console.log(JSON.stringify({ probe: label, http: response.status, code }));
    return { response, payload };
  }
  const members = await request('membership', 'rsvp_admins?select=user_id&limit=1');
  assert.equal(members.response.status, 200);
  assert.ok(Array.isArray(members.payload) && members.payload.length === 1);
  // Mismas columnas y relación de la Edge Function; cero familias devueltas.
  const families = await request('families zero rows', 'invitations?select=id,group_name,max_passes,is_active,rsvp_state,updated_at,rsvp_responses(confirmed_count,is_attending)&order=created_at.asc&limit=0');
  assert.equal(families.response.status, 200);
  const summary = await request('summary RPC, authorized actor', 'rpc/rsvp_admin_dashboard_summary', { p_actor_user_id: members.payload[0].user_id });
  assert.equal(summary.response.status, 200);
  assert.equal(typeof summary.payload.capacity, 'number');
  const denied = await request('summary RPC, missing actor', 'rpc/rsvp_admin_dashboard_summary', { p_actor_user_id: null });
  assert.equal(denied.payload.message, 'ADMIN_UNAUTHORIZED');
  assert.equal(denied.payload.code, 'P0001');
  console.log('Lecturas y RPC verificadas. No se probó el login JWT del navegador.');
}
main().catch(() => {
  console.error('Comprobación fallida. No se imprimen excepciones, claves ni cuerpos de respuesta.');
  process.exitCode = 1;
});
