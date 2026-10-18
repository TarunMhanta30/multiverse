"""
Multiverse - insights from FalkorDB's built-in graph algorithms.

  chokepoints()  algo.betweenness  assets the most dependency paths run through
                                   (touch these and many things are at risk)
  foundations()  algo.pageRank     assets everything ultimately leans on
  islands()      algo.WCC          groups of assets connected to nothing else
  cleanup()      cleanup candidates found with the graph, then each one checked with a real
                 rehearsal - so "safe to delete" is never a guess
  findings()     problems found in the evidence (e.g. config drift in the real Kubernetes file)
"""
from datetime import date

from config import DEP_PATTERN, DEP_RELS, WORLD, db

IDLE_DAYS = 90       # a hand-run job unused for this long is a cleanup candidate


def _g(world):
    return db.select_graph(world)


def available_algorithms(world=WORLD):
    try:
        rows = _g(world).ro_query("CALL dbms.procedures() YIELD name RETURN name").result_set
        return sorted(r[0] for r in rows if r[0].startswith("algo."))
    except Exception:
        return []


def _owners(g):
    return dict(g.ro_query("MATCH (a:Asset)-[:OWNED_BY]->(t:Team) RETURN a.name, t.name").result_set)


def chokepoints(top=6, world=WORLD):
    g = _g(world)
    rows = g.ro_query("""CALL algo.betweenness({nodeLabels: ['Asset'], relationshipTypes: $rels})
                         YIELD node, score
                         RETURN node.name, node.criticality, score ORDER BY score DESC LIMIT $n""",
                      {"rels": list(DEP_RELS), "n": top}).result_set
    owners = _owners(g)
    return [{"name": n, "criticality": c, "score": round(s, 1), "owner": owners.get(n)}
            for n, c, s in rows if s > 0]


def foundations(top=6, world=WORLD):
    g = _g(world)
    rows = g.ro_query("""CALL algo.pageRank('Asset', null) YIELD node, score
                         RETURN node.name, node.criticality, score ORDER BY score DESC LIMIT $n""",
                      {"n": top}).result_set
    owners = _owners(g)
    return [{"name": n, "criticality": c, "score": round(s, 4), "owner": owners.get(n)} for n, c, s in rows]


def islands(world=WORLD):
    """Connected groups of assets, smallest first, leaving out the big main group."""
    rows = _g(world).ro_query("""CALL algo.WCC({nodeLabels: ['Asset'], relationshipTypes: $rels})
                                 YIELD node, componentId
                                 RETURN componentId, collect(node.name)""",
                              {"rels": list(DEP_RELS)}).result_set
    groups = sorted((sorted(names) for _cid, names in rows), key=len)
    return groups[:-1] if len(groups) > 1 else []


def cleanup_candidates(world=WORLD):
    """Assets that look removable, each with the graph evidence for why."""
    g = _g(world)
    found = {}
    try:
        groups = islands(world)
    except Exception:                           # no algo.WCC on this FalkorDB: skip islands
        groups = []
    for group in groups:
        for name in group:
            if len(group) == 1:
                found[name] = "Connected to nothing (algo.WCC: an island of one)"
    for name, confs in g.ro_query(f"""
            MATCH (a:Asset) WHERE a.criticality < 3
            MATCH (x:Asset)-[r:{DEP_PATTERN}]->(a)
            WITH a, collect(r.confidence) AS confs
            WHERE all(c IN confs WHERE c < 1)
            RETURN a.name, confs""").result_set:
        found.setdefault(name, f"Only {len(confs)} uncertain dependent(s), none confirmed")
    today = date.today()
    for name, last in g.ro_query(f"""
            MATCH (j:Job) WHERE j.schedule = '' AND j.criticality < 3
            MATCH (j)-[r:{DEP_PATTERN}]->()
            WITH j, max(r.last_used) AS last
            WHERE last IS NOT NULL AND last <> ''
            RETURN j.name, last""").result_set:
        idle = (today - date.fromisoformat(last)).days
        if idle >= IDLE_DAYS:
            found.setdefault(name, f"Hand-run job, last ran {idle} days ago")
    owners = _owners(g)
    return [{"name": n, "why": w, "owner": owners.get(n)} for n, w in sorted(found.items())]


def cleanup(by="cleanup-finder", client="", world=WORLD):
    """Find candidates, then rehearse deleting each one. Returns candidates with verdicts."""
    from multiverse import rehearse
    out = []
    for c in cleanup_candidates(world):
        s = rehearse({"title": f"Delete {c['name']}", "steps": [{"action": "delete", "asset": c["name"]}]},
                     by=by, client=client, kind="cleanup check", world=world)
        out.append({**c, "verdict": s["verdict"], "p_crit": s["p_crit"], "futures": s["futures"],
                    "exact": s["exact"], "rid": s["rid"],
                    "affected": [a["name"] for a in s["affected"]],
                    "waiting_for": sorted({u["ask"] for u in s["unverified"]})})
    return out


def findings(world=WORLD):
    rows = _g(world).ro_query("MATCH (f:Finding)-[:ABOUT]->(a) RETURN f.kind, f.detail, a.name").result_set
    return [{"kind": k, "detail": d, "asset": a} for k, d, a in rows]


def _safely(fn, problems, name):
    try:
        return fn()
    except Exception as e:                      # e.g. an older FalkorDB with different options
        problems.append(f"{name}: {e}")
        return []


def summary(world=WORLD):
    """Everything above except the (slower) cleanup rehearsals."""
    algos = available_algorithms(world)
    problems = []
    out = {"algorithms": algos, "findings": findings(world)}
    out["chokepoints"] = _safely(lambda: chokepoints(world=world), problems, "algo.betweenness") \
        if "algo.betweenness" in algos else []
    out["foundations"] = _safely(lambda: foundations(world=world), problems, "algo.pageRank") \
        if "algo.pageRank" in algos else []
    out["islands"] = _safely(lambda: islands(world), problems, "algo.WCC") if "algo.WCC" in algos else []
    out["candidates"] = _safely(lambda: cleanup_candidates(world), problems, "cleanup candidates")
    out["problems"] = problems
    return out
