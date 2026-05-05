# integration/ — Nous 联动占位

本目录在 **Nous 联动里程碑启动前保持空**。

Continuo 当前定位是独立 Electron + React + motion 桌面壳;
将来与 [Nous](https://github.com/) AI Agent 平台联动时,适配代码统一放这里,
不污染 `panels/` / `shell/` / `stores/`。

## 计划放什么

- `nous-bridge.ts`:实现 Nous 协议 `IAgentShell.filesystem` 适配器,
  把本工程 `window.api.fs.*`(Step 2 后存在)桥成 Nous 端口形态。
- `shared-context.store.ts`:跨进程共享状态(workingDir / selectedFile),
  用 `zustand/vanilla` 创建,Nous 主进程可直接订阅(参考 Nous CLI 的
  `agent-loop-ui-store.ts` 模式)。
- `nous-channel-map.ts`:抄 Nous `domain:action` IPC 命名,
  与 `electron/main/ipc.ts` 通道命名对齐。

## 设计原则

- **联动方向**:Continuo 是 Electron 宿主,Nous Agent 作为 panel 嵌入
  (Scenario A,详见对话档案与 doc/08 § Nous 联动预留)。
- **底层零依赖**:本目录不允许 import `electron/`,只能间接通过
  `window.api` 与 `src/stores/`(VSCode 风:渲染层不直接走 Node)。
- **Nous 联动可降级**:Continuo 单独运行时本目录不被引用,
  联动失败不影响壳本体可用性。

## 何时落地

资源管理器(M-Explorer)与 markdown 编辑器(M-Editor)走通后,
启动 M-NousBridge 里程碑时再加文件。
