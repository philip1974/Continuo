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
import type { AttachTarget } from './terminal-attach';
import type { ShellFamily } from '@continuo-terminal/shell-quote';

export interface TerminalSessionSnapshot {
  /** 后端 PTY id (term-${uuid}). */
  readonly id: string;
  /** Tab 显示名. */
  readonly title: string;
  /** PTY spawn 时的 cwd. */
  readonly cwd: string;
  /** session 来源:用户手开 / agent 通过 MCP 创建. */
  readonly originHint: OriginHint;
  /** agent 类型才填,如 'codex' / 'gemini'. */
  readonly agentLabel?: string;
  /** Scoped split-pane sessions are hidden from the legacy terminal tabs. */
  readonly scoped?: boolean;
  /** ms epoch. */
  readonly createdAt: number;
  /** null = PTY 仍在运行;number = 已 exit. */
  readonly exitCode: number | null;
  /** owner BrowserWindow.id(Issue #28:renderer 不自报,由 IPC create handler 推断). */
  readonly ownerWindowId: number;
  /** topic-05: agent attach hint;renderer 据此决定新 PTY 接管到哪个 panel/window. */
  readonly attachTarget?: AttachTarget;
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
}
