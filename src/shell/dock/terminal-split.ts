// 拆分终端(VSCode workbench.action.terminal.split「拆分终端」):在父终端旁新建一个终端,焦点进新终端。
// Continuo 的终端是 dock 面板、窗格 = 显示终端的 dock 组(见 terminal-focus-cycle):父终端在主窗 grid → 向右拆出新组;
// 在 popout 子窗 / 浮动组 → 加进父终端的组(留在该窗口;dockview 的 popout 窗口只有一个组)。落点由 DockReconciler 认领
//(expectSplitTerminal)。新终端的 cwd 同 VSCode terminal.integrated.splitCwd 默认 `inherited`:父终端当前目录(main 端
// terminal.cwd:OSC 7 上报的目录;shell 未上报时为 shell 进程的真实当前目录,同 VSCode TerminalProcess.getCwd 的 mac lsof /
// Linux /proc;再取不到 → 其初始目录),都没有 → 工作区根。
// 父终端:焦点所在 → 触发窗口的活动终端 → 最近使用的终端;窗口里没有终端 → 新建终端(VSCode 此时 no-op,其菜单项按
// terminalIsOpen 置灰;本项目菜单 / 命令面板不置灰,按「新建」兑现)。
// BDD: src/__tests__/terminal-split/

import { coApi } from '@/lib/co-api';
import { getIndexedTerminalSessionById, useTerminalStore } from '@/stores/terminal.store';
import { createUserTerminal } from './create-user-terminal';
import { getDockApi } from './dock-api-ref';
import { expectSplitTerminal } from './DockReconciler';
import { getCommandDocument } from './popout-documents';
import { currentTerminalInWindow } from './terminal-focus-cycle';
import { sessionIdFromPanel } from './terminal-panel-id';

/** 拆分指定的终端面板(终端右键菜单);返回新终端 id(失败 / 面板不存在 null)。 */
export async function splitTerminalPanel(panelId: string): Promise<string | null> {
  const panel = getDockApi()?.getPanel(panelId);
  const sessionId = panel ? sessionIdFromPanel(panel) : null;
  if (!panel || sessionId === null) return null;
  const settle = expectSplitTerminal(panel.id);
  let id: string | null = null;
  try {
    const cwd = await inheritedCwd(sessionId);
    id = await createUserTerminal(cwd ? { cwd } : {});
  } finally {
    settle(id);
  }
  return id;
}

/** 父终端的当前目录(见文件头);main 查询失败 → 会话 cwd(OSC 7 上报值或初始目录);空 → undefined。 */
async function inheritedCwd(sessionId: string): Promise<string | undefined> {
  try {
    const r = await coApi.terminal.cwd(sessionId);
    if (r.ok) return r.data.cwd || undefined;
  } catch {
    // IPC 失败:回退会话 cwd
  }
  return getIndexedTerminalSessionById(useTerminalStore.getState().sessions, sessionId)?.cwd || undefined;
}

/** workbench.action.terminal.split:拆分触发窗口的当前终端;没有终端 → 新建。 */
export function splitActiveTerminal(): Promise<string | null> {
  const api = getDockApi();
  const parent = api ? currentTerminalInWindow(api, getCommandDocument()) : undefined;
  return parent ? splitTerminalPanel(parent.id) : createUserTerminal();
}
