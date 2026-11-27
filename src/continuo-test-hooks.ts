// renderer 在 e2e 环境挂到 window.__continuoTest 的测试钩子(main-app 实现;tests/e2e 经全局声明使用同一类型,
// 不再在各用例里重写签名)。只含类型,不引运行时依赖。
import type { PermissionKey } from '../electron/shared/permission-keys';

export interface ContinuoTestHooks {
  openOrFocusPanel: (id: string, component: string, title: string) => void;
  focusPanel: (id: string) => void;
  setEditorContent: (tabId: string, content: string) => void;
  getEditorActiveTabId: () => string | null;
  setSettingValue: (id: string, value: string | number | boolean) => void;
  getSettingValue: (id: string) => unknown;
  /** 触发权限弹窗(plugin install 流程的核心交互). */
  // 可维护性 M9:复用真实权限键类型(与 promptStore.request 契约一致),不再用更宽的
  // string[] + impl 处 `as never` 掩盖非法键。
  requestPermissions: (
    pluginId: string,
    perms: readonly PermissionKey[],
  ) => Promise<readonly PermissionKey[]>;
  /** 命令数量(用于 e2e 验证内置命令注册数). */
  commandCount: () => number;
  /** 执行已注册命令(用于 e2e 走真实 command fn,不绕业务实现). */
  executeCommand: (commandId: string) => Promise<boolean>;
  /** 注册命令(测试动态命令出现).返 dispose. */
  registerCommand: (
    id: string,
    title: string,
    hotkey?: string,
  ) => () => void;
  /** 改 keybindings override(测试 hotkey 显示更新). */
  setHotkey: (commandId: string, hotkey: string) => void;
  /** 活动 dock 面板是终端 → 其缓冲区文本;否则 null(WebGL 渲染时 DOM 里读不到终端文字)。 */
  readActiveTerminalText: () => string | null;
  /** 活动 dock 面板是终端 → 其视口位置(viewportY / baseY / 是否备用屏);否则 null。 */
  readActiveTerminalViewport: () => { viewportY: number; baseY: number; alternate: boolean } | null;
}
