#!/usr/bin/env bash
# Start FastAPI for local `npm run dev` (the Next rewrites need something on :8000).
# Usage from the repo root: ./scripts/dev-api.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1090
  source .env
  set +a
fi
: "${CLERK_JWKS_URL:?Set CLERK_JWKS_URL in .env}"
if [[ -z "${OPENROUTER_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Set OPENROUTER_API_KEY and/or OPENAI_API_KEY in .env (at least one)" >&2
  exit 1
fi
cd "${ROOT}/backend"
PY="${PYTHON:-python3}"
exec "$PY" -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
