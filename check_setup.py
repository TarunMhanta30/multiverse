"""
Multiverse - check that this computer is ready. Prints OK / PROBLEM lines with the fix for each.

Run:  python check_setup.py
"""
import importlib
import sys
from importlib import metadata

problems = 0


def report(ok, what, fix=""):
    global problems
    print(f"  {'OK     ' if ok else 'PROBLEM'}  {what}")
    if not ok:
        problems += 1
        if fix:
            print(f"           fix: {fix}")


print(f"Python {sys.version.split()[0]} at {sys.executable}")
report(sys.version_info >= (3, 11), "Python 3.11 or newer", "install a newer Python")

print("\nPackages:")
for module, dist, pip_name in (("falkordb", "falkordb", "falkordb"), ("mcp", "mcp", "mcp"),
                               ("yaml", "pyyaml", "pyyaml"), ("starlette", "starlette", "mcp"),
                               ("uvicorn", "uvicorn", "mcp"), ("pydantic", "pydantic", "mcp")):
    try:
        importlib.import_module(module)
        report(True, f"{module} {metadata.version(dist)}")
    except ImportError:
        report(False, f"{module} is missing", f"python -m pip install {pip_name}")

print("\nFalkorDB:")
try:
    from config import HOST, MEMORY, PORT, WORLD, db
    db.connection.ping()
    report(True, f"reachable at {HOST}:{PORT}")
    version = "?"
    for mod in db.connection.execute_command("MODULE", "LIST"):
        info = dict(zip(mod[::2], mod[1::2]))
        if info.get(b"name", info.get("name")) in (b"graph", "graph"):
            v = int(info.get(b"ver", info.get("ver")))
            version = f"{v // 10000}.{v // 100 % 100}.{v % 100}"
    report(True, f"FalkorDB module {version}")
    probe = db.select_graph("multiverse_setup_probe")
    probe.query("CREATE (:Probe {n: 1})")
    copy = probe.copy("multiverse_setup_probe_copy")
    copied = copy.ro_query("MATCH (p:Probe) RETURN count(p)").result_set[0][0] == 1
    copy.delete()
    probe.delete()
    report(copied, "GRAPH.COPY works (every future is a copy)", "use a FalkorDB version with GRAPH.COPY")
    graphs = db.list_graphs()
    report(WORLD in graphs, f"world graph '{WORLD}' exists", "python world.py")
    print(f"  info     memory graph '{MEMORY}' {'exists' if MEMORY in graphs else 'will be created on first use'}")
    leftovers = [g for g in graphs if g.startswith(f"{WORLD}__")]
    report(not leftovers, f"no leftover copies ({len(leftovers)} found)",
           "click Reset demo in the console, or restart FalkorDB")
    if WORLD in graphs:
        algos = sorted(r[0] for r in db.select_graph(WORLD).ro_query(
            "CALL dbms.procedures() YIELD name RETURN name").result_set if r[0].startswith("algo."))
        need = {"algo.betweenness", "algo.pageRank", "algo.WCC"}
        report(need <= set(algos), f"graph algorithms: {', '.join(algos) or 'none'}",
               "Insights needs algo.betweenness, algo.pageRank and algo.WCC: update the FalkorDB image")
except Exception as e:
    report(False, f"cannot use FalkorDB: {e}",
           "start it: docker run -p 6380:6379 -p 3001:3000 -it --rm falkordb/falkordb:latest")

print("\nAll good." if not problems else f"\n{problems} problem(s) to fix first.")
