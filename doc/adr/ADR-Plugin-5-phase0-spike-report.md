# ADR-Plugin-5 Phase 0 Spike Report

- **Status**: Proposed (verdict TBD — awaiting manual real_test in /dl-verify)
- **Date**: 2026-06-16
- **Topic**: `.claude/dev-loop/45-plugin-true-isolation-phase0-spike/`
- **Source CSP** (from `index.html:23`):
  - **CSP-A**: `default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: ws://localhost:* wss://localhost:* http://localhost:*; object-src 'none'; base-uri 'self';`
  - **缺**: `frame-src` / `child-src` / `worker-src`（fallback 到 `default-src 'self'` — iframe `src=blob:` 必拦）

## 1. Context

落 [ADR-Plugin-5 §7](./ADR-Plugin-5-true-isolation-roadmap.md) Phase 0 决策门：在 packaged Electron 真实 CSP 下验证 (a) Worker / (b) iframe sandbox / (c) SAB+Atomics.wait 三件套可行性。spike 代码隔离在 `src/spikes/plugin-isolation/`；thin-entry router (`src/main.tsx` ≤30 行) 保主 app 副作用零触发（实测 spike chunk 10KB ⇎ main-app chunk 2.7MB 物理隔离，`scripts/check-spike-isolation.mjs` 3-gate PASS）。`?spike=plugin-isolation` query 触发，packaged 默认无 `CONTINUO_SPIKE=1` 时**两道防线齐拦**（web-contents-created listener + loadFile queryParts 前置 strip）。

## 2. Results (3-track × 3-probe)

| Track | isPackaged | protocol | CSP | Worker | iframe | SAB |
|---|---:|---|---|---|---|---|
| **dev** (pnpm dev) | false | http: | CSP-A | TBD-verify | TBD-verify | TBD-verify |
| **preview** (pnpm build && pnpm preview) | false | file: | CSP-A | TBD-verify | TBD-verify | TBD-verify |
| **packaged-app** (pnpm build:app + open .app) ⚠ HARD GATE | true | file: | CSP-A | TBD-verify | TBD-verify | TBD-verify |

`crossOriginIsolated` 实测 (期 false 三轨——`COMMON_WEB_PREFERENCES` 无 COOP/COEP): **TBD-verify**

**iframe verdict 枚举说明**：`blob-loaded-ok` / `frame-blob-blocked` / `iframe-throw` / `csp-blocks-inline`（独立侧记）。`frame-blob-blocked` 是 Phase 0 「**否+证据**」合法记录态（用户决议接受，对应 plan-v4 NEED-INFO-1）。

## 3. CSP / COOP-COEP 现状

- `frame-src`: **absent** → iframe blob fallback 到 `default-src 'self'`，blob: 被拦
- `worker-src`: **absent** → worker blob fallback 到 `child-src` 再 `default-src`，但 `script-src 'self' blob:` 优先适用 worker (script context)，预期可创建
- `crossOriginIsolated`: **TBD-verify**（COOP/COEP 未设；SAB 大概率 false）
- Phase 1 启动前需 follow-up topic 评估 `frame-src blob:` / `worker-src blob:` / COOP=`same-origin` + COEP=`require-corp`；**本 Phase 0 不改 CSP**。

## 4. Decision

- **Recommendation**: TBD-verify
  - 若 Worker (a) PASS + iframe (b) frame-blob-blocked (预期否+证据) + SAB (c) blocked → 推荐 **Phase 1 启动前 CSP follow-up topic**（frame-src + COOP/COEP）
  - 若 (a) 也 FAIL（worker 在 packaged CSP 下被拦）→ 推荐 **暂缓 Phase 1**，回退强化 option B + marketplace review
  - 若三轨结果不一致（dev/preview/packaged drift）→ 升 user 仲裁
- **Required follow-up**:
  - CSP follow-up topic（评估 frame-src/worker-src/COOP-COEP）
  - 若 Worker PASS：可启 Phase 1 RPC broker + Worker logic host 实施 topic
