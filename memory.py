"""
Multiverse - memory: a second graph, 'boutique_memory', that survives world rebuilds.

  world graph  (boutique_main)   = the company, rebuilt from evidence any time (world.py)
  memory graph (boutique_memory) = everything that HAPPENED: rehearsals, every future played,
                                   questions to teams, their answers, agent calls, agent plans

Every finished future is written here the moment it ends. The console streams futures by
reading this graph, so it shows a rehearsal live no matter which program runs it: the console
itself, an AI agent through the MCP server, or the command line.

Nodes and links:
  (:Rehearsal {id, title, plan, by, client, seed, mode, exact, status, futures, p_crit, verdict, ...})
      -[:HAS_FUTURE]-> (:Future {rid, i, outcome, fork, ms, surge, dropped, overloaded, affected})
      -[:ABOUT]-> (:Asset {name})          -[:RAISED]-> (:Question)
  (:Question {id, link, status, at})  -[:ASKS]-> (:Team), -[:ABOUT]-> (:Asset)
  (:Fact {id, link, source, rel, target, exists, by, note, at})  -[:ANSWERS]-> (:Question)
  (:AgentCall {id, at, agent, client, tool, args, summary, ok, rid})  -[:MADE_BY]-> (:Agent {name})
  (:Plan {id, title, steps, status, ...})  (agent coordination - see coordination.py)

Rule: only the team that OWNS the source of a link may confirm or deny that link.
"""
import json
import uuid
from datetime import datetime

from config import MEMORY, WORLD, db

_ready = False


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:6]}"


def link_text(a, rel, b):
    return f"{a} -{rel}-> {b}"


def mem():
    """The memory graph, with its indexes created on first use."""
    global _ready
    g = db.select_graph(MEMORY)
    if not _ready:
        for label, prop in (("Rehearsal", "id"), ("Future", "rid"), ("Question", "link"),
                            ("Fact", "link"), ("Asset", "name"), ("Team", "name"),
                            ("AgentCall", "at"), ("Agent", "name"), ("Plan", "id")):
            try:
                g.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
            except Exception:
                pass                                        # already indexed
        _ready = True
    return g


def _loads(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


# ----------------------------------------------------------------------------- rehearsals
def create_rehearsal(fields, assets):
    mem().query("""CREATE (r:Rehearsal) SET r = $f
                   WITH r UNWIND $assets AS name
                   MERGE (a:Asset {name: name})
                   CREATE (r)-[:ABOUT]->(a)""", {"f": fields, "assets": sorted(assets)})


def update_rehearsal(rid, **fields):
    mem().query("MATCH (r:Rehearsal {id: $id}) SET r += $f", {"id": rid, "f": fields})


def add_future(rid, fields):
    mem().query("""MATCH (r:Rehearsal {id: $rid})
                   CREATE (r)-[:HAS_FUTURE]->(f:Future) SET f = $f""",
                {"rid": rid, "f": {"rid": rid, **fields}})


def _rehearsal_dict(props):
    d = dict(props)
    d["plan"] = _loads(d.get("plan"), {})
    d["summary"] = _loads(d.get("summary"), None)
    return d


def get_rehearsal(rid):
    rows = mem().ro_query("MATCH (r:Rehearsal {id: $id}) RETURN properties(r)", {"id": rid}).result_set
    return _rehearsal_dict(rows[0][0]) if rows else None


def list_rehearsals(limit=20):
    try:
        rows = mem().ro_query("""MATCH (r:Rehearsal) RETURN properties(r)
                                 ORDER BY r.started DESC LIMIT $n""", {"n": limit}).result_set
    except Exception:
        return []
    out = []
    for (props,) in rows:
        d = _rehearsal_dict(props)
        d.pop("summary", None)
        out.append(d)
    return out


def _future_dict(props):
    d = dict(props)
    d["affected"] = _loads(d.get("affected"), [])
    d["disrupted"] = _loads(d.get("disrupted"), {})
    d["trace"] = _loads(d.get("trace"), None)
    return d


def futures_since(rid, after=0, limit=1000):
    rows = mem().ro_query("""MATCH (f:Future {rid: $rid}) WHERE f.i > $after
                             RETURN properties(f) ORDER BY f.i LIMIT $n""",
                          {"rid": rid, "after": after, "n": limit}).result_set
    return [_future_dict(p) for (p,) in rows]


def get_future(rid, i):
    rows = mem().ro_query("MATCH (f:Future {rid: $rid, i: $i}) RETURN properties(f)",
                          {"rid": rid, "i": int(i)}).result_set
    return _future_dict(rows[0][0]) if rows else None


def prune(keep=60):
    """Keep the futures of the `keep` most recent rehearsals; older ones keep only their summary."""
    mem().query("""MATCH (r:Rehearsal) WITH r ORDER BY r.started DESC SKIP $keep
                   MATCH (r)-[:HAS_FUTURE]->(f:Future) DETACH DELETE f""", {"keep": keep})


# ----------------------------------------------------------------------------- questions and answers
def learned_links():
    """{(source, rel, target): (exists, team)} - the latest answer for every confirmed link."""
    try:
        rows = mem().ro_query("""MATCH (f:Fact) RETURN f.source, f.rel, f.target, f.exists, f.by
                                 ORDER BY f.at""").result_set
    except Exception:
        return {}
    return {(a, rel, b): (ex, by) for a, rel, b, ex, by in rows}


def ask(rid, a, rel, b, team):
    """Open a question for `team` about a link - unless the same question is already open."""
    g = mem()
    link = link_text(a, rel, b)
    found = g.ro_query("MATCH (q:Question {link: $l, status: 'open'}) RETURN q.id", {"l": link}).result_set
    qid = found[0][0] if found else new_id("Q")
    if not found:
        g.query("""MERGE (t:Team {name: $team})
                   MERGE (s:Asset {name: $a})
                   MERGE (d:Asset {name: $b})
                   CREATE (q:Question {id: $id, link: $l, source: $a, rel: $rel, target: $b,
                                       status: 'open', at: $at})
                   CREATE (q)-[:ASKS]->(t), (q)-[:ABOUT]->(s), (q)-[:ABOUT]->(d)""",
                {"team": team, "a": a, "b": b, "rel": rel, "id": qid, "l": link, "at": now_iso()})
    g.query("MATCH (r:Rehearsal {id: $r}), (q:Question {id: $q}) MERGE (r)-[:RAISED]->(q)",
            {"r": rid, "q": qid})
    return qid


def confirm_link(a, rel, b, exists, by, note=""):
    """A team answers 'does this link really exist?'. Stored for good; closes the open question.
    Returns the ids of the questions it answered."""
    world = db.select_graph(WORLD)
    link = link_text(a, rel, b)
    found = world.ro_query("MATCH ()-[l]->() WHERE l.key = $k RETURN count(l)",
                           {"k": f"{a}|{rel}|{b}"}).result_set[0][0]
    if not found:
        raise ValueError(f"No such link in the world: {link}")
    owner = world.ro_query("MATCH (:Asset {name: $a})-[:OWNED_BY]->(t:Team) RETURN t.name",
                           {"a": a}).result_set[0][0]
    if by != owner:
        raise PermissionError(f"Only {owner} can confirm links of {a} (asked by {by})")
    g = mem()
    fid = new_id("F")
    g.query("""MERGE (s:Asset {name: $a})
               MERGE (t:Asset {name: $b})
               CREATE (f:Fact {id: $id, link: $l, source: $a, rel: $rel, target: $b,
                               exists: $ex, by: $by, note: $note, at: $at})
               CREATE (f)-[:ABOUT]->(s), (f)-[:ABOUT]->(t)""",
            {"a": a, "b": b, "id": fid, "l": link, "rel": rel, "ex": bool(exists),
             "by": by, "note": note, "at": now_iso()})
    closed = g.query("""MATCH (q:Question {link: $l, status: 'open'}), (f:Fact {id: $id})
                        SET q.status = 'answered'
                        CREATE (f)-[:ANSWERS]->(q)
                        RETURN q.id""", {"l": link, "id": fid}).result_set
    return [row[0] for row in closed]


def open_questions(team=None):
    """[{id, link, source, rel, target, team, at}] still waiting for an answer."""
    try:
        rows = mem().ro_query("""MATCH (q:Question {status: 'open'})-[:ASKS]->(t:Team)
                                 RETURN q.id, q.link, q.source, q.rel, q.target, t.name, q.at
                                 ORDER BY q.at""").result_set
    except Exception:
        return []
    keys = ("id", "link", "source", "rel", "target", "team", "at")
    return [dict(zip(keys, r)) for r in rows if team is None or r[5] == team]


def history(name):
    """Everything memory holds about an asset, oldest first."""
    try:
        rows = mem().ro_query("""
            MATCH (a:Asset {name: $n})<-[:ABOUT]-(x)
            OPTIONAL MATCH (x)-[:ASKS]->(t:Team)
            RETURN DISTINCT labels(x)[0], properties(x), t.name""", {"n": name}).result_set
    except Exception:
        return []
    events = []
    for kind, props, team in rows:
        p = dict(props)
        at = p.get("started") or p.get("at") or p.get("created") or ""
        e = {"kind": kind, "id": p.get("id"), "at": at, "team": team}
        if kind == "Rehearsal":
            e.update(title=p.get("title"), verdict=p.get("verdict"), status=p.get("decision_status"),
                     p_crit=p.get("p_crit"), futures=p.get("futures"), by=p.get("by"),
                     client=p.get("client"), state=p.get("status"))
        elif kind == "Question":
            e.update(link=p.get("link"), status=p.get("status"))
        elif kind == "Fact":
            e.update(link=p.get("link"), exists=p.get("exists"), by=p.get("by"), note=p.get("note"))
        elif kind == "Plan":
            e.update(title=p.get("title"), status=p.get("status"), by=p.get("agent"))
        events.append(e)
    events.sort(key=lambda e: e["at"] or "")
    return events


# ----------------------------------------------------------------------------- agent activity
def log_call(agent, client, tool, args, summary, ok=True, rid=None):
    """Record one tool call by an AI agent (written by the MCP server)."""
    cid = new_id("C")
    mem().query("""MERGE (ag:Agent {name: $agent})
                   CREATE (c:AgentCall {id: $id, at: $at, agent: $agent, client: $client, tool: $tool,
                                        args: $args, summary: $summary, ok: $ok, rid: $rid})
                   CREATE (c)-[:MADE_BY]->(ag)""",
                {"agent": agent, "id": cid, "at": now_iso(), "client": client or "", "tool": tool,
                 "args": json.dumps(args, default=str)[:2000], "summary": summary[:500], "ok": ok,
                 "rid": rid or ""})
    return cid


def activity_since(after="", limit=50):
    """Agent calls newer than `after` (an ISO timestamp), oldest first."""
    try:
        rows = mem().ro_query("""MATCH (c:AgentCall) WHERE c.at > $after
                                 RETURN properties(c) ORDER BY c.at LIMIT $n""",
                              {"after": after, "n": limit}).result_set
    except Exception:
        return []
    out = []
    for (p,) in rows:
        d = dict(p)
        d["args"] = _loads(d.get("args"), {})
        out.append(d)
    return out


def agents_seen():
    """Every agent that called Multiverse tools: name, client program, calls, last call."""
    try:
        rows = mem().ro_query("""MATCH (c:AgentCall)
                                 RETURN c.agent, c.client, count(c), max(c.at) ORDER BY max(c.at) DESC""").result_set
    except Exception:
        return []
    return [{"agent": a, "client": c, "calls": n, "last": last} for a, c, n, last in rows]


def reset():
    """Forget everything (used to restart the demo)."""
    global _ready
    try:
        db.select_graph(MEMORY).delete()
    except Exception:
        pass
    _ready = False
