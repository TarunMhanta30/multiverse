"""
Multiverse - build the company graph from EVIDENCE (the "company brain").

No dependency is typed in by hand here. Every node and every link comes from a file:

  data/online-boutique/kubernetes-manifests.yaml  REAL       Google's Online Boutique deployment file
  data/backoffice/catalog.toml                    SYNTHETIC  tiers, back-office assets, declared links, load test
  data/backoffice/CODEOWNERS                      SYNTHETIC  who owns what
  data/backoffice/access_log.csv                  SYNTHETIC  13.5 months of data access, run by run

How sure we are about each link (the reason is stored on the link, so anyone can check it):
  1. k8s       a running deployment is configured with the address            -> 1.0
  2. verified  declared in the catalog and signed off by the owning team      -> 1.0
  3. logs      seen in the access log: 1.0 if each of the last 3 runs used it, otherwise
               the share of runs that used it, recent runs weighted more
               (a run's weight halves every 90 days)                          -> 0.05 .. 0.95
  4. declared  declared, not verified, and the log cannot see it              -> 0.5
  A team's answer stored in memory overrides all of these during a rehearsal (memory.py).

Because rule 3 uses today's date, confidence fades as evidence gets older - rebuild and see.

Run:  python world.py
"""
import csv
import re
import tomllib
from datetime import date, datetime

import yaml

from config import DATA, DEP_RELS, WORLD, db
from schedules import describe, parse

MANIFEST = DATA / "online-boutique" / "kubernetes-manifests.yaml"
CATALOG = DATA / "backoffice" / "catalog.toml"
OWNERS = DATA / "backoffice" / "CODEOWNERS"
ACCESS_LOG = DATA / "backoffice" / "access_log.csv"

HALF_LIFE_DAYS = 90       # a run's weight halves every 90 days
CERTAIN_STREAK = 3        # used in each of the last 3 runs -> certain
DECLARED_PRIOR = 0.5      # declared but impossible to check -> a coin flip
NEVER_USED = 0.05         # the job ran but never touched it -> very unlikely
ACTION_REL = {"read": "READS", "write": "WRITES"}
KINDS = ("Service", "Datastore", "Job", "Secret")


def link_key(a, rel, b):
    return f"{a}|{rel}|{b}"


# ----------------------------------------------------------------------------- readers
def read_manifest(path=MANIFEST):
    """Every Deployment: replicas, CPU limit, image and each *_ADDR it is configured with.
    Line numbers are kept so every link can cite the exact line it came from."""
    lines = path.read_text(encoding="utf-8").splitlines()
    docs, start = [], 0
    for i, line in enumerate(lines + ["---"]):
        if line.strip() == "---":
            if i > start:
                docs.append((start, lines[start:i]))
            start = i + 1

    deployments = {}
    for first, doc_lines in docs:
        doc = yaml.safe_load("\n".join(doc_lines))
        if not isinstance(doc, dict) or doc.get("kind") != "Deployment":
            continue
        name = doc["metadata"]["name"]
        pod = doc["spec"]["template"]["spec"]
        main = pod["containers"][0]
        cpu = str(main.get("resources", {}).get("limits", {}).get("cpu", "0"))
        cpu_m = int(cpu[:-1]) if cpu.endswith("m") else int(float(cpu) * 1000)
        addrs = []
        for container in pod.get("containers", []) + pod.get("initContainers", []):
            for env in container.get("env") or []:
                if env.get("name", "").endswith("_ADDR") and "value" in env:
                    value = str(env["value"])
                    line_no = first + 1 + next(j for j, l in enumerate(doc_lines)
                                               if l.strip() == f"value: \"{value}\""
                                               and env["name"] in doc_lines[j - 1])
                    addrs.append((env["name"], value, value.split(":")[0], line_no))
        deployments[name] = {
            "replicas": doc["spec"].get("replicas", 1), "cpu_m": cpu_m,
            "image": main["image"].split("/")[-1].split("@")[0], "addrs": addrs,
            "line": first + 1 + next(j for j, l in enumerate(doc_lines) if l.strip() == f"name: {name}"),
        }
    return deployments


def read_owners(path=OWNERS):
    owners = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            asset, team = line.split()
            owners[asset] = team.lstrip("@").capitalize()
    return owners


def read_access_log(path=ACCESS_LOG):
    """{principal: [(run_start, run_id, {(action, resource), ...}), ...]}, oldest run first."""
    runs = {}
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = datetime.fromisoformat(row["time"])
            run = runs.setdefault(row["principal"], {}).setdefault(row["run_id"], [t, set()])
            run[0] = min(run[0], t)
            run[1].add((row["action"], row["resource"]))
    return {p: sorted((t, rid, acc) for rid, (t, acc) in rs.items()) for p, rs in runs.items()}


# ----------------------------------------------------------------------------- evidence rules
def log_evidence(runs, action, resource, today):
    """Rule 3. Returns (confidence, evidence text, runs seen, runs that used it, last used)."""
    used = [(action, resource) in acc for _t, _rid, acc in runs]
    n, k = len(used), sum(used)
    last_used = max((t for (t, _r, _a), u in zip(runs, used) if u), default=None)
    recent = ", ".join("used" if u else "not used" for u in used[-CERTAIN_STREAK:])
    if n >= CERTAIN_STREAK and all(used[-CERTAIN_STREAK:]):
        conf, why = 1.0, f"used in each of the last {CERTAIN_STREAK} runs"
    elif k == 0:
        conf, why = NEVER_USED, f"ran {n} times and never used it"
    else:
        weights = [0.5 ** ((today - t.date()).days / HALF_LIFE_DAYS) for t, _r, _a in runs]
        share = sum(w for w, u in zip(weights, used) if u) / sum(weights)
        conf = round(min(0.95, max(NEVER_USED, share)), 2)
        why = (f"used in {k} of {n} runs; weighting recent runs more "
               f"(half-life {HALF_LIFE_DAYS} days) gives {conf:.0%}")
    text = f"access_log.csv: {why}. Last {min(n, CERTAIN_STREAK)} runs: {recent}"
    if last_used:
        text += f". Last used {last_used:%d %b %Y}"
    return conf, text, n, k, (last_used.date().isoformat() if last_used else "")


def rhythm_days(runs):
    """How often a hand-run job really runs: average days between its runs (None if under 2 runs)."""
    if len(runs) < 2:
        return None
    span = (runs[-1][0] - runs[0][0]).total_seconds() / 86400
    return round(span / (len(runs) - 1), 1)


# ----------------------------------------------------------------------------- build
def collect(today):
    """Read every evidence file and return (nodes, links, owners, report). No database involved."""
    deployments = read_manifest()
    catalog = tomllib.loads(CATALOG.read_text(encoding="utf-8"))
    owners = read_owners()
    log = read_access_log()
    rps_per_core = catalog.get("loadtest", {}).get("rps_per_core", {})
    calls_per_request = catalog.get("loadtest", {}).get("calls_per_request", {})
    tiers = catalog.get("services", {})

    nodes = {}                                    # name -> (kind, properties)
    for name, d in deployments.items():
        kind = "Datastore" if d["image"].startswith("redis") else "Service"
        props = {"name": name, "criticality": tiers.get(name, {}).get("criticality", 1),
                 "source": "online-boutique", "found_in": f"kubernetes-manifests.yaml:{d['line']}",
                 "replicas": d["replicas"], "cpu_m": d["cpu_m"], "image": d["image"]}
        if kind == "Datastore":
            props["engine"] = "redis"
        if tiers.get(name, {}).get("note"):
            props["note"] = tiers[name]["note"]
        if name in rps_per_core:
            props["rps_per_core"] = rps_per_core[name]
            props["capacity"] = round(d["replicas"] * d["cpu_m"] / 1000 * rps_per_core[name], 1)
        nodes[name] = (kind, props)
    for name, a in catalog.get("assets", {}).items():
        if a["kind"] not in KINDS:
            raise SystemExit(f"catalog.toml: {name} has unknown kind {a['kind']!r}")
        props = {"name": name, "criticality": a["criticality"], "source": "synthetic",
                 "found_in": "catalog.toml"}
        for k in ("engine", "schedule", "duration_min", "note"):
            if k in a:
                props[k] = a[k]
        if "capacity_ops" in a:
            props["capacity"] = float(a["capacity_ops"])
        if a["kind"] == "Job":
            props.setdefault("schedule", "")
            parse(props["schedule"])                       # fail early on a malformed schedule
            props["schedule_text"] = describe(props["schedule"])
        nodes[name] = (a["kind"], props)

    problems = [f"{n} has no owner in CODEOWNERS" for n in sorted(set(nodes) - set(owners))]
    problems += [f"CODEOWNERS names {n}, which is not in the evidence" for n in sorted(set(owners) - set(nodes))]
    if problems:
        raise SystemExit("Evidence is inconsistent:\n  " + "\n  ".join(problems))

    links, drift = {}, []

    def add(a, rel, b, **props):
        if a not in nodes or b not in nodes:
            raise SystemExit(f"Link {a} -{rel}-> {b} names an asset that is not in the evidence")
        if rel not in DEP_RELS:
            raise SystemExit(f"Link {a} -{rel}-> {b}: unknown link type")
        key = link_key(a, rel, b)
        links[key] = {"a": a, "rel": rel, "b": b,
                      "props": {"key": key, "every_days": 0.0, "soft": False, **props}}

    # Rule 1: Kubernetes addresses (real)
    for name, d in deployments.items():
        seen = set()
        for env, value, host, line in d["addrs"]:
            if host in seen:
                continue                                   # loadgenerator lists FRONTEND_ADDR twice
            seen.add(host)
            if host not in deployments:
                drift.append(f"{name} is configured with {env}={value}, but no deployment called "
                             f"{host} exists (kubernetes-manifests.yaml:{line})")
                continue
            common = {"confidence": 1.0, "rule": "k8s", "source": "online-boutique",
                      "soft": host in tiers.get(name, {}).get("soft_calls", []),
                      "evidence": [f"kubernetes-manifests.yaml:{line}: deployment {name} "
                                   f"has {env}={value}"]}
            per = calls_per_request.get(f"{name}>{host}")
            if nodes[host][0] == "Datastore":                # a connection to a store: reads + writes
                add(name, "READS", host, calls_per_request=per, **common)
                add(name, "WRITES", host, **common)          # load is counted once, on READS
            else:
                add(name, "CALLS", host, calls_per_request=per, **common)

    # Rules 2-4: declared links (synthetic catalog), checked against the access log
    declared = set()
    for spec in catalog.get("links", []):
        a, rel, b = spec["from"], spec["rel"], spec["to"]
        declared.add(link_key(a, rel, b))
        note = f" ({spec['note']})" if spec.get("note") else ""
        common = {"source": "synthetic", "calls_per_request": calls_per_request.get(f"{a}>{b}")}
        action = {"READS": "read", "WRITES": "write"}.get(rel)
        if spec.get("verified"):
            add(a, rel, b, confidence=1.0, rule="verified",
                evidence=[f"catalog.toml: declared and verified by {owners[a]}{note}"], **common)
        elif action and log.get(a):
            conf, text, n, k, last = log_evidence(log[a], action, b, today)
            add(a, rel, b, confidence=conf, rule="logs", runs_seen=n, runs_used=k, last_used=last,
                evidence=[f"catalog.toml: declared by {owners[a]}{note}", text], **common)
        else:
            reason = ("secret use is not recorded in the access log" if rel == "USES_SECRET"
                      else "never seen in the access log")
            when = f" on {spec['declared']}" if spec.get("declared") else ""
            add(a, rel, b, confidence=DECLARED_PRIOR, rule="declared",
                evidence=[f"catalog.toml: declared{when} by {owners[a]}, not verified{note}",
                          f"Cannot be checked: {reason}, so 50%"], **common)

    # Rule 3 again: links the log shows that nobody declared
    discovered, people = [], set()
    for principal, runs in log.items():
        if principal not in nodes:
            people.add(principal)
            continue
        for action, resource in sorted({x for _t, _r, acc in runs for x in acc}):
            key = link_key(principal, ACTION_REL[action], resource)
            if key in declared or key in links or resource not in nodes:
                continue
            conf, text, n, k, last = log_evidence(runs, action, resource, today)
            add(principal, ACTION_REL[action], resource, confidence=conf, rule="logs",
                source="synthetic", runs_seen=n, runs_used=k, last_used=last,
                evidence=["Not declared anywhere: found only in access_log.csv", text])
            discovered.append(key)

    # Hand-run jobs: how often they run decides how likely they are to hit a change
    for link in links.values():
        kind, props = nodes[link["a"]]
        if kind == "Job" and not props.get("schedule"):
            every = rhythm_days(log.get(link["a"], []))
            link["props"]["every_days"] = every or 30.0
            link["props"]["evidence"].append(
                f"access_log.csv: {link['a']} runs about every {every:g} days" if every
                else f"{link['a']} has under 2 runs in the log: assumed monthly")

    traffic = catalog.get("traffic", {})
    if traffic.get("entry") not in nodes:
        raise SystemExit("catalog.toml: [traffic] entry must name a service")
    report = {"deployments": len(deployments), "drift": drift, "discovered": discovered,
              "people_ignored": sorted(people), "log_runs": sum(len(r) for r in log.values()),
              "traffic": {"entry": traffic["entry"], "base_rps": float(traffic.get("base_rps", 1))}}
    return nodes, links, owners, report


SOURCES = [  # (name, kind, license, synthetic)
    ("kubernetes-manifests.yaml", "Kubernetes deployment file", "Apache-2.0 (Google LLC)", False),
    ("catalog.toml", "service catalog and load test", "invented for this demo", True),
    ("CODEOWNERS", "ownership file", "invented for this demo", True),
    ("access_log.csv", "data access log", "invented for this demo", True),
]


def search_text(name, kind, owner, props):
    """Words the console's search box can find an asset by (FalkorDB full-text index)."""
    words = [name, *re.split(r"[_\-]+", name), kind, owner or "", props.get("engine", ""),
             props.get("note", ""), props.get("schedule_text", "")]
    if name.endswith("service") and len(name) > 7:
        words.append(name[:-7])                     # "cartservice" -> "cart"
    return " ".join(w for w in words if w).lower()


def build(today=None, world=WORLD):
    """Rebuild the world graph from the evidence files. Returns a report dict."""
    today = today or date.today()
    nodes, links, owners, report = collect(today)
    for name, (kind, props) in nodes.items():
        props["search"] = search_text(name, kind, owners.get(name), props)

    try:
        db.select_graph(world).delete()                 # start fresh every time
    except Exception:
        pass
    g = db.select_graph(world)
    for label, prop in (("Asset", "name"), ("Team", "name"), ("Source", "name")):
        g.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
    try:                                                  # full-text index for the search box
        g.query("CALL db.idx.fulltext.createNodeIndex('Asset', 'search')")
    except Exception:
        try:
            g.query("CREATE FULLTEXT INDEX FOR (n:Asset) ON (n.search)")
        except Exception:
            pass                                          # search falls back to CONTAINS

    g.query("UNWIND $rows AS r CREATE (s:Source) SET s = r",
            {"rows": [{"name": n, "kind": k, "license": lic, "synthetic": syn}
                      for n, k, lic, syn in SOURCES]})
    for kind in KINDS:                                    # Cypher labels can't be parameters
        rows = [props for k, props in nodes.values() if k == kind]
        g.query(f"UNWIND $rows AS r CREATE (a:Asset:{kind}) SET a = r", {"rows": rows})
    g.query("UNWIND $teams AS t CREATE (:Team {name: t})", {"teams": sorted(set(owners.values()))})
    g.query("""UNWIND $rows AS r MATCH (a:Asset {name: r[0]}), (t:Team {name: r[1]})
               CREATE (a)-[:OWNED_BY]->(t)""", {"rows": [[a, t] for a, t in owners.items()]})
    g.query("""MATCH (a:Asset), (s:Source)
               WHERE (a.source = 'online-boutique' AND s.name = 'kubernetes-manifests.yaml')
                  OR (a.source = 'synthetic' AND s.name = 'catalog.toml')
               CREATE (a)-[:FOUND_IN]->(s)""")
    for rel in DEP_RELS:
        rows = [{"a": l["a"], "b": l["b"], "props": l["props"]} for l in links.values() if l["rel"] == rel]
        if rows:
            g.query(f"""UNWIND $rows AS r
                        MATCH (a:Asset {{name: r.a}}), (b:Asset {{name: r.b}})
                        CREATE (a)-[l:{rel}]->(b) SET l = r.props""", {"rows": rows})
    if report["drift"]:
        g.query("""UNWIND $rows AS r MATCH (a:Asset {name: r[0]})
                   CREATE (f:Finding {kind: 'config drift', detail: r[1]})-[:ABOUT]->(a)""",
                {"rows": [[d.split(" ")[0], d] for d in report["drift"]]})
    g.query("CREATE (:Meta {built_at: $at, evidence_date: $today, traffic_entry: $entry, base_rps: $rps})",
            {"at": datetime.now().isoformat(timespec="seconds"), "today": today.isoformat(),
             "entry": report["traffic"]["entry"], "rps": report["traffic"]["base_rps"]})
    report.update(nodes=len(nodes), links=len(links), teams=len(set(owners.values())))
    return report


def print_report(report, world=WORLD):
    g = db.select_graph(world)
    print(f"Built '{world}' from evidence on {date.today():%d %b %Y}")
    print(f"  Real:      {report['deployments']} Kubernetes deployments (Google Online Boutique)")
    print(f"  Synthetic: back office, owners, {report['log_runs']} logged job runs")
    for label in KINDS:
        n = g.ro_query(f"MATCH (a:{label}) RETURN count(a)").result_set[0][0]
        print(f"  {label + 's:':<12}{n}")
    print(f"  {'Teams:':<12}{report['teams']}")
    print("\nWhere the links came from:")
    for rule, n in g.ro_query("""MATCH ()-[r]->() WHERE r.rule IS NOT NULL
                                 RETURN r.rule, count(r) ORDER BY count(r) DESC""").result_set:
        print(f"  {rule:<9} {n}")
    print("\nLinks we are NOT sure about (computed, not typed in):")
    for a, rel, b, conf, ev in g.ro_query("""MATCH (a)-[r]->(b) WHERE r.confidence < 1
                                             RETURN a.name, type(r), b.name, r.confidence, r.evidence
                                             ORDER BY r.confidence DESC""").result_set:
        print(f"  {conf:>4.0%}  {a} -{rel}-> {b}")
        for line in ev:
            print(f"          {line}")
    if report["discovered"]:
        print("\nFound in the access log but declared nowhere:")
        for key in report["discovered"]:
            print(f"  {key.replace('|', ' ')}")
    if report["drift"]:
        print("\nConfiguration drift in the real Kubernetes file:")
        for d in report["drift"]:
            print(f"  {d}")
    if report["people_ignored"]:
        print(f"\nIgnored log lines from people (not assets): {', '.join(report['people_ignored'])}")


if __name__ == "__main__":
    print_report(build())
