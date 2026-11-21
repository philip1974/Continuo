# Security Policy

## Supported versions

Continuo is in early access. Only the latest commit on `main` (and the newest release, when one is published) receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: go to the repository's **Security** tab → **Report a vulnerability** (or open <https://github.com/philip1974/Continuo/security/advisories/new>). Include:

- what is affected (component, file, or MCP tool) and the version / commit;
- steps to reproduce or a proof of concept;
- the impact you expect (e.g. an agent acting without your approval, or untrusted content gaining IPC access).

You should get a first response within a week. Fixes are released as soon as practical, and reporters are credited in the advisory unless they prefer otherwise.

## Scope notes

- In scope: an agent or external process getting past the terminal / debug authorization prompts, the MCP socket ownership checks, or the bearer-token check on the local HTTP MCP endpoint (listens on `127.0.0.1` only; its URL and token are injected into Continuo terminals as `CONTINUO_MCP_URL` / `CONTINUO_MCP_TOKEN`), and anything that lets untrusted content (web pages, files, terminal output) gain IPC or code execution.
- Plugins are **not sandboxed**: they run in the app's JavaScript realm (see `src/plugins/README.md`). A plugin using web APIs that the permission system doesn't cover is a known limitation, not a vulnerability; reports that show a way to make this boundary stronger are still welcome.
- While a `debug.launch` session runs, the debuggee's Node inspector listens on a random `127.0.0.1` port that other local users could reach. This is a known Node / js-debug limitation, documented in the README.
- Early-access builds are unsigned; verify downloads against the published `SHA256SUMS` file.
