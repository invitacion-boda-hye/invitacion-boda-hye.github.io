#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

required_files=(
  "supabase/migrations/202611110001_rsvp_schema_and_security.sql"
  "supabase/functions/public-rsvp/index.ts"
  "supabase/functions/admin-rsvp/index.ts"
  "supabase/functions/_shared/security_test.ts"
  "supabase/functions/.env.example"
  "SUPABASE_SETUP.md"
  "supabase/tests/001_rsvp_invariants.sql"
)

for file in "${required_files[@]}"; do
  [[ -f "$file" ]] || { echo "Falta: $file" >&2; exit 1; }
done

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

# Esta primera etapa no puede modificar la invitación aprobada ni introducir un panel visual.
if git status --porcelain | cut -c4- | rg -q '^(index\.html|css/|js/|admin/)'; then
  echo "La etapa 1 modificó diseño o panel antes de tiempo" >&2
  exit 1
fi

git diff --check
echo "Validación estática de etapa 1 aprobada."
