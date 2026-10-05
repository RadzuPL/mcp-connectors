#!/bin/bash
# Exercises gateway/entrypoint.sh with a fake supergateway. Checks that the proxy
# enforces the token, that supergateway gets the right arguments, that its own port
# is kept off the network, and that the container fails closed (exits, and takes the
# gateway with it) whenever something is missing or dies.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
LOG="${WORK}/entrypoint.log"
LISTEN_PORT=18300
UPSTREAM_PORT=18301
EP=""

cleanup() {
  [ -n "${EP}" ] && kill "${EP}" 2>/dev/null
  pkill -f "${HERE}/auth-proxy.js" 2>/dev/null
  pkill -f "${WORK}/bin/supergateway" 2>/dev/null
  rm -rf "${WORK}"
}
trap cleanup EXIT

mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/supergateway" <<'FAKE'
#!/bin/bash
# Fake supergateway. --help lists flags according to FAKE_HAS_HOST / FAKE_HAS_STATEFUL.
if [ "${1:-}" = "--help" ]; then
  echo "Options:"
  echo "  --port  Port"
  [ "${FAKE_HAS_HOST:-0}" = "1" ] && echo "  --host  Address to listen on"
  [ "${FAKE_HAS_STATEFUL:-1}" = "1" ] && { echo "  --stateful  Stateful mode"; echo "  --sessionTimeout  ms"; }
  exit 0
fi
printf 'FAKE-ARG[%s]\n' "$@" >&2
echo "FAKE-NODE_OPTIONS=${NODE_OPTIONS:-}" >&2
PORT=8000
HOSTARG=""
ARGS=("$@")
i=0
while [ $i -lt ${#ARGS[@]} ]; do
  [ "${ARGS[$i]}" = "--port" ] && PORT="${ARGS[$((i + 1))]}"
  [ "${ARGS[$i]}" = "--host" ] && HOSTARG="${ARGS[$((i + 1))]}"
  i=$((i + 1))
done
# Like supergateway 4.1.0: no host given means every interface.
if [ -n "${HOSTARG}" ]; then LISTEN="s.listen(${PORT},'${HOSTARG}')"; else LISTEN="s.listen(${PORT})"; fi
exec node -e "const s=require('http').createServer((q,r)=>{r.end('upstream-ok')}); ${LISTEN}"
FAKE
chmod +x "${WORK}/bin/supergateway"

TOKEN="$(printf 'x%.0s' {1..40})"
printf '%s' "${TOKEN}" > "${WORK}/token"
chmod 600 "${WORK}/token"

EXT="$(node -e "const os=require('os');for(const l of Object.values(os.networkInterfaces()))for(const a of l||[])if(a.family==='IPv4'&&!a.internal){console.log(a.address);process.exit(0)}")"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
expect_log() { if grep -qF -- "$2" "${LOG}"; then ok "$1"; else bad "$1 (log lacks: $2)"; fi; }
expect_nolog() { if grep -qF -- "$2" "${LOG}"; then bad "$1 (log has: $2)"; else ok "$1"; fi; }

http_code() { curl -s -m 2 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

# start_ep VAR=value ... : runs the entrypoint in a clean environment, waits for the proxy.
# It is started through `bash` on purpose: files pushed through the GitHub API (and some
# checkouts) lose the executable bit, and the test must not depend on it.
start_ep() {
  : > "${LOG}"
  env -i PATH="${WORK}/bin:${PATH}" HOME="${WORK}" APP_DIR="${HERE}" \
    LISTEN_PORT="${LISTEN_PORT}" UPSTREAM_PORT="${UPSTREAM_PORT}" "$@" \
    bash "${HERE}/entrypoint.sh" > "${LOG}" 2>&1 &
  EP=$!
  for _ in $(seq 1 60); do
    [ "$(http_code "http://127.0.0.1:${LISTEN_PORT}/mcp")" != "000" ] && return 0
    kill -0 "${EP}" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}
stop_ep() {
  kill -TERM "${EP}" 2>/dev/null
  wait "${EP}" 2>/dev/null
  EP=""
  sleep 0.3
}
# wait_exit <seconds>: waits for the entrypoint to exit on its own and stores its exit
# code in EXIT_CODE ("still-running" if it did not exit in time). Not called inside $(...),
# because a subshell cannot wait for a process that is not its own child.
EXIT_CODE=""
wait_exit() {
  for _ in $(seq 1 $(($1 * 10))); do
    if ! kill -0 "${EP}" 2>/dev/null; then
      wait "${EP}" 2>/dev/null
      EXIT_CODE=$?
      EP=""
      return 0
    fi
    sleep 0.1
  done
  EXIT_CODE="still-running"
}

echo "== 1. supergateway 4.1.0-like (no --host), stateful on, command with a shell variable"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" FAKE_HAS_HOST=0 FAKE_HAS_STATEFUL=1 \
  GATEWAY_STATEFUL=true GATEWAY_STDIO_CMD='mcp-server-filesystem $ALLOWED_DIRS' || bad "1: entrypoint did not come up"
expect_eq "1: no token -> 401" "$(http_code -X POST "http://127.0.0.1:${LISTEN_PORT}/mcp")" "401"
expect_eq "1: right token -> 200" "$(http_code -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${LISTEN_PORT}/mcp")" "200"
expect_eq "1: wrong token -> 401" "$(http_code -H "Authorization: Bearer nope" "http://127.0.0.1:${LISTEN_PORT}/mcp")" "401"
expect_log "1: GATEWAY_STDIO_CMD reaches supergateway literally (no early expansion)" 'FAKE-ARG[mcp-server-filesystem $ALLOWED_DIRS]'
expect_log "1: --stateful passed" 'FAKE-ARG[--stateful]'
expect_log "1: default session timeout passed" 'FAKE-ARG[1800000]'
expect_log "1: loopback pinning announced" 'pinning port'
expect_log "1: preload handed to supergateway" 'FAKE-NODE_OPTIONS=--require'
expect_eq "1: upstream reachable via loopback" "$(http_code "http://127.0.0.1:${UPSTREAM_PORT}/")" "200"
if [ -n "${EXT}" ]; then
  expect_eq "1: upstream NOT reachable via ${EXT}" "$(http_code "http://${EXT}:${UPSTREAM_PORT}/")" "000"
else
  echo "SKIP 1: no external IPv4 address, cannot check the upstream port from outside"
fi
stop_ep

echo "== 2. supergateway with --host"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" FAKE_HAS_HOST=1 GATEWAY_STDIO_CMD='some-server' || bad "2: entrypoint did not come up"
expect_log "2: --host passed" 'FAKE-ARG[--host]'
expect_log "2: bound to loopback" 'FAKE-ARG[127.0.0.1]'
expect_nolog "2: no preload needed" 'pinning port'
expect_eq "2: right token -> 200" "$(http_code -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${LISTEN_PORT}/mcp")" "200"
stop_ep

echo "== 3. stateful off by default"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" GATEWAY_STDIO_CMD='some-server' || bad "3: entrypoint did not come up"
expect_nolog "3: no --stateful" 'FAKE-ARG[--stateful]'
stop_ep

echo "== 4. stateful requested but not supported"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" FAKE_HAS_STATEFUL=0 GATEWAY_STATEFUL=true GATEWAY_STDIO_CMD='some-server' || bad "4: entrypoint did not come up"
expect_log "4: warns" 'has no --stateful flag'
expect_nolog "4: no --stateful passed" 'FAKE-ARG[--stateful]'
expect_eq "4: proxy still enforces the token" "$(http_code "http://127.0.0.1:${LISTEN_PORT}/mcp")" "401"
stop_ep

echo "== 5. custom session timeout"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" GATEWAY_STATEFUL=true GATEWAY_SESSION_TIMEOUT_MS=900000 GATEWAY_STDIO_CMD='some-server' || bad "5: entrypoint did not come up"
expect_log "5: custom timeout passed" 'FAKE-ARG[900000]'
stop_ep

echo "== 6. fails closed: no GATEWAY_STDIO_CMD"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" && bad "6: should not have come up"
wait_exit 5
expect_eq "6: exits with 2" "${EXIT_CODE}" "2"
expect_log "6: says why" 'GATEWAY_STDIO_CMD is not set'

echo "== 7. fails closed: no token"
start_ep GATEWAY_STDIO_CMD='some-server' && bad "7: should not have come up"
wait_exit 5
expect_eq "7: exits with 2 (the proxy's refusal)" "${EXIT_CODE}" "2"
expect_log "7: proxy refused to start" 'Refusing to start'
sleep 0.5
expect_eq "7: no gateway left behind" "$(http_code "http://127.0.0.1:${UPSTREAM_PORT}/")" "000"

echo "== 8. fails closed: proxy dies"
start_ep MCP_BEARER_TOKEN_FILE="${WORK}/token" GATEWAY_STDIO_CMD='some-server' || bad "8: entrypoint did not come up"
pkill -9 -f "${HERE}/auth-proxy.js"
wait_exit 5
expect_eq "8: exits with 137 (the killed proxy's status)" "${EXIT_CODE}" "137"
sleep 0.5
expect_eq "8: gateway taken down too" "$(http_code "http://127.0.0.1:${UPSTREAM_PORT}/")" "000"

echo
echo "${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
