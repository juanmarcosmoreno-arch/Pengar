#!/usr/bin/env bash
# Aplica la migración y corre las pruebas de RLS y de las funciones (npm run test:db) en una base nueva.
# Sin nada, levanta un Postgres efímero con los binarios del sistema (PGBIN). Con PENGAR_TEST_DB (datos de conexión de
# libpq, ej. «host=localhost port=5432 user=postgres password=postgres»), usa ese servidor: arma una base para la
# corrida y la borra al terminar (así corre en GitHub Actions, con el Postgres del servicio).
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -n "${PENGAR_TEST_DB:-}" ]; then
  DB="pengar_test_$$"
  ADMIN=(psql -X -q -v ON_ERROR_STOP=1 -d "$PENGAR_TEST_DB dbname=postgres")
  "${ADMIN[@]}" -c "create database $DB"
  trap '"${ADMIN[@]}" -c "drop database if exists $DB with (force)" >/dev/null' EXIT
  PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$PENGAR_TEST_DB dbname=$DB")
else
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  TMP="$(mktemp -d)"
  PORT="${PGPORT_TEST:-54339}"
  RUNAS=()
  if [ "$(id -u)" = "0" ]; then chown -R postgres "$TMP"; RUNAS=(sudo -u postgres); fi
  "${RUNAS[@]}" "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" start >/dev/null
  trap '"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null; rm -rf "$TMP"' EXIT
  PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres -d postgres)
fi
"${PSQL[@]}" -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f supabase/tests/pengar.test.sql
echo "Base: todo bien"
