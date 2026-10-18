"""
Multiverse - coordination between AI agents ("air traffic control").

Agents PROPOSE plans instead of acting. For every proposal Multiverse:
  1. rehearses the plan on its own
  2. finds active plans that overlap it - in time (their windows overlap) AND in the graph
     (they touch the same assets, or assets that depend on them) - with one Cypher query on memory
  3. rehearses the new plan TOGETHER with each overlapping plan, because two plans that are each
     safe alone can be dangerous together
  4. approves it (the agent now holds those assets for that window), holds it (a conflict - with
     the earliest safe time slot when the plan has a time window), or blocks it (unsafe on its own)
An agent may execute only its own approved plan, and execution re-checks everything first.

Memory graph:
  (:Plan {id, title, steps, agent, client, status, window_start, window_end, created, reason, ...})
      -[:PROPOSED_BY]->(:Agent)   -[:TOUCHES]->(:Asset)   -[:REHEARSED_IN]->(:Rehearsal)
      -[:CONFLICTS_WITH {rid, p_joint}]->(:Plan)
Plan status: approved -> executed (permanent change done) or booked (time window reserved),
             held (clashes with another plan), blocked (unsafe alone), cancelled.
"""
import json
from datetime import datetime, timedelta

import memory
from config import SAFETY_LINE, WORLD, db
from multiverse import execute, rehearse, upstream
from plans import combine, describe, named_assets, parse_time, plan_window, validate
from schedules import runs_overlapping

ACTIVE = ("approved", "booked")
SEARCH_DAYS = 7


def _lite(s):
    """The parts of a rehearsal summary worth keeping on a plan."""
    return {"rid": s["rid"], "verdict": s["verdict"], "p_crit": s["p_crit"], "futures": s["futures"],
            "exact": s["exact"], "affected": [a["name"] for a in s["affected"] if a["critical"]] or
            [a["name"] for a in s["affected"]], "title": s["title"]}


def blast_radius(plan, world=WORLD):
    """Assets a plan names, plus everything that depends on them (Cypher, on the world graph)."""
    named = named_assets(plan)
    g = db.select_graph(world)
    existing = {r[0] for r in g.ro_query("MATCH (a:Asset) WHERE a.name IN $n RETURN a.name",
                                         {"n": sorted(named)}).result_set}
    radius = upstream(g, existing) | named
    if any(s["action"] == "launch" for s in plan["steps"]):
        radius |= {r[0] for r in g.ro_query("MATCH (a:Asset) WHERE a.capacity IS NOT NULL "
                                            "RETURN a.name").result_set}
    return radius


def _plan_dict(props):
    d = dict(props)
    d["plan"] = json.loads(d.get("plan") or "{}")
    for key in ("alone", "conflicts", "suggestion", "execution"):
        d[key] = json.loads(d[key]) if d.get(key) else None
    return d


def get_plan(pid):
    rows = memory.mem().ro_query("MATCH (p:Plan {id: $id}) RETURN properties(p)", {"id": pid}).result_set
    return _plan_dict(rows[0][0]) if rows else None


def list_plans(limit=30):
    try:
        rows = memory.mem().ro_query("MATCH (p:Plan) RETURN properties(p) ORDER BY p.created DESC LIMIT $n",
                                     {"n": limit}).result_set
    except Exception:
        return []
    return [_plan_dict(p) for (p,) in rows]


def _set(pid, **fields):
    for key in ("alone", "conflicts", "suggestion", "execution"):
        if key in fields and not isinstance(fields[key], str):
            fields[key] = json.dumps(fields[key], default=str)
    memory.mem().query("MATCH (p:Plan {id: $id}) SET p += $f", {"id": pid, "f": fields})


def overlapping(pid, start, end, exclude=()):
    """Active plans sharing at least one asset with plan `pid` whose time windows overlap."""
    rows = memory.mem().ro_query("""
        MATCH (p:Plan {id: $id})-[:TOUCHES]->(a:Asset)<-[:TOUCHES]-(q:Plan)
        WHERE q.status IN $active AND q.id <> $id AND NOT q.id IN $exclude
          AND q.window_start < $end AND q.window_end > $start
        RETURN DISTINCT properties(q)""",
                                 {"id": pid, "active": list(ACTIVE), "exclude": list(exclude),
                                  "start": start.isoformat(timespec="minutes"),
                                  "end": end.isoformat(timespec="minutes")}).result_set
    return [_plan_dict(p) for (p,) in rows]


def _clashes(plan, alone, others, agent, client, world):
    """Rehearse `plan` together with each plan in `others`. Returns the conflicts found."""
    conflicts = []
    for q in others:
        joint = rehearse(combine(q["plan"], plan), by="coordinator", client=client,
                         kind="coordination: together", world=world)
        q_alone = (q.get("alone") or {}).get("p_crit", 0.0)
        if joint["p_crit"] >= SAFETY_LINE and joint["p_crit"] > max(alone["p_crit"], q_alone):
            conflicts.append({"plan_id": q["id"], "agent": q["agent"], "title": q["title"],
                              "p_joint": joint["p_crit"], "rid": joint["rid"],
                              "breaks": [a["name"] for a in joint["affected"] if a["critical"]]})
    return conflicts


def propose(plan, agent, client="", world=WORLD, now=None):
    """An agent asks to do `plan`. Returns the decision with the evidence behind it."""
    now = (now or datetime.now()).replace(second=0, microsecond=0)
    plan = validate(plan, db.select_graph(world), now)
    start, end = plan_window(plan, now)
    alone = rehearse(plan, by=agent, client=client, kind="coordination: alone", world=world)
    pid = memory.new_id("P")
    g = memory.mem()
    g.query("""MERGE (ag:Agent {name: $agent})
               CREATE (p:Plan {id: $id, title: $title, plan: $plan, agent: $agent, client: $client,
                               status: 'checking', window_start: $ws, window_end: $we,
                               created: $at, steps_text: $steps})
               CREATE (p)-[:PROPOSED_BY]->(ag)
               WITH p MATCH (r:Rehearsal {id: $rid}) CREATE (p)-[:REHEARSED_IN]->(r)""",
            {"agent": agent, "id": pid, "title": plan["title"], "plan": json.dumps(plan),
             "client": client or "", "ws": start.isoformat(timespec="minutes"),
             "we": end.isoformat(timespec="minutes"), "at": memory.now_iso(),
             "steps": [describe(s) for s in plan["steps"]], "rid": alone["rid"]})
    g.query("""MATCH (p:Plan {id: $id}) UNWIND $names AS n
               MERGE (a:Asset {name: n}) CREATE (p)-[:TOUCHES]->(a)""",
            {"id": pid, "names": sorted(blast_radius(plan, world))})

    result = {"plan_id": pid, "agent": agent, "title": plan["title"], "alone": _lite(alone),
              "conflicts": [], "suggestion": None,
              "window": [start.isoformat(timespec="minutes"), end.isoformat(timespec="minutes")]}
    if alone["verdict"] == "BLOCK":
        result["status"] = "blocked"
        result["reason"] = (f"Unsafe on its own: {alone['p_crit']:.0%} of futures break something "
                            f"critical ({', '.join(_lite(alone)['affected'])}).")
    else:
        conflicts = _clashes(plan, alone, overlapping(pid, start, end), agent, client, world)
        for c in conflicts:
            g.query("""MATCH (p:Plan {id: $p}), (q:Plan {id: $q})
                       CREATE (p)-[:CONFLICTS_WITH {rid: $rid, p_joint: $pj}]->(q)""",
                    {"p": pid, "q": c["plan_id"], "rid": c["rid"], "pj": c["p_joint"]})
        result["conflicts"] = conflicts
        if conflicts:
            result["status"] = "held"
            first = conflicts[0]
            result["reason"] = (f"Safe alone, but together with {first['agent']}'s plan "
                                f"\"{first['title']}\" {first['p_joint']:.0%} of futures break "
                                f"{', '.join(first['breaks']) or 'something critical'}.")
            if any(s["action"] in ("offline", "launch") for s in plan["steps"]):
                result["suggestion"] = safe_window(plan, agent=agent, client=client, world=world,
                                                   exclude=(pid,), now=now)
        else:
            result["status"] = "approved"
            others = overlapping(pid, start, end)
            reason = ("Approved: safe alone and together with every overlapping plan."
                      if others else "Approved: safe alone, and no other plan overlaps it.")
            if end - start < timedelta(days=3000):              # a time window, not a permanent change
                reason += f" {agent} holds these assets until {end:%a %d %b %H:%M}."
            result["reason"] = reason
    _set(pid, status=result["status"], reason=result["reason"], alone=result["alone"],
         conflicts=result["conflicts"], suggestion=result["suggestion"], decided=memory.now_iso())
    return result


def _timed_step(plan):
    for i, s in enumerate(plan["steps"]):
        if s["action"] in ("offline", "launch"):
            return i, s
    raise ValueError("This plan has no time window to move")


def safe_window(plan, agent="coordinator", client="", world=WORLD, exclude=(), now=None,
                days=SEARCH_DAYS):
    """Find the earliest start time (hourly, over `days` days from the requested start) at which
    the plan is SAFE together with every active plan it would overlap.

    Trick that keeps it fast: two start times give identical futures when the same scheduled jobs
    run inside the window and the same plans overlap it - so each group is rehearsed once."""
    now = (now or datetime.now()).replace(second=0, microsecond=0)
    plan = validate(plan, db.select_graph(world), now)
    i, step = _timed_step(plan)
    requested = parse_time(step["start"])
    hours = float(step["hours"])
    first = max(requested, now + timedelta(hours=1)).replace(minute=0)
    jobs = db.select_graph(world).ro_query(
        "MATCH (j:Job) WHERE j.schedule <> '' RETURN j.name, j.schedule, j.duration_min").result_set
    radius = blast_radius(plan, world)
    active = [p for p in list_plans(200) if p["status"] in ACTIVE and p["id"] not in exclude]
    touching = []
    for p in active:
        rows = memory.mem().ro_query("MATCH (:Plan {id: $id})-[:TOUCHES]->(a) RETURN a.name",
                                     {"id": p["id"]}).result_set
        if radius & {r[0] for r in rows}:
            touching.append(p)

    groups = {}
    for h in range(days * 24):
        start = first + timedelta(hours=h)
        end = start + timedelta(hours=hours)
        running = tuple(sorted(n for n, s, d in jobs if runs_overlapping(s, d, start, end)))
        others = tuple(sorted(p["id"] for p in touching
                              if parse_time(p["window_start"]) < end and parse_time(p["window_end"]) > start))
        groups.setdefault((running, others), []).append(start)

    by_id = {p["id"]: p for p in touching}
    results = []
    for (running, others), starts in groups.items():
        trial = json.loads(json.dumps(plan))
        trial["steps"][i]["start"] = starts[0].isoformat(timespec="minutes")
        trial["title"] = f"{plan['title']} (trying {starts[0]:%a %d %b %H:%M})"
        joint = combine(*[by_id[o]["plan"] for o in others], trial) if others else trial
        s = rehearse(joint, by=agent, client=client, kind="coordination: window search",
                     world=world, keep_futures=False)
        results.append({"jobs_running": list(running), "overlapping_plans": list(others),
                        "verdict": s["verdict"], "p_crit": s["p_crit"], "rid": s["rid"],
                        "starts": [x.isoformat(timespec="minutes") for x in starts]})
    rank = {"SAFE": 0, "REVIEW": 1, "BLOCK": 2}
    best = min(((rank[r["verdict"]], r["p_crit"], x, r) for r in results for x in r["starts"]),
               key=lambda t: (t[0], t[1], t[2]))
    best_start = datetime.fromisoformat(best[2])
    return {"requested": requested.isoformat(timespec="minutes"), "hours": hours,
            "best_start": best[2], "best_end": (best_start + timedelta(hours=hours)).isoformat(timespec="minutes"),
            "best_verdict": best[3]["verdict"], "best_p_crit": best[3]["p_crit"],
            "candidates": sum(len(r["starts"]) for r in results), "rehearsed": len(results),
            "groups": sorted(results, key=lambda r: r["starts"][0])}


def execute_plan(pid, agent, client="", accept_minor=False, world=WORLD):
    """Run an approved plan. Only its own agent may, and multiverse.execute re-checks it first."""
    p = get_plan(pid)
    if not p:
        raise ValueError(f"No plan {pid}")
    if p["agent"] != agent:
        raise PermissionError(f"Plan {pid} belongs to {p['agent']}, not {agent}")
    if p["status"] != "approved":
        raise PermissionError(f"Plan {pid} is {p['status']}, not approved")
    now = datetime.now()
    start, end = parse_time(p["window_start"]), parse_time(p["window_end"])
    clashes = _clashes(p["plan"], p["alone"], overlapping(pid, start, end), agent, client, world)
    if clashes:
        _set(pid, status="held", conflicts=clashes,
             reason="A plan approved after this one now clashes with it; re-propose.")
        return {"executed": False, "reason": "Refused: it now clashes with another plan.", "conflicts": clashes}
    out = execute(p["plan"], by=agent, client=client, accept_minor=accept_minor, world=world)
    if out["executed"]:
        timed = any(s["action"] in ("offline", "launch") for s in p["plan"]["steps"])
        status = "booked" if timed and end > now else "executed"
        _set(pid, status=status, executed=memory.now_iso(),
             execution={"rid": out["rehearsal"]["rid"], "changes": out["changes"], "booked": out["booked"]})
        out["plan_status"] = status
    return out


def cancel(pid, agent):
    p = get_plan(pid)
    if not p:
        raise ValueError(f"No plan {pid}")
    if p["agent"] != agent and agent != "console":
        raise PermissionError(f"Plan {pid} belongs to {p['agent']}")
    _set(pid, status="cancelled", reason=f"Cancelled by {agent}")
    return {"plan_id": pid, "status": "cancelled"}
