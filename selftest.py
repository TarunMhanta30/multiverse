"""
Multiverse - self-test: proves each claim with a real run and prints PASS or FAIL with the numbers.

It uses its OWN graphs (selftest_world, selftest_memory) and deletes them at the end, so your demo
company and memory are never touched. Takes about two minutes.

Run:  python selftest.py
"""
import os

os.environ["MULTIVERSE_WORLD"] = "selftest_world"      # must be set before the project is imported
os.environ["MULTIVERSE_MEMORY"] = "selftest_memory"

import math       # noqa: E402
import time       # noqa: E402
from datetime import datetime, timedelta  # noqa: E402

import coordination  # noqa: E402
import evidence      # noqa: E402
import insights      # noqa: E402
import memory        # noqa: E402
import world         # noqa: E402
from config import HORIZON_DAYS, MEMORY, WORLD, db  # noqa: E402
from multiverse import execute, rehearse, replay, start  # noqa: E402
from plans import combine  # noqa: E402
from rehearse import drop  # noqa: E402
from scenarios import presets, two_agents  # noqa: E402
from schedules import next_run  # noqa: E402

results = []


def check(name, ok, detail):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      {detail}")


def link(key):
    rows = db.select_graph(WORLD).ro_query("MATCH ()-[r]->() WHERE r.key = $k RETURN r.confidence",
                                           {"k": key}).result_set
    return rows[0][0] if rows else None


def clean(s):
    return s["fingerprint"]["unchanged"] and not s["forks_left"]


t0 = time.time()
print(f"Self-test on graphs '{WORLD}' and '{MEMORY}' (your demo is not touched)\n")
drop(WORLD), drop(MEMORY)
report = world.build()
P = {p["id"]: p["plan"] for p in presets()}
everything_clean = True

# 1. The company comes from evidence --------------------------------------------------------------
tax, report_link, refund = (link("tax_filing_job|READS|orders_archive"),
                      link("revenue_report|READS|orders_archive"),
                      link("refund_script|USES_SECRET|payment_gateway_key"))
check("World built from evidence files, confidence computed (not typed in)",
      report["deployments"] == 12 and report["drift"] and report["discovered"] and 0 < tax < 1 and 0 < report_link < 1
      and refund == 0.5,
      f"12 real Kubernetes deployments, {report['links']} links. tax->archive {tax:.0%} and report->archive "
      f"{report_link:.0%} from the access log, refund->key 50% (declared only). Undeclared link found: "
      f"{report['discovered'][0]}. Drift: {report['drift'][0][:70]}...")

# 2. Futures stream live into memory --------------------------------------------------------------
rid = start(P["cleanup-archive"], mode="precise", futures=40, seed=11)
samples = []
while True:
    time.sleep(0.4)
    r = memory.get_rehearsal(rid)
    samples.append(len(memory.futures_since(rid, 0)))
    if r["status"] != "running":
        break
check("Each future is written to memory the moment it finishes (that is what the console streams)",
      len(set(samples)) >= 4 and samples[-1] == 40,
      f"futures stored, sampled every 0.4 s while running: {samples}")

# 3. Fresh dice, replayable dice --------------------------------------------------------------------
a = rehearse(P["cleanup-archive"], seed=777)
b = rehearse(P["cleanup-archive"], seed=777)
c = rehearse(P["cleanup-archive"])
everything_clean &= clean(a) and clean(b) and clean(c)
check("Same dice replay the same futures; no dice given = new dice",
      a["outcomes"] == b["outcomes"] and c["seed"] != 777,
      f"dice #777 twice: identical {len(a['outcomes'])} outcomes. New dice #{c['seed']}: "
      f"{c['p_crit']:.0%} critical vs {a['p_crit']:.0%}.")

# 4. Futures converge on the evidence ------------------------------------------------------------
now = datetime.now()
runs_soon = next_run("quarterly@03:00", now) <= now + timedelta(days=HORIZON_DAYS)
theory = tax * (1 if runs_soon else 0)
big = rehearse(P["cleanup-archive"], mode="precise", futures=300, seed=5)
everything_clean &= clean(big)
se = math.sqrt(max(theory * (1 - theory), 1e-9) / 300)
check("300 futures land on what the evidence says (within 3 standard errors)",
      abs(big["p_crit"] - theory) <= 3 * se + 0.005,
      f"tax_filing_job breaks in {big['p_crit']:.1%} of 300 futures; evidence says {theory:.1%} "
      f"(confidence {tax:.0%} x its next run {'is' if runs_soon else 'is not'} within {HORIZON_DAYS} days)")

# 5. Exact when nothing is uncertain ------------------------------------------------------------
e = rehearse(P["delete-export"])
everything_clean &= clean(e)
check("One future is the exact answer when nothing uncertain touches the plan",
      e["exact"] and e["futures"] == 1 and e["verdict"] == "SAFE", f"{e['title']}: {e['stop_reason']}")

# 6. Any future can be played again, exactly, with every FalkorDB command traced -------------------
again = [replay(a["rid"], i) for i in range(1, min(12, a["futures"]) + 1)]
stored = memory.get_future(a["rid"], 1)["trace"] or []
steps = [t["step"] for t in again[0]["trace"]]
check("Replay any future in a fresh copy: same result, every command traced, nothing left behind",
      all(r["identical"] for r in again) and steps[0] == "snapshot" and "fork" in steps and "ripple" in steps
      and steps[-1] == "drop" and [t["step"] for t in stored][:1] == ["fork"]
      and not [g for g in db.list_graphs() if "__replay" in g],
      f"{sum(r['identical'] for r in again)} of {len(again)} replayed futures identical to the recording; "
      f"trace: {' > '.join(steps)}")

# 7. Search and evidence come straight from FalkorDB and the files --------------------------------
hits = [r[0] for r in db.select_graph(WORLD).ro_query(
    "CALL db.idx.fulltext.queryNodes('Asset', 'cart*') YIELD node RETURN node.name").result_set]
ev = evidence.link_sources("tax_filing_job|READS|orders_archive")
items = ev["runs"]["items"]
share = sum(r["weight"] for r in items if r["used"]) / sum(r["weight"] for r in items)
check("Full-text search finds assets; the evidence view recomputes the confidence from the log",
      "cartservice" in hits and "redis-cart" in hits and abs(round(share, 2) - tax) < 0.011
      and any("kubernetes-manifests.yaml" == f["file"] for f in evidence.asset_sources("frontend")),
      f"search 'cart*': {', '.join(hits)}. Access log: {sum(r['used'] for r in items)} of {len(items)} runs used "
      f"the archive, weighted share {share:.1%} = stored confidence {tax:.0%}")

# 8. A change in the graph changes the answer -----------------------------------------------------
db.select_graph(WORLD).query("""MATCH (a:Asset {name: 'payouts'}), (b:Asset {name: 'orders_archive'})
                                CREATE (a)-[:READS {key: 'payouts|READS|orders_archive', confidence: 1.0,
                                rule: 'test', evidence: ['added by selftest'], every_days: 0.0, soft: false}]->(b)""")
d = rehearse(P["cleanup-archive"], seed=777)
everything_clean &= clean(d)
payouts = next((x for x in d["affected"] if x["name"] == "payouts"), None)
check("Add one link to the graph and the result changes (nothing is precomputed)",
      payouts and payouts["probability"] == 1.0 and d["p_crit"] == 1.0,
      f"after adding payouts -READS-> orders_archive: payouts breaks in "
      f"{payouts['probability'] if payouts else 0:.0%} of futures, critical {d['p_crit']:.0%} (was {a['p_crit']:.0%})")
world.build()

# 9. Plans ----------------------------------------------------------------------------------------
v1, mig = rehearse(P["delete-legacy-db"]), rehearse(P["migrate-billing"])
everything_clean &= clean(v1) and clean(mig)
check("Fix the dependency first and the same delete becomes safe",
      v1["verdict"] == "BLOCK" and mig["verdict"] == "SAFE",
      f"delete legacy_orders_db: {v1['verdict']} ({', '.join(x['name'] for x in v1['affected'])}). "
      f"Repoint billing to the replica, then delete: {mig['verdict']}.")

# 10. Time windows ---------------------------------------------------------------------------------
A, B = two_agents()
alone_a, alone_b, together = rehearse(A["plan"]), rehearse(B["plan"]), rehearse(combine(A["plan"], B["plan"]))
check("Two plans that are each safe alone can be dangerous together",
      alone_a["verdict"] == "SAFE" and alone_b["verdict"] == "SAFE" and together["verdict"] == "BLOCK",
      f"billing to replica: {alone_a['verdict']}. Replica offline 01:00-04:00: {alone_b['verdict']}. "
      f"Both: {together['verdict']} ({', '.join(x['name'] for x in together['affected'])}).")

# 11. Coordination ---------------------------------------------------------------------------------
ra = coordination.propose(A["plan"], A["agent"])
rb = coordination.propose(B["plan"], B["agent"])
sug = rb.get("suggestion") or {}
check("Coordination: approve, hold on a clash, and find a safe slot",
      ra["status"] == "approved" and rb["status"] == "held" and sug.get("best_verdict") == "SAFE",
      f"{A['agent']}: {ra['status']}. {B['agent']}: {rb['status']}. Earliest safe slot "
      f"{sug.get('best_start')} ({sug.get('candidates')} start times, {sug.get('rehearsed')} rehearsals).")

# 12. Launch: futures agree with the maths --------------------------------------------------------
sale = rehearse(P["festival-sale"], mode="precise", futures=200, seed=3)
L = sale["launch"]
se = math.sqrt(L["theory_p_crit"] * (1 - L["theory_p_crit"]) / 200)
check("Launch rehearsal agrees with the closed-form maths",
      abs(L["simulated_p_crit"] - L["theory_p_crit"]) <= 3 * se + 0.005,
      f"festival sale: futures {L['simulated_p_crit']:.1%} vs maths {L['theory_p_crit']:.1%}; "
      f"first critical break at {L['first_critical_break']}x traffic")
scaled = rehearse(P["festival-sale-scaled"], seed=3)
check("Following the scaling advice brings the launch under the safety line",
      scaled["p_crit"] < 0.05, f"with advice: {scaled['verdict']}, critical {scaled['p_crit']:.1%}")

# 13. Rotation asks the right team ----------------------------------------------------------------
rot = rehearse(P["rotate-key"])
check("Secret rotation: known consumers are fine, the suspected one is flagged and its team asked",
      rot["verdict"] == "REVIEW" and rot["unverified"] and rot["unverified"][0]["ask"] == "Finance",
      f"{rot['verdict']}: {', '.join(x['name'] for x in rot['affected'])} may break; asked "
      f"{rot['unverified'][0]['ask'] if rot['unverified'] else '-'}")

# 14. Memory: answers change the outcome, permissions hold, execution is guarded ------------------
plan = P["cleanup-archive"]
first = execute(plan, by="selftest")
try:
    memory.confirm_link("tax_filing_job", "READS", "orders_archive", False, by="Data")
    wrong_team = "accepted (bad)"
except PermissionError:
    wrong_team = "refused"
memory.confirm_link("tax_filing_job", "READS", "orders_archive", False, by="Finance")
memory.confirm_link("revenue_report", "READS", "orders_archive", False, by="Data")
second = execute(plan, by="selftest")
gone = not db.select_graph(WORLD).ro_query("MATCH (a:Asset {name: 'orders_archive'}) RETURN a").result_set
check("Answers are remembered, only the owner may answer, and only SAFE executes",
      not first["executed"] and wrong_team == "refused" and second["executed"] and gone,
      f"before answers: executed={first['executed']}. Data answering for Finance: {wrong_team}. "
      f"After both answers: executed={second['executed']} ({second['rehearsal']['stop_reason'][:40]}...)")

# 15. Graph algorithms ----------------------------------------------------------------------------
summary = insights.summary()
top = summary["chokepoints"][0]["name"] if summary["chokepoints"] else None
islands = summary["islands"]
check("FalkorDB algorithms: betweenness, PageRank and WCC run on the company graph",
      top and summary["foundations"] and any(["old_csv_export"] == g for g in islands),
      f"top chokepoint {top}; top foundation {summary['foundations'][0]['name'] if summary['foundations'] else '-'}; "
      f"islands {islands}")

check("Every rehearsal left the real company unchanged and deleted all its copies",
      everything_clean, "fingerprint before == after for each one, 0 copies left behind")

drop(WORLD), drop(MEMORY)
print(f"\n{sum(results)} of {len(results)} checks passed in {time.time() - t0:.0f} s.")
