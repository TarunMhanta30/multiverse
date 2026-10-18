"""
Multiverse - rehearse a plan across many possible futures, live.

  prepare()  check the plan, snapshot the company (GRAPH.COPY), apply the plan's changes to the
             snapshot, list every source of uncertainty, record the rehearsal in memory
  run()      play futures one at a time, each in its own copy of the snapshot (rehearse.py).
             Each finished future is written to the memory graph immediately - the console
             streams from there, so it shows the rehearsal live whoever started it
  rehearse() prepare + run and wait.     start() prepare + run in the background.
  execute()  the ONLY way to change the real company: a fresh rehearsal first, and only a SAFE
             verdict lets the plan through - applied with the same Cypher that was rehearsed

What each future rolls dice for:
  - links we are not sure exist (confidence between 0 and 1, computed from evidence)
  - hand-run jobs: will they run during the window? P = 1 - exp(-window / how often they run)
  - launch traffic: how big is the surge? (log-normal: median `surge`, 90th percentile `surge_p90`)
Scheduled jobs are not random: their calendar says whether a run falls inside the window.
If nothing uncertain touches the plan, ONE future is the exact answer, and the result says so.

Dice: every rehearsal has a dice number (seed). Same plan + same dice = the same futures, so any
result can be replayed exactly. Leave it out and fresh dice are rolled.

Run:  python multiverse.py      (rehearses a few plans and prints the results)
"""
import json
import math
import random
import secrets
import threading
import time
from collections import Counter
from datetime import datetime
from statistics import NormalDist

import memory
from config import BATCH, DEP_PATTERN, MAX_DEPTH, MAX_FUTURES, SAFETY_LINE, WORLD, db
from plans import describe, disruption_windows, named_assets, surge_sigma, validate
from rehearse import apply_changes, drop, fingerprint, fork, path_text, play_future
from schedules import runs_overlapping

PRECISE_DEFAULT = 100        # futures in "precise" mode when no number is given
HEADROOM = 0.99              # launch advice: be ready for the 1-in-100 surge
SEVERITY = ("deleted", "overloaded", "broken", "stale", "degraded")
CRITICAL_STATUSES = ("deleted", "overloaded", "broken")
STATUS_RANK = {s: i for i, s in enumerate(reversed(SEVERITY))}
RUNNING = {}                 # rid -> context of rehearsals running in THIS program (for cancel)


def wilson(hits, n, z=1.96):
    """95% range for a probability measured from n futures (Wilson score interval)."""
    if n == 0:
        return 0.0, 1.0
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


# ----------------------------------------------------------------------------- reading the snapshot
def load_model(graph):
    """Assets, dependency links and traffic settings of a graph, as plain Python data."""
    nodes = {}
    for name, labels, crit, team, schedule, duration, capacity in graph.ro_query("""
            MATCH (a:Asset) OPTIONAL MATCH (a)-[:OWNED_BY]->(t:Team)
            RETURN a.name, labels(a), a.criticality, t.name, a.schedule, a.duration_min,
                   a.capacity""").result_set:
        nodes[name] = {"kind": next(l for l in labels if l != "Asset"), "crit": crit or 1,
                       "owner": team or "unknown", "schedule": schedule or "",
                       "duration": duration or 0, "capacity": capacity}
    links = {}
    for key, a, rel, b, conf, every, soft, rule, evidence in graph.ro_query(f"""
            MATCH (a:Asset)-[r:{DEP_PATTERN}]->(b:Asset)
            RETURN r.key, a.name, type(r), b.name, r.confidence, r.every_days, r.soft, r.rule,
                   r.evidence""").result_set:
        links[key] = {"a": a, "rel": rel, "b": b, "conf": 1.0 if conf is None else conf,
                      "every": every or 0.0, "soft": bool(soft), "rule": rule or "",
                      "evidence": list(evidence or [])}
    meta = graph.ro_query("MATCH (m:Meta) RETURN m.traffic_entry, m.base_rps").result_set
    traffic = {"entry": meta[0][0], "base_rps": meta[0][1]} if meta else {"entry": None, "base_rps": 1.0}
    return nodes, links, traffic


def p_used(link, nodes, start, end):
    """Chance that the link is actually used between start and end."""
    consumer = nodes[link["a"]]
    if consumer["kind"] == "Job" and consumer["schedule"]:          # the calendar decides
        return 1.0 if runs_overlapping(consumer["schedule"], consumer["duration"], start, end) else 0.0
    if link["every"] > 0:                                             # hand-run: random arrivals
        return 1 - math.exp(-((end - start).total_seconds() / 86400) / link["every"])
    return 1.0                                                        # used all the time


def reachable_links(links, targets, used):
    """Links a failure starting at `targets` could ever travel along: they might exist (confidence
    above 0) and might be in use during the window (used[key] above 0). Only these can change an
    outcome, so only their dice matter - and if none of them is uncertain, one future is exact."""
    found, frontier, seen = set(), set(targets), set(targets)
    while frontier:
        nxt = set()
        for key, l in links.items():
            if l["b"] in frontier and l["conf"] > 0 and used.get(key, 1.0) > 0:
                found.add(key)
                if l["a"] not in seen:
                    seen.add(l["a"])
                    nxt.add(l["a"])
        frontier = nxt
    return found


def upstream(graph, targets):
    """Every asset with a dependency path into any of `targets` (targets included)."""
    if not targets:
        return set()
    rows = graph.ro_query(f"""MATCH (x:Asset)-[:{DEP_PATTERN}*0..{MAX_DEPTH}]->(t:Asset)
                              WHERE t.name IN $t RETURN DISTINCT x.name""",
                          {"t": sorted(targets)}).result_set
    return {r[0] for r in rows}


def launch_model(graph, nodes, traffic, surge, surge_p90):
    """Where a traffic surge would break things, computed on the graph:
    load on each service = entry traffic x product of calls_per_request along every path to it."""
    entry, base = traffic["entry"], traffic["base_rps"]
    rows = graph.ro_query(f"""
        MATCH p = (e:Asset {{name: $entry}})-[:CALLS|READS|WRITES*0..{MAX_DEPTH}]->(y:Asset)
        WHERE all(r IN relationships(p) WHERE r.calls_per_request IS NOT NULL)
        RETURN y.name, sum(reduce(f = 1.0, r IN relationships(p) | f * r.calls_per_request))""",
                          {"entry": entry}).result_set
    per_request = {name: m for name, m in rows if m}
    critical_if = {r[0] for r in graph.ro_query(f"""
        MATCH p = (x:Asset)-[:{DEP_PATTERN}*0..{MAX_DEPTH}]->(y:Asset)
        WHERE x.criticality = 3 AND y.name IN $names
          AND none(r IN relationships(p) WHERE coalesce(r.soft, false) OR type(r) = 'FED_BY')
        RETURN DISTINCT y.name""", {"names": sorted(per_request)}).result_set}
    thresholds, points = {}, []
    for name, m in per_request.items():
        cap = nodes.get(name, {}).get("capacity")
        if cap:
            thresholds[name] = cap / (base * m)
            points.append({"asset": name, "load_per_request": round(m, 3), "capacity": cap,
                           "breaks_at": round(thresholds[name], 2), "critical": name in critical_if,
                           "owner": nodes[name]["owner"]})
    points.sort(key=lambda p: p["breaks_at"])
    sigma = surge_sigma(surge, surge_p90)
    crit_points = [thresholds[n] for n in thresholds if n in critical_if]
    first_crit = min(crit_points) if crit_points else math.inf
    if sigma > 0 and first_crit < math.inf:
        theory = 1 - NormalDist().cdf((math.log(first_crit) - math.log(surge)) / sigma)
    else:
        theory = 1.0 if surge >= first_crit else 0.0
    ready_for = surge * math.exp(NormalDist().inv_cdf(HEADROOM) * sigma)
    advice = [{"asset": p["asset"], "factor": math.ceil(ready_for / p["breaks_at"])}
              for p in points if p["critical"] and p["breaks_at"] < ready_for]
    return {"entry": entry, "base_rps": base, "surge": surge, "surge_p90": surge_p90,
            "sigma": round(sigma, 4), "thresholds": thresholds, "breaking_points": points,
            "first_critical_break": None if first_crit == math.inf else round(first_crit, 2),
            "theory_p_crit": round(theory, 4), "ready_for": round(ready_for, 2), "advice": advice}


def launch_advice(surge, surge_p90, world=WORLD):
    """Scaling advice for a launch, read straight from the world graph (no rehearsal)."""
    g = db.select_graph(world)
    nodes, _links, traffic = load_model(g)
    return launch_model(g, nodes, traffic, surge, surge_p90)


# ----------------------------------------------------------------------------- prepare
def prepare(plan, by="console", client="", seed=None, mode="decide", futures=None, world=WORLD,
            kind="rehearsal", keep_futures=True, now=None, record=True, rid=None, facts=None,
            snapshot_name=None):
    """Check the plan, snapshot the company and work out every source of chance.
    record=False (used by replay) builds exactly the same context without writing to memory;
    `facts` = [[link key, exists, team], ...] replaces the team answers read from memory."""
    now = (now or datetime.now()).replace(second=0, microsecond=0)
    g = db.select_graph(world)
    plan = validate(plan, g, now)
    mode = mode if mode in ("decide", "precise") else "decide"
    target_n = max(1, min(int(futures or PRECISE_DEFAULT), 1000)) if mode == "precise" else MAX_FUTURES
    seed = int(seed) if seed not in (None, "") else secrets.randbelow(900_000) + 100_000
    rid = rid or memory.new_id("R")
    fp_before = fingerprint(g)
    snap_name = snapshot_name or f"{world}__{rid}__snapshot"
    t0 = time.perf_counter()
    snapshot = fork(g, snap_name)                                  # the company, frozen right now
    prep_trace = [{"step": "snapshot", "query": f"GRAPH.COPY {world} {snap_name}",
                   "ms": round((time.perf_counter() - t0) * 1000, 2)}]
    try:
        changes = apply_changes(snapshot, plan["steps"])            # the plan's edits, in the copy
        if changes:
            prep_trace.append({"step": "changes", "count": len(changes),
                               "detail": [c.get("key") or c.get("name") for c in changes]})
        nodes, links, traffic = load_model(snapshot)
        if facts is None:
            facts = [[f"{a}|{rel}|{b}", bool(ex), team]
                     for (a, rel, b), (ex, team) in memory.learned_links().items()]
        used_facts, facts_used = [], []
        for key, exists, team in facts:
            link = links.get(key)
            if link:                                                 # a team answered: no more guessing
                a, rel, b = key.split("|")
                link["conf"] = 1.0 if exists else 0.0
                link["answered_by"] = team
                used_facts.append({"link": f"{a} -{rel}-> {b}", "exists": bool(exists), "by": team})
                facts_used.append([key, bool(exists), team])

        disruptions, launch, fixed_targets = [], None, set()
        for i, action, asset, start, end in disruption_windows(plan, now):
            d = {"step": i, "action": action, "asset": asset, "start": start, "end": end, "origins": {}}
            if action == "launch":
                step = plan["steps"][i]
                launch = launch_model(snapshot, nodes, traffic, step["surge"], step["surge_p90"])
                d["asset"] = traffic["entry"]
            else:
                d["origins"] = {asset: {"delete": "deleted", "offline": "offline",
                                        "rotate_secret": "rotated"}[action]}
                fixed_targets.add(asset)
            d["p_used"] = {key: p_used(l, nodes, start, end) for key, l in links.items()}
            if action == "rotate_secret":                            # known consumers get the new key
                for key, l in links.items():
                    if l["b"] == asset and l["conf"] >= 1.0:
                        d["p_used"][key] = 0.0
            disruptions.append(d)

        relevant = set()                     # links a failure could possibly travel along
        for d in disruptions:
            targets = set(d["origins"]) or set(launch["thresholds"])
            relevant |= reachable_links(links, targets, d["p_used"])
        uncertain = sorted((k, links[k]["conf"]) for k in relevant if 0 < links[k]["conf"] < 1)
        for d in disruptions:
            d["random_usage"] = sorted((k, p) for k, p in d["p_used"].items() if k in relevant and 0 < p < 1)
            d["always_inactive"] = sorted(k for k, p in d["p_used"].items() if p <= 0)   # idle all window
            del d["p_used"]
        n_random = (len(uncertain) + sum(len(d["random_usage"]) for d in disruptions)
                    + (1 if launch and launch["sigma"] > 0 else 0))
    except Exception:
        drop(snap_name)
        raise

    exact = n_random == 0
    uncertainty = {
        "links": [{"key": k, "link": k.replace("|", " "), "confidence": c,
                   "owner": nodes[links[k]["a"]]["owner"], "rule": links[k]["rule"],
                   "evidence": links[k]["evidence"]} for k, c in uncertain],
        "timing": [{"key": k, "chance_used": round(p, 3), "window": d["action"]}
                   for d in disruptions for k, p in d["random_usage"]],
        "surge": bool(launch and launch["sigma"] > 0),
    }
    windows = [{"step": d["step"], "action": d["action"], "asset": d["asset"],
                "start": d["start"].isoformat(timespec="minutes"),
                "end": d["end"].isoformat(timespec="minutes")} for d in disruptions]
    ctx = {"rid": rid, "plan": plan, "world": world, "seed": seed, "mode": "exact" if exact else mode,
           "exact": exact, "target_n": 1 if exact else target_n, "snapshot": snapshot,
           "snapshot_name": snap_name, "nodes": nodes, "links": links,
           "crit": {n: v["crit"] for n, v in nodes.items()}, "uncertain": uncertain,
           "always_dropped": sorted(k for k, l in links.items() if l["conf"] <= 0),
           "disruptions": disruptions, "launch": launch, "keep_futures": keep_futures,
           "used_facts": used_facts, "changes": changes, "windows": windows,
           "uncertainty": uncertainty, "fp_before": fp_before, "by": by, "client": client or "",
           "kind": kind, "n_random": n_random, "cancelled": False, "now": now,
           "prep_trace": prep_trace}
    if not record:
        return ctx
    memory.create_rehearsal({
        "id": rid, "title": plan["title"], "plan": json.dumps(plan), "kind": kind, "by": by,
        "client": client or "", "seed": seed, "mode": ctx["mode"], "exact": exact,
        "status": "running", "started": memory.now_iso(), "target_futures": ctx["target_n"],
        "futures": 0, "critical": 0, "p_crit": 0.0, "low": 0.0, "high": 1.0,
        "fingerprint_before": fp_before, "snapshot": snap_name, "world": world,
        "uncertainty": json.dumps(uncertainty), "changes": json.dumps(changes),
        "windows": json.dumps(windows), "sources_of_chance": n_random,
        "launch": json.dumps({k: v for k, v in launch.items() if k != "thresholds"}) if launch else "",
        "now": now.isoformat(timespec="minutes"), "facts": json.dumps(facts_used),
        "prep_trace": json.dumps(prep_trace),
    }, named_assets(plan))
    return ctx


# ----------------------------------------------------------------------------- run
def draw(ctx, rng):
    """Roll the dice for one future. Always rolls the same number of dice in the same order,
    so a dice number (seed) replays exactly."""
    dropped = list(ctx["always_dropped"])
    for key, conf in ctx["uncertain"]:
        if rng.random() >= conf:
            dropped.append(key)                       # in this future the link isn't real
    surge, overloaded = None, set()
    if ctx["launch"]:
        L = ctx["launch"]
        z = rng.gauss(0.0, 1.0) if L["sigma"] > 0 else 0.0
        surge = round(L["surge"] * math.exp(L["sigma"] * z), 3)
        overloaded = {n for n, s in L["thresholds"].items() if surge >= s}
    disruptions, idle = [], set()
    for d in ctx["disruptions"]:
        inactive = list(d["always_inactive"])
        for key, p in d["random_usage"]:
            if rng.random() >= p:
                inactive.append(key)                  # the hand-run job doesn't run in the window
                idle.add(key)
        origins = ({n: "overloaded" for n in overloaded} if d["action"] == "launch" else dict(d["origins"]))
        disruptions.append({"origins": origins, "inactive": inactive})
    return {"dropped": dropped, "disruptions": disruptions, "surge": surge, "overloaded": overloaded,
            "idle": sorted(idle - set(dropped))}


def run(ctx):
    rid, world = ctx["rid"], ctx["world"]
    RUNNING[rid] = ctx
    rng = random.Random(ctx["seed"])
    n = hits = 0
    outcomes, counts, why, path_keys, surges = [], {}, {}, set(), []
    early = False
    t0 = time.perf_counter()
    try:
        while n < ctx["target_n"] and not ctx["cancelled"]:
            sample = draw(ctx, rng)
            fork_name = f"{world}__{rid}__f{n + 1:03d}"
            trace = [] if n == 0 else None                  # future #1 keeps every command it ran
            res = play_future(ctx["snapshot"], fork_name, sample["dropped"], sample["disruptions"],
                              ctx["crit"], trace=trace)
            n += 1
            hits += res["outcome"] == "critical"
            outcomes.append(res["outcome"])
            if sample["surge"] is not None:
                surges.append(sample["surge"])
            for a in res["affected"]:
                c = counts.setdefault(a["name"], Counter())
                c[a["status"]] += 1
                c["any"] += 1
                why.setdefault(a["name"], Counter())[path_text(a["path"], a["rels"])] += 1
                path_keys.update(a["keys"])
            low, high = wilson(hits, n)
            if ctx["keep_futures"]:
                fields = {
                    "i": n, "outcome": res["outcome"], "fork": fork_name, "ms": res["ms"],
                    "surge": sample["surge"], "dropped": sample["dropped"], "idle": sample["idle"],
                    "overloaded": sorted(sample["overloaded"]),
                    "affected": json.dumps(res["affected"]), "disrupted": json.dumps(res["disrupted"]),
                    "hops": max((len(a["path"]) - 1 for a in res["affected"]), default=0),
                    "critical": sorted(a["name"] for a in res["affected"]
                                       if a["status"] in CRITICAL_STATUSES and ctx["crit"].get(a["name"]) == 3)}
                if trace is not None:
                    fields["trace"] = json.dumps(trace, default=str)
                memory.add_future(rid, fields)
            memory.update_rehearsal(rid, futures=n, critical=hits, p_crit=round(hits / n, 4),
                                    low=round(low, 4), high=round(high, 4))
            if (ctx["mode"] == "decide" and n % BATCH == 0
                    and (low > SAFETY_LINE or high < SAFETY_LINE)):
                early = True                          # statistically clear which side we are on
                break
    except Exception as e:
        memory.update_rehearsal(rid, status="failed", error=f"{type(e).__name__}: {e}",
                                finished=memory.now_iso())
        raise
    finally:
        drop(ctx["snapshot_name"])
        RUNNING.pop(rid, None)
    secs = time.perf_counter() - t0
    return summarize(ctx, n, hits, outcomes, counts, why, path_keys, surges, early, secs)


def summarize(ctx, n, hits, outcomes, counts, why, path_keys, surges, early, secs):
    rid, nodes, links = ctx["rid"], ctx["nodes"], ctx["links"]
    n = max(n, 1)
    p = hits / n
    low, high = (p, p) if ctx["exact"] else wilson(hits, n)   # one exact future has no error bar
    affected = []
    for name, c in counts.items():
        worst = next(s for s in SEVERITY if c[s])
        crit = nodes.get(name, {}).get("crit", 1)
        affected.append({
            "name": name, "status": worst, "probability": round(c["any"] / n, 4),
            "probabilities": {s: round(c[s] / n, 4) for s in SEVERITY if c[s]},
            "criticality": crit, "owner": nodes.get(name, {}).get("owner", "unknown"),
            "critical": crit == 3 and worst in CRITICAL_STATUSES,
            "why": why[name].most_common(1)[0][0]})
    affected.sort(key=lambda a: (not a["critical"], -a["probability"], a["name"]))
    verdict = "BLOCK" if p >= SAFETY_LINE else ("REVIEW" if affected else "SAFE")
    unverified = [{"link": k.replace("|", " "), "key": k, "confidence": conf,
                   "ask": nodes[links[k]["a"]]["owner"], "evidence": links[k]["evidence"]}
                  for k, conf in ctx["uncertain"] if k in path_keys]
    if verdict == "SAFE":
        status = "cleared"
    elif unverified:
        status = "waiting_for_answers"
    else:
        status = "refused" if verdict == "BLOCK" else "needs_review"
    if ctx["exact"]:
        stop = "Exact: nothing uncertain touches this plan, so one future is the whole answer."
    elif early:
        side = "above" if low > SAFETY_LINE else "below"
        stop = (f"Stopped after {n} futures: the 95% range ({low:.0%} to {high:.0%}) "
                f"is clearly {side} the {SAFETY_LINE:.0%} safety line.")
    elif ctx["cancelled"]:
        stop = f"Stopped by request after {n} futures."
    elif ctx["mode"] == "precise":
        stop = f"Ran the {n} futures asked for."
    else:
        stop = f"Hit the {MAX_FUTURES}-future limit: the answer sits close to the {SAFETY_LINE:.0%} line."

    world_graph = db.select_graph(ctx["world"])
    fp_after = fingerprint(world_graph)
    forks_left = [x for x in db.list_graphs() if x.startswith(f"{ctx['world']}__{rid}")]
    questions = []
    if verdict != "SAFE":
        for u in unverified:
            a, rel, b = u["key"].split("|")
            questions.append(memory.ask(rid, a, rel, b, u["ask"]))

    launch = None
    if ctx["launch"]:
        L = {k: v for k, v in ctx["launch"].items() if k != "thresholds"}
        only_launch = len(ctx["disruptions"]) == 1 and not ctx["uncertain"]
        L["simulated_p_crit"] = round(p, 4)
        L["theory_applies"] = only_launch
        L["surge_seen"] = ([round(min(surges), 2), round(sorted(surges)[len(surges) // 2], 2),
                            round(max(surges), 2)] if surges else [])
        launch = L
    named = named_assets(ctx["plan"])
    summary = {
        "rid": rid, "title": ctx["plan"]["title"], "plan": ctx["plan"],
        "steps": [describe(s) for s in ctx["plan"]["steps"]],
        "by": ctx["by"], "client": ctx["client"], "kind": ctx["kind"],
        "verdict": verdict, "decision_status": status,
        "p_crit": round(p, 4), "range": [round(low, 4), round(high, 4)],
        "futures": n, "critical_futures": hits, "outcomes": outcomes,
        "mode": ctx["mode"], "exact": ctx["exact"], "seed": ctx["seed"], "stop_reason": stop,
        "seconds": round(secs, 2), "ms_per_future": round(secs * 1000 / n, 1),
        "safety_line": SAFETY_LINE, "affected": affected, "unverified": unverified,
        "learned": ctx["used_facts"], "uncertainty": ctx["uncertainty"], "windows": ctx["windows"],
        "changes": ctx["changes"], "launch": launch, "questions": questions,
        "reviewers": sorted({a["owner"] for a in affected} |
                            {nodes[x]["owner"] for x in named if x in nodes}),
        "fingerprint": {"before": ctx["fp_before"], "after": fp_after,
                        "unchanged": ctx["fp_before"] == fp_after},
        "forks_left": forks_left,
    }
    memory.update_rehearsal(rid, status="done", finished=memory.now_iso(), verdict=verdict,
                            decision_status=status, fingerprint_after=fp_after,
                            forks_left=len(forks_left), seconds=round(secs, 2),
                            summary=json.dumps(summary, default=str))
    return summary


def rehearse(plan, **kw):
    """Rehearse and wait for the result."""
    return run(prepare(plan, **kw))


def start(plan, **kw):
    """Start a rehearsal in the background; returns its id at once (the futures stream into memory)."""
    ctx = prepare(plan, **kw)
    threading.Thread(target=_run_quietly, args=(ctx,), daemon=True, name=ctx["rid"]).start()
    return ctx["rid"]


def cancel(rid):
    """Ask a rehearsal running in this program to stop after the current future."""
    ctx = RUNNING.get(rid)
    if ctx:
        ctx["cancelled"] = True
    return bool(ctx)


def _run_quietly(ctx):
    try:
        run(ctx)
    except Exception:
        pass                                          # already recorded as failed in memory


def replay(rid, i):
    """Play future `i` of rehearsal `rid` again - same plan, same dice, same team answers, same
    moment in time - in a fresh copy, recording every FalkorDB command it runs. Nothing is written
    to memory. Returns the trace, the result, and whether it matches what was recorded."""
    r = memory.get_rehearsal(rid)
    if not r:
        raise ValueError(f"No rehearsal {rid}")
    i = int(i)
    if not 1 <= i <= int(r.get("futures") or 0):
        raise ValueError(f"Rehearsal {rid} has no future {i}")
    world = r.get("world") or WORLD
    when = r.get("now") or r.get("started")
    now = datetime.fromisoformat(when).replace(tzinfo=None) if when else None
    facts = json.loads(r["facts"]) if r.get("facts") else None
    tag = secrets.token_hex(2)
    ctx = prepare(r["plan"], by=r.get("by") or "console", client=r.get("client") or "",
                  seed=r["seed"], mode=r.get("mode") if r.get("mode") in ("decide", "precise") else "decide",
                  futures=r.get("target_futures"), world=world, kind="replay", keep_futures=False,
                  now=now, record=False, rid=rid, facts=facts,
                  snapshot_name=f"{world}__{rid}__replay{tag}_snapshot")
    fork_name = f"{world}__{rid}__replay{tag}_f{i:03d}"
    rng = random.Random(ctx["seed"])
    sample = None
    for _ in range(i):                                    # the same dice, in the same order
        sample = draw(ctx, rng)
    trace = list(ctx["prep_trace"])
    try:
        res = play_future(ctx["snapshot"], fork_name, sample["dropped"], sample["disruptions"],
                          ctx["crit"], trace=trace)
    finally:
        drop(ctx["snapshot_name"])
    recorded = memory.get_future(rid, i)
    key = lambda f: sorted((a["name"], a["status"]) for a in f["affected"])   # noqa: E731
    same = bool(recorded) and recorded["outcome"] == res["outcome"] and key(recorded) == key(res)
    for a in res["affected"]:
        a["critical"] = a["status"] in CRITICAL_STATUSES and ctx["crit"].get(a["name"]) == 3
    return {"rid": rid, "i": i, "seed": ctx["seed"], "fork": fork_name, "trace": trace,
            "outcome": res["outcome"], "affected": res["affected"], "disrupted": res["disrupted"],
            "dropped": sample["dropped"], "idle": sample["idle"], "surge": sample["surge"],
            "overloaded": sorted(sample["overloaded"]), "ms": res["ms"],
            "identical": same, "recorded_outcome": recorded["outcome"] if recorded else None,
            "world_changed": fingerprint(db.select_graph(world)) != r.get("fingerprint_before")}


# ----------------------------------------------------------------------------- acting for real
def execute(plan, by="console", client="", accept_minor=False, world=WORLD, on_ready=None):
    """Change the REAL company - only if a fresh rehearsal says SAFE (or REVIEW with no open
    questions, when the caller explicitly accepts minor impact). Returns a dict with 'executed'.
    on_ready(rid) is called as soon as the safety rehearsal exists, so it can be watched live."""
    ctx = prepare(plan, by=by, client=client, kind="check before acting", world=world)
    if on_ready:
        on_ready(ctx["rid"])
    s = run(ctx)
    allowed = s["verdict"] == "SAFE" or (s["verdict"] == "REVIEW" and accept_minor and not s["unverified"])
    if not allowed:
        reason = f"Refused: a fresh rehearsal says {s['verdict']}"
        if s["verdict"] == "BLOCK":
            reason += f" ({s['p_crit']:.0%} of {s['futures']} futures break something critical)"
        elif s["verdict"] == "REVIEW" and not accept_minor and not s["unverified"]:
            reason += " (minor impact only: accept it explicitly to go ahead)"
        if s["unverified"]:
            reason += ". Waiting for answers from: " + ", ".join(sorted({u["ask"] for u in s["unverified"]}))
        return {"executed": False, "reason": reason + ".", "rehearsal": s}
    g = db.select_graph(world)
    if fingerprint(g) != s["fingerprint"]["after"]:
        return {"executed": False, "rehearsal": s,
                "reason": "Refused: the company changed while the check ran. Rehearse again."}
    changes = apply_changes(g, s["plan"]["steps"], real=True)
    booked = [describe(st) for st in s["plan"]["steps"] if st["action"] in ("offline", "launch")]
    memory.update_rehearsal(s["rid"], decision_status="executed")
    s["decision_status"] = "executed"
    done = [c for c in changes]
    reason = f"Rehearsal said {s['verdict']} across {s['futures']} future(s): done."
    return {"executed": True, "reason": reason, "changes": done, "booked": booked, "rehearsal": s}


# ----------------------------------------------------------------------------- command line
def show(s):
    print(f"\n=== {s['title']} ===")
    print(f"Verdict: {s['verdict']}  ({s['decision_status']})   critical breakage in {s['p_crit']:.0%} "
          f"of {s['futures']} futures (95% range {s['range'][0]:.0%}-{s['range'][1]:.0%})")
    print(f"Dice #{s['seed']}   {s['stop_reason']}   {s['seconds']} s")
    for a in s["affected"]:
        flag = "CRITICAL" if a["critical"] else a["status"]
        print(f"  {flag:<9} {a['probability']:>4.0%}  {a['name']:<24} owner {a['owner']:<10} why: {a['why']}")
    if s["launch"]:
        L = s["launch"]
        print(f"  Launch: first critical break at {L['first_critical_break']}x traffic; "
              f"maths says {L['theory_p_crit']:.1%}, futures say {L['simulated_p_crit']:.1%}")
        if L["advice"]:
            print("  To be ready for", f"{L['ready_for']}x:", ", ".join(f"{a['asset']} x{a['factor']}" for a in L["advice"]))
    for u in s["unverified"]:
        print(f"  Not sure: {u['link']} ({u['confidence']:.0%}) -> asked {u['ask']}")
    for f in s["learned"]:
        print(f"  Learned: {f['link']} = {'yes' if f['exists'] else 'no'} (from {f['by']})")
    print(f"Real company unchanged: {'yes' if s['fingerprint']['unchanged'] else 'NO'} "
          f"(fingerprint {s['fingerprint']['after'][:12]}), copies left behind: {len(s['forks_left'])}")


if __name__ == "__main__":
    from scenarios import presets
    for p in presets():
        if p["id"] in ("cleanup-archive", "delete-legacy-db", "migrate-billing", "festival-sale"):
            show(rehearse(p["plan"], by="cli"))
