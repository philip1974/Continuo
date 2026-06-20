# ADR-Plugin-5 Phase 0 Spike Report

- **Status**: Proposed — Phase 0 verdict collected (2026-06-16, topic 46); Phase 1 RPC broker + Worker logic host authorized to start; iframe UI host (Phase 2) blocked on CSP follow-up
- topic 48 (2026-06-17): isPackaged 升级 user-attested → main-injected via webPreferences.additionalArguments; 缺 arg 返 null 保旧语义
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
| **dev** (pnpm dev) | pending Op7 verify | http: | CSP-A | ✅ ok 2.04ms | frame-blob-blocked (expected) | sab-construct-fail (SAB undefined) |
| **preview** (pnpm build && pnpm preview) | pending Op7 verify | file: | CSP-A | ✅ ok 1.34ms | frame-blob-blocked (expected) | sab-construct-fail (SAB undefined) |
| **packaged-app** (pnpm build:app + open .app) ⚠ HARD GATE | pending Op7 verify | file: | CSP-A | ✅ ok 0.96ms | frame-blob-blocked (expected) | sab-construct-fail (SAB undefined) |

`crossOriginIsolated` 实测 (期 false 三轨——`COMMON_WEB_PREFERENCES` 无 COOP/COEP): **false (三轨实测一致；印证无 COOP/COEP)**

**iframe verdict 枚举说明**：`blob-loaded-ok` / `frame-blob-blocked` / `iframe-throw` / `csp-blocks-inline`（独立侧记）。`frame-blob-blocked` 是 Phase 0 「**否+证据**」合法记录态（用户决议接受，对应 plan-v4 NEED-INFO-1）。

## 3. CSP / COOP-COEP 现状

- `frame-src`: **absent** → iframe blob fallback 到 `default-src 'self'`，blob: 被拦
- `worker-src`: **absent** → worker blob fallback 到 `child-src` 再 `default-src`，但 `script-src 'self' blob:` 优先适用 worker (script context)，预期可创建
- `crossOriginIsolated`: **false (三轨)**（COOP/COEP 未设；SAB 大概率 false）
- Phase 1 启动前需 follow-up topic 评估 `frame-src blob:` / `worker-src blob:` / COOP=`same-origin` + COEP=`require-corp`；**本 Phase 0 不改 CSP**。

## 4. Decision

- **Recommendation**: **(a) 启 Phase 1 RPC broker + Worker logic host** — Worker probe 在三轨 (dev/preview/packaged) 实测 PASS 0.96-2.04ms，证明 blob worker 在当前 packaged CSP 下可行；Phase 1 worker host 不需 frame-src/COOP-COEP 改造。iframe UI (Phase 2) + SAB 同步桥（如需）由后续 CSP follow-up topic 处理
  - 若 Worker (a) PASS + iframe (b) frame-blob-blocked (预期否+证据) + SAB (c) blocked → 推荐 **Phase 1 启动前 CSP follow-up topic**（frame-src + COOP/COEP）
  - 若 (a) 也 FAIL（worker 在 packaged CSP 下被拦）→ 推荐 **暂缓 Phase 1**，回退强化 option B + marketplace review
  - 若三轨结果不一致（dev/preview/packaged drift）→ 升 user 仲裁
- **Required follow-up**:
  - CSP follow-up topic（评估 frame-src/worker-src/COOP-COEP）
  - 若 Worker PASS：可启 Phase 1 RPC broker + Worker logic host 实施 topic
