#!/usr/bin/env bash
# Recreates the local test database: auth stub + all migrations (+ seed with --seed).
# Usage: scripts/reset-test-db.sh [--seed]
# Uses TEST_DATABASE_URL (default postgresql://localhost:5432/omdomme_test).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PGOPTIONS="-c client_min_messages=warning"
DB_URL="${TEST_DATABASE_URL:-postgresql://localhost:5432/omdomme_test}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" <<'SQL'
drop schema if exists public cascade;
drop schema if exists auth cascade;
create schema public;
grant usage on schema public to public;
SQL

"${PSQL[@]}" -f "$ROOT/supabase/tests/auth_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$f"
done

if [[ "${1:-}" == "--seed" ]]; then
  "${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
fi
echo "Test database ready: $DB_URL"
