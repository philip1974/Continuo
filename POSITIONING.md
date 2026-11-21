# Continuo — Positioning

## Thesis

Continuo is an **open-source GUI substrate for terminal-native agents** (Claude Code, Codex CLI, Aider, Cline, your own). Multi-terminal in parallel + popout to a second display + a plugin system with per-plugin permissions. The Markdown editor and Explorer tree are GUI layers built *on* the substrate for the human operator looking over the agent's shoulder — they are not the product.

## What sets it apart

- **Open source** (MIT), local-only — no hosted service, no account.
- **Many terminals in parallel**: dockable tabs, split layouts (drag a tab to split the dock), and popout windows for a second display.
- **Agents drive the GUI over MCP**: an agent can open terminal panels, type into them, read their output, wait for another agent to finish its turn, and drive a debugger — each behind a per-window permission prompt.
- **Third-party plugins with declared permissions**: plugins declare what they need (`fs` with path scopes, `network`, `shell`, `clipboard`, `mcp-tools`) and the user grants it. Plugins are not sandboxed, so install only plugins you trust.
- **Bring your own agent**: no agent is built in or privileged.

## If you're looking for X, this is / isn't for you

- **A nicer Markdown editor** → not us. Try [Obsidian](https://obsidian.md) or Cursor's editor.
- **A terminal you type in yourself** → not us. Try [Warp](https://www.warp.dev) or [Ghostty](https://ghostty.org).
- **An IDE that calls an LLM on your behalf** → not us. Try [Cursor](https://cursor.com) or [Zed](https://zed.dev).
- **Hosted sync / B2B SSO / cloud workspaces** → not us. We don't run a service.
- **A substrate where *your* agent (Claude Code, Codex CLI, your own) drives a desktop GUI with explicit permission boundaries** → ✅ us.
- **An ecosystem where third-party plugins surface their own MCP tools, permissions, and UI to agents** → ✅ us (early; plugin MCP tools are callable by agents running in a Continuo terminal of the same window — see `src/plugins/`).

## Why "substrate", not "agent"

Continuo deliberately does not ship a built-in agent. The thesis is that the agent layer churns fast (new models, new CLIs every few months) and the *substrate* — a dockable multi-terminal Electron shell with a permissioned plugin host and an MCP server — is the durable surface. Lock in to a substrate, not to an agent.

This means: Claude Code and Codex CLI are flagship integrations, but neither is privileged at the substrate level. If you ship a competitor agent tomorrow, it gets the same first-class treatment.

---

*Thesis locked 2026-05-17.*
