#!/usr/bin/env python3
"""Verify archive/write lock ordering in a network-isolated rehearsal DB.

This fixture writes only randomly generated local rows, removes them in a
finally block, and refuses containers with networking enabled. It does not
connect to a hosted project or test a provider action.
"""

import argparse
import json
import re
import subprocess
import time
import uuid
from pathlib import Path


def docker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def sql(container: str, statement: str) -> subprocess.CompletedProcess[str]:
    role = "select set_config('request.jwt.claim.role','service_role',true);"
    return docker("exec", container, "psql", "-U", "postgres",
                  "-v", "ON_ERROR_STOP=1", "-At", "-c", role + statement)


def require_ok(result: subprocess.CompletedProcess[str], action: str) -> str:
    if result.returncode:
        raise RuntimeError(f"{action} failed in isolated rehearsal")
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="aa-staging-pr363-full-rehearsal")
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"aa-staging-[a-z0-9-]+-rehearsal", args.container):
        raise RuntimeError("Expected a disposable staging rehearsal container")
    inspected = docker("inspect", args.container)
    require_ok(inspected, "container inspection")
    detail = json.loads(inspected.stdout)
    if len(detail) != 1 or detail[0]["HostConfig"]["NetworkMode"] != "none":
        raise RuntimeError("Container is not network-isolated")

    client, lead, appointment = (str(uuid.uuid4()) for _ in range(3))
    setup = (
        f"insert into public.clients(id,name,initials) values ('{client}',"
        "'Local lock fixture','LF');"
        f"insert into public.client_leads(id,client_id,name) values ('{lead}',"
        f"'{client}','Local lock lead');"
    )
    require_ok(sql(args.container, setup), "fixture setup")
    result: dict[str, object] = {"network_isolated": True, "verified": False}
    try:
        role = "select set_config('request.jwt.claim.role','service_role',true);"
        archive_side = (
            f"begin; {role} select id from public.client_leads where id='{lead}' "
            f"for update; select pg_sleep(3); delete from public.client_leads "
            f"where id='{lead}'; commit;"
        )
        first = subprocess.Popen(
            ["docker", "exec", args.container, "psql", "-U", "postgres",
             "-v", "ON_ERROR_STOP=1", "-At", "-c", archive_side],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        time.sleep(0.7)
        if first.poll() is not None:
            raise RuntimeError("Archive-side transaction ended before the write")
        running = require_ok(sql(args.container,
            "select count(*) from pg_stat_activity "
            "where query like '%pg_sleep(3)%' and state='active' "
            "and pid<>pg_backend_pid()"), "archive lock observation")
        if int(running) < 1:
            raise RuntimeError("Archive-side transaction was not observed")

        write = (
            "insert into public.client_appointments"
            "(id,client_id,lead_id,starts_at,ends_at,booked_via) values "
            f"('{appointment}','{client}','{lead}',now()+interval '1 day',"
            "now()+interval '1 day 1 hour','person')"
        )
        started = time.monotonic()
        second = sql(args.container, write)
        elapsed = time.monotonic() - started
        first_error = first.communicate(timeout=10)[1]
        if first.returncode or second.returncode == 0 or elapsed < 1.5 \
                or "current same-client lead" not in second.stderr:
            raise RuntimeError("Concurrent dependent write did not fail closed") from None
        state = require_ok(sql(args.container,
            f"select (select count(*) from public.client_leads where id='{lead}')"
            f"||'|'||(select count(*) from public.client_appointments "
            f"where id='{appointment}')||'|'||(select count(*) from "
            f"public.lead_identities where id='{lead}')"), "post-race state")
        if state != "0|0|1":
            raise RuntimeError("Post-race active/appointment/identity state differs")
        result.update({"archive_transaction_committed": True,
                       "new_dependent_write_refused": True,
                       "waited_for_row_lock": True,
                       "elapsed_seconds_rounded": round(elapsed, 1),
                       "post_race_counts": state, "verified": True})
    finally:
        # The immutable lineage triggers block ordinary fixture-client delete.
        # Bypass them only in this network-isolated local container and only
        # for this random fixture client, then verify no fixture rows remain.
        cleanup = (
            "begin; set local session_replication_role=replica;"
            f"delete from public.delivery_lineage_links_v6 where client_id='{client}';"
            f"delete from public.delivery_entity_heads_v6 where client_id='{client}';"
            f"delete from public.delivery_entity_versions_v6 where client_id='{client}';"
            f"delete from public.client_appointments where client_id='{client}';"
            f"delete from public.client_leads where client_id='{client}';"
            f"delete from public.archived_leads where client_id='{client}';"
            f"delete from public.lead_identities where client_id='{client}';"
            f"delete from public.clients where id='{client}'; commit;"
        )
        require_ok(sql(args.container, cleanup), "fixture cleanup")
        residual = require_ok(sql(args.container,
            f"select (select count(*) from public.clients where id='{client}')"
            f"||'|'||(select count(*) from public.lead_identities "
            f"where client_id='{client}')"), "fixture cleanup readback")
        if residual != "0|0":
            raise RuntimeError("Fixture rows remain after cleanup")
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, indent=2) + "\n")
    args.result.chmod(0o600)
    print(json.dumps({"verified": result["verified"],
                      "waited_for_row_lock": result["waited_for_row_lock"],
                      "result": str(args.result)}))


if __name__ == "__main__":
    main()
