/* Cliente mínimo: las tablas nunca se consultan desde el navegador. */
const RSVP_API = (() => {
  function functionUrl(name) {
    if (!RSVP_CONFIG.supabaseUrl) throw new Error('RSVP_NOT_CONFIGURED');
    return `${RSVP_CONFIG.supabaseUrl.replace(/\/$/, '')}/functions/v1/${name}`;
  }

  async function request(url, body, headers = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'REQUEST_FAILED');
      error.status = response.status;
      throw error;
    }
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
