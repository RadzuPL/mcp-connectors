#!/bin/bash
# Generic entrypoint for every gateway image in this repo.
#
# Runs the wrapped MCP server through supergateway (stdio -> streamable-HTTP) on
# loopback, with the authenticating proxy (auth-proxy.js) on :8000 in front of it.
# supergateway has no inbound authentication of its own, so the proxy is the only
# thing that checks the bearer token. If either process exits, the whole container
# exits: a dead proxy can never leave an unauthenticated gateway behind, and a dead
# gateway is visible as a stopped container.
#
# Environment:
#   GATEWAY_STDIO_CMD           (required) shell command line of the wrapped MCP server.
#                               It is run by supergateway through a shell, so it may
#                               contain variables such as $ALLOWED_DIRS.
#   GATEWAY_STATEFUL            "true" runs supergateway with --stateful: one server
#                               process per client session instead of one per request.
#                               Needed by servers that log in to something on start.
#                               Default: false.
#   GATEWAY_SESSION_TIMEOUT_MS  inactivity timeout of a stateful session. Default 1800000.
#   MCP_BEARER_TOKEN_FILE / MCP_BEARER_TOKEN / MCP_ALLOW_PATH_TOKEN
#                               read by auth-proxy.js (see gateway/README.md)
#   LISTEN_PORT (8000) / UPSTREAM_PORT (8001)
set -u

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SG_PORT="${UPSTREAM_PORT:-8001}"
STDIO_CMD="${GATEWAY_STDIO_CMD:-}"

if [ -z "${STDIO_CMD}" ]; then
  echo "entrypoint: GATEWAY_STDIO_CMD is not set (the command of the MCP server to wrap). Refusing to start." >&2
  exit 2
fi

SG_HELP="$(supergateway --help 2>&1)"

# Keep supergateway's own port off the container network. Newer versions have
# --host; supergateway 4.1.0 does not and listens on every interface, so other
# containers on the same Docker network could skip the proxy. In that case a
# small preload pins the port to 127.0.0.1 (see force-loopback.js).
HOST_ARGS=()
SG_ENV=()
if printf '%s\n' "${SG_HELP}" | grep -q -- '--host'; then
  HOST_ARGS=(--host 127.0.0.1)
else
  echo "entrypoint: supergateway has no --host flag; pinning port ${SG_PORT} to 127.0.0.1 with force-loopback.js" >&2
  SG_ENV=("NODE_OPTIONS=--require ${APP_DIR}/force-loopback.js" "FORCE_LOOPBACK_PORT=${SG_PORT}")
fi

# Stateless mode (the default) starts a fresh server process per HTTP request. A server
# that logs in somewhere on every start (unifi-network-mcp does, and UniFi OS answers a
# burst of logins with an authentication rate limit) needs stateful mode instead: one
# server process, and one login, per client session.
STATE_ARGS=()
case "$(printf '%s' "${GATEWAY_STATEFUL:-false}" | tr '[:upper:]' '[:lower:]')" in
  true | 1 | yes)
    if printf '%s\n' "${SG_HELP}" | grep -q -- '--stateful'; then
      STATE_ARGS=(--stateful --sessionTimeout "${GATEWAY_SESSION_TIMEOUT_MS:-1800000}")
    else
      echo "entrypoint: WARNING: GATEWAY_STATEFUL is set but this supergateway has no --stateful flag; running stateless" >&2
    fi
    ;;
esac

node "${APP_DIR}/auth-proxy.js" &
PROXY_PID=$!

env ${SG_ENV[@]+"${SG_ENV[@]}"} supergateway --stdio "${STDIO_CMD}" --outputTransport streamableHttp \
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
