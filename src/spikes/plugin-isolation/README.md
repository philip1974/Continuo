# Spike: plugin-isolation (ADR-Plugin-5 Phase 0)

> Temporary feasibility spike for running plugins in a Worker / iframe. It is bundled as an isolated lazy chunk but gated off in packaged builds unless `CONTINUO_SPIKE=1` or `--spike` is set. Notes below are in Chinese.

承 ADR-Plugin-5 §7(维护者本地 `doc/adr/`,未公开)Phase 0 可行性验证。**临时 spike 代码，验完即删。**

## 触发

- **dev**：`pnpm dev` → 主窗口 DevTools console → `location.assign(location.origin + location.pathname + '?spike=plugin-isolation')`
- **preview**：`pnpm build && pnpm preview`(preview 非打包版,与 dev 一样直接放行) → 同上
- **packaged-app**：`pnpm build:app` → `open dist-electron/mac-arm64/Continuo.app --args --spike`(`open` 经 LaunchServices 启动,不继承 shell 环境变量,故用 `--spike` 参数) → 同上
- **不命中时**：主 app 正常起动；不加载 spike chunk（`pnpm build` 后手动运行 `node scripts/check-spike-isolation.mjs` 校验,未接入 CI:入口不 modulepreload main-app,且 main-app 与 spike 两个 chunk 互不引用）

## 三 probe

- [`worker-probe.ts`](./worker-probe.ts) — `new Worker(blobURL)` + ping/pong + CSP error catch
- [`iframe-probe.ts`](./iframe-probe.ts) — `iframe src=blob:` 加载 + sandbox 强校验 + 四态枚举（`blob-loaded-ok` / `frame-blob-blocked` / `iframe-throw` / `csp-blocks-inline`）
- [`sab-probe.ts`](./sab-probe.ts) — SAB+Atomics.wait 五态显式(ok + 四种失败) + `crossOriginIsolated` 实测

结果挂 `window.__continuoSpikeResult` 全局 + DOM `#continuo-spike-root` + console `[spike]`。结果矩阵填入维护者本地的 `doc/adr/ADR-Plugin-5-phase0-spike-report.md`。

## 何时删

Phase 0 决策门评估完成（启 Phase 1 / 暂缓 / CSP follow-up）后，本目录 + 配套 spec [`src/__tests__/45-plugin-isolation-spike/`](../../__tests__/45-plugin-isolation-spike/) + main wire（`electron/main/spike-gate.ts` 内 spike-only 逻辑）在启动 Phase 1 实现时一并清理。

## 安全约束

- `?spike=` 仅在 dev / preview,或打包版设了 `CONTINUO_SPIKE=1` 环境变量或带 `--spike` 参数时放行；packaged 默认由导航守卫拦下（[`electron/main/spike-gate.ts`](../../../electron/main/spike-gate.ts) `installSpikeGate`；主窗初始 query 由 main 自己构造,不含 `spike`）
- 主 app 副作用零触发：thin-entry router (`src/main.tsx`) 动态 import 互斥；`pnpm build` 后手动运行 `node scripts/check-spike-isolation.mjs` 验 spike chunk ⇎ main-app chunk 物理隔离(未接入 CI)
