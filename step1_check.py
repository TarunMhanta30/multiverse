"""
Multiverse - Step 1 check.
Proves the two things the whole project depends on:
  1. FalkorDB can find everything that depends on a database (multi-hop).
  2. GRAPH.COPY gives a fork we can change without touching the original.
Run:  python step1_check.py
"""
from falkordb import FalkorDB

db = FalkorDB(host="localhost", port=6380)  # 6380 so it won't clash with your other Docker projects
world = db.select_graph("world_check")

# Start clean (ignore the error if the graph doesn't exist yet)
for name in ("world_check", "world_check_fork"):
    try:
        db.select_graph(name).delete()
    except Exception:
        pass

# A tiny "company": a billing job reads orders_v1, payouts depend on billing
world.query("""
CREATE (orders_db:Database {name: 'orders_v1'}),
       (billing:Job {name: 'month_end_billing'}),
       (payouts:Service {name: 'payouts'}),
       (billing)-[:READS]->(orders_db),
       (payouts)-[:DEPENDS_ON]->(billing)
""")

# Check 1: who breaks if orders_v1 disappears? (any depth up to 5 hops)
deps = world.ro_query("""
MATCH (x)-[*1..5]->(:Database {name: 'orders_v1'})
RETURN DISTINCT x.name
""").result_set
print("Depends on orders_v1:", sorted(r[0] for r in deps))
# expected: ['month_end_billing', 'payouts']

# Check 2: fork the world, delete the database ONLY in the fork
fork = world.copy("world_check_fork")
fork.query("MATCH (d:Database {name: 'orders_v1'}) DETACH DELETE d")

count = "MATCH (d:Database) RETURN count(d)"
print("Databases in fork:    ", fork.ro_query(count).result_set[0][0])   # expected: 0
print("Databases in original:", world.ro_query(count).result_set[0][0])  # expected: 1

# Clean up
fork.delete()
world.delete()
print("Step 1 check finished.")
