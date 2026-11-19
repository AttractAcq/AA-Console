#!/usr/bin/env python3
"""Replay pinned PR #363 SQL against a disposable, already-restored staging copy.

This runner deliberately cannot connect to Supabase or a networked database. It
requires a Docker container with networking disabled, the 569-row staging
baseline, paused cron, and the saved Storage/trigger state. It does not prepare
or repair the restore; those are separate, evidenced steps.
"""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / "docs/client-delivery-pr363-migration-review-2026-11-18.md"
MIGRATIONS = REPO / "supabase/migrations"
START = "20261124034600"
END = "20261124051100"
EXPECTED = 85


def docker(container: str, *args: str, input_bytes: bytes | None = None,
           log_path: Path | None = None) -> bytes:
    result = subprocess.run(["docker", *args], input=input_bytes,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            check=False)
    if log_path is not None:
        log_path.write_bytes(result.stdout + result.stderr)
        log_path.chmod(0o600)
    if result.returncode:
        # SQL errors may include restored customer data; only the protected
        # local log gets the output, never the terminal or result JSON.
        raise RuntimeError(f"Local Docker command failed ({result.returncode}); stopped")
    return result.stdout


def query(container: str, sql: str) -> str:
    return docker(container, "exec", container, "psql", "-U", "postgres",
                  "-Atqc", sql, "postgres").decode().strip()


def pinned_files() -> list[tuple[Path, str]]:
    pins: dict[str, str] = {}
    for line in MANIFEST.read_text().splitlines():
        match = re.search(r"\|\s*\d+\s*\|\s*`([^`]+\.sql)`\s*\|\s*`([0-9a-f]{64})`", line)
        if match:
            pins[match.group(1)] = match.group(2)
    files = [p for p in sorted(MIGRATIONS.glob("*.sql")) if START < p.name[:14] <= END]
    if len(files) != EXPECTED or len(pins) != EXPECTED or len({p.name[:14] for p in files}) != EXPECTED:
        raise RuntimeError("Candidate file count, manifest count or migration versions differ; stopped")
    for p in files:
        if pins.get(p.name) != hashlib.sha256(p.read_bytes()).hexdigest():
            raise RuntimeError(f"Manifest hash mismatch for {p.name}; stopped")
    if files[-1].name[:14] != END:
        raise RuntimeError("Candidate migration head differs; stopped")
    return [(p, pins[p.name]) for p in files]


def local_identity(container: str) -> dict[str, str]:
    return {
        "clients": query(container, "select count(*)||'|'||coalesce(md5(string_agg(id::text,',' order by id)),'') from public.clients"),
        "auth_users": query(container, "select count(*)||'|'||coalesce(md5(string_agg(id::text,',' order by id)),'') from auth.users"),
        "storage_policies": query(container, "select count(*)||'|'||coalesce(md5(string_agg(to_jsonb(p)::text,',' order by tablename,policyname)),'') from pg_policies p where schemaname='storage'"),
        "storage_rls": query(container, "select string_agg(c.relname||':'||c.relrowsecurity::text,',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname in ('objects','buckets')"),
        "cron": query(container, "select count(*)||'|'||count(*) filter(where active) from cron.job"),
        "cron_max_id": query(container, "select max(jobid)::text from cron.job"),
        "rls_trigger": query(container, "select count(*) from pg_event_trigger where evtname='ensure_rls' and evtenabled='O'"),
        "postgres_superuser": query(container, "select rolsuper::text from pg_roles where rolname='postgres'"),
    }


def assert_isolated(container: str) -> None:
    if not re.fullmatch(r"aa-staging-[a-z0-9-]+-rehearsal", container):
        raise RuntimeError("Container name must identify a disposable staging rehearsal; stopped")
    detail = json.loads(docker(container, "inspect", container).decode())
    if len(detail) != 1 or detail[0]["HostConfig"]["NetworkMode"] != "none":
        raise RuntimeError("Container is not network-isolated; stopped")


def old_cron_digest(container: str, maximum_id: str) -> str:
    if not maximum_id.isdigit():
        raise RuntimeError("The saved cron ID boundary is invalid; stopped")
    return query(container, "select count(*)||'|'||coalesce(md5(string_agg(to_jsonb(j)::text,',' order by jobid)),'') "
                 f"from cron.job j where jobid<={maximum_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="aa-staging-pr363-rehearsal")
    parser.add_argument("--result", type=Path, default=Path("/private/tmp/pr363-staging-rehearsal-result.json"))
    parser.add_argument("--manifest-only", action="store_true")
    args = parser.parse_args()
    files = pinned_files()
    print(f"Verified {len(files)} pinned migration files through {END}.", flush=True)
    if args.manifest_only:
        return

    assert_isolated(args.container)
    history = query(args.container, "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
    baseline = local_identity(args.container)
    if history != f"569|{START}" or baseline["cron"] != "22|0" \
            or not baseline["storage_policies"].startswith("26|") \
            or baseline["storage_rls"] != "buckets:true,objects:true" \
            or baseline["rls_trigger"] != "1" \
            or baseline["postgres_superuser"] != "true":
        raise RuntimeError("Restored staging baseline, paused cron, Storage, trigger or local replay role differs; stopped")
    old_cron = old_cron_digest(args.container, baseline["cron_max_id"])
    log_dir = args.result.parent / "pr363-local-migration-logs"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    log_dir.chmod(0o700)
    state: dict[str, object] = {"container": args.container, "start": START,
                                "expected": EXPECTED, "before": baseline,
                                "old_cron_digest": old_cron,
                                "applied": [], "failed": None}
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(state, indent=2) + "\n")
    args.result.chmod(0o600)
    for index, (path, digest) in enumerate(files, 1):
        match = re.fullmatch(r"(\d{14})_([A-Za-z0-9_]+)\.sql", path.name)
        if match is None:
            raise RuntimeError("Unexpected migration filename; stopped")
        version, name = match.groups()
        sql = path.read_bytes()
        log = log_dir / f"{version}.log"
        try:
            docker(args.container, "exec", "-i", args.container, "psql", "-U", "postgres",
                   "-v", "ON_ERROR_STOP=1", "postgres", input_bytes=sql,
                   log_path=log)
            docker(args.container, "exec", "-i", args.container, "psql", "-U", "postgres",
                   "-v", "ON_ERROR_STOP=1", "postgres",
                   input_bytes=("insert into supabase_migrations.schema_migrations(version,name) "
                                f"values('{version}','{name}');\n").encode(),
                   log_path=log_dir / f"{version}-history.log")
        except RuntimeError:
            state["failed"] = {"file": path.name, "protected_log": str(log)}
            args.result.write_text(json.dumps(state, indent=2) + "\n")
            raise RuntimeError(f"Stopped at {path.name}; inspect isolated container and protected logs") from None
        state["applied"].append({"file": path.name, "sha256": digest})
        args.result.write_text(json.dumps(state, indent=2) + "\n")
        if index % 10 == 0:
            print(f"Applied {index}/{EXPECTED} through {version}.", flush=True)

    after = local_identity(args.container)
    final_history = query(args.container, "select count(*)||'|'||max(version) from supabase_migrations.schema_migrations")
    state["after"] = after
    state["history"] = final_history
    state["old_cron_digest_after"] = old_cron_digest(args.container, baseline["cron_max_id"])
    state["verified"] = (final_history == f"654|{END}"
                         and after["clients"] == baseline["clients"]
                         and after["auth_users"] == baseline["auth_users"]
                         and after["storage_policies"] == baseline["storage_policies"]
                         and after["storage_rls"] == baseline["storage_rls"]
                         and after["rls_trigger"] == baseline["rls_trigger"]
                         and after["postgres_superuser"] == baseline["postgres_superuser"]
                         and after["cron"] == "23|0"
                         and state["old_cron_digest_after"] == old_cron)
    args.result.write_text(json.dumps(state, indent=2) + "\n")
    if not state["verified"]:
        raise RuntimeError("Post-replay data, cron, policy, trigger or history guard failed; stopped")
    print("Local data and paused-execution guards passed; hosted parity and recovery remain unverified.")


if __name__ == "__main__":
    main()
