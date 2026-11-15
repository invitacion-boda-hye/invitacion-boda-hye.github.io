#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

required_files=(
  "supabase/migrations/202611110001_rsvp_schema_and_security.sql"
  "supabase/functions/public-rsvp/index.ts"
  "supabase/functions/admin-rsvp/index.ts"
  "supabase/functions/_shared/security_test.ts"
  "js/rsvp-config.js"
  "js/rsvp-client.js"
  "js/rsvp.js"
  "admin/index.html"
  "admin/admin.js"
  "supabase/functions/.env.example"
  "SUPABASE_SETUP.md"
  "supabase/tests/001_rsvp_invariants.sql"
  "supabase/migrations/202611120002_guest_tables.sql"
  "supabase/tests/002_guest_tables_invariants.sql"
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || { echo "Falta: $file" >&2; exit 1; }
done

rg -q -U '^\[functions\.public-rsvp\]\nverify_jwt = false$' "supabase/config.toml"
rg -q -U '^\[functions\.admin-rsvp\]\nverify_jwt = false$' "supabase/config.toml"
rg -q 'type JsonRecord' "supabase/functions/_shared/supabase.ts"
rg -q 'requireInvitationToken' "supabase/functions/public-rsvp/index.ts"
rg -q 'rsvp_submit' "supabase/functions/public-rsvp/index.ts"
rg -q 'requireAuthenticatedAdmin' "supabase/functions/admin-rsvp/index.ts"
rg -q 'rsvp_admins' "supabase/functions/_shared/supabase.ts"
rg -q 'SUPABASE_PUBLISHABLE_KEYS' "supabase/functions/_shared/config.ts"
rg -q 'SUPABASE_SECRET_KEYS' "supabase/functions/_shared/config.ts"
rg -q 'ADMIN_MEMBERSHIP_CHECK_FAILED' "supabase/functions/_shared/supabase.ts"
rg -q 'listInvitations' "supabase/functions/admin-rsvp/index.ts"
rg -q 'rsvp_admin_get_guest_data' "supabase/functions/admin-rsvp/index.ts"
rg -q 'assignSeat' "supabase/functions/admin-rsvp/index.ts"
rg -q 'ORIGIN_NOT_ALLOWED' "admin/admin.js"

migration="supabase/migrations/202611110001_rsvp_schema_and_security.sql"
rg -q "token_hash char\\(64\\)" "$migration"
rg -q "for update" "$migration"
rg -q "enable row level security" "$migration"
rg -q "RSVP_CAPACITY_EXCEEDED" "$migration"
rg -q "ADMIN_REACTIVATION_CAPACITY_EXCEEDED" "$migration"
rg -q "ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES" "$migration"
rg -q "ADMIN_REACTIVATION_CAPACITY_EXCEEDED" "supabase/tests/001_rsvp_invariants.sql"
rg -q "ADMIN_CAPACITY_BELOW_ASSIGNED_PASSES" "supabase/tests/001_rsvp_invariants.sql"
rg -q "rsvp_submit" "$migration"
rg -q "rsvp_admin_regenerate_token" "$migration"
rg -q "pg_catalog.gen_random_uuid" "$migration"
if rg -q "extensions.gen_random_uuid|create extension if not exists pgcrypto" "$migration"; then
  echo "La migración no debe depender de pgcrypto para UUID" >&2
  exit 1
fi

tables_migration="supabase/migrations/202611120002_guest_tables.sql"
rg -q "event_tables" "$tables_migration"
rg -q "rsvp_seat_assignments" "$tables_migration"
rg -q "rsvp_admin_assign_seat" "$tables_migration"
rg -q "rsvp_admin_release_seat" "$tables_migration"
rg -q "rsvp_admin_export_guest_data" "$tables_migration"
[[ "$(rg -c "security definer" "$tables_migration")" -eq "$(rg -c "set search_path = ''" "$tables_migration")" ]]
rg -q "sum\(capacity\)::integer.*54" "supabase/tests/002_guest_tables_invariants.sql"

security_definer_count="$(rg -c "security definer" "$migration")"
empty_search_path_count="$(rg -c "set search_path = ''" "$migration")"
[[ "$security_definer_count" -eq "$empty_search_path_count" ]] || {
  echo "Cada función SECURITY DEFINER debe usar un search_path vacío" >&2
  exit 1
}
if rg -q "set search_path = public, private, pg_catalog" "$migration"; then
  echo "Se encontró un search_path inseguro en una función SECURITY DEFINER" >&2
  exit 1
fi

# La clave de servidor debe permanecer estrictamente fuera de los recursos web.
if rg -n "SUPABASE_(SECRET|SERVICE_ROLE)|sb_secret" index.html js css admin 2>/dev/null; then
  echo "Se detectó una clave privada en recursos del navegador" >&2
  exit 1
fi

# La integración no puede retirar los elementos de la invitación aprobada.
rg -q 'id="envelopeScreen"' index.html
rg -q 'id="musicButton"' index.html
! rg -q 'id="autoTourButton"' index.html
! rg -q 'Descubrir nuestra invitación' index.html
rg -q 'assets/musica.mp3' index.html
rg -q 'pauseAutoTour' js/app.js
rg -Fq "document.addEventListener('click'" js/app.js
rg -q 'RSVP_API.publicRequest' js/rsvp.js
rg -q 'admin-rsvp' js/rsvp-config.js
if rg -q 'wa\.me' js/app.js; then
  echo "El RSVP no debe conservar el envío por WhatsApp" >&2
  exit 1
fi

git diff --check
echo "Validación estática de etapa 1 aprobada."
