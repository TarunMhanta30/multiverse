"""
Multiverse - calendar maths for scheduled jobs.

A schedule is a short string:
  "daily@05:00"          every day at 05:00
  "weekly:mon@04:30"     every Monday at 04:30
  "monthly:day=1@02:00"  on the 1st of every month at 02:00
  "quarterly@03:00"      on Jan 1, Apr 1, Jul 1 and Oct 1 at 03:00
  ""                     no fixed calendar: people run it by hand

All times are the computer's local time.
"""
from datetime import date, datetime, time, timedelta

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def parse(schedule):
    """'monthly:day=1@02:00' -> ('monthly', {'day': 1}, time(2, 0)). Raises ValueError if malformed."""
    if not schedule:
        return None
    try:
        rule, at = schedule.split("@")
        hh, mm = (int(x) for x in at.split(":"))
        when = time(hh, mm)
    except ValueError:
        raise ValueError(f"Bad schedule {schedule!r}: expected something like 'daily@05:00'") from None
    if rule == "daily" or rule == "quarterly":
        return rule, {}, when
    if rule.startswith("weekly:"):
        day = rule.split(":", 1)[1]
        if day not in WEEKDAYS:
            raise ValueError(f"Bad weekday in {schedule!r}: use one of {', '.join(WEEKDAYS)}")
        return "weekly", {"weekday": WEEKDAYS.index(day)}, when
    if rule.startswith("monthly:day="):
        day = int(rule.split("=", 1)[1])
        if not 1 <= day <= 28:
            raise ValueError(f"Bad day in {schedule!r}: use 1..28 so every month has it")
        return "monthly", {"day": day}, when
    raise ValueError(f"Bad schedule {schedule!r}: use daily@, weekly:mon@, monthly:day=1@ or quarterly@")


def _fires_on(kind, params, d):
    if kind == "daily":
        return True
    if kind == "weekly":
        return d.weekday() == params["weekday"]
    if kind == "monthly":
        return d.day == params["day"]
    return d.day == 1 and d.month in (1, 4, 7, 10)          # quarterly


def runs_overlapping(schedule, duration_min, start, end):
    """Start times of every run whose [start, start + duration) overlaps the window [start, end)."""
    parsed = parse(schedule)
    if parsed is None:
        return []
    kind, params, when = parsed
    duration = timedelta(minutes=duration_min or 0)
    runs = []
    d = (start - duration).date()
    while d <= end.date():
        if _fires_on(kind, params, d):
            run = datetime.combine(d, when)
            if run < end and run + max(duration, timedelta(minutes=1)) > start:
                runs.append(run)
        d += timedelta(days=1)
    return runs


def next_run(schedule, after, within_days=400):
    """The first run starting at or after `after` (None for hand-run jobs)."""
    runs = runs_overlapping(schedule, 0, after, after + timedelta(days=within_days))
    return runs[0] if runs else None


def describe(schedule):
    parsed = parse(schedule)
    if parsed is None:
        return "run by hand"
    kind, params, when = parsed
    at = when.strftime("%H:%M")
    if kind == "daily":
        return f"every day at {at}"
    if kind == "weekly":
        return f"every {WEEKDAYS[params['weekday']].capitalize()} at {at}"
    if kind == "monthly":
        return f"on day {params['day']} of every month at {at}"
    return f"on the first day of each quarter at {at}"


def next_first_of_month(after, avoid_quarter_starts=True):
    """The next 1st of a month after `after` (skipping Jan/Apr/Jul/Oct if asked). Used by presets."""
    d = date(after.year, after.month, 1)
    while True:
        d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
        if not (avoid_quarter_starts and d.month in (1, 4, 7, 10)):
            return d
