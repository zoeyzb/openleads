#!/bin/bash
set -euo pipefail
VENDOR="$HOME/lead-workspace/openleads-vendors/harvey"
if [[ ! -x "$VENDOR/.venv/bin/harvey" || ! -x "$VENDOR/.harvey-codex-cli/node_modules/.bin/codex" ]]; then
  echo "Harvey's isolated tools are not installed." >&2
  exit 1
fi
export PATH="$VENDOR/.harvey-codex-cli/node_modules/.bin:$PATH"
cd "$VENDOR"
exec "$VENDOR/.venv/bin/harvey" "$@"
