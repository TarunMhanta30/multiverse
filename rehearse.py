"""
Multiverse - play ONE future inside its own copy of the company.

  1. copy the snapshot (FalkorDB GRAPH.COPY)            -> the real company is never touched
  2. delete the links that don't exist in this future   -> uncertainty, decided by the dice
  3. mark what the plan disrupts                        -> deleted / offline / rotated / overloaded
  4. let the failure ripple one hop at a time, against the dependency arrows,
     using only links that are really in use during the disruption window
                                                         -> broken, stale or degraded, and why
  5. write the statuses into the copy, read them back as the result, delete the copy

Also here, because they work on graphs directly:
  fork()            GRAPH.COPY with a lock and retries (FalkorDB makes one copy at a time)
  fingerprint()     a hash of every node, link and property - proves the real world is unchanged
  apply_changes()   the Cypher for plan changes; the SAME code edits a copy during a rehearsal
                    and the real world during execution, so what runs is what was rehearsed
"""
import hashlib
import json
import random
import threading
import time

from redis.exceptions import ResponseError

from config import DEP_PATTERN, DEP_RELS, MAX_DEPTH, db
from plans import link_key
from schedules import describe as describe_schedule

ORIGINS = ("deleted", "offline", "rotated", "overloaded")
RANK = {"degraded": 1, "stale": 2, "broken": 3}
_copy_lock = threading.Lock()


# ----------------------------------------------------------------------------- graph helpers
def fork(graph, name, attempts=200):
    """GRAPH.COPY `graph` to `name`. FalkorDB copies by forking its process and refuses a second
    copy while one is running ("could not fork"), so copies wait for each other - inside this
    program with a lock, across programs (console + MCP server) by retrying."""
    for _ in range(attempts):
        try:
            with _copy_lock:
                return graph.copy(name)
        except ResponseError as e:
            if "fork" not in str(e).lower():
                raise
            time.sleep(0.02 + random.random() * 0.08)
    raise RuntimeError("FalkorDB stayed busy copying graphs for too long; try again")


def drop(name):
    try:
        db.select_graph(name).delete()
    except Exception:
        pass


def fingerprint(graph):
    """SHA-256 over every node (labels + properties) and every link (ends, type, properties)."""
    nodes = graph.ro_query("MATCH (n) RETURN labels(n), properties(n)").result_set
    links = graph.ro_query("MATCH (a)-[r]->(b) RETURN a.name, type(r), b.name, properties(r)").result_set
    canon = sorted(json.dumps([sorted(l), dict(p)], sort_keys=True, default=str) for l, p in nodes)
    canon += sorted(json.dumps([a, t, b, dict(p)], sort_keys=True, default=str) for a, t, b, p in links)
    return hashlib.sha256("\n".join(canon).encode()).hexdigest()


def apply_changes(graph, steps, real=False):
    """Apply a plan's change steps (and, when real=True, its deletes) to `graph`.
    Returns a list of {'kind', ...} describing what changed, for the console to draw."""
    changes = []
    for step in steps:
        a = step["action"]
        if a == "repoint":
            src, old, new = step["asset"], step["old"], step["new"]
            rows = graph.query("MATCH (s:Asset {name: $s})-[r]->(o:Asset {name: $o}) "
                               "WHERE type(r) IN $deps RETURN type(r), properties(r)",
                               {"s": src, "o": old, "deps": list(DEP_RELS)}).result_set
            for rel, props in rows:                       # rel comes from DEP_RELS: safe in f-string
                props = dict(props)
                props.update(key=link_key(src, rel, new), confidence=1.0, rule="plan",
                             evidence=list(props.get("evidence", [])) + [f"Repointed from {old} by a plan"])
                props.pop("runs_seen", None), props.pop("runs_used", None), props.pop("last_used", None)
                graph.query(f"MATCH (s:Asset {{name: $s}}), (n:Asset {{name: $n}}) "
                            f"CREATE (s)-[l:{rel}]->(n) SET l = $p", {"s": src, "n": new, "p": props})
                graph.query(f"MATCH (s:Asset {{name: $s}})-[r:{rel}]->(o:Asset {{name: $o}}) DELETE r",
                            {"s": src, "o": old})
                changes.append({"kind": "link_removed", "key": link_key(src, rel, old)})
                changes.append({"kind": "link_added", "key": link_key(src, rel, new),
                                "from": src, "to": new, "rel": rel})
        elif a == "reschedule":
            graph.query("MATCH (j:Job {name: $n}) SET j.schedule = $s, j.schedule_text = $t",
                        {"n": step["asset"], "s": step["schedule"], "t": describe_schedule(step["schedule"])})
            changes.append({"kind": "node_changed", "name": step["asset"],
                            "detail": f"now runs {describe_schedule(step['schedule'])}"})
        elif a == "scale":
            graph.query("MATCH (s:Asset {name: $n}) SET s.replicas = coalesce(s.replicas, 1) * $f, "
                        "s.capacity = s.capacity * $f", {"n": step["asset"], "f": step["factor"]})
            changes.append({"kind": "node_changed", "name": step["asset"],
                            "detail": f"capacity x{step['factor']:g}"})
        elif a == "add_service":
            name = step["asset"]
            capacity = round(step["cpu_m"] / 1000 * step["rps_per_core"], 1)
            graph.query("""MATCH (t:Team {name: $owner})
                           CREATE (s:Asset:Service {name: $n, criticality: $c, source: 'plan',
                                   found_in: 'plan', replicas: 1, cpu_m: $cpu, rps_per_core: $rps,
                                   capacity: $cap})-[:OWNED_BY]->(t)""",
                        {"owner": step["owner"], "n": name, "c": int(step["criticality"]),
                         "cpu": int(step["cpu_m"]), "rps": float(step["rps_per_core"]), "cap": capacity})
            entry = graph.ro_query("MATCH (a:Asset) WHERE a.name = 'frontend' RETURN a.name").result_set
            edges = [[name, target, float(per), False] for target, per in step.get("calls", {}).items()]
            if entry:
                edges.append(["frontend", name, float(step["entry_share"]), bool(step.get("soft", True))])
            graph.query("""UNWIND $rows AS r MATCH (a:Asset {name: r[0]}), (b:Asset {name: r[1]})
                           CREATE (a)-[:CALLS {key: r[0] + '|CALLS|' + r[1], confidence: 1.0,
                                   rule: 'plan', source: 'plan', calls_per_request: r[2], soft: r[3],
                                   every_days: 0.0, evidence: ['Added by a plan']}]->(b)""",
                        {"rows": edges})
            changes.append({"kind": "node_added", "name": name, "owner": step["owner"]})
            for src, dst, _per, _soft in edges:
                changes.append({"kind": "link_added", "key": link_key(src, "CALLS", dst),
                                "from": src, "to": dst, "rel": "CALLS"})
        elif a == "assume" and not real:                  # what-ifs only exist in rehearsals
            graph.query("MATCH ()-[r]->() WHERE r.key = $k SET r.confidence = $c, r.rule = 'assumed'",
                        {"k": step["link"], "c": step["confidence"]})
            changes.append({"kind": "link_assumed", "key": step["link"], "confidence": step["confidence"]})
        elif a == "delete" and real:
            graph.query("MATCH (a:Asset {name: $n}) DETACH DELETE a", {"n": step["asset"]})
            changes.append({"kind": "node_removed", "name": step["asset"]})
        elif a == "rotate_secret" and real:
            graph.query("MATCH (s:Secret {name: $n}) SET s.rotated_at = $at",
                        {"n": step["asset"], "at": time.strftime("%Y-%m-%dT%H:%M")})
            changes.append({"kind": "node_changed", "name": step["asset"], "detail": "rotated"})
    return changes


# ----------------------------------------------------------------------------- one future
RIPPLE_QUERY = f"""UNWIND $frontier AS f
MATCH (x:Asset)-[r:{DEP_PATTERN}]->(y:Asset {{name: f}})
WHERE NOT r.key IN $inactive
RETURN x.name, type(r), r.soft, r.key, y.name"""
DROP_QUERY = "MATCH ()-[r]->() WHERE r.key IN $keys DELETE r"
MARK_QUERY = ("UNWIND $rows AS r MATCH (a:Asset {name: r[0]}) "
              "SET a.status = r[1], a.via = r[2], a.via_rel = r[3]")
READ_QUERY = "MATCH (a:Asset) WHERE a.status IS NOT NULL RETURN a.name, a.status"


def _ms(t0):
    return round((time.perf_counter() - t0) * 1000, 2)


def ripple(graph, origins, inactive, trace=None):
    """Spread failure from `origins` ({name: status}) one hop at a time, against the arrows.
    `inactive` = keys of links not in use during this disruption's window (they carry nothing).
    Returns {name: [status, via, via_rel, via_key]} for every newly affected asset.
    If `trace` is a list, every hop's query and what it found are appended to it."""
    state = {}
    frontier = list(origins)
    for depth in range(MAX_DEPTH):
        if not frontier:
            break
        t0 = time.perf_counter()
        rows = graph.ro_query(RIPPLE_QUERY, {"frontier": frontier, "inactive": inactive}).result_set
        spreading, found = [], []
        for x, rel, soft, key, y in rows:
            if x in origins:
                continue
            y_status = "broken" if y in origins else state[y][0]
            if rel == "FED_BY" or y_status == "stale":
                new = "stale"              # data stops getting fresh; nothing errors yet
            elif soft:
                new = "degraded"           # works without it, just worse; does not spread
            else:
                new = "broken"
            current = state.get(x)
            if current is None or RANK[new] > RANK[current[0]]:
                state[x] = [new, y, rel, key]
                found.append([x, new, y, rel])
                if new != "degraded" and x not in spreading:
                    spreading.append(x)
        if trace is not None:
            trace.append({"step": "ripple", "hop": depth + 1, "query": RIPPLE_QUERY,
                          "params": {"frontier": list(frontier), "inactive": len(inactive)},
                          "rows": len(rows), "found": found, "ms": _ms(t0)})
        frontier = spreading
    return state


def explain(name, state, origins):
    """Follow the 'via' pointers back to the disrupted asset: names, link types and link keys."""
    names, rels, keys = [name], [], []
    seen = {name}
    while names[-1] not in origins:
        _status, via, rel, key = state[names[-1]]
        rels.append(rel)
        keys.append(key)
        names.append(via)
        if via in seen:
            break
        seen.add(via)
    return names, rels, keys


def play_future(snapshot, fork_name, dropped, disruptions, crit, trace=None):
    """Play one future. `disruptions` = [{'origins': {name: status}, 'inactive': [keys]}].
    Returns {'outcome', 'affected', 'disrupted', 'ms'}.
    If `trace` is a list, every FalkorDB command this future ran is appended to it, in order,
    with its timing - the console shows it as "the exact Cypher that ran"."""
    t0 = time.perf_counter()
    t = time.perf_counter()
    g = fork(snapshot, fork_name)                                         # 1. copy
    if trace is not None:
        trace.append({"step": "fork", "query": f"GRAPH.COPY {snapshot.name} {fork_name}", "ms": _ms(t)})
    try:
        if dropped:                                                        # 2. uncertainty
            t = time.perf_counter()
            res = g.query(DROP_QUERY, {"keys": dropped})
            if trace is not None:
                trace.append({"step": "dice", "query": DROP_QUERY, "params": {"keys": list(dropped)},
                              "rows": getattr(res, "relationships_deleted", None), "ms": _ms(t)})
        elif trace is not None:
            trace.append({"step": "dice", "query": "(nothing to remove: every uncertain link is real "
                                                   "in this future)", "params": {"keys": []}, "rows": 0, "ms": 0})
        origins_all, state_all, why = {}, {}, {}
        for d in disruptions:                                              # 3 + 4
            origins = d["origins"]
            if not origins:
                continue
            origins_all.update(origins)
            if trace is not None:
                trace.append({"step": "disrupt", "origins": dict(origins), "inactive": list(d["inactive"])})
            state = ripple(g, origins, d["inactive"], trace)
            for name, entry in state.items():
                if name in origins_all:
                    continue
                if name not in state_all or RANK[entry[0]] > RANK[state_all[name][0]]:
                    state_all[name] = entry
                    why[name] = explain(name, state, origins)
        rows = ([[n, s, n, ""] for n, s in origins_all.items()] +
                [[n, e[0], e[1], e[2]] for n, e in state_all.items()])
        if rows:                                                           # 5. into the copy...
            t = time.perf_counter()
            res = g.query(MARK_QUERY, {"rows": rows})
            if trace is not None:
                trace.append({"step": "mark", "query": MARK_QUERY, "rows": len(rows),
                              "props": getattr(res, "properties_set", None), "ms": _ms(t)})
        t = time.perf_counter()
        diff = g.ro_query(READ_QUERY).result_set                           # ...and back out
        if trace is not None:
            trace.append({"step": "read", "query": READ_QUERY, "rows": len(diff), "ms": _ms(t)})
    finally:
        t = time.perf_counter()
        g.delete()
        if trace is not None:
            trace.append({"step": "drop", "query": f"GRAPH.DELETE {fork_name}", "ms": _ms(t)})

    affected = []
    for name, status in diff:
        if status in ("deleted", "overloaded") or status in RANK:
            if status == "deleted" and crit.get(name, 1) < 3:
                continue                   # deleting a non-critical asset is the intended change
            names, rels, keys = why.get(name, ([name], [], []))
            affected.append({"name": name, "status": status, "path": names, "rels": rels, "keys": keys})
    critical = any(a["status"] in ("broken", "overloaded", "deleted") and crit.get(a["name"], 1) == 3
                   for a in affected)
    outcome = "critical" if critical else ("minor" if affected else "clear")
    return {"outcome": outcome, "affected": affected, "disrupted": origins_all,
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


def path_text(names, rels):
    out = names[0]
    for rel, name in zip(rels, names[1:]):
        out += f" -{rel}-> {name}"
    return out
