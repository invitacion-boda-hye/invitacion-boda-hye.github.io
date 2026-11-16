const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const read = (path) => readFileSync(path, 'utf8');
const migration = read('supabase/migrations/202611160001_allow_single_word_rsvp_names.sql');
const client = read('js/rsvp.js');
const acceptsName = (value) => /\S/.test(value.trim());

assert(acceptsName('Hector'), 'un nombre simple debe ser válido');
assert(acceptsName('Hector Pérez'), 'un nombre completo debe ser válido');
assert(!acceptsName(''), 'un nombre vacío debe rechazarse');
assert(!acceptsName('   '), 'un nombre con solo espacios debe rechazarse');
assert.match(migration, /rsvp_attendees_full_name_check[\s\S]*char_length\(full_name\) between 1 and 160/);
assert.match(migration, /invitation_members_full_name_check[\s\S]*char_length\(btrim\(full_name\)\) between 1 and 160/);
assert.doesNotMatch(migration, /\\S\+\\s\+\\S\+/);
assert.match(migration, /rsvp_submit[\s\S]*char_length\(v_name\) not between 1 and 160/);
assert.doesNotMatch(client, /Ingresa nombre y apellido/);

console.log('Validación estática de nombres RSVP aprobada.');
