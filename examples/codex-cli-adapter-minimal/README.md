# codex-cli-adapter-minimal

The smallest working example of pointing **OpenAI Codex CLI** at a running **Continuo** instance via MCP. Documentation-first: this directory is a runnable recipe, not a Continuo plugin.

When you finish this README, Codex CLI can drive terminal panels in Continuo through the same 7 `terminal.*` MCP tools that all Continuo agents speak.

## Prereqs

- Continuo running (dev = `pnpm dev`, or packaged = `pnpm build:app` → `out-pack/.../Continuo.app`).
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and on `$PATH`. (Continuo treats Codex CLI as a peer of Claude Code — neither is privileged.)
- The absolute path to `scripts/continuo-mcp-stdio.mjs` in your Continuo clone.

## Step 1 — Register Continuo as an MCP server in Codex CLI

Codex CLI uses a TOML config (typically `~/.codex/config.toml`). Add a `mcp_servers.continuo` block:

```toml
[mcp_servers.continuo]
command = "/absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs"
args    = []
env     = {}
```

`continuo-mcp-stdio.mjs` is a thin bidirectional byte proxy: it accepts MCP NDJSON on stdin/stdout and forwards it to Continuo's Unix-socket / Windows-named-pipe MCP server. Same script, same socket logic, same fallback behavior as the Claude Code adapter — see `examples/claude-code-adapter-minimal/README.md` for the socket / pipe path table.

## Step 2 — Verify the wiring

Start a Codex CLI session and ask it what tools the `continuo` server exposes. You should see:

- `terminal.list_sessions`
- `terminal.create_session`
- `terminal.send_input`
- `terminal.send_text`
- `terminal.press_key`
- `terminal.read_output`
- `terminal.kill`

Continuo prompts you in-app the first time an agent tries to call a tool (one authorization per Continuo launch — by design; see `src/stores/agent-auth.store.ts`).

## Step 3 — Drive Continuo from Codex CLI

Try this prompt:

> *"Use the continuo MCP server to open a terminal panel and run `git status` in it, then read the output back to me."*

Expected behavior: Codex calls `terminal.create_session` → a new panel appears in Continuo with the `(agent)` suffix → Codex calls `terminal.send_text` with `"git status\n"` → Codex calls `terminal.read_output` after a short delay → reports back what `git status` produced.

If you have a workspace open in Continuo (Explorer → Open Folder), the panel inherits that folder as its cwd. Without a workspace, the panel falls back to your home directory; pass an explicit `cwd` argument to `terminal.create_session` to override.

## What this example is NOT

- Not a Continuo plugin. There's no `manifest.json` / `main.js` in this directory. The plugin-side counterpart (a plugin registering MCP tools *for* agents) is `examples/mcp-demo-plugin/`.
- Not a Codex CLI tutorial. We assume you know how to run it; the only Codex-specific bit here is the TOML config.
- Not a production adapter. No multi-profile management, no session persistence, no shared prompt library, no operator workspaces.

## Troubleshooting

- **Codex says the `continuo` server is offline**: Continuo isn't running, or it's running on a flavor the proxy didn't auto-detect. Start Continuo or set `CONTINUO_MCP_SOCKET=/explicit/path` in the `env` block of the TOML config.
- **Codex tools list is empty**: the proxy connected but Continuo's MCP host isn't registering the terminal tools. Check Continuo's main-process console for errors from `mcp-host.service.ts`.
- **Calls hang on first invocation**: the agent-auth prompt is waiting in Continuo. Approve it once per launch; subsequent calls flow through.

## For more

A production-ready Codex CLI integration with operator workspaces, persistent agent profiles, and multi-agent session orchestration is part of **BYO-Agent Kit** (link TBA after Plan 01 Phase 0).
