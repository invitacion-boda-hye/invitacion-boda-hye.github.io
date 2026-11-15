/*
 * Configuración pública del RSVP. La URL del proyecto no es secreta.
 * La clave publishable solo será necesaria para el panel de administración;
 * nunca agregues credenciales de servidor en este archivo.
 */
const RSVP_CONFIG = Object.freeze({
  supabaseUrl: 'https://ldgybrbdbpbfbgarglkt.supabase.co',
  publishableKey: 'sb_publishable_3ldS2unOiB9ceF3ZfAm96A_7psdZO8M',
  publicFunction: 'public-rsvp',
  adminFunction: 'admin-rsvp'
});
