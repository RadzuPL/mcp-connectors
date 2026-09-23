#!/bin/sh
set -e
# Buduje nagłówek Basic Auth z osobnych zmiennych - unika ręcznego
# kodowania base64 i ryzyka uciętego/zdublowanego znaku przy wklejaniu.
AUTH="Basic $(printf '%s:%s' "$GLANCES_USER" "$GLANCES_PASSWORD" | base64 -w0)"
exec mcp-proxy --headers Authorization "$AUTH" "$GLANCES_SSE_URL"
