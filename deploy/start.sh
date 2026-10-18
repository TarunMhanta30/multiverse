#!/usr/bin/env bash
# Start FalkorDB inside the container, build the company graph, then the console.
set -e
cd "$(dirname "$0")/.."
PKG=$(python -c "import os, redislite; print(os.path.dirname(redislite.__file__))")
LIBS="$PKG/../falkordblite.libs"
DB_PORT="${FALKORDB_PORT:-6380}"
echo "Starting FalkorDB on port $DB_PORT"
LD_LIBRARY_PATH="$LIBS:${LD_LIBRARY_PATH:-}" "$PKG/bin/redis-server" --port "$DB_PORT" --bind 127.0.0.1 \
  --loadmodule "$PKG/bin/falkordb.so" --save "" --appendonly no --dir /tmp &
for i in $(seq 1 60); do
  if python -c "from config import db; db.connection.ping()" 2>/dev/null; then break; fi
  sleep 0.5
done
python world.py
exec python app.py