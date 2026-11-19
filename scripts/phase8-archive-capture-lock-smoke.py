#!/usr/bin/env python3
"""Race a consented capture against archive in a network-isolated local DB."""

import argparse
import hashlib
import json
import re
import subprocess
import time
import uuid
from pathlib import Path


def psql(container: str, statement: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "exec", container, "psql", "-U", "postgres",
         "-v", "ON_ERROR_STOP=1", "-At", "-c", statement],
        capture_output=True, text=True)


def expect(result: subprocess.CompletedProcess[str], label: str) -> str:
    if result.returncode:
        raise RuntimeError(f"{label} failed in isolated rehearsal")
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="aa-staging-pr363-full-rehearsal")
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"aa-staging-[a-z0-9-]+-rehearsal", args.container):
        raise RuntimeError("Expected a disposable rehearsal container")
    inspected = subprocess.run(["docker", "inspect", args.container],
                               capture_output=True, text=True, check=True)
    detail = json.loads(inspected.stdout)
    if len(detail) != 1 or detail[0]["HostConfig"]["NetworkMode"] != "none":
        raise RuntimeError("Container is not network-isolated")

    client, lead, endpoint = (str(uuid.uuid4()) for _ in range(3))
    token = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    email = f"race-{uuid.uuid4().hex}@example.invalid"
    setup = (
        "begin;"
        "select set_config('request.jwt.claim.role','service_role',true);"
        f"insert into public.clients(id,name,initials) values('{client}','Race fixture','RF');"
        f"insert into public.client_leads(id,client_id,name,email,contact,stage) "
        f"values('{lead}','{client}','Race fixture','{email}','{email}','profile_visit');"
        "set local session_replication_role=replica;"
        "insert into public.lead_capture_endpoints"
        "(id,client_id,purpose,token_hash,consent_wording,expires_at,enabled,max_submissions)"
        f"values('{endpoint}','{client}','agent_handoff','{token}',"
        "'I agree to be contacted',now()+interval '1 day',true,10);"
        "set local session_replication_role=origin;commit;")
    expect(psql(args.container, setup), "fixture setup")
    result: dict[str, object] = {"verified": False, "network_isolated": True}
    first: subprocess.Popen[str] | None = None
    try:
        archive = (
            "begin;select set_config('request.jwt.claim.role','service_role',true);"
            f"select id from public.client_leads where id='{lead}' for update;"
            "select pg_sleep(3);"
            f"select public.archive_lead('{lead}','Race fixture finished');commit;")
        first = subprocess.Popen(
            ["docker", "exec", args.container, "psql", "-U", "postgres",
             "-v", "ON_ERROR_STOP=1", "-At", "-c", archive],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        time.sleep(0.7)
        if first.poll() is not None:
            raise RuntimeError("Archive transaction finished before capture")
        active = expect(psql(args.container,
            "select count(*) from pg_stat_activity where "
            "query like '%pg_sleep(3)%' and state='active' "
            "and pid<>pg_backend_pid()"), "archive lock observation")
        if int(active) < 1:
            raise RuntimeError("Archive lock was not observed")
        capture = (
            "select set_config('request.jwt.claim.role','service_role',true);"
            "select public.capture_lead_v6("
            f"'{token}','race','Race fixture','{email}',null,null,true,"
            "'{}'::jsonb,null,null);")
        started = time.monotonic()
        output = expect(psql(args.container, capture), "concurrent capture")
        elapsed = time.monotonic() - started
        first.communicate(timeout=10)
        if first.returncode:
            raise RuntimeError("Archive transaction failed")
        captured = json.loads(output)
        if captured.get("pending_review") is not True or captured.get("lead_id") is not None:
            raise RuntimeError("Concurrent capture did not enter review hold")
        state = expect(psql(args.container,
            f"select (select count(*) from public.client_leads where client_id='{client}')"
            f"||'|'||(select count(*) from public.archived_leads where client_id='{client}')"
            f"||'|'||(select count(*) from public.lead_submissions where client_id='{client}'"
            " and status='received' and lead_id is null)"), "post-race state")
        if elapsed < 1.5 or state != "0|1|1":
            raise RuntimeError("Archive/capture lock ordering or state differed")
        result.update({"verified": True, "waited_for_archive_lock": True,
                       "elapsed_seconds_rounded": round(elapsed, 1),
                       "post_race_counts_active_archived_held": state})
    finally:
        if first is not None and first.poll() is None:
            first.communicate(timeout=10)
        cleanup = (
            "begin;set local session_replication_role=replica;"
            f"delete from public.lead_submissions where client_id='{client}';"
            f"delete from public.lead_capture_endpoints where client_id='{client}';"
            f"delete from public.delivery_lineage_links_v6 where client_id='{client}';"
            f"delete from public.delivery_entity_heads_v6 where client_id='{client}';"
            f"delete from public.delivery_entity_versions_v6 where client_id='{client}';"
            f"delete from public.client_leads where client_id='{client}';"
            f"delete from public.archived_leads where client_id='{client}';"
            f"delete from public.lead_identities where client_id='{client}';"
            f"delete from public.clients where id='{client}';commit;")
        expect(psql(args.container, cleanup), "fixture cleanup")
        residual = expect(psql(args.container,
            f"select (select count(*) from public.clients where id='{client}')"
            f"||'|'||(select count(*) from public.lead_identities "
            f"where client_id='{client}')"), "fixture cleanup readback")
        if residual != "0|0":
            raise RuntimeError("Fixture rows remain after cleanup")
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, indent=2) + "\n")
    args.result.chmod(0o600)
    print(json.dumps({"verified": result["verified"],
                      "result": str(args.result)}))


if __name__ == "__main__":
    main()
