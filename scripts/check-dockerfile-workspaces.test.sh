#!/usr/bin/env bash
# Self-test for check-dockerfile-workspaces.sh: the guard must pass on a
# converged fixture and fail on each kind of drift, or it is not a detector.
set -euo pipefail

guard="$(cd "$(dirname "$0")" && pwd)/check-dockerfile-workspaces.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fixture() { # $1 = dir, rest = Dockerfile COPY targets
  local dir="$tmp/$1"; shift
  mkdir -p "$dir/packages/backend" "$dir/plugins/a-backend"
  echo '{}' >"$dir/packages/backend/package.json"
  echo '{}' >"$dir/plugins/a-backend/package.json"
  {
    echo 'FROM node:22 AS build'
    for ws in "$@"; do echo "COPY --chown=node:node $ws/package.json $ws/"; done
    echo 'RUN yarn install --immutable'
  } >"$dir/Dockerfile"
  echo "$dir"
}

expect() { # $1 = want exit (0/1), $2 = label, $3 = root
  local got=0
  "$guard" "$3" >/dev/null 2>&1 || got=$?
  if [ "$got" -ne "$1" ]; then echo "FAIL: $2 (exit $got, want $1)"; exit 1; fi
  echo "ok: $2"
}

expect 0 "converged" "$(fixture green packages/backend plugins/a-backend)"
expect 1 "missing workspace COPY" "$(fixture missing packages/backend)"
expect 1 "COPY of a nonexistent workspace" "$(fixture stale packages/backend plugins/a-backend plugins/gone)"
empty="$tmp/empty"; mkdir -p "$empty"; echo 'FROM node:22' >"$empty/Dockerfile"
expect 1 "no workspaces found" "$empty"
nodf="$tmp/nodf"; mkdir -p "$nodf/plugins/x"; echo '{}' >"$nodf/plugins/x/package.json"
expect 1 "no Dockerfile" "$nodf"
