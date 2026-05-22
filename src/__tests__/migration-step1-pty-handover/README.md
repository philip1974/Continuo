# migration-step1-pty-handover

BDD specs covering Step 1 PTY ownership handover from `pty.spawn()` to `@continuo-terminal/server-node` `SessionManager`. Each spec targets one of the 4 P0 paths identified by red-team:

- `multi-window-routing.spec.ts` — verifies per-session `WebContents` routing via `sessionTargets` Map + `safeSend` variadic helper (P0-2)
- `force-kill-cleanup.spec.ts` — verifies `forceKill` triggers sync local cleanup independent of SessionManager `onExit` disposal (P0-1)
- `create-failure-rollback.spec.ts` — verifies `createTerminal` rolls back instances/buffer/target on `sm.create` reject (P0-3)
- `window-close-cleanup.spec.ts` — verifies `makeWindowClosedCleanup` baseline graceful order + `webContents.isDestroyed()` guard (P0-4)

Run via `pnpm test src/__tests__/migration-step1-pty-handover/`. After adding/modifying specs, run `pnpm bdd:index` to update the index.

Refs: ContinuoTerminal/.claude/dev-loop/18-migration-step1-continuo-pty-handover/ (plan-v3 + plan-v3-patches)
