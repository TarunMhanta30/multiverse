# Boutique Inc. back office: synthetic

Everything in this folder was **invented for the Multiverse demo**. Online Boutique (the real
part, in `../online-boutique/`) has no back office, so these files give agent actions real
consequences to rehearse.

| File | What it is | How `world.py` uses it |
|---|---|---|
| `catalog.toml` | service tiers, back-office assets, declared dependencies, load-test numbers | node properties; declared links; capacity |
| `CODEOWNERS` | which team owns each asset | `OWNED_BY` links; who gets asked about a link |
| `access_log.csv` | 13.5 months of who read or wrote which datastore, run by run | confidence of job dependencies; links nobody declared |
| `make_access_log.py` | the script that wrote `access_log.csv`, with no randomness | read it to see the story the log tells |

Confidence rules (strongest evidence wins):

1. A running Kubernetes deployment configured with the address: **certain**.
2. Declared in `catalog.toml` and verified by the owning team: **certain**.
3. Seen in the access log: certain if the last 3 runs all used it; otherwise the share of runs
   that used it, where recent runs count more (a run's weight halves every 90 days).
4. Declared, not verified, and the log cannot see it: **50%**.
5. A team's answer in Multiverse memory overrides all of the above.
