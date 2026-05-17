# Continuo — open-source GUI substrate for terminal-native agents

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

Run Claude Code, Codex CLI, Aider, or your own agent inside a dockable multi-terminal GUI. Each agent operates with explicit per-plugin permission boundaries. Bring your own agent.

## What it's NOT

- ❌ Not yet-another-AI-Markdown-editor
- ❌ Not a Cursor / VSCode competitor
- ❌ Not cloud-hosted; no sync service
- ❌ Not bundled with one agent's brand

## Demo

<!-- demo video link here after Plan 01 Phase 0 -->

## Quick start

Requires **Node 24** and **pnpm**.

**1 · Install + run dev build**

```bash
pnpm install
pnpm dev
```

**2 · Wire Continuo to Claude Code as an MCP server**

Continuo ships a stdio bridge (`scripts/continuo-mcp-stdio.mjs`) that proxies MCP traffic into the running Continuo app over a Unix socket / Windows named pipe.

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

Codex CLI / Aider have analogous stdio-MCP server config — point the same script.

**3 · Let the agent drive the UI**

Once Continuo is running and the MCP server is registered, the agent can call:

| Tool | Purpose |
|------|---------|
| `terminal.create_session` | spawn a new terminal panel (becomes a dockable tile) |
| `terminal.send_text` | type text into a session |
| `terminal.press_key` | send a named key (Enter, Ctrl+C, etc.) |
| `terminal.read_output` | read what scrolled past |
| `terminal.list_sessions` | enumerate active panels |
| `terminal.kill` | tear a panel down |

Ask Claude Code: *"open 4 panels and run `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm e2e` — one in each"* and watch it happen.

## Design docs

Architecture, history, and ADR depth live in a separate **ContinuoWiki** repo (read-only relative to this codebase). This README is the surface — the wiki is the depth. Quick local references for contributors:

- Sub-area READMEs near the code: `src/plugins/`, `src/marketplace/`, `src/shell/dock/`, `src/stores/`, `electron/main/`
- ADRs: `doc/adr/`
- Positioning vs. adjacent tools: [POSITIONING.md](POSITIONING.md)
- Working with the codebase: [CONTRIBUTING.md](CONTRIBUTING.md)
- Working with agents in this repo: [AGENTS.md](AGENTS.md)

## License

MIT — see [LICENSE](LICENSE). Third-party component attributions live in [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md).
