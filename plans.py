"""
Multiverse - plans: what an agent (or a person) wants to do, written as steps.

A plan is {"title": "...", "steps": [step, ...]}. Every step has an "action".

DISRUPTIONS - something stops working; Multiverse finds out what breaks because of it:
  delete         {"action": "delete", "asset": "legacy_orders_db"}
  offline        {"action": "offline", "asset": "orders_replica", "start": "2026-11-01T01:00", "hours": 3}
  rotate_secret  {"action": "rotate_secret", "asset": "payment_gateway_key"}
                 (consumers we KNOW about get the new key; the ones we only suspect may break)
  launch         {"action": "launch", "surge": 3, "surge_p90": 6, "hours": 6, "start": "2026-10-24T18:00"}
                 (traffic becomes `surge` x normal - and in 1 future out of 10, more than `surge_p90` x)

CHANGES - edited into the copy first, then the disruptions are rehearsed on the changed copy:
  repoint        {"action": "repoint", "asset": "month_end_billing", "old": "legacy_orders_db", "new": "orders_replica"}
  reschedule     {"action": "reschedule", "asset": "nightly_analytics_export", "schedule": "daily@02:00"}
  scale          {"action": "scale", "asset": "cartservice", "factor": 2}
  add_service    {"action": "add_service", "asset": "giftcardservice", "owner": "Checkout",
                  "criticality": 2, "calls": {"paymentservice": 1.0, "cartservice": 0.5},
                  "entry_share": 0.1, "rps_per_core": 300, "cpu_m": 200}
  assume         {"action": "assume", "link": "tax_filing_job|READS|orders_archive", "confidence": 0.9}
                 (what-if: rehearse as if we were this sure about a link)
"""
import math
from datetime import datetime, timedelta

from config import DEP_RELS, HORIZON_DAYS
from schedules import parse as parse_schedule
from schedules import describe as describe_schedule

DISRUPTIONS = ("delete", "offline", "rotate_secret", "launch")
CHANGES = ("repoint", "reschedule", "scale", "add_service", "assume")
ACTIONS = DISRUPTIONS + CHANGES
FOREVER = timedelta(days=3650)


class PlanError(ValueError):
    """A plan that cannot be rehearsed, with a message a person (or an LLM) can act on."""


def link_key(a, rel, b):
    return f"{a}|{rel}|{b}"


def parse_time(value, field="start"):
    if isinstance(value, datetime):
        return value.replace(second=0, microsecond=0, tzinfo=None)
    try:
        return datetime.fromisoformat(str(value)).replace(second=0, microsecond=0, tzinfo=None)
    except ValueError:
        raise PlanError(f"{field} must look like 2026-11-01T01:00, got {value!r}") from None


def fmt_time(dt):
    return dt.strftime("%a %d %b %H:%M")


def describe(step):
    """One plain-English line for a step."""
    a = step.get("action")
    if a == "delete":
        return f"Delete {step['asset']}"
    if a == "offline":
        start = parse_time(step["start"])
        end = start + timedelta(hours=float(step["hours"]))
        return f"Take {step['asset']} offline {fmt_time(start)} to {end:%H:%M} ({step['hours']:g} h)"
    if a == "rotate_secret":
        return f"Rotate {step['asset']}"
    if a == "launch":
        when = f" from {fmt_time(parse_time(step['start']))}" if step.get("start") else ""
        return (f"Launch: traffic {step['surge']:g}x normal (1 in 10 chance of over "
                f"{step.get('surge_p90', step['surge']):g}x) for {step.get('hours', 6):g} h{when}")
    if a == "repoint":
        return f"Point {step['asset']} at {step['new']} instead of {step['old']}"
    if a == "reschedule":
        return f"Reschedule {step['asset']} to run {describe_schedule(step['schedule'])}"
    if a == "scale":
        return f"Scale {step['asset']} x{step['factor']:g}"
    if a == "add_service":
        calls = ", ".join(step.get("calls", {}))
        return f"Add new service {step['asset']} (calls {calls or 'nothing'})"
    if a == "assume":
        a_, rel, b = step["link"].split("|")
        return f"Assume {a_} -{rel}-> {b} is {float(step['confidence']):.0%} likely"
    return f"Unknown step {a!r}"


def normalize(plan):
    """Accept a plan dict, a list of steps or a single step; return {'title', 'steps'}."""
    if isinstance(plan, dict) and "steps" in plan:
        steps = list(plan["steps"])
        title = plan.get("title") or ""
    elif isinstance(plan, list):
        steps, title = plan, ""
    elif isinstance(plan, dict) and "action" in plan:
        steps, title = [plan], ""
    else:
        raise PlanError("A plan needs 'steps': a list of steps like {'action': 'delete', 'asset': 'x'}")
    if not steps:
        raise PlanError("The plan has no steps")
    clean = []
    for step in steps:
        if not isinstance(step, dict):
            raise PlanError(f"Each step must be an object, got {step!r}")
        clean.append({k: v for k, v in step.items() if v is not None and v != ""})
    return {"title": title or "; ".join(describe(s) for s in clean), "steps": clean}


def validate(plan, graph, now=None):
    """Check a plan against the world graph. Returns the normalized plan or raises PlanError."""
    plan = normalize(plan)
    now = now or datetime.now()
    rows = graph.ro_query("""MATCH (a:Asset) OPTIONAL MATCH (a)-[:OWNED_BY]->(t:Team)
                             RETURN a.name, labels(a), a.capacity, t.name""").result_set
    kinds = {n: next(l for l in labels if l != "Asset") for n, labels, _c, _t in rows}
    capacity = {n: c for n, _l, c, _t in rows}
    teams = {t for *_x, t in rows if t}
    new_names = set()

    def asset(step, field="asset"):
        name = step.get(field)
        if not name:
            raise PlanError(f"Step '{step.get('action')}' needs '{field}'")
        if name not in kinds and name not in new_names:
            raise PlanError(f"No asset called {name!r}. Ask list_assets for valid names.")
        return name

    for step in plan["steps"]:
        a = step.get("action")
        if a not in ACTIONS:
            raise PlanError(f"Unknown action {a!r}. Use one of: {', '.join(ACTIONS)}")
        if a == "delete":
            asset(step)
        elif a == "offline":
            asset(step)
            step["start"] = parse_time(step.get("start") or "", "start").isoformat(timespec="minutes")
            hours = float(step.get("hours", 0))
            if not 0 < hours <= 24 * 14:
                raise PlanError("offline 'hours' must be between 0 and 336")
            step["hours"] = hours
        elif a == "rotate_secret":
            if kinds.get(asset(step)) != "Secret":
                raise PlanError(f"{step['asset']} is not a Secret, so it cannot be rotated")
        elif a == "launch":
            surge = float(step.get("surge", 0))
            p90 = float(step.get("surge_p90", surge))
            if surge <= 0 or p90 < surge:
                raise PlanError("launch needs surge > 0 and surge_p90 >= surge (e.g. surge 3, surge_p90 6)")
            step.update(surge=surge, surge_p90=p90, hours=float(step.get("hours", 6)))
            step["start"] = parse_time(step.get("start") or now, "start").isoformat(timespec="minutes")
        elif a == "repoint":
            src, old, new = asset(step), asset(step, "old"), asset(step, "new")
            n = graph.ro_query("MATCH (a:Asset {name: $a})-[r]->(o:Asset {name: $o}) "
                               "WHERE type(r) IN $deps RETURN count(r)",
                               {"a": src, "o": old, "deps": list(DEP_RELS)}).result_set[0][0]
            if not n and src not in new_names:
                raise PlanError(f"{src} has no dependency on {old} to repoint")
            if old == new:
                raise PlanError("repoint 'old' and 'new' are the same asset")
        elif a == "reschedule":
            if kinds.get(asset(step)) != "Job":
                raise PlanError(f"{step['asset']} is not a Job, so it has no schedule")
            try:
                parse_schedule(step.get("schedule", ""))
            except ValueError as e:
                raise PlanError(str(e)) from None
            if not step.get("schedule"):
                raise PlanError("reschedule needs a schedule such as 'daily@02:00'")
        elif a == "scale":
            name = asset(step)
            factor = float(step.get("factor", 0))
            if not 0 < factor <= 20:
                raise PlanError("scale 'factor' must be between 0 and 20")
            if capacity.get(name) is None and name not in new_names:
                raise PlanError(f"{name} has no measured capacity, so scaling it changes nothing")
            step["factor"] = factor
        elif a == "add_service":
            name = step.get("asset", "")
            if not name or name in kinds or name in new_names:
                raise PlanError(f"add_service needs a new, unused name (got {name!r})")
            if step.get("owner") not in teams:
                raise PlanError(f"add_service 'owner' must be one of: {', '.join(sorted(teams))}")
            for target in step.get("calls", {}):
                if target not in kinds and target not in new_names:
                    raise PlanError(f"{name} would call {target!r}, which does not exist")
            step.setdefault("criticality", 2)
            step.setdefault("entry_share", 0.1)
            step.setdefault("rps_per_core", 300)
            step.setdefault("cpu_m", 200)
            new_names.add(name)
            kinds[name] = "Service"
        elif a == "assume":
            try:
                src, rel, dst = step.get("link", "").split("|")
            except ValueError:
                raise PlanError("assume 'link' must look like 'a|READS|b'") from None
            n = graph.ro_query("MATCH ()-[r]->() WHERE r.key = $k RETURN count(r)",
                               {"k": step["link"]}).result_set[0][0]
            if not n:
                raise PlanError(f"No link {src} -{rel}-> {dst} in the world")
            conf = float(step.get("confidence", -1))
            if not 0 <= conf <= 1:
                raise PlanError("assume 'confidence' must be between 0 and 1")
            step["confidence"] = conf
    if sum(s["action"] == "launch" for s in plan["steps"]) > 1:
        raise PlanError("A plan can contain at most one launch step")
    return plan


def disruption_windows(plan, now):
    """[(step index, action, asset, window start, window end)] for every disruption."""
    out = []
    for i, step in enumerate(plan["steps"]):
        a = step["action"]
        if a in ("delete", "rotate_secret"):
            out.append((i, a, step["asset"], now, now + timedelta(days=HORIZON_DAYS)))
        elif a in ("offline", "launch"):
            start = parse_time(step["start"])
            out.append((i, a, step.get("asset"), start, start + timedelta(hours=float(step["hours"]))))
    return out


def plan_window(plan, now):
    """(start, end) of the time a plan needs the world to itself - used to spot clashing plans.
    Permanent changes (delete, repoint, ...) last 'forever' from now."""
    starts, ends = [], []
    for step in plan["steps"]:
        a = step["action"]
        if a in ("offline", "launch"):
            start = parse_time(step["start"])
            starts.append(start)
            ends.append(start + timedelta(hours=float(step["hours"])))
        elif a == "rotate_secret":
            starts.append(now)
            ends.append(now + timedelta(days=1))
        elif a != "assume":
            starts.append(now)
            ends.append(now + FOREVER)
    if not starts:
        return now, now
    return min(starts), max(ends)


def named_assets(plan):
    """Every asset a plan names directly."""
    names = set()
    for step in plan["steps"]:
        for field in ("asset", "old", "new"):
            if step.get(field):
                names.add(step[field])
        names.update(step.get("calls", {}))
        if step.get("link"):
            a, _rel, b = step["link"].split("|")
            names.update((a, b))
    return names


def combine(*plans):
    """One plan containing every step of the given plans (used to rehearse plans together)."""
    plans = [normalize(p) for p in plans]
    return {"title": " + ".join(p["title"] for p in plans),
            "steps": [dict(s) for p in plans for s in p["steps"]]}


def surge_sigma(surge, surge_p90):
    """Spread of a log-normal traffic surge whose median is `surge` and 90th percentile `surge_p90`."""
    return math.log(surge_p90 / surge) / 1.2816 if surge_p90 > surge else 0.0
