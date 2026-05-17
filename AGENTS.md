# AGENTS.md — main repo agent contract

> This file governs how AI agents (Claude Code, Codex CLI, Aider, etc.) operate inside the **Continuo main repository**. It is distinct from the AGENTS.md in the ContinuoWiki sister repo.

## 1 · Repository identity

- This is the **substrate repository** for Continuo (the Electron app: main process, preload bridge, renderer shell, plugin SDK, marketplace, dock layer).
- It is **code-first**. Documentation in this repo is intentionally thin and stays close to the code it describes (`README.md` per sub-area + `doc/adr/` for decisions).
- Long-form design docs, tutorials, history, and verified source-card cross-refs are **not** here. They live in `~/Desktop/ContinuoWiki/` (a separate repo, maintained by the human owner).

## 2 · Default agent workflow

Before proposing any change:

1. **Read the relevant code.** Don't infer from filenames. Open the modules you intend to touch *and* the modules that call into them.
2. **Read existing tests.** This repo enforces BDD + TDD (see `CLAUDE.md`); existing `src/__tests__/<topic>/` BDD specs and module-level `*.spec.ts` are the authoritative spec for current behavior.
3. **Run the lint + typecheck baseline.** `pnpm lint && pnpm typecheck` must be green before your change. If it's red on `main`, surface that to the human before proceeding.
4. **Write the BDD or TDD test first** when introducing or changing observable behavior. See `CLAUDE.md` § "BDD+TDD 驱动开发规则".
5. **Respect the design-system constraints** in `CLAUDE.md` (no raw Tailwind colors, no native `<button>` / `<input>` className, no edits to `src/styles/nous-tokens.css`).

## 3 · Cross-repo boundary (asymmetric — read carefully)

Agents working in this repo also have visibility into `~/Desktop/ContinuoWiki/`. The boundary is **asymmetric**:

- 🚫 **Forbidden — never write** any file under `~/Desktop/ContinuoWiki/`. Not the index, not the log, not a tutorial, not a frontmatter field. The wiki is maintained exclusively by the human owner. Agents in this repo treat the wiki as read-only.
- ✅ **Allowed — read-only** access to two paths only:
  - `~/Desktop/ContinuoWiki/wiki/tutorials/` — verified design tutorials (current canonical design source).
  - `~/Desktop/ContinuoWiki/wiki/sources/` — verified source-card cross-references.
- ⛔ **Default — do not read** any other path under `~/Desktop/ContinuoWiki/` (plans, drafts, raw notes, etc.). Reading them pollutes context with unverified material.

If a task seems to require writing to ContinuoWiki, stop and ask the human — the answer is "you write it, I'll read it once you do".

## 4 · Source-of-truth precedence

When multiple sources disagree:

1. **Current code** (in this repo) — always wins for "what the system does today".
2. **`CLAUDE.md` in this repo** — operational rules, design-system constraints, BDD+TDD workflow.
3. **`doc/adr/` in this repo** — decisions that shaped the code, ≤ 80 lines each.
4. **`~/Desktop/ContinuoWiki/wiki/tutorials/`** — broader rationale and history; read-only reference, may lag behind the code.
5. **Plans / requirements documents** — describe what the human *wants*; the code describes what *is*. If they disagree, the plan is the source of intent and the code is the source of state. Surface the gap.

## 5 · Things this repo no longer maintains (do not recreate)

- `doc/00` – `doc/24+` long-form design docs — deleted 2026-05-17 by the human owner because of drift accumulation. **Do not recreate them.** Long-form design docs belong in ContinuoWiki tutorials.
- `doc/checklist/freeze-*` — if not present, do not recreate. If present (left over from earlier work), do not modify them as part of unrelated tasks.
- `CHANGELOG.md` — release tooling handles this; don't author it by hand.

## 6 · Out-of-scope for agent execution

- Marketing site / landing page work.
- Discord / Twitter / social channel setup.
- Anything related to the closed-source BYO-Agent Kit (separate private repo).
- License changes (legal decision — surface to human, do not act).
- Force-pushes, branch deletions, `git reset --hard`, or any destructive git operation without explicit human confirmation.

## 7 · Authorization expiration

A human approval for one action (e.g., "go ahead and commit", "push it") does **not** extend to subsequent actions of the same kind. Each commit, each push, each PR creation requires its own go-ahead unless the human gave a durable instruction in `CLAUDE.md`.
