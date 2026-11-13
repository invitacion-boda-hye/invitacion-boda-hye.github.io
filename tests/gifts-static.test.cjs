const fs = require('fs');
const assert = require('assert');
const root = `${__dirname}/..`;
const read = (path) => fs.readFileSync(`${root}/${path}`, 'utf8');

const page = read('index.html');
const client = read('js/gifts.js');
const migration = read('supabase/migrations/202611130001_gifts_and_messages.sql');
const publicFn = read('supabase/functions/public-rsvp/index.ts');
const adminFn = read('supabase/functions/admin-rsvp/index.ts');

for (const required of ['giftBox', 'giftForm', 'copyBank', 'transferSender', 'transferDate']) assert(page.includes(`id="${required}"`));
assert(client.includes("submit('giftMessage'"));
assert(client.includes("submit('giftTransfer'"));
assert(client.includes('sessionStorage'));
assert(migration.includes('enable row level security'));
assert(migration.includes('grant execute') && migration.includes('to service_role'));
assert(migration.includes("'transfer_verified'"));
assert(publicFn.includes('GIFT_LIMIT') && publicFn.includes('gift_submit'));
assert(adminFn.includes('listGifts') && adminFn.includes('verifyGift'));
assert(!/SUPABASE_(SECRET|SERVICE_ROLE)|sb_secret/.test(`${page}\n${client}`));
console.log('Validación estática de regalos aprobada.');
