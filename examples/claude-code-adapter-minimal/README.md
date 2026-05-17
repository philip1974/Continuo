# claude-code-adapter-minimal

The smallest working example of pointing **Claude Code** at a running **Continuo** instance via MCP. Documentation-first: this directory is a runnable recipe, not a Continuo plugin.

When you finish this README, Claude Code can:

- Spawn terminal panels inside Continuo (`terminal.create_session`)
- Type into them (`terminal.send_text`, `terminal.press_key`)
- Read their output (`terminal.read_output`)
- Enumerate / kill sessions (`terminal.list_sessions`, `terminal.kill`)

…all without you typing anything in the terminal yourself.

## Prereqs

- Continuo running (dev or packaged). Dev = `pnpm dev` from the repo root; packaged = `out-pack/mac-arm64/Continuo.app` (or your platform's equivalent built via `pnpm build:app`).
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and on `$PATH`.
- The absolute path to `scripts/continuo-mcp-stdio.mjs` in this repo. Wherever you cloned Continuo, this file lives at `<clone>/scripts/continuo-mcp-stdio.mjs`.

## Step 1 — Register Continuo as an MCP server in Claude Code

```bash
claude mcp add \
  --transport stdio \
  continuo \
  -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

What this does: `claude` records that whenever you start a session, it should spawn `continuo-mcp-stdio.mjs` as a stdio MCP server. The script is a thin proxy — it doesn't run any logic of its own; it just forwards bytes between Claude Code's stdin/stdout and Continuo's Unix-socket / Windows-named-pipe MCP server.

The socket the proxy connects to depends on which Continuo is running:

| Continuo flavor | Socket / pipe |
|---|---|
| Packaged (default) | macOS: `~/Library/Application Support/Continuo/mcp.sock` · Linux: `${XDG_CONFIG_HOME:-~/.config}/Continuo/mcp.sock` |
| Dev (`pnpm dev`) | macOS: `~/Library/Application Support/Continuo Dev/mcp.sock` (proxy auto-falls back when no packaged socket exists) |
| Windows (any) | named pipe `\\.\pipe\continuo-mcp` |
| Override | set `CONTINUO_MCP_SOCKET=<path>` |

If neither Continuo flavor is running when Claude Code tries to call a tool, you'll see `socket not found` from the proxy and Claude will mark the server as unavailable until you start Continuo.

## Step 2 — Verify the wiring

```bash
claude
```

Inside the Claude Code REPL, ask:

> *"What MCP tools do you have available from the `continuo` server?"*

You should see the 7 terminal tools listed: `terminal.list_sessions`, `terminal.create_session`, `terminal.send_input`, `terminal.send_text`, `terminal.press_key`, `terminal.read_output`, `terminal.kill`. Continuo prompts you in-app the first time an agent attempts to use a tool (one-shot per-launch authorization — see `src/stores/agent-auth.store.ts`).

## Step 3 — Drive Continuo from Claude Code

Try this exact prompt in Claude Code:

> *"Open four terminal panels in Continuo. In each one, run a different one of: `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm e2e`. Tell me which one finishes first and what its exit code is."*

What you'll see: four panels appear in Continuo (dockable, draggable, popout-able just like user-created ones); each is tagged with the `(agent)` suffix in the title; Claude reads their output and reports back as runs complete.

## What this example is NOT

- Not a Continuo plugin. There is no `manifest.json` / `main.js` here. If you want to see a plugin that **registers** an MCP tool **for** agents (Continuo → agent direction), look at `examples/mcp-demo-plugin/`.
- Not a production-grade adapter. No auth flow, no per-workspace agent profiles, no operator-shorthand commands, no shared session library.
- Not coupled to Claude Code's specific protocol; the same `continuo-mcp-stdio.mjs` works with any MCP-compatible client (`codex` CLI, Aider's experimental MCP support, etc.). See the sibling `examples/codex-cli-adapter-minimal/`.

## Troubleshooting

- **`socket not found`**: Continuo isn't running, or it's running but on a flavor (packaged vs dev) the proxy didn't auto-detect. Start Continuo or set `CONTINUO_MCP_SOCKET=/explicit/path`.
- **Tools listed but every call hangs**: the agent-auth prompt is open in Continuo waiting for you. Approve or deny it.
- **`terminal.create_session` returns `TERMINAL_CWD_UNRESOLVED`**: no workspace root is set in Continuo. Open a folder in Continuo's Explorer first, or pass an explicit `cwd` in the tool call arguments.

## For more

This minimal adapter is intentionally a demo, not a daily driver. A production-ready Claude Code integration with operator workspaces, persistent agent profiles, multi-agent session orchestration, and shared prompt libraries lives in **BYO-Agent Kit** (link TBA after Plan 01 Phase 0).
