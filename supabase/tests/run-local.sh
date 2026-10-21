#!/usr/bin/env bash
# Levanta un Postgres efímero, aplica la migración y corre las pruebas de RLS y de las funciones (npm run test:db).
set -euo pipefail
cd "$(dirname "$0")/../.."
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54339}"
RUNAS=()
if [ "$(id -u)" = "0" ]; then chown -R postgres "$TMP"; RUNAS=(sudo -u postgres); fi
"${RUNAS[@]}" "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" start >/dev/null
trap '"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null; rm -rf "$TMP"' EXIT
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f supabase/tests/pengar.test.sql
echo "Base: todo bien"
