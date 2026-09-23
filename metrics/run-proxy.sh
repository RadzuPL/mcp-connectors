#!/bin/sh
set -e
# Build the Basic Auth header from separate variables instead of a
# pre-encoded secret - avoids manual base64 encoding and the risk of a
# truncated or duplicated character when pasting one in by hand.
AUTH="Basic $(printf '%s:%s' "$GLANCES_USER" "$GLANCES_PASSWORD" | base64 -w0)"
exec mcp-proxy --headers Authorization "$AUTH" "$GLANCES_SSE_URL"
