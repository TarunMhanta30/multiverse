"""
Multiverse - shared settings. Every other file imports from here, so there is one place to change.

FalkorDB runs in Docker on port 6380 (the -p 6380:6379 in the docker run command).
To use another address, set FALKORDB_HOST / FALKORDB_PORT before running anything.
"""
import os
from pathlib import Path

from falkordb import FalkorDB

HOST = os.environ.get("FALKORDB_HOST", "localhost")
PORT = int(os.environ.get("FALKORDB_PORT", "6380"))

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"

WORLD = os.environ.get("MULTIVERSE_WORLD", "boutique_main")      # the company, rebuilt by world.py
MEMORY = os.environ.get("MULTIVERSE_MEMORY", "boutique_memory")  # what happened (survives rebuilds)
# (selftest.py sets these two to its own graph names, so it never touches your demo)

# Link types that mean "the source needs the target". OWNED_BY and FOUND_IN are not dependencies.
DEP_RELS = ("CALLS", "READS", "WRITES", "USES_SECRET", "DEPENDS_ON", "FED_BY")
DEP_PATTERN = "|".join(DEP_RELS)            # for Cypher: [r:CALLS|READS|...]

HORIZON_DAYS = 90              # a delete is judged on the next 90 days
SAFETY_LINE = 0.05             # BLOCK when 5% or more of futures break something critical
BATCH = 25                     # futures are added 25 at a time ...
MAX_FUTURES = 400              # ... up to this many, until the answer is statistically clear
MAX_DEPTH = 8                  # how many hops a failure can ripple

db = FalkorDB(host=HOST, port=PORT)
