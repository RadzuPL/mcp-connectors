#!/bin/bash
# Starts supergateway on loopback (no authentication of its own) and the
# authenticating proxy on :8000 in front of it. If either process exits, the
# whole container exits, so a dead proxy can never leave an unauthenticated
# gateway behind and a dead gateway is visible as a stopped container.
set -u

APP_DIR="${APP_DIR:-/app}"
SG_PORT="${UPSTREAM_PORT:-8001}"

# Bind supergateway to loopback when this version supports --host. If it does
# not, say so loudly: the proxy still enforces the token on :8000, but the
# gateway's own port would be reachable from other containers on the network.
HOST_ARGS=()
if supergateway --help 2>&1 | grep -q -- '--host'; then
  HOST_ARGS=(--host 127.0.0.1)
else
  echo "entrypoint: WARNING: this supergateway has no --host flag; port ${SG_PORT} is not bound to loopback" >&2
fi

node "${APP_DIR}/auth-proxy.js" &
PROXY_PID=$!

supergateway --stdio 'unifi-network-mcp' --outputTransport streamableHttp \
  ${HOST_ARGS[@]+"${HOST_ARGS[@]}"} --port "${SG_PORT}" &
GATEWAY_PID=$!

stop() {
  kill "${PROXY_PID}" "${GATEWAY_PID}" 2>/dev/null
}
trap 'stop; exit 143' TERM INT

wait -n
CODE=$?
stop
wait 2>/dev/null
# A clean exit of either half still means the pair is broken: report failure.
if [ "${CODE}" -eq 0 ]; then CODE=1; fi
exit "${CODE}"
