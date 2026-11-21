# Agent-controllable debug spike

Phase 0 verifies the narrow DAP pre-gate for topic 49.

- Phase 0a runs a real `vscode-js-debug` DAP server over a local socket, launches the TypeScript fixture, binds a source-map breakpoint at `fixture.ts:14`, reads local/closure variables, evaluates expressions, continues, and disconnects.
- The teardown scenario is POSIX-only in this phase. It records the adapter/debuggee process tree, sends group SIGTERM/SIGKILL as needed, and verifies no watched process remains alive.
- This is a KC#1 pre-gate signal only. It does not prove Electron BrowserWindow close behavior, asar packaging, renderer IPC, CodeMirror UI markers, or the future MCP-facing debug API.

The executable spec skips when the pinned adapter cache is absent; CI follow-up must fetch the adapter first and treat a missing adapter as failure rather than a green skip.
