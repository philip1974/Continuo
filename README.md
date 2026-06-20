# Continuo — open-source GUI substrate for terminal-native agents

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/philip1974/Continuo)](https://github.com/philip1974/Continuo/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

Run Claude Code, Codex CLI, Aider, or your own agent inside a dockable multi-terminal GUI. Each agent operates with explicit per-plugin permission boundaries. **Bring your own agent.**

## Demo

Real Claude Code driving Codex through Continuo's MCP — Claude Code opens a *second* terminal panel itself, hands Codex a task, and reads back the result, all in one window:

![Continuo demo — Claude Code and Codex collaborating in one window](docs/assets/demo.gif)

▶️ [Watch with audio / full quality](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/continuo-demo.mp4)

## Download

Want to try Continuo without building from source?

**macOS (Apple Silicon)** — early-access, **unsigned** build:

- [DMG](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64.dmg)
- [ZIP fallback](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/Continuo-0.2.4-arm64-mac.zip)
- [SHA256 checksums](https://github.com/philip1974/Continuo/releases/download/v0.2.4-early/SHA256SUMS.txt)

Prefer the release page? [Download the latest release](https://github.com/philip1974/Continuo/releases/latest).

> Unsigned build: after mounting the `.dmg`, **right-click the app → Open → Open** to get past Gatekeeper. Code signing / notarization comes in a later release. Windows / Linux builds are on the way. Prefer to build from source? See **Quick start** below.

## First-run feedback

1. Download the macOS Apple Silicon build above.
2. Open the unsigned app with right-click -> Open.
3. Connect your normal terminal agent through the MCP stdio bridge.
4. Tell us what happened: OS, agent, and the exact step where setup or MCP broke.

Useful feedback:

- Did the app open?
- Which agent did you try: Claude Code, Codex CLI, Aider, or your own?
- Where did setup or MCP integration fail?
- Would you use it a second time for real work?

Feedback/issues:
<https://github.com/philip1974/Continuo/issues/new?template=first-run-feedback.md>

## What it's NOT

- ❌ Not yet-another-AI-Markdown-editor
- ❌ Not a Cursor / VSCode competitor
- ❌ Not cloud-hosted; no sync service
- ❌ Not bundled with one agent's brand

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
