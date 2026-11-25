// 可维护性 M14:终端 session 的 renderer-visible 数据形态单一来源。
//
// 此前 main(MainTerminalSession)/ preload(PreloadTerminalSession)/ renderer
// (terminal.store.TerminalSession)各自手写同一组字段,已出现漂移(preload/main 有
// attachTarget,renderer 曾遗漏)。统一到此 DTO:
//   - preload 的 PreloadTerminalSession 与 renderer 的 TerminalSession 直接 = 本类型;
//   - main 的 MainTerminalSession 在此基础上追加 main-内部字段(controllerToken,绝不跨
//     IPC 给 renderer)。
// 新增 renderer 可见的 session 元数据只改这一处,三层自动同步。

import type { OriginHint } from './origin-hint';
import type { ShellFamily } from '@continuo-terminal/shell-quote';

export interface TerminalSessionSnapshot {
  /** 后端 PTY id (term-${uuid}). */
  readonly id: string;
  /** Tab 显示名;未显式命名时为英文稳定名 `Terminal N`(MCP list_sessions 原样给 agent). */
  readonly title: string;
  /**
   * 未显式命名时 main 分配的默认名序号 N(每窗口单调)。renderer 据此按当前语言显示「终端 N」,并随语言切换更新;
   * 显式命名的会话无此字段,按 title 原样显示。
   */
  readonly defaultTitleIndex?: number;
  /** PTY spawn 时的 cwd. */
  readonly cwd: string;
  /** session 来源:用户手开 / agent 通过 MCP 创建. */
  readonly originHint: OriginHint;
  /** agent 类型才填,如 'codex' / 'gemini'. */
  readonly agentLabel?: string;
  /** ms epoch. */
  readonly createdAt: number;
  /** null = PTY 仍在运行;number = 已 exit. */
  readonly exitCode: number | null;
  /** owner BrowserWindow.id(Issue #28:renderer 不自报,由 IPC create handler 推断). */
  readonly ownerWindowId: number;
  /**
   * 创建时所在 workspace.root;undefined = 全局会话(所有 workspace 都可见)。
   * 主进程只存,renderer 端按当前 workspaceRoot 过滤可见 sessions。
   */
  readonly workspaceRoot?: string;
  /**
   * 跨平台审计:PTY 实际 shell 的引号族(posix/cmd/powershell)。main 创建时按 shell
   * 路径算好,renderer 终端拖拽文件按此引用路径(取代按 navigator.platform 盲猜)。
   * undefined = 旧会话 / 未知,renderer 回退平台默认。
   */
  readonly shellFamily?: ShellFamily;
  /**
   * 用户在 tab 右键「重命名…」设的标题(VSCode TitleEventSource.Api):设了之后固定显示,不再被 OSC / 进程名覆盖;
   * 重命名为空 → 清除,回到自动标题。
   */
  readonly userTitle?: string;
  /** 前台正在运行的 shell 以外的程序名(node-pty `process`,VSCode `${process}`);只有 shell 时缺省。main 输出后节流刷新。 */
  readonly processName?: string;
  /** 程序经 OSC 0 / 2 设的窗口标题(VSCode `${sequence}`;renderer xterm onTitleChange 上报)。空标题 → 缺省。 */
  readonly sequenceTitle?: string;
}

/** 未命名终端的默认 title(英文稳定名,main 存储 / MCP 对外;renderer 显示用本地化名,见 defaultTitleIndex)。 */
export function defaultTerminalTitle(index: number): string {
  return `Terminal ${index}`;
}
