"""
Multiverse - the web console.

A thin layer over the same functions the command line and the MCP server use, so all three agree.
Live views are Server-Sent Events that read the MEMORY GRAPH, not this program's variables:
a rehearsal started by an AI agent through the MCP server streams here exactly like one started
from the console.

Run:  python app.py      then open  http://localhost:8765
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import uuid

import uvicorn
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

import ask as asker
import coordination
import evidence
import insights
import memory
import multiverse
import world as world_builder
from config import DEP_PATTERN, HERE, HOST, MAX_DEPTH, PORT as DB_PORT, WORLD, db
from plans import PlanError
from rehearse import drop, fingerprint
from scenarios import presets, two_agents

UI = HERE / "ui"
PORT = 8765
ACTOR = "console"
LINK_RE = re.compile(r"^(?P<a>\S+?)(?: -|\|)(?P<rel>[A-Z_]+)(?:-> |\|)(?P<b>\S+)$")
EXECUTIONS = {}          # rid -> result of an execution started from the console
AGENT_JOBS = {}          # job id -> {"lines": [...], "done": bool}


def ok(data, status=200):
    return JSONResponse(data, status_code=status)


def error(message, status=400):
    return JSONResponse({"error": message}, status_code=status)


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def body(request):
    try:
        return await request.json()
    except Exception:
        return {}


def guarded(fn):
    """Turn known errors into clean JSON answers instead of stack traces."""
    async def wrapper(request):
        try:
            return await fn(request)
        except PlanError as e:
            return error(str(e), 400)
        except PermissionError as e:
            return error(str(e), 403)
        except ValueError as e:
            return error(str(e), 400)
    return wrapper


# ----------------------------------------------------------------------------- world and status
def falkordb_version():
    try:
        for mod in db.connection.execute_command("MODULE", "LIST"):
            info = dict(zip(mod[::2], mod[1::2]))
            name = info.get(b"name", info.get("name"))
            if name in (b"graph", "graph"):
                v = int(info.get(b"ver", info.get("ver")))
                return f"{v // 10000}.{v // 100 % 100}.{v % 100}"
    except Exception:
        pass
    return "unknown"


def leftover_forks():
    running = {r["id"] for r in memory.list_rehearsals(100) if r.get("status") == "running"}
    out = []
    for name in db.list_graphs():
        if name.startswith(f"{WORLD}__"):
            rid = name.split("__")[1] if name.count("__") >= 2 else ""
            if rid not in running:
                out.append(name)
    return out


def world_payload():
    g = db.select_graph(WORLD)
    learned = memory.learned_links()
    meta = g.ro_query("MATCH (m:Meta) RETURN properties(m)").result_set
    nodes = []
    for name, labels, props, team in g.ro_query("""
            MATCH (a:Asset) OPTIONAL MATCH (a)-[:OWNED_BY]->(t:Team)
            RETURN a.name, labels(a), properties(a), t.name ORDER BY a.name""").result_set:
        p = dict(props)
        nodes.append({"name": name, "kind": next(l for l in labels if l != "Asset"), "owner": team,
                      **{k: p.get(k) for k in ("criticality", "source", "found_in", "schedule",
                                               "schedule_text", "duration_min", "capacity", "replicas",
                                               "cpu_m", "rps_per_core", "engine", "note", "image",
                                               "rotated_at")}})
    edges = []
    for a, rel, b, props in g.ro_query("""MATCH (a:Asset)-[r]->(b:Asset)
                                          RETURN a.name, type(r), b.name, properties(r)""").result_set:
        p = dict(props)
        fact = learned.get((a, rel, b))
        edges.append({"from": a, "to": b, "rel": rel, "key": p.get("key"),
                      "confidence": p.get("confidence", 1.0), "rule": p.get("rule"),
                      "soft": bool(p.get("soft")), "evidence": p.get("evidence", []),
                      "every_days": p.get("every_days"), "calls_per_request": p.get("calls_per_request"),
                      "answered": {"exists": fact[0], "by": fact[1]} if fact else None})
    return {"name": "Boutique Inc.", "meta": dict(meta[0][0]) if meta else {},
            "nodes": nodes, "edges": edges, "findings": insights.findings(),
            "fingerprint": fingerprint(g)}


async def index(_request):
    return FileResponse(UI / "index.html")


async def status(_request):
    def collect():
        g = db.select_graph(WORLD)
        meta = g.ro_query("MATCH (m:Meta) RETURN properties(m)").result_set
        return {"falkordb": {"version": falkordb_version(), "host": HOST, "port": DB_PORT},
                "algorithms": insights.available_algorithms(),
                "world": dict(meta[0][0]) if meta else None,
                "graphs": db.list_graphs(), "leftover_forks": leftover_forks(),
                "agents": memory.agents_seen(),
                "llm": {"configured": bool(os.environ.get("LLM_MODEL")),
                        "model": os.environ.get("LLM_MODEL", ""),
                        "base_url": os.environ.get("LLM_BASE_URL", "")}}
    return ok(await run_in_threadpool(collect))


async def world(_request):
    return ok(await run_in_threadpool(world_payload))


async def scenarios(_request):
    def collect():
        return {"presets": presets(), "two_agents": two_agents()}
    return ok(await run_in_threadpool(collect))


# ----------------------------------------------------------------------------- rehearsals
@guarded
async def rehearse_start(request):
    b = await body(request)
    rid = await run_in_threadpool(lambda: multiverse.start(
        b.get("plan"), by=b.get("by") or ACTOR, client="multiverse-console",
        seed=b.get("seed"), mode=b.get("mode", "decide"), futures=b.get("futures")))
    return ok({"rid": rid})


async def rehearsal_cancel(request):
    return ok({"cancelled": multiverse.cancel(request.path_params["rid"])})


async def rehearsals(_request):
    return ok(await run_in_threadpool(memory.list_rehearsals, 30))


async def rehearsal(request):
    r = await run_in_threadpool(memory.get_rehearsal, request.path_params["rid"])
    return ok(r) if r else error("No such rehearsal", 404)


def _meta(r):
    keep = ("id", "title", "by", "client", "seed", "mode", "exact", "status", "target_futures",
            "started", "kind", "snapshot", "fingerprint_before", "sources_of_chance")
    out = {k: r.get(k) for k in keep}
    for k in ("uncertainty", "windows", "changes", "launch"):
        try:
            out[k] = json.loads(r.get(k) or "null")
        except ValueError:
            out[k] = None
    out["plan"] = r.get("plan")
    out["now"] = r.get("now")
    try:
        out["prep_trace"] = json.loads(r.get("prep_trace") or "[]")
    except ValueError:
        out["prep_trace"] = []
    return out


def _slim(f):
    """What the live view needs per future: outcome, the copy it ran in, and what broke where."""
    return {"i": f["i"], "outcome": f["outcome"], "fork": f.get("fork"), "ms": f.get("ms"),
            "surge": f.get("surge"), "critical": f.get("critical", []), "hops": f.get("hops", 0),
            "dropped": len(f.get("dropped") or []), "affected": len(f.get("affected") or []),
            "hit": {a["name"]: a["status"] for a in f.get("affected") or []},
            "origins": f.get("disrupted") or {}}


async def rehearsal_stream(request):
    rid = request.path_params["rid"]

    async def events():
        r = await run_in_threadpool(memory.get_rehearsal, rid)
        if not r:
            yield sse("failed", {"error": "No such rehearsal"})
            return
        yield sse("meta", _meta(r))
        last_i, last_progress = 0, None
        while True:
            if await request.is_disconnected():
                return
            for f in await run_in_threadpool(memory.futures_since, rid, last_i, 400):
                last_i = f["i"]
                yield sse("future", _slim(f))
            r = await run_in_threadpool(memory.get_rehearsal, rid)
            progress = (r.get("futures"), r.get("critical"))
            if progress != last_progress:
                last_progress = progress
                yield sse("progress", {k: r.get(k) for k in ("futures", "critical", "p_crit", "low", "high",
                                                             "target_futures", "status")})
            if r.get("status") in ("done", "failed"):
                for f in await run_in_threadpool(memory.futures_since, rid, last_i, 2000):
                    yield sse("future", _slim(f))
                if r["status"] == "done":
                    yield sse("done", r.get("summary") or {})
                else:
                    yield sse("failed", {"error": r.get("error", "failed")})
                return
            await asyncio.sleep(0.12)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def future_detail(request):
    f = await run_in_threadpool(memory.get_future, request.path_params["rid"], request.path_params["i"])
    return ok(f) if f else error("No such future", 404)


@guarded
async def future_replay(request):
    """Play one recorded future again in a fresh copy, with every FalkorDB command traced."""
    rid, i = request.path_params["rid"], request.path_params["i"]
    return ok(await run_in_threadpool(multiverse.replay, rid, i))


@guarded
async def execute(request):
    b = await body(request)
    ready = threading.Event()
    holder = {}

    def work():
        def on_ready(rid):
            holder["rid"] = rid
            ready.set()
        try:
            out = multiverse.execute(b.get("plan"), by=b.get("by") or ACTOR, client="multiverse-console",
                                     accept_minor=bool(b.get("accept_minor")), on_ready=on_ready)
            EXECUTIONS[holder["rid"]] = {"state": "done", **out}
        except Exception as e:                        # PlanError before on_ready, or a crash
            holder["error"] = e
            if "rid" in holder:
                EXECUTIONS[holder["rid"]] = {"state": "failed", "reason": str(e)}
        finally:
            ready.set()

    threading.Thread(target=work, daemon=True).start()
    await run_in_threadpool(ready.wait, 60)
    if "rid" not in holder:
        e = holder.get("error")
        if isinstance(e, ValueError):
            raise e
        return error(str(e) if e else "Execution did not start", 500)
    EXECUTIONS.setdefault(holder["rid"], {"state": "checking"})
    return ok({"rid": holder["rid"]})


async def execution(request):
    out = EXECUTIONS.get(request.path_params["rid"])
    return ok(out) if out else error("Unknown execution", 404)


# ----------------------------------------------------------------------------- memory
async def inbox(_request):
    return ok(await run_in_threadpool(memory.open_questions))


@guarded
async def answer(request):
    b = await body(request)
    m = LINK_RE.match(str(b.get("link", "")).strip())
    if not m:
        return error("Malformed link")
    closed = await run_in_threadpool(lambda: memory.confirm_link(
        m["a"], m["rel"], m["b"], exists=bool(b.get("exists")), by=b.get("team", ""), note=b.get("note", "")))
    return ok({"closed": closed})


async def memory_of(request):
    return ok(await run_in_threadpool(memory.history, request.query_params.get("name", "")))


# ----------------------------------------------------------------------------- insights
async def insights_summary(_request):
    return ok(await run_in_threadpool(insights.summary))


async def cleanup(_request):
    return ok(await run_in_threadpool(lambda: insights.cleanup(by="cleanup-finder", client="multiverse-console")))


async def launch_advice(request):
    q = request.query_params
    surge, p90 = float(q.get("surge", 3)), float(q.get("p90", 6))
    return ok(await run_in_threadpool(multiverse.launch_advice, surge, p90))


async def sources_asset(request):
    try:
        return ok(await run_in_threadpool(evidence.asset_sources, request.query_params.get("name", "")))
    except ValueError as e:
        return error(str(e), 404)


async def sources_link(request):
    try:
        return ok(await run_in_threadpool(evidence.link_sources, request.query_params.get("key", "")))
    except ValueError as e:
        return error(str(e), 404)


async def sources_line(request):
    q = request.query_params
    try:
        return ok(await run_in_threadpool(evidence.file_excerpt, q.get("file", ""), int(q.get("line", "1"))))
    except ValueError as e:
        return error(str(e), 404)


def search_assets(text):
    """FalkorDB full-text index over each asset's name, kind, owner and description."""
    words = [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 2]
    if not words:
        return {"query": "", "how": "", "results": []}
    g = db.select_graph(WORLD)
    query = " ".join(f"{w}*" for w in words)
    try:
        rows = g.ro_query("""CALL db.idx.fulltext.queryNodes('Asset', $q) YIELD node, score
                             RETURN node.name, labels(node), node.note, score
                             ORDER BY score DESC LIMIT 12""", {"q": query}).result_set
        how = "FalkorDB full-text index"
    except Exception:
        rows = g.ro_query("""MATCH (a:Asset) WHERE a.search CONTAINS $q
                             RETURN a.name, labels(a), a.note, 1.0 LIMIT 12""", {"q": text.lower()}).result_set
        how = "CONTAINS (no full-text index)"
    return {"query": query, "how": how,
            "results": [{"name": n, "kind": next((l for l in labels if l != "Asset"), "Asset"),
                         "note": note or "", "score": round(score, 2)} for n, labels, note, score in rows]}


async def search(request):
    return ok(await run_in_threadpool(search_assets, request.query_params.get("q", "")))


PATH_QUERY = (f"MATCH (x:Asset {{name: $a}}), (y:Asset {{name: $b}}) "
              f"WITH shortestPath((x)-[:{DEP_PATTERN}*1..{MAX_DEPTH}]->(y)) AS p "
              f"WHERE p IS NOT NULL RETURN [n IN nodes(p) | n.name], [r IN relationships(p) | r.key]")


def find_path(a, b):
    """Shortest dependency path between two assets, in either direction (Cypher shortestPath)."""
    g = db.select_graph(WORLD)
    for x, y, direction in ((a, b, f"{a} depends on {b}"), (b, a, f"{b} depends on {a}")):
        rows = g.ro_query(PATH_QUERY, {"a": x, "b": y}).result_set
        if rows:
            return {"names": rows[0][0], "keys": rows[0][1], "direction": direction, "cypher": PATH_QUERY}
    return {"names": [], "keys": [], "direction": None, "cypher": PATH_QUERY}


async def path(request):
    q = request.query_params
    return ok(await run_in_threadpool(find_path, q.get("a", ""), q.get("b", "")))


async def ask_graph(request):
    question = (await body(request)).get("question", "")
    try:
        return ok(await run_in_threadpool(asker.ask, question))
    except ValueError as e:
        return error(str(e), 400)
    except Exception as e:                            # the model or the query failed
        return error(str(e), 502)


async def agents(_request):
    return ok(await run_in_threadpool(memory.agents_seen))


# ----------------------------------------------------------------------------- coordination
async def plans_list(_request):
    return ok(await run_in_threadpool(coordination.list_plans, 40))


@guarded
async def plans_propose(request):
    b = await body(request)
    agent = (b.get("agent") or "").strip() or "console-agent"
    return ok(await run_in_threadpool(lambda: coordination.propose(b.get("plan"), agent,
                                                                   client="multiverse-console")))


@guarded
async def plans_execute(request):
    b = await body(request)
    return ok(await run_in_threadpool(lambda: coordination.execute_plan(
        request.path_params["pid"], b.get("agent", ""), client="multiverse-console",
        accept_minor=bool(b.get("accept_minor")))))


@guarded
async def plans_cancel(request):
    b = await body(request)
    return ok(await run_in_threadpool(coordination.cancel, request.path_params["pid"], b.get("agent", ACTOR)))


@guarded
async def safe_window(request):
    b = await body(request)
    return ok(await run_in_threadpool(lambda: coordination.safe_window(
        b.get("plan"), agent=b.get("agent") or ACTOR, client="multiverse-console")))


# ----------------------------------------------------------------------------- live activity
async def activity_stream(request):
    async def events():
        last_at = ""
        seen = {}
        last_fp = None
        tick = 0
        backlog = await run_in_threadpool(memory.activity_since, "", 500)
        for c in backlog[-30:]:
            yield sse("call", c)
        if backlog:
            last_at = backlog[-1]["at"]
        while True:
            if await request.is_disconnected():
                return
            for c in await run_in_threadpool(memory.activity_since, last_at, 50):
                last_at = c["at"]
                yield sse("call", c)
            for r in await run_in_threadpool(memory.list_rehearsals, 12):
                state = (r.get("status"), r.get("decision_status"))
                if seen.get(r["id"]) != state:
                    first_time = r["id"] not in seen
                    seen[r["id"]] = state
                    if tick or not first_time:
                        yield sse("rehearsal", {k: r.get(k) for k in (
                            "id", "title", "by", "client", "status", "verdict", "decision_status",
                            "p_crit", "futures", "kind", "started", "exact")})
            if tick % 4 == 0:
                fp = await run_in_threadpool(lambda: fingerprint(db.select_graph(WORLD)))
                if last_fp and fp != last_fp:
                    yield sse("world", {"fingerprint": fp})
                last_fp = fp
            tick += 1
            await asyncio.sleep(0.6)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ----------------------------------------------------------------------------- AI agent runner
async def agent_run(request):
    if not os.environ.get("LLM_MODEL"):
        return error("Set LLM_MODEL (and LLM_API_KEY, LLM_BASE_URL) in this window before "
                     "starting the console to run an AI agent from here.", 400)
    task = (await body(request)).get("task", "").strip()
    if not task:
        return error("Write a task for the agent")
    job = uuid.uuid4().hex[:8]
    AGENT_JOBS[job] = {"lines": [], "done": False}

    def work():
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}   # Windows-safe output
        proc = subprocess.Popen([sys.executable, "-u", str(HERE / "agent.py"), task], cwd=HERE, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace")
        for line in proc.stdout:
            AGENT_JOBS[job]["lines"].append(line.rstrip("\n"))
        proc.wait()
        AGENT_JOBS[job]["done"] = True
        AGENT_JOBS[job]["code"] = proc.returncode

    threading.Thread(target=work, daemon=True).start()
    return ok({"job": job})


async def agent_stream(request):
    job = AGENT_JOBS.get(request.path_params["job"])
    if not job:
        return error("Unknown job", 404)

    async def events():
        sent = 0
        while True:
            if await request.is_disconnected():
                return
            lines = job["lines"]
            while sent < len(lines):
                yield sse("line", {"text": lines[sent]})
                sent += 1
            if job["done"] and sent >= len(job["lines"]):
                yield sse("done", {"code": job.get("code")})
                return
            await asyncio.sleep(0.15)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ----------------------------------------------------------------------------- maintenance
async def reset_demo(_request):
    def work():
        for name in leftover_forks():
            drop(name)
        report = world_builder.build()
        memory.reset()
        EXECUTIONS.clear()
        return {"ok": True, "nodes": report["nodes"], "links": report["links"]}
    return ok(await run_in_threadpool(work))


async def cleanup_forks(_request):
    def work():
        names = leftover_forks()
        for name in names:
            drop(name)
        return {"deleted": names}
    return ok(await run_in_threadpool(work))


app = Starlette(routes=[
    Route("/", index),
    Route("/api/status", status),
    Route("/api/world", world),
    Route("/api/scenarios", scenarios),
    Route("/api/rehearse", rehearse_start, methods=["POST"]),
    Route("/api/rehearsals", rehearsals),
    Route("/api/rehearsals/{rid}", rehearsal),
    Route("/api/rehearsals/{rid}/stream", rehearsal_stream),
    Route("/api/rehearsals/{rid}/cancel", rehearsal_cancel, methods=["POST"]),
    Route("/api/rehearsals/{rid}/futures/{i:int}", future_detail),
    Route("/api/rehearsals/{rid}/futures/{i:int}/replay", future_replay, methods=["POST"]),
    Route("/api/sources/asset", sources_asset),
    Route("/api/sources/link", sources_link),
    Route("/api/sources/line", sources_line),
    Route("/api/search", search),
    Route("/api/path", path),
    Route("/api/ask", ask_graph, methods=["POST"]),
    Route("/api/agents", agents),
    Route("/api/execute", execute, methods=["POST"]),
    Route("/api/executions/{rid}", execution),
    Route("/api/inbox", inbox),
    Route("/api/answer", answer, methods=["POST"]),
    Route("/api/memory", memory_of),
    Route("/api/insights", insights_summary),
    Route("/api/cleanup", cleanup, methods=["POST"]),
    Route("/api/launch-advice", launch_advice),
    Route("/api/plans", plans_list),
    Route("/api/plans/propose", plans_propose, methods=["POST"]),
    Route("/api/plans/{pid}/execute", plans_execute, methods=["POST"]),
    Route("/api/plans/{pid}/cancel", plans_cancel, methods=["POST"]),
    Route("/api/safe-window", safe_window, methods=["POST"]),
    Route("/api/activity/stream", activity_stream),
    Route("/api/agent/run", agent_run, methods=["POST"]),
    Route("/api/agent/{job}/stream", agent_stream),
    Route("/api/reset", reset_demo, methods=["POST"]),
    Route("/api/cleanup-forks", cleanup_forks, methods=["POST"]),
    Mount("/static", StaticFiles(directory=UI), name="static"),
])

if __name__ == "__main__":
    if WORLD not in db.list_graphs():                    # e.g. FalkorDB was restarted and is empty
        print("The company graph is missing: building it from the evidence files...")
        world_builder.build()
    print(f"Multiverse console: http://localhost:{PORT}   (FalkorDB at {HOST}:{DB_PORT})")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
