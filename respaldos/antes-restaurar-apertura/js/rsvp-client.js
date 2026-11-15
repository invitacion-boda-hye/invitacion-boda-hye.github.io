/* Cliente mínimo: las tablas nunca se consultan desde el navegador. */
const RSVP_API = (() => {
  function functionUrl(name) {
    if (!RSVP_CONFIG.supabaseUrl) throw new Error('RSVP_NOT_CONFIGURED');
    return `${RSVP_CONFIG.supabaseUrl.replace(/\/$/, '')}/functions/v1/${name}`;
  }

  async function request(url, body, headers = {}) {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    }).catch(() => { throw new Error('NETWORK_ERROR'); });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Preserve machine codes only; never display arbitrary server bodies or
      // credentials returned by an upstream proxy.
      const code = typeof payload?.error === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(payload.error)
        ? payload.error : `HTTP_${response.status}`;
      const error = new Error(code);
      error.status = response.status;
      throw error;
    }
    if (!payload || typeof payload !== 'object') throw new Error('INVALID_RESPONSE');
    return payload;
  }

  function publicRequest(body) {
    return request(functionUrl(RSVP_CONFIG.publicFunction), body);
  }

  function requirePublishableKey() {
    if (!RSVP_CONFIG.publishableKey) throw new Error('ADMIN_NOT_CONFIGURED');
    return RSVP_CONFIG.publishableKey;
  }

  async function signIn(email, password) {
    const key = requirePublishableKey();
    const response = await fetch(`${RSVP_CONFIG.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email, password })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error('ADMIN_LOGIN_FAILED');
    return payload;
  }

  function adminRequest(action, payload, accessToken) {
    const key = requirePublishableKey();
    return request(functionUrl(RSVP_CONFIG.adminFunction), { action, ...payload }, {
      apikey: key,
      Authorization: `Bearer ${accessToken}`
    });
  }

  return { publicRequest, signIn, adminRequest };
})();
