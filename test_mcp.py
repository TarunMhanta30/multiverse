"""
Multiverse - check the MCP server the way an AI agent uses it (in-process, no model, no API key).

It calls the real tools, so the rehearsals are real and you can watch them in the console
(open http://localhost:8765 while this runs). Every call also lands in the activity feed.

Run:  python test_mcp.py
"""
import anyio
from mcp import Client

from mcp_server import mcp

AGENT = "test-mcp"


async def call(client, tool, args):
    r = await client.call_tool(tool, {"agent": AGENT, **args})
    if r.is_error:
        return None, r.content[0].text
    data = r.structured_content
    return data.get("result", data), None


async def main():
    async with Client(mcp) as client:
        tools = [t.name for t in (await client.list_tools()).tools]
        print(f"{len(tools)} tools: {', '.join(tools)}\n")

        assets, _ = await call(client, "list_assets", {})
        real = sum(a["source"] == "online-boutique" for a in assets)
        print(f"list_assets: {len(assets)} assets, {real} from the real Kubernetes file")

        deps, _ = await call(client, "what_depends_on", {"name": "legacy_orders_db"})
        print(f"what_depends_on(legacy_orders_db): {deps}")

        links, _ = await call(client, "evidence", {"name": "orders_archive"})
        for l in links:
            print(f"evidence: {l['link']} {l['confidence']:.0%} ({l['rule']}) - {l['evidence'][-1][:90]}")

        s, _ = await call(client, "rehearse_delete", {"name": "orders_archive"})
        print(f"\nrehearse_delete(orders_archive): {s['verdict']} {s['critical_breakage_probability']:.0%} "
              f"over {s['futures_rehearsed']} futures, dice #{s['dice']}, unchanged={s['real_company_unchanged']}")
        for a in s["affected"]:
            print(f"   {a['status']:<8} {a['probability']:>4.0%}  {a['name']}  ({a['why']})")
        print(f"   asked: {[u['ask'] for u in s['unverified_links']]}")

        r, _ = await call(client, "delete_asset", {"name": "legacy_orders_db"})
        print(f"\ndelete_asset(legacy_orders_db): executed={r['executed']} - {r['reason']}")

        s, _ = await call(client, "rehearse", {"steps": [{"action": "rotate_secret", "asset": "payment_gateway_key"}]})
        print(f"rehearse(rotate payment_gateway_key): {s['verdict']} - {s['stop_reason']}")

        adv, _ = await call(client, "launch_advice", {"surge": 3, "surge_p90": 6})
        print(f"launch_advice(3x, 6x): first critical break at {adv['first_critical_break']}x, "
              f"P(critical) = {adv['theory_p_crit']:.1%}; scale {[(a['asset'], a['factor']) for a in adv['advice']][:3]}...")

        _, err = await call(client, "rehearse_delete", {"name": "does_not_exist"})
        print(f"\nbad name -> error: {err}")
        _, err = await call(client, "rehearse", {"steps": [{"action": "rotate_secret", "asset": "orders_db"}]})
        print(f"bad plan -> error: {err}")

        inbox, _ = await call(client, "team_inbox", {})
        print(f"team_inbox: {[(q['team'], q['link']) for q in inbox]}")


anyio.run(main)
