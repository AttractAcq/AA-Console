#!/usr/bin/env bash
set -euo pipefail
umask 077

# One-pass, disposable candidate-head check for the rollback-only image
# lineage fixture. This does not use a linked Supabase project or credentials.
repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_dir"
for program in node supabase docker psql; do
  command -v "$program" >/dev/null || { echo "Missing required program: $program" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker daemon is unavailable.' >&2; exit 1; }
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_DB_URL

port_base="${AA_IMAGE_FIXTURE_PORT_BASE:-55480}"
if [[ ! "$port_base" =~ ^[0-9]+$ ]] || (( port_base < 20000 || port_base > 62000 )); then
  echo 'AA_IMAGE_FIXTURE_PORT_BASE must be an integer from 20000 to 62000.' >&2
  exit 1
fi
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/aa-image-fixture.XXXXXXXX")"
project_id="aa_schema_ci_image_${RANDOM}_${RANDOM}"
evidence_dir="${AA_IMAGE_FIXTURE_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/aa-image-evidence.XXXXXXXX")}"
mkdir -p "$evidence_dir"
evidence_dir="$(cd "$evidence_dir" && pwd)"
keep_disposable=0
cleanup() {
  if (( keep_disposable )); then
    echo "Disposable fixture retained for inspection: project $project_id, port $((port_base + 2)), workspace $run_dir" >&2
    return
  fi
  supabase --workdir "$run_dir" stop --no-backup >"$run_dir/stop.private.log" 2>&1 || true
  rm -rf "$run_dir"
}
trap cleanup EXIT

node scripts/prepare-schema-replay.mjs "$run_dir" "$project_id" "$port_base" \
  >"$evidence_dir/manifest.json"
if ! supabase --workdir "$run_dir" start --exclude vector,storage \
  --ignore-health-check >"$run_dir/start.private.log" 2>&1; then
  printf 'failed\n' >"$evidence_dir/start.status.txt"
  echo 'Disposable Supabase start failed; private CLI output withheld.' >&2
  exit 1
fi
printf 'passed\n' >"$evidence_dir/start.status.txt"
expected_head="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.headVersion)' \
  "$evidence_dir/manifest.json")"
actual_head="$(PGPASSWORD=postgres psql -X -qAt -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p "$((port_base + 2))" -U postgres -d postgres \
  -c 'select version from supabase_migrations.schema_migrations order by version desc limit 1')"
printf '%s\n' "$actual_head" >"$evidence_dir/applied-head.txt"
if [[ "$actual_head" != "$expected_head" ]]; then
  printf 'failed\n' >"$evidence_dir/head.status.txt"
  echo "Disposable migration head differs: expected $expected_head, observed $actual_head" >&2
  exit 1
fi
printf 'passed\n' >"$evidence_dir/head.status.txt"
if PGPASSWORD=postgres psql -X -qAt -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$((port_base + 2))" -U postgres -d postgres \
    -f scripts/manual-first-image-lineage-smoke.sql \
    >"$run_dir/image-fixture.private.log" 2>&1; then
  printf 'passed\n' >"$evidence_dir/image-lineage.status.txt"
  remaining="$(PGPASSWORD=postgres psql -X -qAt -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$((port_base + 2))" -U postgres -d postgres \
    -c "select (select count(*) from public.clients where name='Manual image lineage fixture') + (select count(*) from public.client_campaigns where name='Two route image fixture')")"
  printf '%s\n' "$remaining" >"$evidence_dir/remaining-fixture-rows.txt"
  if [[ "$remaining" != "0" ]]; then
    printf 'failed\n' >"$evidence_dir/rollback.status.txt"
    echo 'The rollback fixture left client or campaign rows.' >&2
    exit 1
  fi
  printf 'passed\n' >"$evidence_dir/rollback.status.txt"
  echo "Disposable image-lineage fixture and rollback passed at migration $actual_head. Evidence: $evidence_dir"
else
  printf 'failed\n' >"$evidence_dir/image-lineage.status.txt"
  grep -E 'ERROR:|psql:' "$run_dir/image-fixture.private.log" | tail -3 >&2 || true
  if [[ "${AA_IMAGE_FIXTURE_KEEP_ON_FAILURE:-0}" == "1" ]]; then keep_disposable=1; fi
  exit 1
fi
