# Agent-controllable debug spike

Phase 0 verified the narrow DAP pre-gate for topic 49 (historical record). This directory now only holds the DAP frame codec spec (`dap-framing.spec.ts`: `DapStreamDecoder` / `encodeDapMessage`); the real-adapter smoke and teardown checks live in `electron/main/__tests__/debug-adapter-smoke.spec.ts` and `dap-teardown-mini.spec.ts` (both skip when the pinned adapter cache is absent).

Phase 0 (historical):

- Phase 0a runs a real `vscode-js-debug` DAP server over a local socket, launches the TypeScript fixture, binds a source-map breakpoint at `fixture.ts:14`, reads local/closure variables, evaluates expressions, continues, and disconnects.
- The teardown scenario is POSIX-only in this phase. It records the adapter/debuggee process tree, sends group SIGTERM/SIGKILL as needed, and verifies no watched process remains alive.
- This is a KC#1 pre-gate signal only. It does not prove Electron BrowserWindow close behavior, asar packaging, renderer IPC, CodeMirror UI markers, or the future MCP-facing debug API.

In CI the `debug-spike` job fetches the pinned adapter, asserts it exists, and then runs both real-adapter specs, so a missing adapter fails the job instead of producing a green skip.
