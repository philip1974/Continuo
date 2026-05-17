# Continuo — Positioning

## Thesis

Continuo is an **open-source GUI substrate for terminal-native agents** (Claude Code, Codex CLI, Aider, Cline, your own). Multi-terminal in parallel + popout to a second display + a plugin system with fine-grained per-plugin permissions. The Markdown editor and Explorer tree are GUI layers built *on* the substrate for the human operator looking over the agent's shoulder — they are not the product.

## Competitive landscape

| 维度 | Continuo | Warp | Cursor | Claude Desktop | Zed |
|---|---|---|---|---|---|
| 开源 | ✅ | ❌ | ❌ | ❌ | ✅ |
| 多 terminal 并行 (dock-style, split + popout) | ✅ | ⚠️ tab-only | ❌ | ❌ | ⚠️ |
| Agent 通过 MCP 操作 GUI | ✅ (独有) | ❌ | ❌ | ⚠️ partial | ❌ |
| 第三方 plugin + 细粒度权限 | ✅ | ❌ | ❌ | ❌ | ⚠️ extension-only |
| popout 到第二屏 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Bring-your-own agent (no brand lock) | ✅ | ❌ | ❌ | ❌ | ❌ |

Legend: ✅ first-class · ⚠️ partial · ❌ not supported.

## If you're looking for X, this is / isn't for you

- **A nicer Markdown editor** → not us. Try [Obsidian](https://obsidian.md) or Cursor's editor.
- **A terminal you type in yourself** → not us. Try [Warp](https://www.warp.dev) or [Ghostty](https://ghostty.org).
- **An IDE that calls an LLM on your behalf** → not us. Try [Cursor](https://cursor.com) or [Zed](https://zed.dev).
- **Hosted sync / B2B SSO / cloud workspaces** → not us. We don't run a service.
- **A substrate where *your* agent (Claude Code, Codex CLI, your own) drives a desktop GUI with explicit permission boundaries** → ✅ us.
- **An ecosystem where third-party plugins surface their own MCP tools, permissions, and UI to agents** → ✅ us (early; see `src/plugins/`).

## Why "substrate", not "agent"

Continuo deliberately does not ship a built-in agent. The thesis is that the agent layer churns fast (new models, new CLIs every few months) and the *substrate* — a dockable multi-terminal Electron shell with a permissioned plugin host and an MCP server — is the durable surface. Lock in to a substrate, not to an agent.

This means: Claude Code and Codex CLI are flagship integrations, but neither is privileged at the substrate level. If you ship a competitor agent tomorrow, it gets the same first-class treatment.

---

*Thesis locked 2026-05-17. See ContinuoWiki for design depth.*
