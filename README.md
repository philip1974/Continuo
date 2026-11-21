# Continuo — open-source GUI substrate for terminal-native agents

**English** · [简体中文](README.zh-CN.md) · [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/philip1974/Continuo?style=social)](https://github.com/philip1974/Continuo)

Run Claude Code, Codex CLI, Aider, or your own agent inside a dockable multi-terminal GUI. Agents act only after you allow them in the window they target; plugins declare the permissions they use (they are not sandboxed, so install only plugins you trust). **Bring your own agent.**

> **Why it exists:** a single coding agent will tell you it's "done" when it isn't. Continuo lets you run several terminal agents in one window — one driving, another auditing — so you can see what each actually did instead of trusting a final "done".

## Download

Prebuilt installers are published on the [Releases page](https://github.com/philip1974/Continuo/releases) when available. **There is no published build right now — build from source** (see **Quick start** below).

Early-access builds are **macOS (Apple Silicon) only and unsigned**: mount the `.dmg` and drag Continuo into **Applications**, then **right-click the app → Open → Open** to get past Gatekeeper (macOS 14 and earlier); on macOS 15 and later, try to open it once, then click **Open Anyway** in System Settings → Privacy & Security. If macOS says the app "is damaged", remove the download quarantine flag: `xattr -dr com.apple.quarantine /Applications/Continuo.app`. Code signing / notarization and Windows / Linux builds come later.

## First-run feedback

1. Build from source (**Quick start** below), or use a build from the Releases page when one is available (unsigned — see the Gatekeeper note above).
2. Connect your normal terminal agent through the MCP stdio bridge.
3. Tell us what happened: OS, agent, and the exact step where setup or MCP broke.

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

Requires **Node 24** and **pnpm 9 or newer**.

> **Platform support:** Continuo has only been run and tested on **macOS** so far. Windows and Linux are not yet tested — they may work, but expect rough edges. Reports and fixes welcome.

**1 · Clone, install, run the dev build**

Continuo depends on the sibling repo [ContinuoTerminal](https://github.com/philip1974/ContinuoTerminal), consumed via `file:../ContinuoTerminal/...` and pinned to the commit recorded in `.continuo-terminal-ref`. Clone both side by side:

```bash
git clone https://github.com/philip1974/Continuo.git
git clone https://github.com/philip1974/ContinuoTerminal.git
git -C ContinuoTerminal checkout "$(cat Continuo/.continuo-terminal-ref)"

cd Continuo
pnpm install
pnpm dev
```

The `debug.*` tools need Microsoft's js-debug adapter, which is not in the repo. Download it once (pinned version, checksum-verified) with `node scripts/fetch-debug-adapter.mjs`; packaged builds include it. Once the adapter is present, `pnpm test` also runs the real-debugger tests, which need their fixture compiled first: `pnpm exec tsc -p scripts/debug-spike/tsconfig.json`.

**2 · Wire Continuo to Claude Code as an MCP server**

Continuo ships a stdio bridge (`scripts/continuo-mcp-stdio.mjs`) that proxies MCP traffic into the running Continuo app over a Unix socket / Windows named pipe.

```bash
claude mcp add --transport stdio continuo -- /absolute/path/to/Continuo/scripts/continuo-mcp-stdio.mjs
```

On Windows, call it through Node: `claude mcp add --transport stdio continuo -- node "C:\path\to\Continuo\scripts\continuo-mcp-stdio.mjs"`. The status bar's **Copy MCP config** button gives you the right command for your platform.

Other MCP-capable agents (e.g. Codex CLI) have an equivalent stdio MCP server setting — point it at the same script.

Inside a Continuo terminal the bridge always connects to the Continuo instance that owns that terminal (its socket path is injected as `CONTINUO_MCP_SOCKET`), so a dev build and the packaged app can run side by side. Outside Continuo terminals it tries the packaged app first, then the dev build. Setting `CONTINUO_MCP_SOCKET` explicitly in your MCP server config overrides both. On macOS / Linux the bridge only connects to a socket that is owned by the current user and lives in a directory owned by the current user that is not writable by group / others (Continuo's own socket always is); an explicit value that fails this check (another user's socket, a socket under `/tmp`, a symlink whose resolved target fails these checks) makes the bridge exit with an error without connecting or sending the window token. On Windows an explicit value must be a valid local Continuo pipe name (`\\.\pipe\continuo-mcp-…`); any other value (a remote pipe, an arbitrary path) makes the bridge exit immediately with an error instead of falling back to other candidates.

**3 · Let the agent drive the UI**

Once Continuo is running and the MCP server is registered, the agent can call:

| Tool | Purpose |
|------|---------|
| `terminal.create_session` | spawn a new terminal panel (becomes a dockable tile) |
| `terminal.send_text` | type text into a session |
| `terminal.send_input` | write raw bytes to a session (advanced; prefer `send_text` + `press_key`) |
| `terminal.press_key` | send a named key (`enter`, `ctrl_c`, `tab`, `escape`, arrow keys, …) |
| `terminal.read_output` | read what scrolled past |
| `terminal.list_sessions` | enumerate active panels |
| `terminal.kill` | signal a session: `SIGTERM` (default) sends Ctrl+C, then force-kills after 3 s; `SIGINT` only sends Ctrl+C (Continuo does not force the process to exit); `SIGKILL` kills immediately. After the process exits the panel stays and `list_sessions` reports its `exit_code`; the output buffer is released then, so call `read_output` first if you need the final output |
| `terminal.await_stop_hook` | block until the agent in a session fires its Stop hook (finishes its turn); the hook is installed only when the session was created with `install_stop_hook: true`, an `agentLabel` of `claude` / `claude-code` / `cc` / `codex`, and a cwd inside the window's workspace folder that is not your home directory or one of its parents |
| `debug.*` | drive a Node.js debugger: `launch`, `set_breakpoint`, `wait_for_stop`, `continue`, `step_over` / `step_in` / `step_out`, `stack`, `scopes`, `variables`, `evaluate`, `disconnect`, `list_sessions` |

Before an agent can act on a window, Continuo asks you in that window to allow it; terminal and debug access are separate permissions. `list_sessions` shows every session in the window, but the read / write / kill / wait tools and `debug.*` only act on sessions that the same MCP connection created with `create_session` or `debug.launch`.

> **Debugging on multi-user machines:** while a `debug.launch` session is running, the debugged Node process's inspector listens on a random port on `127.0.0.1`. Any other local user on the same machine can connect to that port and run code inside the debuggee as you — a general Node / js-debug limitation, not specific to Continuo. On multi-user hosts, use `debug.launch` with care and disconnect sessions as soon as you are done.

Ask Claude Code: *"open 4 panels and run `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm typecheck` — one in each"* and watch it happen.

## Design docs

Documentation stays close to the code:

- Sub-area READMEs: `src/plugins/`, `src/marketplace/`, `src/shell/dock/`, `src/stores/`, `electron/main/`
- Positioning vs. adjacent tools: [POSITIONING.md](POSITIONING.md)
- Working with the codebase: [CONTRIBUTING.md](CONTRIBUTING.md)
- Working with agents in this repo: [AGENTS.md](AGENTS.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## License

MIT — see [LICENSE](LICENSE). Third-party component attributions live in [LICENSE-3RD-PARTY.md](LICENSE-3RD-PARTY.md).
