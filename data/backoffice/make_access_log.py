"""
Writes access_log.csv: 13.5 months of SYNTHETIC data-access history for Boutique Inc.

Nothing here is random: every run is listed on purpose, so you can read exactly what
"happened" and check the confidence numbers world.py computes from it.

The story the log tells:
  month_end_billing        runs on the 1st at 02:00, always reads legacy_orders_db
  tax_filing_job           quarterly at 03:00, reads orders_replica; it ALSO read
                           orders_archive every quarter until July 2026, but not in October
  nightly_analytics_export daily at 05:00, reads orders_replica, writes analytics_warehouse
  revenue_report           run by hand 7 times; read orders_archive in 3 of them
                           (nobody declared that dependency - the log is the only witness)
  refund_script            run by hand 3 times, reads orders_db
  people (user:...)        ad-hoc queries; not assets, so world.py ignores them

Run:  python data/backoffice/make_access_log.py
"""
import csv
from datetime import date, datetime, timedelta
from pathlib import Path

OUT = Path(__file__).with_name("access_log.csv")
START, END = date(2025, 9, 1), date(2026, 10, 16)

rows = []          # (time, run_id, principal, action, resource)


def run(principal, when, accesses):
    rid = f"{principal}#{when:%Y%m%d%H%M}"
    for minutes, action, resource in accesses:
        rows.append((when + timedelta(minutes=minutes), rid, principal, action, resource))


def days():
    d = START
    while d <= END:
        yield d
        d += timedelta(days=1)


for d in days():
    at = datetime(d.year, d.month, d.day)
    if d.day == 1:                                                   # month_end_billing
        run("month_end_billing", at.replace(hour=2), [(1, "read", "legacy_orders_db"),
                                                      (31, "read", "legacy_orders_db")])
    if d.day == 1 and d.month in (1, 4, 7, 10):                     # tax_filing_job
        accesses = [(2, "read", "orders_replica")]
        if d < date(2026, 10, 1):
            accesses.append((14, "read", "orders_archive"))
        run("tax_filing_job", at.replace(hour=3), accesses)
    run("nightly_analytics_export", at.replace(hour=5),             # nightly_analytics_export
        [(1, "read", "orders_replica"), (19, "write", "analytics_warehouse")])

ADHOC = [  # (when, also read the archive?)
    (datetime(2025, 9, 18, 10, 12), False), (datetime(2025, 11, 20, 15, 40), True),
    (datetime(2026, 1, 14, 11, 5), False), (datetime(2026, 3, 9, 16, 22), True),
    (datetime(2026, 5, 21, 9, 47), False), (datetime(2026, 7, 8, 14, 30), True),
    (datetime(2026, 9, 2, 10, 55), False),
]
for when, archive in ADHOC:
    accesses = [(3, "read", "analytics_warehouse")]
    if archive:
        accesses.append((9, "read", "orders_archive"))
    run("revenue_report", when, accesses)

for when in (datetime(2025, 12, 3, 18, 20), datetime(2026, 3, 17, 17, 5),
             datetime(2026, 6, 29, 19, 40)):
    run("refund_script", when, [(2, "read", "orders_db")])

for when, who, resource in [                                       # people, not assets
    (datetime(2025, 10, 7, 11, 30), "user:priya", "analytics_warehouse"),
    (datetime(2026, 2, 12, 15, 2), "user:arjun", "orders_replica"),
    (datetime(2026, 8, 19, 12, 44), "user:priya", "analytics_warehouse"),
]:
    run(who, when, [(0, "read", resource)])

rows.sort()
with OUT.open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["time", "run_id", "principal", "action", "resource"])
    for t, rid, principal, action, resource in rows:
        w.writerow([t.isoformat(timespec="minutes"), rid, principal, action, resource])
print(f"Wrote {len(rows)} rows to {OUT}")
