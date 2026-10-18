"""
Multiverse - ask the company graph a question in plain English (text to Cypher).

  1. an LLM gets the graph's schema and writes ONE read-only Cypher query
  2. FalkorDB runs it with GRAPH.RO_QUERY - read-only by construction, a write would fail -
     with a time limit
  3. the LLM turns the rows into a short answer; the console shows the question, the Cypher,
     the rows and the answer, and lights up every asset the answer mentions

Uses the same model settings as agent.py (any OpenAI-compatible endpoint):
  $env:LLM_BASE_URL  $env:LLM_API_KEY  $env:LLM_MODEL
Without them, ask() raises a clear error instead of guessing.
"""
import json
import os
import re
import urllib.error
import urllib.request

from config import WORLD, db

ROW_LIMIT = 50
TIMEOUT_MS = 3000
WRITES = re.compile(r"\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV)\b|db\.idx\.\w+\.(create|drop)",
                    re.IGNORECASE)

SCHEMA = """FalkorDB graph of the company Boutique Inc. (OpenCypher).
Nodes:
  (:Asset) with exactly one more label: :Service, :Datastore, :Job or :Secret.
     properties: name, criticality (1 = nice to have, 3 = the business stops without it),
     source ('online-boutique' = from Google's real Kubernetes file, 'synthetic' = invented back office),
     note (one-line description), engine (datastores), schedule_text (jobs, e.g. 'every day at 05:00'),
     capacity (requests per second it can take), replicas, cpu_m
  (:Team {name})        teams: Storefront, Checkout, Catalog, Platform, Finance, Data
  (:Finding {kind, detail})   problems found in the evidence, e.g. kind 'config drift'
Relationships between assets - (a)-[r]->(b) always means "a depends on b":
  CALLS, READS, WRITES, USES_SECRET, DEPENDS_ON, FED_BY (b feeds data into a)
  properties: confidence (0..1, how sure we are the link exists), rule ('k8s', 'verified', 'logs',
  'declared'), evidence (list of strings), soft (true = a still works without b, just worse),
  calls_per_request
Other relationships: (a:Asset)-[:OWNED_BY]->(t:Team), (f:Finding)-[:ABOUT]->(a:Asset)"""

PROMPT = """Write ONE read-only Cypher query that answers the question about the graph below.
Rules: only MATCH / OPTIONAL MATCH / WHERE / WITH / RETURN / ORDER BY / LIMIT / UNWIND and functions;
never CREATE, MERGE, SET, DELETE, REMOVE or CALL; return asset names (a.name) rather than whole nodes;
use variable-length paths like -[:CALLS|READS|WRITES|USES_SECRET|DEPENDS_ON|FED_BY*1..6]-> for
"directly or indirectly"; add LIMIT 50.
Reply with JSON only: {"cypher": "...", "explain": "one short sentence on what the query does"}

{schema}

Question: {question}"""

ANSWER = """Question: {question}
Cypher that was run: {cypher}
Rows (first {n}): {rows}
Answer the question in one to three plain sentences using only these rows. If there are no rows,
say that the graph has nothing matching. Mention asset names exactly as written."""


def settings():
    return {"base_url": os.environ.get("LLM_BASE_URL", "http://localhost:20128/v1").rstrip("/"),
            "api_key": os.environ.get("LLM_API_KEY", ""), "model": os.environ.get("LLM_MODEL", "")}


def configured():
    return bool(settings()["model"])


def chat(prompt):
    cfg = settings()
    body = json.dumps({"model": cfg["model"], "temperature": 0,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(f"{cfg['base_url']}/chat/completions", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {cfg['api_key']}"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read())["choices"][0]["message"].get("content") or ""
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"The model call failed ({e.code}): {e.read().decode()[:300]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cannot reach the model at {cfg['base_url']}: {e.reason}") from None


def _json_reply(text):
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("The model did not reply with JSON")
    return json.loads(text[start:end + 1])


def _plain(value):
    """Rows can hold nodes, edges or paths; keep them readable and JSON-safe."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    props = getattr(value, "properties", None)
    if isinstance(props, dict):
        return props.get("name") or {k: _plain(v) for k, v in props.items()}
    return str(value)


def ask(question, world=WORLD):
    question = (question or "").strip()
    if not question:
        raise ValueError("Write a question first")
    if not configured():
        raise ValueError("Asking in plain English needs a model: set $env:LLM_MODEL (and LLM_API_KEY, "
                         "LLM_BASE_URL) in PowerShell, then start python app.py from that window.")
    plan = _json_reply(chat(PROMPT.replace("{schema}", SCHEMA).replace("{question}", question)))
    cypher = str(plan.get("cypher", "")).strip().rstrip(";")
    if not cypher:
        raise RuntimeError("The model returned no query")
    if WRITES.search(cypher) or re.search(r"\bCALL\b", cypher, re.IGNORECASE):
        raise RuntimeError(f"Refused: the model wrote a query that is not read-only: {cypher}")
    g = db.select_graph(world)
    res = g.ro_query(cypher, timeout=TIMEOUT_MS)          # GRAPH.RO_QUERY: writes are impossible
    columns = [h[1] if isinstance(h, (list, tuple)) else str(h) for h in (res.header or [])]
    columns = [c.decode() if isinstance(c, bytes) else str(c) for c in columns]
    rows = [_plain(r) for r in res.result_set[:ROW_LIMIT]]
    names = {r[0] for r in g.ro_query("MATCH (a:Asset) RETURN a.name").result_set}
    blob = json.dumps(rows)
    mentioned = sorted(n for n in names if re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", blob))
    try:
        answer = chat(ANSWER.format(question=question, cypher=cypher, n=min(len(rows), 30),
                                    rows=json.dumps(rows[:30])[:4000])).strip()
    except Exception as e:                                  # still show the rows
        answer = f"(No summary: {e})"
    return {"question": question, "cypher": cypher, "explain": plan.get("explain", ""),
            "columns": columns, "rows": rows, "answer": answer, "assets": mentioned,
            "ms": round(getattr(res, "run_time_ms", 0) or 0, 2)}
