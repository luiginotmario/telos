#!/bin/sh
# Refresh the CelesTrak GP data behind the Earth orbit layer, then rebuild public/orbits.
# CelesTrak updates every 2 h and refuses repeat downloads inside that window.
set -e
cd "$(dirname "$0")/../.."
mkdir -p research/raw/celestrak
for g in active stations fengyun-1c-debris iridium-33-debris cosmos-2251-debris cosmos-1408-debris; do
  curl -sf -o "research/raw/celestrak/$g.json.new" "https://celestrak.org/NORAD/elements/gp.php?GROUP=$g&FORMAT=json" \
    && head -c 1 "research/raw/celestrak/$g.json.new" | grep -q '\[' \
    && mv "research/raw/celestrak/$g.json.new" "research/raw/celestrak/$g.json" \
    || { echo "kept previous $g"; rm -f "research/raw/celestrak/$g.json.new"; }
  sleep 2
done
python3 -I research/scripts/orbits.py research/raw/celestrak public/orbits
