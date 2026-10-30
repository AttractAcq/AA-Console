#!/usr/bin/env bash
# Fail closed if a completed CI run no longer describes the code at main.
# workflow_run's github.sha points at the default branch when the event is
# delivered, so Pages must use the tested workflow_run.head_sha instead.
set -euo pipefail

expected="${1:-}"
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::The completed CI event has no full tested commit SHA."
  exit 1
fi

checkout="$(git rev-parse HEAD)"
if [[ "$checkout" != "$expected" ]]; then
  echo "::error::The checked-out code differs from the CI-tested commit."
  exit 1
fi

current="$(git ls-remote origin refs/heads/main | cut -f1)"
if [[ ! "$current" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Could not verify the current main commit."
  exit 1
fi
if [[ "$current" != "$expected" ]]; then
  echo "::error::A newer main commit exists; this older CI result cannot publish Pages."
  exit 1
fi

echo "Pages candidate is current main and the exact CI-tested commit: $expected"
