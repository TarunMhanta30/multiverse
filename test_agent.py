"""
Multiverse - check the agent loop end to end WITHOUT an API key.

The real agent loop (agent.py) and the real MCP server (a separate process, stdio) run unchanged;
only the language model is replaced by a small scripted STAND-IN, so the test is free and repeatable.
The stand-in is not an AI. What it does:
  - decides each next step from the REAL tool results it receives (it reads the verdict)
  - writes its final report from those results - no number in it is written in advance

  TEST 1  rogue stand-in: calls delete_asset(legacy_orders_db) straight away.
          Expected: refused (a fresh rehearsal says BLOCK) and legacy_orders_db is still in the company.
  TEST 2  careful stand-in: recall -> rehearse_delete -> delete only if SAFE, else report.
  TEST 3  the same careful stand-in behind a local OpenAI-compatible HTTP server, so agent.py's
          real network path (urllib -> /chat/completions -> tool calls -> MCP) is exercised exactly
          as with OmniRoute or any hosted model.

A real model: python agent.py "..." (with LLM_* set), or Claude Desktop (python connect_claude.py).
Run:  python test_agent.py
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anyio

import agent
from config import WORLD, db

TARGET = "orders_archive"


def tool_call(n, name, args):
    return {"role": "assistant", "content": None,
            "tool_calls": [{"id": f"call_{n}", "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)}}]}


def parse(content):
    try:
        data = json.loads(content)
        return data.get("result", data) if isinstance(data, dict) else data
    except (TypeError, ValueError):
        return {"text": content}


def report(r):
    """The stand-in's final words, built only from the rehearsal result it received."""
    if r.get("verdict") == "SAFE":
        return f"{TARGET} is SAFE to delete ({r['stop_reason']})"
    breaks = ", ".join(f"{a['name']} ({a['probability']:.0%}, {a['status']})" for a in r["affected"]) or "nothing"
    why = "; ".join(sorted({a["why"] for a in r["affected"]}))
    asked = ", ".join(sorted({u["ask"] for u in r["unverified_links"]})) or "nobody"
    return (f"Not deleted. Verdict {r['verdict']}: something critical breaks in "
            f"{r['critical_breakage_probability']:.0%} of {r['futures_rehearsed']} futures. "
            f"Breaks: {breaks}. Why: {why}. Asked: {asked}.")


def careful(messages, agent_name):
    tools_done = [m for m in messages if m["role"] == "tool"]
    n = len(tools_done)
    if n == 0:
        return tool_call(n, "recall", {"name": TARGET, "agent": agent_name})
    if n == 1:
        return tool_call(n, "rehearse_delete", {"name": TARGET, "agent": agent_name})
    last = parse(tools_done[-1]["content"])
    if n == 2:
        if last.get("verdict") == "SAFE":
            return tool_call(n, "delete_asset", {"name": TARGET, "agent": agent_name})
        return {"role": "assistant", "content": report(last)}
    return {"role": "assistant", "content": f"Done: {last.get('reason', last)}"}


def rogue(messages, agent_name):
    tools_done = [m for m in messages if m["role"] == "tool"]
    if not tools_done:
        return tool_call(0, "delete_asset", {"name": "legacy_orders_db", "agent": agent_name})
    last = parse(tools_done[-1]["content"])
    return {"role": "assistant", "content": f"I tried. Multiverse said: {last.get('reason', last)}"}


def stand_in(policy, agent_name):
    async def chat(messages, _tools):
        return policy(messages, agent_name)
    return chat


class FakeModelServer(BaseHTTPRequestHandler):
    """Speaks the OpenAI /chat/completions format; the careful stand-in decides the reply."""
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["tools"], "agent.py must send the MCP tools to the model"
        msg = careful(body["messages"], "http-agent")
        out = json.dumps({"choices": [{"message": msg}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *_args):
        pass


def in_world(name):
    return bool(db.select_graph(WORLD).ro_query("MATCH (a:Asset {name: $n}) RETURN a", {"n": name}).result_set)


async def main():
    line = "=" * 72
    print(f"{line}\nTEST 1 - rogue stand-in deletes legacy_orders_db without rehearsing\n{line}")
    await agent.run("Delete legacy_orders_db right now.", chat=stand_in(rogue, "rogue-agent"), agent_name="rogue-agent")
    print(f"\nlegacy_orders_db still in the company: {'yes' if in_world('legacy_orders_db') else 'NO'}")

    print(f"\n{line}\nTEST 2 - careful stand-in follows the rules, decides from real results\n{line}")
    await agent.run(f"Delete {TARGET}.", chat=stand_in(careful, "careful-agent"), agent_name="careful-agent")
    print(f"\n{TARGET} still in the company: {'yes' if in_world(TARGET) else 'no (it was SAFE and got deleted)'}")

    print(f"\n{line}\nTEST 3 - agent.py's real HTTP path against a local model server\n{line}")
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(LLM_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1", LLM_MODEL="local-stand-in",
                      LLM_API_KEY="test")
    await agent.run(f"Delete {TARGET}.", agent_name="http-agent")       # uses agent.openai_chat (urllib)
    server.shutdown()


anyio.run(main)
