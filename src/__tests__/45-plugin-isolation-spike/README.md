# Topic 45 - Plugin True Isolation Phase0 Spike

关联设计：ADR-Plugin-5 §7，Phase0 只验证 renderer 侧隔离原语与 packaged gate，不把正式 plugin runtime 纳入本 topic。

本目录是 BDD-first 规格目录。实现文件在 Op3-7 才落盘，因此当前 spec 允许 pending/skip，但 spec 自身必须 type-clean。

## 规格分工

- `worker-probe.spec.ts`
  - 验证 blob Worker ping/pong 成功、CSP SecurityError、timeout、以及 CSP meta 读取。
- `iframe-probe.spec.ts`
  - 验证 iframe probe 四态：`blob-loaded-ok`、`frame-blob-blocked`、`iframe-throw`、`csp-blocks-inline`。
  - 额外强校验 sandbox 只能是单 token `allow-scripts`，且不能含 `allow-same-origin`。
- `sab-probe.spec.ts`
  - 验证 SharedArrayBuffer/Atomics probe 四个失败阶段与 `crossOriginIsolated` 记录。
  - 保证 `Atomics.wait` 只能在 worker 中执行。
- `spike-gate.spec.ts`
  - 验证 packaged spike gate：navigation guard、window-open guard、query strip、renderer query builder、allow reason。
  - 明确事件 wire 列表不能包含 `did-frame-navigate`。
- `thin-entry.spec.ts`
  - 验证 thin entry 在 spike route 与 normal route 下只加载对应模块。
  - 验证 `main-app.ts` 只有允许的顶层 statement 形态。

## 删除条件

当 Topic 45 Phase0 spike 被正式 runtime 设计取代，并且 ADR-Plugin-5 §7 的证据已迁移到正式 isolation 测试后，本目录应整体删除。

