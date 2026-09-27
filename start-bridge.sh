#!/usr/bin/env bash
# Start the deictic bridge and wait for it to answer.
#
# Detached on purpose: the bridge is a server and an action is expected to exit.
# The port comes from BRIDGE_PORT, so the same script starts a second instance
# when something else already holds 9977.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${BRIDGE_PORT:-9977}"
url="http://127.0.0.1:${port}"
log="${TMPDIR:-/tmp}/deictic-bridge.log"

healthy() { curl -fsS "${url}/health" >/dev/null 2>&1; }

if healthy; then
  echo "already answering on ${url}"
  curl -fsS "${url}/health"
  echo
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required: the bridge is Bun.serve" >&2
  exit 1
fi

# setsid, not nohup alone. Herdr tears down the action's process group when the
# action returns, and a child in that group dies with it; a new session is what
# actually outlives the caller. Verified by invoking the action and then asking
# the bridge whether it was still there.
if command -v setsid >/dev/null 2>&1; then
  setsid bun "${here}/bridge.mjs" >"${log}" 2>&1 &
else
  nohup bun "${here}/bridge.mjs" >"${log}" 2>&1 &
fi

for _ in $(seq 1 40); do
  if healthy; then
    sleep 0.5
    if healthy; then
      echo "bridge listening on ${url}"
      curl -fsS "${url}/health"
      echo
      echo "point the plugin at it: endpoint: '${url}/prompt'"
      exit 0
    fi
  fi
  sleep 0.25
done

echo "the bridge did not answer on ${url}; see ${log}" >&2
exit 1
