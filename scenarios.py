"""
Multiverse - ready-made scenarios for the console and the demo.

These are INPUTS only (plans, with dates worked out from today). No result is stored here:
every verdict and every number you see for them is computed live when you rehearse.
"""
from datetime import datetime, timedelta

from config import WORLD
from schedules import next_first_of_month


def next_weekday(now, weekday, hour):
    """The next given weekday (0 = Monday) at `hour`:00, strictly after today."""
    days = (weekday - now.weekday()) % 7 or 7
    return (now + timedelta(days=days)).replace(hour=hour, minute=0, second=0, microsecond=0)


def iso(dt):
    return dt.isoformat(timespec="minutes")


def presets(now=None, world=WORLD):
    from multiverse import launch_advice                 # imported here: multiverse imports us for its CLI
    now = now or datetime.now()
    first = next_first_of_month(now)                     # a 1st that is not a quarter start
    maintenance = datetime(first.year, first.month, first.day, 1, 0)
    sale = next_weekday(now, 5, 18)                      # next Saturday 18:00
    advice = launch_advice(3, 6, world)["advice"]
    scale_steps = [{"action": "scale", "asset": a["asset"], "factor": a["factor"]} for a in advice]
    return [
        {"id": "cleanup-archive", "agent": "cleanup-agent", "group": "Delete",
         "title": "Delete orders_archive",
         "story": "A cleanup agent thinks the archive is unused. The access log is not so sure.",
         "plan": {"title": "Delete orders_archive",
                  "steps": [{"action": "delete", "asset": "orders_archive"}]}},
        {"id": "delete-legacy-db", "agent": "cleanup-agent", "group": "Delete",
         "title": "Delete legacy_orders_db",
         "story": "It looks like a legacy table nobody needs.",
         "plan": {"title": "Delete legacy_orders_db", "steps": [{"action": "delete", "asset": "legacy_orders_db"}]}},
        {"id": "delete-export", "agent": "cleanup-agent", "group": "Delete",
         "title": "Delete old_csv_export",
         "story": "A one-off export nobody remembers.",
         "plan": {"title": "Delete old_csv_export",
                  "steps": [{"action": "delete", "asset": "old_csv_export"}]}},
        {"id": "migrate-billing", "agent": "finance-agent", "group": "Change",
         "title": "Move billing to the replica, then delete legacy_orders_db",
         "story": "Fix the dependency first, then remove the legacy table.",
         "plan": {"title": "Move billing to orders_replica, then delete legacy_orders_db",
                  "steps": [{"action": "repoint", "asset": "month_end_billing",
                             "old": "legacy_orders_db", "new": "orders_replica"},
                            {"action": "delete", "asset": "legacy_orders_db"}]}},
        {"id": "rotate-key", "agent": "security-agent", "group": "Change",
         "title": "Rotate payment_gateway_key",
         "story": "Known consumers get the new key automatically. The ones we only suspect may not.",
         "plan": {"title": "Rotate payment_gateway_key",
                  "steps": [{"action": "rotate_secret", "asset": "payment_gateway_key"}]}},
        {"id": "replica-maintenance", "agent": "platform-agent", "group": "Maintenance",
         "title": f"Replica offline {maintenance:%a %d %b} 01:00-04:00",
         "story": "Platform wants 3 hours to upgrade the read replica, overnight on the 1st.",
         "plan": {"title": f"Take orders_replica offline {maintenance:%a %d %b} 01:00-04:00",
                  "steps": [{"action": "offline", "asset": "orders_replica",
                             "start": iso(maintenance), "hours": 3}]}},
        {"id": "festival-sale", "agent": "growth-agent", "group": "Launch",
         "title": "Festival sale: 3x traffic, maybe 6x",
         "story": f"A 6-hour sale from {sale:%a %d %b} 18:00. Expected 3x normal traffic; "
                  "1 chance in 10 of more than 6x.",
         "plan": {"title": "Festival sale: 3x traffic (1 in 10: over 6x) for 6 h",
                  "steps": [{"action": "launch", "surge": 3, "surge_p90": 6, "hours": 6,
                             "start": iso(sale)}]}},
        {"id": "festival-sale-scaled", "agent": "growth-agent", "group": "Launch",
         "title": "Festival sale with the recommended scaling",
         "story": "The same sale, after scaling what the graph says breaks first "
                  "(advice computed live from capacity and traffic paths).",
         "plan": {"title": "Festival sale + recommended scaling",
                  "steps": scale_steps + [{"action": "launch", "surge": 3, "surge_p90": 6,
                                           "hours": 6, "start": iso(sale)}]}},
        {"id": "gift-cards", "agent": "growth-agent", "group": "Launch",
         "title": "Launch gift cards (a new service)",
         "story": "A new giftcardservice that calls payments and the cart, with a 2x launch-day spike.",
         "plan": {"title": "Launch giftcardservice at 2x traffic",
                  "steps": [{"action": "add_service", "asset": "giftcardservice", "owner": "Checkout",
                             "criticality": 2, "calls": {"paymentservice": 1.0, "cartservice": 0.5},
                             "entry_share": 0.05, "rps_per_core": 300, "cpu_m": 200},
                            {"action": "launch", "surge": 2, "surge_p90": 3, "hours": 6,
                             "start": iso(sale)}]}},
    ]


def two_agents(now=None):
    """The coordination demo: two plans that are each safe alone and dangerous together."""
    now = now or datetime.now()
    first = next_first_of_month(now)
    maintenance = datetime(first.year, first.month, first.day, 1, 0)
    return [
        {"agent": "finance-agent",
         "plan": {"title": "Move month_end_billing to read orders_replica",
                  "steps": [{"action": "repoint", "asset": "month_end_billing",
                             "old": "legacy_orders_db", "new": "orders_replica"}]}},
        {"agent": "platform-agent",
         "plan": {"title": f"Take orders_replica offline {maintenance:%a %d %b} 01:00-04:00",
                  "steps": [{"action": "offline", "asset": "orders_replica",
                             "start": iso(maintenance), "hours": 3}]}},
    ]
