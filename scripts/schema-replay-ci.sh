#!/usr/bin/env bash
set -euo pipefail

# A local-only schema gate. No linked ref, project ID, database URL, or
# production credential is accepted or needed by any Supabase command below.
repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_dir"
command -v node >/dev/null || { echo 'Missing required program: node' >&2; exit 1; }
node scripts/schema-migration-order.mjs
for program in supabase docker psql diff; do
  command -v "$program" >/dev/null || { echo "Missing required program: $program" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker daemon is unavailable.' >&2; exit 1; }

unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_DB_URL
port_base="${AA_SCHEMA_PORT_BASE:-55320}"
if [[ ! "$port_base" =~ ^[0-9]+$ ]] || (( port_base < 20000 || port_base > 62000 )); then
  echo 'AA_SCHEMA_PORT_BASE must be an integer from 20000 to 62000.' >&2
  exit 1
fi

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/aa-schema-ci.XXXXXXXX")"
run_id="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}_${RANDOM}"
run_id="$(printf '%s' "$run_id" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_')"
project_id="aa_schema_ci_${run_id}"
evidence_dir="${AA_SCHEMA_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/aa-schema-evidence.XXXXXXXX")}"
mkdir -p "$evidence_dir"
evidence_dir="$(cd "$evidence_dir" && pwd)"
started=0
cleanup() {
  if (( started )); then
    supabase --workdir "$run_dir" stop --no-backup >"$run_dir/private-stop.log" 2>&1 || true
  fi
  rm -rf "$run_dir"
}
trap cleanup EXIT

node scripts/prepare-schema-replay.mjs "$run_dir" "$project_id" "$port_base" \
  >"$evidence_dir/manifest.json"
auth_file="20260903105742_11_auth_users_and_role_metadata.sql"
if ! diff -q "supabase/migrations/$auth_file" \
    "$run_dir/supabase/migrations/$auth_file" >/dev/null; then
  echo 'Raw Auth replay requires identical migration 11 source bytes.' >&2
  exit 1
fi
echo 'Raw Auth migration 11 source bytes verified.'
echo "Disposable Supabase project: $project_id; evidence: $evidence_dir"

run_logged() {
  local name="$1"
  shift
  echo "== $name =="
  # Supabase start can print local API keys. Keep all CLI output in the
  # temporary private directory and upload only an allowlisted filename trace.
  if "$@" >"$run_dir/$name.private.log" 2>&1; then
    grep -Eo '[0-9]{14}_[A-Za-z0-9_.-]+\.sql' "$run_dir/$name.private.log" \
      >"$evidence_dir/$name.migrations.txt" || true
    printf 'passed\n' >"$evidence_dir/$name.status.txt"
    echo "$name passed."
  else
    grep -Eo '[0-9]{14}_[A-Za-z0-9_.-]+\.sql' "$run_dir/$name.private.log" \
      >"$evidence_dir/$name.migrations.txt" || true
    printf 'failed\n' >"$evidence_dir/$name.status.txt"
    echo "$name failed; raw CLI output withheld because it may contain local keys." >&2
    tail -1 "$evidence_dir/$name.migrations.txt" >&2 || true
    return 1
  fi
}
supabase_local() {
  supabase --workdir "$run_dir" "$@"
}
psql_local() {
  PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$((port_base + 2))" -U postgres -d postgres "$@"
}
assert_migrations() {
  local stage="$1"
  local max_version="$2"
  find "$run_dir/supabase/migrations" -maxdepth 1 -name '*.sql' -print \
    | sed -E 's#.*/([0-9]{14})_.*#\1#' | sort \
    | awk -v maximum="$max_version" '$0 <= maximum' \
    >"$evidence_dir/$stage.expected-versions.txt"
  psql_local -At -c 'select version from supabase_migrations.schema_migrations order by version' \
    >"$evidence_dir/$stage.applied-versions.txt"
  diff -u "$evidence_dir/$stage.expected-versions.txt" \
    "$evidence_dir/$stage.applied-versions.txt" \
    >"$evidence_dir/$stage.migration-diff.txt" || {
      cat "$evidence_dir/$stage.migration-diff.txt" >&2
      echo "Migration history differs after $stage replay." >&2
      return 1
    }
}
snapshot_schema() {
  local stage="$1"
  psql_local -qAt -f supabase/verification/schema-replay-contract.sql \
    >"$evidence_dir/$stage.contract.txt"
  psql_local -qAt -f supabase/verification/schema-replay-fingerprint.sql \
    >"$evidence_dir/$stage.fingerprint.json"
}

# A fresh project start is itself a clean migration replay. Reset below
# exercises the CLI's separate reset path as well.
started=1
run_logged start supabase_local start
head_version="$(AA_SCHEMA_MANIFEST="$evidence_dir/manifest.json" node -p \
  "JSON.parse(require('fs').readFileSync(process.env.AA_SCHEMA_MANIFEST)).headVersion")"
released_version="$(AA_SCHEMA_MANIFEST="$evidence_dir/manifest.json" node -p \
  "JSON.parse(require('fs').readFileSync(process.env.AA_SCHEMA_MANIFEST)).releasedVersion")"
assert_migrations initial "$head_version"
snapshot_schema initial

# Supabase CLI 2.101.0 interprets db reset --version as its global version
# flag and exits successfully without resetting anything. Remove only the
# pending files from this disposable project, reset, then put them back for
# the upgrade path. The source checkout and linked project are untouched.
pending_dir="$run_dir/pending-migrations"
mkdir -p "$pending_dir"
pending_count=0
for migration_file in "$run_dir"/supabase/migrations/*.sql; do
  migration_name="${migration_file##*/}"
  migration_version="${migration_name%%_*}"
  if [[ "$migration_version" > "$released_version" ]]; then
    mv "$migration_file" "$pending_dir/$migration_name"
    pending_count=$((pending_count + 1))
  fi
done
run_logged reset-released supabase_local db reset --local --no-seed
assert_migrations released "$released_version"
if (( pending_count > 0 )); then
  mv "$pending_dir"/*.sql "$run_dir/supabase/migrations/"
fi
run_logged upgrade supabase_local migration up --local
assert_migrations upgrade "$head_version"
snapshot_schema upgrade

run_logged reset-clean supabase_local db reset --local --no-seed
assert_migrations clean "$head_version"
snapshot_schema clean
diff -u "$evidence_dir/upgrade.fingerprint.json" \
  "$evidence_dir/clean.fingerprint.json" \
  >"$evidence_dir/upgrade-vs-clean.diff" || {
    cat "$evidence_dir/upgrade-vs-clean.diff" >&2
    echo 'Upgrade and clean catalogs differ.' >&2
    exit 1
  }

# Run a real two-session lock-order regression against the same disposable
# local PostgreSQL server, in its own database so replay fingerprints stay
# unchanged. PGlite cannot expose this class of deadlock.
if bash scripts/test-b006-budget-locks.sh "$((port_base + 2))" \
  >"$run_dir/b006-budget-lock.private.log" 2>&1; then
  printf 'passed\n' >"$evidence_dir/b006-budget-lock.status.txt"
  echo 'B006 two-connection budget lock order passed.'
else
  printf 'failed\n' >"$evidence_dir/b006-budget-lock.status.txt"
  tail -12 "$run_dir/b006-budget-lock.private.log" >&2
  exit 1
fi

if ! supabase_local gen types --local --lang typescript --schema public,graphql_public \
  >"$evidence_dir/database.generated.ts" \
  2>"$run_dir/private-gen-types.log"; then
  echo 'Local type generation failed; raw CLI output withheld because it may contain local keys.' >&2
  exit 1
fi
# The CLI emits an extra terminal blank line; keep the checked-in file in
# normal source format while comparing every generated type and relationship.
node -e 'const fs = require("node:fs"); const path = process.argv[1]; const raw = fs.readFileSync(path, "utf8"); fs.writeFileSync(path, raw.replace(/\n+$/, "\n"));' \
  "$evidence_dir/database.generated.ts"
diff -u src/types/database.ts "$evidence_dir/database.generated.ts" \
  >"$evidence_dir/database-types.diff" || {
    head -200 "$evidence_dir/database-types.diff" >&2
    echo 'Generated database types differ from src/types/database.ts.' >&2
    exit 1
  }

echo "Schema replay, upgrade equivalence, catalog contract and generated types passed."
