#!/usr/bin/env bash
# Multiverse: start everything on macOS / Linux. Needs Python 3.11+ and Docker (running).
# Run:  bash run.sh      then open http://localhost:8765
set -e
cd "$(dirname "$0")"
if ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q '6380->6379'; then
  echo "Starting FalkorDB in Docker on port 6380..."
  docker run -d --rm --name multiverse-falkordb -p 6380:6379 -p 3001:3000 falkordb/falkordb:latest >/dev/null
  sleep 4
fi
python3 -m pip install -r requirements.txt
python3 check_setup.py
python3 world.py
python3 app.py