// Renderer 侧的 fs 类型再导出层。
// FileEntry 实际定义在 electron/shared/fs-entry.ts(主进程拥有,跨进程共享)。
// renderer 组件 import 时统一从这里走,避免散漂 electron/shared 路径。

export type { FileEntry } from '../../../electron/shared/fs-entry';
export type { IpcResult } from '../../../electron/shared/ipc-result';
