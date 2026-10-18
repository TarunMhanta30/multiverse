"""
Multiverse - show the evidence behind any asset or link, as the actual lines of the files.

The company graph is built from files (world.py). This module goes back to those files and returns
the exact lines a node or a link came from, so anyone can check that nothing was typed in by hand:

  asset_sources("frontend")                      the Deployment in Google's Kubernetes file,
                                                 the catalog section, the CODEOWNERS line
  link_sources("tax_filing_job|READS|orders_archive")
                                                 the catalog [[links]] block, plus every run of the
                                                 job in the access log, each marked used / not used,
                                                 with the weight the confidence formula gave it
"""
import re
from datetime import date

from config import WORLD, db
from world import (ACCESS_LOG, CATALOG, CERTAIN_STREAK, HALF_LIFE_DAYS, MANIFEST, OWNERS,
                   read_access_log)

MANIFEST_REF = re.compile(r"kubernetes-manifests\.yaml:(\d+)")


def _lines(path):
    return path.read_text(encoding="utf-8").splitlines()


def _excerpt(path, focus, before=2, after=2, label=""):
    """Lines around line number `focus` (1-based) of `path`."""
    lines = _lines(path)
    start = max(1, focus - before)
    end = min(len(lines), focus + after)
    return {"file": path.name, "start": start, "focus": [focus], "label": label,
            "lines": lines[start - 1:end]}


def _block(path, first, last, focus, label=""):
    lines = _lines(path)
    return {"file": path.name, "start": first, "focus": focus, "label": label,
            "lines": lines[first - 1:last]}


def _catalog_section(name):
    """The [services.NAME] or [assets.NAME] table of catalog.toml."""
    lines = _lines(CATALOG)
    for i, line in enumerate(lines):
        if line.strip() in (f"[services.{name}]", f"[assets.{name}]"):
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("["):
                j += 1
            return _block(CATALOG, i + 1, j, [i + 1], "catalog.toml (synthetic)")
    return None


def _catalog_link(a, b):
    """The [[links]] block of catalog.toml that declares a -> b."""
    lines = _lines(CATALOG)
    for i, line in enumerate(lines):
        if line.strip() != "[[links]]":
            continue
        j = i + 1
        while j < len(lines) and lines[j].strip() and not lines[j].startswith("["):
            j += 1
        body = lines[i:j]
        if f'from = "{a}"' in body and f'to = "{b}"' in body:
            return _block(CATALOG, i + 1, j, [i + 1], "catalog.toml (synthetic)")
    return None


def _owner_line(name):
    for i, line in enumerate(_lines(OWNERS)):
        if line.split("#", 1)[0].split()[:1] == [name]:
            return _excerpt(OWNERS, i + 1, 0, 0, "CODEOWNERS (synthetic)")
    return None


def _evidence_date():
    meta = db.select_graph(WORLD).ro_query("MATCH (m:Meta) RETURN m.evidence_date").result_set
    try:
        return date.fromisoformat(meta[0][0])
    except (IndexError, TypeError, ValueError):
        return date.today()


def asset_sources(name):
    g = db.select_graph(WORLD)
    rows = g.ro_query("MATCH (a:Asset {name: $n}) RETURN a.found_in", {"n": name}).result_set
    if not rows:
        raise ValueError(f"No asset called {name!r}")
    out = []
    m = MANIFEST_REF.search(rows[0][0] or "")
    if m:
        out.append(_excerpt(MANIFEST, int(m.group(1)), 3, 6, "kubernetes-manifests.yaml (real, Google)"))
    for part in (_catalog_section(name), _owner_line(name)):
        if part:
            out.append(part)
    return out


def link_sources(key):
    g = db.select_graph(WORLD)
    rows = g.ro_query("MATCH (a:Asset)-[r]->(b:Asset) WHERE r.key = $k "
                      "RETURN a.name, type(r), b.name, properties(r)", {"k": key}).result_set
    if not rows:
        raise ValueError(f"No link {key!r}")
    a, rel, b, props = rows[0]
    p = dict(props)
    out = {"key": key, "from": a, "rel": rel, "to": b, "rule": p.get("rule"),
           "confidence": p.get("confidence"), "evidence": list(p.get("evidence") or []),
           "files": [], "runs": None}
    for text in out["evidence"]:
        m = MANIFEST_REF.search(text)
        if m:                                      # the env line plus its "- name:" line above
            out["files"].append(_excerpt(MANIFEST, int(m.group(1)), 1, 0, "kubernetes-manifests.yaml (real, Google)"))
            break
    block = _catalog_link(a, b)
    if block:
        out["files"].append(block)
    if p.get("rule") == "logs" and rel in ("READS", "WRITES"):
        action = {"READS": "read", "WRITES": "write"}[rel]
        today = _evidence_date()
        runs = read_access_log().get(a, [])
        out["runs"] = {
            "file": ACCESS_LOG.name, "half_life_days": HALF_LIFE_DAYS, "certain_streak": CERTAIN_STREAK,
            "evidence_date": today.isoformat(), "every_days": p.get("every_days"),
            "items": [{"at": t.isoformat(timespec="minutes"), "run": run_id, "used": (action, b) in acc,
                       "weight": round(0.5 ** ((today - t.date()).days / HALF_LIFE_DAYS), 4)}
                      for t, run_id, acc in runs]}
    return out


ALLOWED = {p.name: p for p in (MANIFEST, CATALOG, OWNERS)}


def file_excerpt(name, line, before=2, after=2):
    """Lines around `line` of one of the evidence files (only those files can be read)."""
    path = ALLOWED.get(name)
    if not path:
        raise ValueError(f"Not an evidence file: {name!r}")
    labels = {MANIFEST.name: "kubernetes-manifests.yaml (real, Google)",
              CATALOG.name: "catalog.toml (synthetic)", OWNERS.name: "CODEOWNERS (synthetic)"}
    return _excerpt(path, max(1, int(line)), before, after, labels[path.name])
