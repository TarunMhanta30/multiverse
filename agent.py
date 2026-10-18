"""
Multiverse - a real LLM agent that uses Multiverse through MCP.

The agent starts mcp_server.py as a SEPARATE process (real MCP over stdio), discovers its tools,
and hands them to any OpenAI-compatible model: OmniRoute, Gemini, OpenAI, Groq, ...

Settings - set them in the PowerShell window before running (read at call time):
  $env:LLM_BASE_URL = "http://localhost:20128/v1"     (OmniRoute default)
  $env:LLM_API_KEY  = "your-key"
  $env:LLM_MODEL    = "provider/model-name"           (must support tool calling)

Run:  python agent.py "Clean up: delete orders_archive, nobody seems to use it."

Safety does not depend on the model obeying: delete_asset and execute_approved_plan refuse anything
a fresh rehearsal does not call SAFE. Claude Desktop can be the agent too: python connect_claude.py
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import anyio
from mcp import Client, StdioServerParameters
from mcp.types import Implementation, TextContent

HERE = Path(__file__).resolve().parent
AGENT = "cleanup-agent"
MAX_STEPS = 14

SYSTEM = f"""You are {AGENT}, an operations agent for the company Boutique Inc.
You change the real company only through Multiverse tools, and Multiverse rehearses first.
Rules:
1. Before deleting or changing anything: recall it, then rehearse it (rehearse_delete or rehearse).
2. Act only on a SAFE verdict: delete_asset for a delete; propose_plan then execute_approved_plan
   for windows, launches and other plans.
3. On BLOCK or REVIEW do not act and do not retry with other wording. Report what breaks, how likely,
   why (the dependency path and its evidence) and which teams were asked.
Always pass agent="{AGENT}". Finish with a short report: what you did, what you refused, and why."""


def server_params():
    return StdioServerParameters(command=sys.executable, args=[str(HERE / "mcp_server.py")], cwd=str(HERE))


def settings():
    return {"base_url": os.environ.get("LLM_BASE_URL", "http://localhost:20128/v1").rstrip("/"),
            "api_key": os.environ.get("LLM_API_KEY", ""), "model": os.environ.get("LLM_MODEL", "")}


def _post_chat(messages, tools):
    cfg = settings()
    body = json.dumps({"model": cfg["model"], "messages": messages, "tools": tools,
                       "tool_choice": "auto", "temperature": 0}).encode()
    req = urllib.request.Request(f"{cfg['base_url']}/chat/completions", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {cfg['api_key']}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())["choices"][0]["message"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"LLM call failed ({e.code}): {e.read().decode()[:500]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cannot reach the model at {cfg['base_url']}: {e.reason}") from None


async def openai_chat(messages, tools):
    """One call to any OpenAI-compatible /chat/completions endpoint (Python built-ins only)."""
    return await anyio.to_thread.run_sync(_post_chat, messages, tools)


def one_line(data):
    """Short human-readable echo of a tool result for the console."""
    if not isinstance(data, dict):
        return "(no structured result)"
    if "verdict" in data:
        exact = "exact" if data.get("exact") else f"{data['futures_rehearsed']} futures"
        return (f"{data['verdict']}: {data['critical_breakage_probability']:.0%} critical, {exact}, "
                f"rehearsal {data['rehearsal_id']} ({data['decision_status']})")
    if "executed" in data:
        return ("EXECUTED - " if data["executed"] else "") + data["reason"]
    if "status" in data and "plan_id" in data:
        return f"{data['status'].upper()} - {data['reason']}"
    if "result" in data:
        return f"{len(data['result'])} item(s)"
    return "ok"


async def run(task, chat=openai_chat, agent_name=AGENT):
    """Run the agent loop. `chat` can be swapped (test_agent.py plugs in stand-ins)."""
    system = SYSTEM.replace(AGENT, agent_name)
    async with Client(server_params(), client_info=Implementation(name="multiverse-agent", version="2")) as mcp:
        tools = (await mcp.list_tools()).tools
        llm_tools = [{"type": "function",
                      "function": {"name": t.name, "description": t.description or "",
                                   "parameters": t.input_schema}} for t in tools]
        print(f"[{agent_name}] {len(tools)} tools discovered over MCP")
        print(f"[{agent_name}] Task: {task}\n")
        messages = [{"role": "system", "content": system}, {"role": "user", "content": task}]
        for _step in range(MAX_STEPS):
            msg = await chat(messages, llm_tools)
            calls = msg.get("tool_calls") or []
            messages.append({"role": "assistant", "content": msg.get("content"),
                             **({"tool_calls": calls} if calls else {})})
            if not calls:
                print(f"\n[{agent_name}] Final report:\n{msg.get('content') or '(empty)'}")
                return messages
            for call in calls:
                name = call["function"]["name"]
                args = json.loads(call["function"].get("arguments") or "{}")
                shown = ", ".join(f"{k}={v!r}" for k, v in args.items() if k != "agent")
                print(f"  -> {name}({shown})")
                result = await mcp.call_tool(name, args)
                text = "\n".join(b.text for b in result.content if isinstance(b, TextContent))
                print(f"     {'ERROR: ' + text if result.is_error else one_line(result.structured_content)}")
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
        print(f"\n[{agent_name}] Stopped after {MAX_STEPS} steps.")
        return messages


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit()
    if not settings()["model"]:
        print("Set $env:LLM_MODEL (and LLM_API_KEY / LLM_BASE_URL) first - see the top of agent.py.")
        sys.exit(1)
    anyio.run(run, " ".join(sys.argv[1:]))
