# How Multiverse works

## In one minute

Think of the company as toys tied together with strings. A string means "this one needs that one".
FalkorDB holds that web and can answer at once: "if I take this toy out, which toys fall?"

Some strings are dotted: nobody is sure they are real. Before an AI agent touches anything, Multiverse:

1. takes a **snapshot** of the whole web (FalkorDB `GRAPH.COPY`),
2. makes a **copy of the snapshot for each possible future**,
3. in each copy **rolls dice** for every dotted string (is it real? is it used during the window?),
4. does the agent's action **in the copy** and lets the failure ripple outward, one hop at a time,
5. reads back what fell, then **deletes the copy**.

After enough futures it knows how likely it is that something important breaks. If it's 5% or more,
the action is **blocked**, and the team that owns the dotted string is asked "is this real?".
Their answer goes into a second graph, the **memory**, so it is never guessed again.

## The console, page by page

Open `http://localhost:8765`. The home page shows the idea in one screen: a 3D stack of copies of the
company, where one copy at a time plays "Delete orders_archive" with the real link confidences. **Take the
2-minute tour** (home page, or **Menu**) walks through everything using the real engine. **Ctrl K** opens the command palette: search any asset (FalkorDB full-text index), run any
scenario, jump to any page, or ask the graph a question.

| Page | What you do there | What it proves |
|---|---|---|
| **Rehearse** | Pick a scenario (or add steps), press Rehearse. Squares appear live, one per future, each a tiny copy of the company with what broke in it. Click a square to open that future; press **Replay** to watch it run again in FalkorDB, command by command, with the failure spreading on the graph in step with the real query results. | Every number is counted from real futures. The real company is never touched (fingerprint). Any future replays identically. |
| **Launch day** | Drag the traffic slider. Every service shows its load as a share of capacity; dark means above 80%, orange means over capacity. The surge forecast, the maths and the scaling advice update live. | Load is computed on the graph: traffic at the front door times the calls along every path. 100 futures agree with the maths. |
| **Agents** | Run the two-agent demo, or connect Claude Desktop. Flight strips show every plan (cleared, holding, blocked), the schedule shows when each needs the company, and the heat map shows every possible start time checked for a held plan. Live tool calls stream in from any MCP client. | Two plans that are safe alone can be dangerous together; 168 start times are checked with 3 rehearsals. |
| **Company graph** | Click any asset or link: the exact lines of the evidence files it came from, and for log-based links every run of the job with its weight and the formula that gives the %. Overlays for teams, real vs synthetic, and FalkorDB algorithms. Path finder (`shortestPath`). Ask the graph in plain English. Cleanup finder. | Nothing is typed in by hand. |
| **Inbox** | Answer the questions Multiverse asked the owning teams. See what it learned, every recent rehearsal, and the history of any asset. | Answers are remembered and replace the dice in every later rehearsal. |
| **How it works** | The six steps with the real Cypher, the FalkorDB features used, and what is real vs invented. | |

## What is real and what is synthetic

| Part | Real or synthetic | Where |
|---|---|---|
| 12 services and Redis, who calls whom, replicas, CPU limits | **Real**: Google's Online Boutique deployment file, unmodified | `data/online-boutique/` |
| One-line descriptions of the 12 services | Paraphrased from the Online Boutique README | `data/backoffice/catalog.toml` |
| Back office: billing, tax, analytics jobs, databases, secrets | Synthetic, labelled | `data/backoffice/catalog.toml` |
| Owners (teams) | Synthetic | `data/backoffice/CODEOWNERS` |
| 13.5 months of data-access history | Synthetic, generated with no randomness | `data/backoffice/access_log.csv` |
| Load-test numbers (requests per CPU core, calls per request) | Synthetic | `catalog.toml` `[loadtest]` |
| Every confidence percentage, verdict, breaking point and safe slot | **Computed** live from the files above, never typed in | `world.py`, `multiverse.py` |

The back-office names say what they are: `orders_archive` (orders from past years), `legacy_orders_db`
(the old orders database that billing still reads), `old_csv_export` (a one-off export nobody remembers),
`revenue_report` and `refund_script` (jobs people run by hand).

## How sure is each link? (`world.py`)

| Rule | Example | Confidence |
|---|---|---|
| `k8s`: a running deployment is configured with the address | `frontend` has `CART_SERVICE_ADDR=cartservice:7070` (manifest line 532) | 100% |
| `verified`: declared in the catalog and signed off by the owner | `paymentservice` uses `payment_gateway_key` | 100% |
| `logs`: seen in the access log | `tax_filing_job` read the archive in 4 of its last 5 runs, but not the latest | 48% (recent runs weigh more; a run's weight halves every 90 days) |
| `declared`: declared, unverified, and the log can't see it | `refund_script` uses the payment key (from an old runbook) | 50% |

The 48% is checkable by hand. The five runs weigh 0.05, 0.11, 0.22, 0.44 and 0.88 (the most recent
counts most). The four that read the archive add up to 0.81 out of 1.70, and 0.81 ÷ 1.70 = 48%. Click
the link on the Company graph page to see exactly this.

It also finds things nobody typed in: `revenue_report -> orders_archive` exists only in the log
(an **undeclared dependency**). In Google's real file, `frontend` is configured to call
`shoppingassistantservice`, which is not deployed (**real configuration drift**, line 542).

## One rehearsal, step by step (`multiverse.py`, `rehearse.py`)

1. **Check the plan** against the world graph (`plans.validate`). Unknown asset? A clear error.
2. **Snapshot:** `GRAPH.COPY boutique_main boutique_main__<rid>__snapshot`. Apply the plan's changes inside it
   with the same Cypher that would later change the real company (`rehearse.apply_changes`).
3. **List what is uncertain**, and for each disruption its time window:
   - A scheduled job is used in the window only if a run overlaps it (calendar maths, `schedules.py`).
   - A hand-run job is used with chance `1 - exp(-window / how often it runs)`.
   - Team answers from memory make a link 100% or 0%.
4. **Each future:**
   1. Roll the dice (`multiverse.draw`). The same replay code always rolls the same values, in the same order.
   2. `GRAPH.COPY` the snapshot.
   3. Delete the links that are not real in this future:
      `MATCH ()-[r]->() WHERE r.key IN $keys DELETE r`
   4. Ripple one hop at a time, against the arrows, skipping links idle during the window:
      ```cypher
      UNWIND $frontier AS f
      MATCH (x:Asset)-[r:CALLS|READS|WRITES|USES_SECRET|DEPENDS_ON|FED_BY]->(y:Asset {name: f})
      WHERE NOT r.key IN $inactive
      RETURN x.name, type(r), r.soft, r.key, y.name
      ```
      Hard link: **broken**. Soft link: **degraded** (it stops there). Through `FED_BY`: **stale**.
   5. Write the statuses into the copy (`SET a.status, a.via`), read them back, delete the copy.
   6. Write the future to memory: `CREATE (r)-[:HAS_FUTURE]->(:Future {...})`. Future #1 also keeps the
      full list of commands it ran, with timings (the Commands tab).
5. **Statistics:** after every 25 futures, a 95% Wilson range. Stop when it is clearly above or below 5%, up to 400 futures.
6. **Verdict:** BLOCK if 5% or more of futures break something critical (criticality 3). REVIEW if anything else breaks. SAFE otherwise.
7. **Memory:** for every uncertain link on a breaking path, ask the owning team (`(:Question)-[:ASKS]->(:Team)`).

**Replay (`multiverse.replay`).** Any recorded future can be played again: the same plan, the same replay
code, the same team answers and the same moment in time, in a fresh copy, with every command traced.
Nothing is written to memory. `selftest.py` replays 12 futures and checks each matches the recording.

**Exact answers.** If no uncertain link and no hand-run job can reach the plan's effects, every future
would be identical, so Multiverse plays exactly one and says "Exact".

## Launch day (the launch simulator)

Load on every service = entry traffic multiplied by the `calls_per_request` along every path to it. That is
one Cypher query with `reduce()` over path relationships. Capacity divided by that load is each service's
**breaking point**, for example "cartservice breaks at 3.5x normal traffic". Each future draws a traffic surge
(log-normal: median = expected traffic, 90th percentile = the bad day). Overloaded services fail, and the
failure ripples like any other. The futures agree with the closed-form maths within sampling error
(`selftest.py`), and the scaling advice for the 1-in-100 surge is proved with a new rehearsal.

## Agent air traffic control (`coordination.py`)

Agents **propose** plans instead of acting. For each proposal, Multiverse:
1. rehearses it alone,
2. finds other agents' active plans that overlap in time and in the graph (one Cypher query on the memory graph),
3. rehearses the plans **together**, then clears, holds or blocks it.

Demo:
- The finance agent moves billing to the replica: safe alone.
- The platform agent takes the replica offline on the 1st, 01:00 to 04:00: safe alone.
- Together, billing runs at 02:00 against a database that is down, so billing and payouts break. The second plan is **held**.
- Multiverse checks 168 hourly start times with only 3 rehearsals and suggests 06:00. Start times that see the
  same running jobs and the same overlapping plans have identical futures, so each group is rehearsed once.
  The heat map on the Agents page shows all 168 results.

## Ask the graph (`ask.py`)

Type a question ("which jobs read orders_replica?"). An LLM (the same OpenAI-compatible settings as
`agent.py`) gets the graph's schema and writes one Cypher query. FalkorDB runs it with `GRAPH.RO_QUERY`, which
cannot write, with a 3-second limit; queries containing write keywords are refused before they run. The
console shows the answer, the Cypher, the rows, and lights up the assets on the graph. Without a model
configured, it says so instead of guessing.

## The graph data model

**World graph `boutique_main`** (rebuilt from evidence by `world.py`)

| Node | Key properties |
|---|---|
| `(:Asset:Service)` | name, criticality 1-3, source, found_in (file:line), note, replicas, cpu_m, rps_per_core, capacity |
| `(:Asset:Datastore)` | name, engine, criticality, capacity |
| `(:Asset:Job)` | name, schedule, duration_min, criticality |
| `(:Asset:Secret)` | name, criticality |
| `(:Team)` `(:Source)` `(:Finding)` `(:Meta)` | owners, evidence files, config drift, traffic settings |

Every asset also has a `search` text (name parts, kind, owner, description) with a full-text index on it.

| Link (dependent -> dependency) | Meaning |
|---|---|
| `CALLS` | service calls service (real ones come from Kubernetes `*_ADDR` env vars) |
| `READS` / `WRITES` | uses a datastore |
| `USES_SECRET` | needs a secret |
| `DEPENDS_ON` | needs a job's output |
| `FED_BY` | data stays fresh only while the feeder runs |
| `OWNED_BY`, `FOUND_IN` | team, evidence file (not dependencies) |

Every dependency link carries: `key`, `confidence`, `rule`, `evidence` (a list of sentences),
`every_days`, `calls_per_request`, `soft`, and (from logs) `runs_seen`, `runs_used`, `last_used`.

**Memory graph `boutique_memory`** (survives rebuilds; see `memory.py`)
`(:Rehearsal)-[:HAS_FUTURE]->(:Future)` and `(:Rehearsal)-[:ABOUT]->(:Asset)`, `(:Question)-[:ASKS]->(:Team)`,
`(:Fact)-[:ANSWERS]->(:Question)`, `(:AgentCall)-[:MADE_BY]->(:Agent)`, `(:Plan)-[:TOUCHES]->(:Asset)`,
`(:Plan)-[:CONFLICTS_WITH]->(:Plan)`.

## How FalkorDB is used

| FalkorDB feature | What it does here |
|---|---|
| `GRAPH.COPY` | a snapshot per rehearsal and a copy per future (hundreds per demo) |
| Variable-length paths `*0..8` | blast radius, who depends on what, load multipliers |
| Hop-by-hop Cypher in each copy | the failure ripple, with writes into the copy |
| `reduce()` over path relationships | traffic load on every service |
| Map parameters, `UNWIND` batches, indexes | fast imports and writes |
| Full-text index (`db.idx.fulltext.queryNodes`) | the search box (Ctrl K) |
| `shortestPath` | the path finder: why does A depend on B? |
| `algo.betweenness`, `algo.pageRank`, `algo.WCC` | chokepoints, foundations, islands (islands feed the cleanup finder) |
| `GRAPH.RO_QUERY` with a timeout | asking the graph in plain English, safely |
| Two graphs side by side | the company (rebuildable) and memory (permanent) |
| The memory graph as a shared bus | the console, the MCP server (Claude Desktop) and the CLI see each other live |

Python's job: roll dice, count, statistics, the web page and the MCP tools. Every fact about the company
and every "who depends on whom" answer comes from FalkorDB.

## The console's design

An editorial, exhibition-catalogue look: warm paper, black ink and one signal colour (orange, used only where
something breaks). Pages are hairline grids of cells, edge to edge, with wide display type (Archivo at
125% width) and a giant typographic mark behind the 3D hero. Outcomes are told apart by more than colour:
orange = critical, dark hatching = minor, white = nothing broke, plus an icon and a word everywhere.

Motion: a short intro on the first visit, a page wipe between pages, headings that unmask word by word,
cells that rise in order, circle buttons that follow the pointer, a scenario carousel drawn as a CSS 3D stack
of company copies, and the WebGL hero (`ui/hero3d.js`, three.js) that plays one future at a time. Without
WebGL the hero falls back to the CSS 3D stack; with `prefers-reduced-motion` everything is still.

Kept from Vercel's web interface guidelines and the Raycast/Linear UI skills: visible keyboard focus,
`aria-live` for live updates, no `transition: all`, the URL reflects the page, a confirmation dialog before
anything destructive, tabular numbers, text contrast of at least 4.5:1. The graph and all charts are drawn
by hand in SVG. Fonts: Archivo and JetBrains Mono (both OFL). Icons: Lucide (ISC). 3D: three.js (MIT).

## Files

| File | What it does |
|---|---|
| `world.py` | builds the company graph from evidence, computes confidence, full-text index |
| `plans.py` | the nine actions, checking, time windows |
| `rehearse.py` | one future in one copy (with an optional command trace); copying with retries; fingerprint; changes |
| `multiverse.py` | many futures: dice, live persistence, statistics, launch maths, replay, guarded execute |
| `memory.py` | the memory graph |
| `coordination.py` | agents propose plans: clashes, holds, safe time slots |
| `insights.py` | FalkorDB algorithms and the cleanup finder |
| `evidence.py` | the exact file lines behind any asset or link, and the access-log runs behind a % |
| `ask.py` | plain-English questions to read-only Cypher |
| `scenarios.py` | ready-made plans (inputs only, never results) |
| `app.py` + `ui/` | the live console (`ui/graph.js` draws the graph, `ui/app.js` is the logic, `ui/motion.js` the motion, `ui/hero3d.js` the 3D hero) |
| `mcp_server.py` | 13 MCP tools for any AI agent |
| `agent.py` | an LLM agent for OmniRoute and other OpenAI-compatible models |
| `connect_claude.py` | connects Claude Desktop |
| `selftest.py` | 17 checks that prove the claims above |
| `test_mcp.py`, `test_agent.py`, `check_setup.py` | tool test, agent loop test, setup doctor |

## Honest limits (say them before a judge does)

- The back office, the owners, the access log and the load-test numbers are synthetic. They are labelled everywhere, and only the
  Online Boutique part is real.
- The ripple knows hard, soft and stale dependencies. It does not model retries, timeouts or "either A or B is enough" redundancy.
- FalkorDB makes one copy at a time (it forks to copy), so futures run one after another: about 0.1 s each, most of it the copy.
  Concurrent copies from two programs wait and retry.
- The closed-form cross-check exists only for launch-only plans. Elsewhere, `selftest.py` checks the futures against the evidence.
- Asking in plain English needs a model you configure; the answer is only as good as the Cypher it writes (the Cypher is always shown).
