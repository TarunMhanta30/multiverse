"""
Multiverse - MCP server (MCP Python SDK v2). Any AI agent - Claude Desktop, the agent.py script,
any MCP client - uses Multiverse through these tools.

Look before acting:
  list_assets()                       every asset, with kind, owner, criticality and source
  what_depends_on(name)               static check: every asset with a dependency path into `name`
  evidence(name)                      every link into and out of `name`, with confidence and evidence
  recall(name)                        what memory holds: past rehearsals, questions, team answers
  find_cleanup_candidates()           graph algorithms + a rehearsal for each candidate
  launch_advice(surge, surge_p90)     where a traffic surge breaks things, and what to scale
Rehearse (never changes anything):
  rehearse_delete(name)               many possible futures, each in its own copy of the company
  rehearse(steps)                     the same for any plan: offline windows, rotations, launches, ...
Act (both re-check with a fresh rehearsal; only SAFE gets through):
  delete_asset(name)                  the simple path for a delete
  propose_plan(steps) / execute_approved_plan(plan_id)
                                      coordination with other agents: approved, held or blocked
  find_safe_window(steps)             earliest time slot that is safe with every other plan
  team_inbox(team)                    questions waiting for a team's answer

Every call is logged to the memory graph (agent, calling app, tool, result), so the console shows
what agents are doing live, and every rehearsal streams there as it runs.

Agents launch this over stdio:  python mcp_server.py
Claude Desktop:                 python connect_claude.py   (writes its config for you)
Test it without any agent:      python test_mcp.py
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field
from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError

import coordination
import insights
import memory
import multiverse
from config import DEP_PATTERN, MAX_DEPTH, WORLD, db
from plans import PlanError

mcp = MCPServer(
    "multiverse",
    instructions=(
        "Multiverse rehearses actions on the company Boutique Inc. before they happen. "
        "Rules: (1) Before deleting or changing anything, rehearse it (rehearse_delete or rehearse). "
        "(2) Act only when the verdict is SAFE: delete_asset for a delete; for maintenance windows, "
        "launches and other plans, propose_plan and then execute_approved_plan. "
        "(3) If the verdict is BLOCK or REVIEW, do not act and do not retry with different wording: "
        "explain what breaks, how likely, why (the dependency path and its evidence) and which "
        "teams were asked. (4) Always pass agent='<your name>', e.g. agent='claude-desktop'. "
        "Asset names come from list_assets."),
)

Action = Literal["delete", "offline", "rotate_secret", "launch", "repoint", "reschedule", "scale",
                 "add_service", "assume"]


class Step(BaseModel):
    """One step of a plan. Which fields matter depends on `action`."""
    action: Action
    asset: Optional[str] = Field(None, description="The asset the step acts on (any action except launch/assume)")
    start: Optional[str] = Field(None, description="offline/launch: local start time like 2026-11-01T01:00")
    hours: Optional[float] = Field(None, description="offline/launch: how long, in hours")
    surge: Optional[float] = Field(None, description="launch: expected traffic as a multiple of normal, e.g. 3")
    surge_p90: Optional[float] = Field(None, description="launch: 1-in-10 high case, e.g. 6")
    old: Optional[str] = Field(None, description="repoint: the dependency to stop using")
    new: Optional[str] = Field(None, description="repoint: the dependency to use instead")
    schedule: Optional[str] = Field(None, description="reschedule: e.g. 'daily@02:00', 'monthly:day=1@02:00'")
    factor: Optional[float] = Field(None, description="scale: capacity multiplier, e.g. 2")
    owner: Optional[str] = Field(None, description="add_service: owning team")
    criticality: Optional[int] = Field(None, description="add_service: 1 low .. 3 high")
    calls: Optional[dict[str, float]] = Field(None, description="add_service: {service: calls per request}")
    entry_share: Optional[float] = Field(None, description="add_service: share of entry traffic it gets")
    rps_per_core: Optional[float] = None
    cpu_m: Optional[int] = None
    link: Optional[str] = Field(None, description="assume: link key 'a|READS|b'")
    confidence: Optional[float] = Field(None, description="assume: 0..1")


class Asset(BaseModel):
    name: str
    kind: str
    criticality: int = Field(description="1 low .. 3 high")
    owner: str
    source: str = Field(description="'online-boutique' (real Kubernetes file) or 'synthetic'")


class Link(BaseModel):
    link: str
    confidence: float
    rule: str = Field(description="k8s, verified, logs, declared or plan")
    evidence: list[str]
    team_answer: Optional[str] = None


class Affected(BaseModel):
    name: str
    status: str = Field(description="broken, stale, degraded, overloaded or deleted")
    probability: float = Field(description="Share of rehearsed futures where this happens")
    criticality: int
    critical: bool
    owner: str
    why: str = Field(description="The dependency path that explains it")


class Unverified(BaseModel):
    link: str
    confidence: float
    ask: str = Field(description="Team that can confirm or deny it (already asked)")
    evidence: list[str]


class Rehearsal(BaseModel):
    rehearsal_id: str
    title: str
    verdict: str = Field(description="SAFE, REVIEW or BLOCK")
    decision_status: str
    critical_breakage_probability: float
    probability_range: list[float]
    exact: bool = Field(description="True when nothing uncertain touches the plan (one future is exact)")
    futures_rehearsed: int
    dice: int = Field(description="Seed; the same plan with the same dice replays the same futures")
    stop_reason: str
    affected: list[Affected]
    unverified_links: list[Unverified]
    learned_facts: list[str]
    launch: Optional[dict[str, Any]] = None
    reviewers: list[str]
    real_company_unchanged: bool = Field(description="Fingerprint of the whole company graph before == after")
    copies_left_behind: int
    questions_opened: list[str]


class ExecuteResult(BaseModel):
    executed: bool
    reason: str
    changes: list[str] = []
    booked: list[str] = []
    plan_status: Optional[str] = None
    rehearsal: Optional[Rehearsal] = None


class Proposal(BaseModel):
    plan_id: str
    status: str = Field(description="approved, held or blocked")
    reason: str
    alone: dict[str, Any]
    conflicts: list[dict[str, Any]]
    suggestion: Optional[dict[str, Any]] = None


class MemoryEvent(BaseModel):
    kind: str
    at: str
    summary: str


class OpenQuestion(BaseModel):
    id: str
    team: str
    link: str
    asked_at: str


# ----------------------------------------------------------------------------- helpers
def _client(ctx):
    try:
        return ctx.session.client_params.client_info.name or ""
    except Exception:
        return ""


def _summary_text(result):
    if isinstance(result, Rehearsal):
        return (f"{result.verdict} ({result.decision_status}): "
                f"{'exact' if result.exact else f'{result.futures_rehearsed} futures'}, "
                f"critical {result.critical_breakage_probability:.0%}")
    if isinstance(result, ExecuteResult):
        return ("EXECUTED: " if result.executed else "") + result.reason
    if isinstance(result, Proposal):
        return f"{result.status.upper()}: {result.reason}"
    if isinstance(result, list):
        return f"{len(result)} item(s)"
    if isinstance(result, dict):
        return ", ".join(f"{k}={v}" for k, v in list(result.items())[:3])
    return str(result)[:200]


def _run(ctx, agent, tool, args, fn):
    """Run a tool body, log the call to the memory graph, and turn errors into ToolError."""
    client = _client(ctx)
    try:
        result = fn()
    except (PlanError, ValueError, PermissionError) as e:
        memory.log_call(agent, client, tool, args, str(e), ok=False)
        raise ToolError(str(e)) from None
    rid = getattr(result, "rehearsal_id", None) or getattr(getattr(result, "rehearsal", None), "rehearsal_id", None)
    memory.log_call(agent, client, tool, args, _summary_text(result), ok=True, rid=rid)
    return result


def _rehearsal_model(s):
    launch = None
    if s.get("launch"):
        L = s["launch"]
        launch = {"first_critical_break_x": L["first_critical_break"], "theory_p_crit": L["theory_p_crit"],
                  "simulated_p_crit": L["simulated_p_crit"], "advice": L["advice"],
                  "breaking_points": L["breaking_points"][:6]}
    return Rehearsal(
        rehearsal_id=s["rid"], title=s["title"], verdict=s["verdict"], decision_status=s["decision_status"],
        critical_breakage_probability=s["p_crit"], probability_range=s["range"], exact=s["exact"],
        futures_rehearsed=s["futures"], dice=s["seed"], stop_reason=s["stop_reason"],
        affected=[Affected(**{k: a[k] for k in Affected.model_fields}) for a in s["affected"]],
        unverified_links=[Unverified(**{k: u[k] for k in Unverified.model_fields}) for u in s["unverified"]],
        learned_facts=[f"{f['link']} = {'EXISTS' if f['exists'] else 'DOES NOT EXIST'} (answered by {f['by']})"
                       for f in s["learned"]],
        launch=launch, reviewers=s["reviewers"], real_company_unchanged=s["fingerprint"]["unchanged"],
        copies_left_behind=len(s["forks_left"]), questions_opened=s["questions"])


def _steps(steps):
    return [s.model_dump(exclude_none=True) for s in steps]


def _execute_model(out):
    return ExecuteResult(executed=out["executed"], reason=out["reason"],
                         changes=[f"{c['kind']}: {c.get('key') or c.get('name')}" for c in out.get("changes", [])],
                         booked=out.get("booked", []), plan_status=out.get("plan_status"),
                         rehearsal=_rehearsal_model(out["rehearsal"]) if out.get("rehearsal") else None)


# ----------------------------------------------------------------------------- look
@mcp.tool()
def list_assets(ctx: Context, agent: str = "unknown-agent") -> list[Asset]:
    """Every asset in the company (services, datastores, jobs, secrets) with owner, criticality and source."""
    def body():
        rows = db.select_graph(WORLD).ro_query("""
            MATCH (a:Asset)-[:OWNED_BY]->(t:Team)
            RETURN a.name, labels(a), a.criticality, t.name, a.source ORDER BY a.name""").result_set
        return [Asset(name=n, kind=next(l for l in labels if l != "Asset"), criticality=c, owner=t, source=s)
                for n, labels, c, t, s in rows]
    return _run(ctx, agent, "list_assets", {}, body)


@mcp.tool()
def what_depends_on(name: str, ctx: Context, agent: str = "unknown-agent") -> list[str]:
    """Static check: every asset with a dependency path into `name` (ignores time and uncertainty)."""
    def body():
        rows = db.select_graph(WORLD).ro_query(f"""
            MATCH (x:Asset)-[:{DEP_PATTERN}*1..{MAX_DEPTH}]->(t:Asset {{name: $n}})
            WHERE x <> t RETURN DISTINCT x.name""", {"n": name}).result_set
        if not db.select_graph(WORLD).ro_query("MATCH (a:Asset {name: $n}) RETURN a", {"n": name}).result_set:
            raise ValueError(f"No asset called {name!r}. Ask list_assets for valid names.")
        return sorted(r[0] for r in rows)
    return _run(ctx, agent, "what_depends_on", {"name": name}, body)


@mcp.tool()
def evidence(name: str, ctx: Context, agent: str = "unknown-agent") -> list[Link]:
    """Every dependency link into and out of `name`, with its confidence, the rule that set it and the
    evidence behind it (Kubernetes lines, access-log statistics, catalog entries, team answers)."""
    def body():
        learned = memory.learned_links()
        rows = db.select_graph(WORLD).ro_query(f"""
            MATCH (a:Asset)-[r:{DEP_PATTERN}]->(b:Asset) WHERE a.name = $n OR b.name = $n
            RETURN a.name, type(r), b.name, r.confidence, r.rule, r.evidence""", {"n": name}).result_set
        if not rows and not db.select_graph(WORLD).ro_query("MATCH (a:Asset {name: $n}) RETURN a",
                                                           {"n": name}).result_set:
            raise ValueError(f"No asset called {name!r}. Ask list_assets for valid names.")
        out = []
        for a, rel, b, conf, rule, ev in rows:
            fact = learned.get((a, rel, b))
            out.append(Link(link=f"{a} -{rel}-> {b}", confidence=conf, rule=rule or "", evidence=list(ev or []),
                            team_answer=(f"{'exists' if fact[0] else 'does not exist'} ({fact[1]})" if fact else None)))
        return out
    return _run(ctx, agent, "evidence", {"name": name}, body)


@mcp.tool()
def recall(name: str, ctx: Context, agent: str = "unknown-agent") -> list[MemoryEvent]:
    """What memory holds about an asset, oldest first: rehearsals, questions to teams, their answers, plans."""
    def body():
        events = []
        for e in memory.history(name):
            if e["kind"] == "Rehearsal":
                s = (f"Rehearsal '{e['title']}' by {e['by']}: {e['verdict'] or e['state']}"
                     f" ({(e['p_crit'] or 0):.0%} critical){', ' + e['status'] if e['status'] else ''}")
            elif e["kind"] == "Question":
                s = f"Asked {e['team']}: does '{e['link']}' exist? [{e['status']}]"
            elif e["kind"] == "Fact":
                s = f"{e['by']} answered: '{e['link']}' {'EXISTS' if e['exists'] else 'DOES NOT EXIST'}. {e['note'] or ''}"
            else:
                s = f"Plan '{e['title']}' by {e['by']}: {e['status']}"
            events.append(MemoryEvent(kind=e["kind"], at=e["at"], summary=s.strip()))
        return events
    return _run(ctx, agent, "recall", {"name": name}, body)


@mcp.tool()
def find_cleanup_candidates(ctx: Context, agent: str = "unknown-agent") -> list[dict[str, Any]]:
    """Assets that look removable (graph algorithms: islands, uncertain-only dependents, idle jobs),
    each checked with a real delete rehearsal. Only candidates with verdict SAFE may be deleted."""
    return _run(ctx, agent, "find_cleanup_candidates", {},
                lambda: insights.cleanup(by=agent, client=_client(ctx)))


@mcp.tool()
def launch_advice(surge: float, surge_p90: float, ctx: Context, agent: str = "unknown-agent") -> dict[str, Any]:
    """For a traffic surge (median `surge`, 1-in-10 high case `surge_p90`): the traffic multiple at which
    each service breaks, the chance something critical breaks, and how much to scale to be ready."""
    def body():
        L = multiverse.launch_advice(surge, surge_p90)
        return {k: L[k] for k in ("first_critical_break", "theory_p_crit", "ready_for", "advice", "breaking_points")}
    return _run(ctx, agent, "launch_advice", {"surge": surge, "surge_p90": surge_p90}, body)


# ----------------------------------------------------------------------------- rehearse
@mcp.tool()
def rehearse_delete(name: str, ctx: Context, agent: str = "unknown-agent",
                    dice: Optional[int] = None) -> Rehearsal:
    """Rehearse deleting `name` across many possible futures, each played in its own copy of the company.
    Returns the verdict, what breaks, how likely and why, and asks the owning team about any uncertain
    link that decided it. Changes nothing."""
    return _run(ctx, agent, "rehearse_delete", {"name": name, "dice": dice}, lambda: _rehearsal_model(
        multiverse.rehearse({"steps": [{"action": "delete", "asset": name}]}, by=agent,
                            client=_client(ctx), seed=dice)))


@mcp.tool()
def rehearse(steps: list[Step], ctx: Context, agent: str = "unknown-agent", title: str = "",
             dice: Optional[int] = None) -> Rehearsal:
    """Rehearse any plan (delete, offline window, secret rotation, traffic launch, repoint, reschedule,
    scale, new service, what-if) across many possible futures. Changes nothing."""
    plan = {"title": title, "steps": _steps(steps)}
    return _run(ctx, agent, "rehearse", plan, lambda: _rehearsal_model(
        multiverse.rehearse(plan, by=agent, client=_client(ctx), seed=dice)))


# ----------------------------------------------------------------------------- act
@mcp.tool()
def delete_asset(name: str, ctx: Context, agent: str = "unknown-agent") -> ExecuteResult:
    """Delete `name` from the REAL company. Runs a fresh rehearsal first and refuses unless it is SAFE.
    This check cannot be skipped."""
    return _run(ctx, agent, "delete_asset", {"name": name}, lambda: _execute_model(
        multiverse.execute({"steps": [{"action": "delete", "asset": name}]}, by=agent, client=_client(ctx))))


@mcp.tool()
def propose_plan(steps: list[Step], ctx: Context, agent: str = "unknown-agent", title: str = "") -> Proposal:
    """Ask to carry out a plan. Multiverse rehearses it alone and together with every other agent's
    active plan that overlaps it in time and in the graph. Returns approved, held (with the clash and
    a safe time slot when there is one) or blocked."""
    plan = {"title": title, "steps": _steps(steps)}

    def body():
        r = coordination.propose(plan, agent, client=_client(ctx))
        return Proposal(plan_id=r["plan_id"], status=r["status"], reason=r["reason"], alone=r["alone"],
                        conflicts=r["conflicts"], suggestion=r["suggestion"])
    return _run(ctx, agent, "propose_plan", plan, body)


@mcp.tool()
def execute_approved_plan(plan_id: str, ctx: Context, agent: str = "unknown-agent",
                          accept_minor: bool = False) -> ExecuteResult:
    """Carry out a plan that propose_plan approved for this agent. Re-checks clashes and re-rehearses
    first; only SAFE (or REVIEW with accept_minor=True and no open questions) gets through."""
    return _run(ctx, agent, "execute_approved_plan", {"plan_id": plan_id, "accept_minor": accept_minor},
                lambda: _execute_model(coordination.execute_plan(plan_id, agent, client=_client(ctx),
                                                                 accept_minor=accept_minor)))


@mcp.tool()
def find_safe_window(steps: list[Step], ctx: Context, agent: str = "unknown-agent") -> dict[str, Any]:
    """For a plan with a time window (offline or launch): the earliest start in the next 7 days that is
    SAFE together with every other agent's active plan."""
    plan = {"title": "", "steps": _steps(steps)}

    def body():
        r = coordination.safe_window(plan, agent=agent, client=_client(ctx))
        return {k: r[k] for k in ("requested", "best_start", "best_end", "best_verdict", "best_p_crit",
                                  "candidates", "rehearsed")}
    return _run(ctx, agent, "find_safe_window", plan, body)


@mcp.tool()
def team_inbox(ctx: Context, agent: str = "unknown-agent", team: Optional[str] = None) -> list[OpenQuestion]:
    """Questions still waiting for a team's answer. Pass a team name to see only that team's inbox."""
    return _run(ctx, agent, "team_inbox", {"team": team}, lambda: [
        OpenQuestion(id=q["id"], team=q["team"], link=q["link"], asked_at=q["at"])
        for q in memory.open_questions(team)])


if __name__ == "__main__":
    if WORLD not in db.list_graphs():          # FalkorDB restarted empty: rebuild the company first
        import world
        world.build()
    mcp.run()   # stdio: an agent host launches this file and talks over stdin/stdout
