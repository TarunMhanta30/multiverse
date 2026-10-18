"""
Multiverse - connect Claude Desktop to Multiverse, so Claude itself becomes the agent.

It adds one entry, "multiverse", to Claude Desktop's MCP config (keeping everything else, and
saving a backup first). Claude Desktop then starts mcp_server.py itself and can call its tools.

Run:              python connect_claude.py
Only print it:    python connect_claude.py --print     (to paste via Settings > Developer > Edit Config)

Then fully quit Claude Desktop (also from the system tray) and open it again.
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

from config import HERE, HOST, PORT


def config_path():
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    return Path.home() / ".config" / "Claude" / "claude_desktop_config.json"


def entry():
    return {"command": sys.executable, "args": [str(HERE / "mcp_server.py")],
            "env": {"FALKORDB_HOST": HOST, "FALKORDB_PORT": str(PORT)}}


def main():
    block = {"mcpServers": {"multiverse": entry()}}
    if "--print" in sys.argv:
        print(json.dumps(block, indent=2))
        return
    path = config_path()
    config = {}
    if path.exists():
        try:
            config = json.loads(path.read_text(encoding="utf-8") or "{}")
        except ValueError:
            print(f"{path} is not valid JSON, so it was left alone. Fix it, or paste this by hand:\n")
            print(json.dumps(block, indent=2))
            sys.exit(1)
        backup = path.with_name(f"claude_desktop_config.backup-{time.strftime('%Y%m%d-%H%M%S')}.json")
        shutil.copy2(path, backup)
        print(f"Backup saved: {backup}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    config.setdefault("mcpServers", {})["multiverse"] = entry()
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(f"Added 'multiverse' to {path}")
    print(json.dumps({"multiverse": entry()}, indent=2))
    print("""
Next:
  1. Fully quit Claude Desktop (right-click its icon in the system tray > Quit) and open it again.
  2. Keep FalkorDB running in Docker, and keep  python app.py  open to watch it live.
  3. In a new chat, try:
       "Use Multiverse to clean up Boutique Inc. Delete orders_archive, nobody uses it."
       "Can we take orders_replica offline on the 1st from 01:00 to 04:00?"
       "We expect 3x traffic for a sale, maybe 6x. What breaks, and what should we scale?"
If it does not show up: Claude Desktop > Settings > Developer shows the server's status, and
its logs are in %APPDATA%\\Claude\\logs (mcp-server-multiverse.log).""")


if __name__ == "__main__":
    main()
