#!/usr/bin/env bash
# Fails when the root Dockerfile's hand-written workspace COPY list drifts
# from the yarn workspaces (packages/*, plugins/*). The Dockerfile copies each
# workspace package.json before `yarn install --immutable`; a missing one makes
# the image build fail with "Workspace not found" (mctl-portal#139, 4.17.0).
#
# Usage: check-dockerfile-workspaces.sh [ROOT]
# ROOT defaults to the repository root; the self-test points it at fixtures.
set -euo pipefail

cd "${1:-$(dirname "$0")/..}"
dockerfile="Dockerfile"

[ -f "$dockerfile" ] || { echo "::error::$dockerfile not found"; exit 1; }

workspaces=()
for manifest in packages/*/package.json plugins/*/package.json; do
  [ -f "$manifest" ] && workspaces+=("${manifest%/package.json}")
done
# An empty list means the globs did not match, not that there is nothing to check.
[ "${#workspaces[@]}" -gt 0 ] || { echo "::error::no workspace package.json found under packages/* or plugins/*"; exit 1; }

copied=$(sed -nE 's#^COPY[[:space:]]+(--[^[:space:]]+[[:space:]]+)*((packages|plugins)/[^/[:space:]]+)/package\.json[[:space:]].*#\2#p' "$dockerfile" | sort -u)

status=0
for ws in "${workspaces[@]}"; do
  if ! grep -qxF "$ws" <<<"$copied"; then
    echo "::error file=$dockerfile::workspace $ws is not copied before yarn install; add: COPY --chown=node:node $ws/package.json $ws/"
    status=1
  fi
done
while IFS= read -r ws; do
  [ -n "$ws" ] || continue
  if [ ! -f "$ws/package.json" ]; then
    echo "::error file=$dockerfile::Dockerfile copies $ws/package.json, which does not exist"
    status=1
  fi
done <<<"$copied"

[ "$status" -eq 0 ] && echo "Dockerfile copies all ${#workspaces[@]} workspace manifests."
exit "$status"
