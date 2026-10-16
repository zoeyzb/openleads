#!/bin/sh
# Standalone local Google Maps collector; no Redis, Railway or paid API.
set -eu
NAME=openleads-maps-local
PORT=18080
DATA="$HOME/lead-workspace/local-maps-data"
mkdir -p "$DATA"
if ! docker info >/dev/null 2>&1; then
  echo 'Docker not running. Start OrbStack first: orb start' >&2
  exit 2
fi
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "Already running: http://127.0.0.1:$PORT"
else
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" \
      --memory 2g --cpus 2 \
      -p "127.0.0.1:$PORT:8080" \
      -v "$DATA:/gmapsdata" \
      gosom/google-maps-scraper:latest -data-folder /gmapsdata >/dev/null
  fi
fi
printf 'Local Maps scraper: http://127.0.0.1:%s\n' "$PORT"
