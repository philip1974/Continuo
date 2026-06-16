# Spike: plugin-isolation (ADR-Plugin-5 Phase 0)

承 [ADR-Plugin-5 §7](../../../doc/adr/ADR-Plugin-5-true-isolation-roadmap.md) Phase 0 可行性验证。**临时 spike 代码，验完即删。**

## 触发

- **dev**：`pnpm dev` → 主窗口 DevTools console → `location.assign(location.origin + location.pathname + '?spike=plugin-isolation')`
- **preview**：`CONTINUO_SPIKE=1 pnpm build && CONTINUO_SPIKE=1 pnpm preview` → 同上
- **packaged-app**：`CONTINUO_SPIKE=1 pnpm build:app` → `CONTINUO_SPIKE=1 open dist-electron/mac-arm64/Continuo.app` → 同上
- **不命中时**：主 app 正常起动；spike chunk 不被 modulepreload（实测 [scripts/check-spike-isolation.mjs](../../../scripts/check-spike-isolation.mjs) 3-gate PASS）

## 三 probe

- [`worker-probe.ts`](./worker-probe.ts) — `new Worker(blobURL)` + ping/pong + CSP error catch
- [`iframe-probe.ts`](./iframe-probe.ts) — `iframe src=blob:` 加载 + sandbox 强校验 + 四态枚举（`blob-loaded-ok` / `frame-blob-blocked` / `iframe-throw` / `csp-blocks-inline`）
- [`sab-probe.ts`](./sab-probe.ts) — SAB+Atomics.wait 四态显式 + `crossOriginIsolated` 实测

结果挂 `window.__continuoSpikeResult` 全局 + DOM `#continuo-spike-root` + console `[spike]`。结果矩阵填入 [doc/adr/ADR-Plugin-5-phase0-spike-report.md](../../../doc/adr/ADR-Plugin-5-phase0-spike-report.md)。

## 何时删

Phase 0 决策门评估完成（启 Phase 1 / 暂缓 / CSP follow-up）后，本目录 + 配套 spec [`src/__tests__/45-plugin-isolation-spike/`](../../__tests__/45-plugin-isolation-spike/) + main wire（`electron/main/spike-gate.ts` 内 spike-only 逻辑）由 Phase 1 启动 topic 一并清理。

## 安全约束

- `?spike=` 仅 dev 或 `CONTINUO_SPIKE=1` 时放行；packaged 默认两道防线齐拦（[`electron/main/spike-gate.ts`](../../../electron/main/spike-gate.ts) `installSpikeGate` + `stripSpikeQuery`）
- 主 app 副作用零触发：thin-entry router (`src/main.tsx`) 动态 import 互斥；`pnpm build` 后 `scripts/check-spike-isolation.mjs` 验 spike chunk ⇎ main-app chunk 物理隔离
