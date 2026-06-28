# Debug Spike Report

machine-generated: true
topic: 49-agent-controllable-debug
phase: Phase 0 spike

## Environment

- js-debug: 1.117.0
- sha256: ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772
- node: v24.15.0
- platform: darwin/arm64

## Criteria

- Phase 0a pure Node DAP closed loop + variable chain: PASS
  - `[debug-spike] stopped(reason=breakpoint)`
  - `[debug-spike] frame source=/Users/RiGang/Desktop/Continuo/scripts/debug-spike/fixture.ts:14`
  - `[debug-spike] variables nested.answer=42`
  - `[debug-spike] variables sum=21`
  - `[debug-spike] evaluate nested.answer=42`
  - `[debug-spike] evaluate sum=21`
- Node-level forced teardown: PASS
- Phase 0b main-context teardown: PASS
  - `pnpm exec vitest run --project electron electron/main/__tests__/dap-teardown-mini.spec.ts --reporter=verbose`
  - `1 passed`; adapter POSIX process group reaped after main-context child_process spawn.

## Findings

- vscode-js-debug uses a parent/child multi-session architecture. The parent session emits `startDebugging`; the child session owns breakpoint stop, stack, scopes, variables, and evaluate. A single-session engine assumption is invalid and must feed Phase 1/2 engine design.

## Caveats

- DAP `process` events reported no debuggee PID in observed teardown output. Phase 0 positively verifies adapter process-group reaping, but does not fully exclude orphan debuggee cases. Phase 1 must improve PID tracking.
- Phase 0 is a KC#1 pre-gate only. It is not KC#1 pass. Final KC#1 judgment requires the Phase 1 Electron BrowserWindow-close end-to-end path.

## Deletion Condition

- After Phase 1 lands a main-hosted regression, this report and `scripts/debug-spike/` can be deleted or downgraded.
