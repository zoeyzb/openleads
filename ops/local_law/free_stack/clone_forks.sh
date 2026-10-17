#!/bin/sh
# Optional on-demand checkout of owned forks outside of OpenLeads/Git.
# No Git submodules, vendor blobs, automatic execution or network evasion.
set -eu
BASE="${OPENLEADS_FORKS_DIR:-$HOME/lead-workspace/openleads-forks}"
case "${1:-}" in
  searxng|yacy_search_server|google-maps-scraper|stormcrawler|cdx_toolkit) name="$1" ;;
  *) echo "Usage: sh $0 searxng|yacy_search_server|google-maps-scraper|stormcrawler|cdx_toolkit" >&2; exit 2 ;;
esac
mkdir -p "$BASE"
if [ -d "$BASE/$name/.git" ]; then
  printf 'Already present: %s\n' "$BASE/$name"
else
  git clone --depth 1 --filter=blob:none "https://github.com/zoeyzb/$name.git" "$BASE/$name"
fi
printf 'Fork source checkout: %s\n' "$BASE/$name"
