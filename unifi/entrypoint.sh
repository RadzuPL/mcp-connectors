#!/bin/bash
# Starts supergateway on loopback (no authentication of its own) and the
# authenticating proxy on :8000 in front of it. If either process exits, the
# whole container exits, so a dead proxy can never leave an unauthenticated
# gateway behind and a dead gateway is visible as a stopped container.
set -u

APP_DIR="${APP_DIR:-/app}"
SG_PORT="${UPSTREAM_PORT:-8001}"

# Keep supergateway's own port off the container network. Newer versions have
# --host; supergateway 4.1.0 does not and listens on every interface, so other
# containers on the same Docker network could skip the proxy. In that case a
# small preload pins the port to 127.0.0.1 (see force-loopback.js).
HOST_ARGS=()
SG_ENV=()
STATE_ARGS=()
if supergateway --help 2>&1 | grep -q -- '--host'; then
  HOST_ARGS=(--host 127.0.0.1)
else
  echo "entrypoint: supergateway has no --host flag; pinning port ${SG_PORT} to 127.0.0.1 with force-loopback.js" >&2
  SG_ENV=("NODE_OPTIONS=--require ${APP_DIR}/force-loopback.js" "FORCE_LOOPBACK_PORT=${SG_PORT}")
fi

# Stateless mode (the default) starts a fresh server process per HTTP request, and
# unifi-network-mcp logs in to the controller on every start; UniFi OS answers a burst
# of logins with an authentication rate limit. Stateful mode keeps one server process
# (and one login) per client session.
if supergateway --help 2>&1 | grep -q -- '--stateful'; then
  STATE_ARGS=(--stateful --sessionTimeout "${GATEWAY_SESSION_TIMEOUT_MS:-1800000}")
else
  echo "entrypoint: WARNING: supergateway has no --stateful flag; every request starts a new server and logs in again" >&2
fi

node "${APP_DIR}/auth-proxy.js" &
PROXY_PID=$!

env ${SG_ENV[@]+"${SG_ENV[@]}"} supergateway --stdio 'unifi-network-mcp' --outputTransport streamableHttp \
  ${HOST_ARGS[@]+"${HOST_ARGS[@]}"} ${STATE_ARGS[@]+"${STATE_ARGS[@]}"} --port "${SG_PORT}" &
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
