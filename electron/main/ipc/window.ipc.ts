// Window IPC 注册(多窗口支持,issue #23)。
// renderer 通过 coApi.window.create 在已有 main process 内开新主窗口。
// Phase 2B:从 explorer.json 异步算 newWindowSeq,query string 注入,renderer 据此
// 持久化到自己段(windows[seq]),实现多窗状态隔离。

import { z } from 'zod';
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { safeHandle, safeHandleWithCtx } from '../safe-handle';
import { statDirGated } from '../lib/dir-stat-gate';
import {
  WINDOW_CHANNELS,
  type IpcWindowCreateInput,
} from '../../shared/window-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  allocateWindowSeq,
} from '../persistence';
import { EXPLORER_FILE_NAME } from '../../shared/explorer-persistence-schema';
import {
  clearWindow as clearWindowRoot,
  setWorkspaceRoot,
} from '../services/window-workspace-roots.service';
import { codedError, errorMessage, thrownFields } from '../../shared/error-message';
import { mapNodeErrnoCode } from './fs/path-utils';
import { windowSeqCount } from '../services/window-seq.service';
import { WINDOW_BACKGROUND_COLORS, type ResolvedTheme } from '../../shared/window-background';

function summarizePath(p: string): string {
  return p.length > 60 ? p.slice(0, 50) + '...' : p;
}

import { ROOT_MAX, WindowCreateInputSchema as CreateInput } from '../../shared/window-create-schema';

export { ROOT_MAX };

/**
 * 开窗函数由组合根(main/index.ts)注入,不从 '../index' 导入 —— 否则形成
 * index → ipc → ipc/window.ipc → index 的循环导入(index 是带大量启动副作用的入口模块)。
 */
export interface WindowIpcDeps {
  readonly createMainWindow: (opts: {
    windowSeq: number;
    workspace?: string;
    fresh?: boolean;
  }) => { readonly id: number };
}

// 边界(数量上限):renderer 发起的新建窗口(「新建窗口」命令 / 在新窗口打开文件夹)此前无上限。第三方插件经
// app.commands.execute('window.new') 循环即可开窗,而每个新窗口都会重新加载该插件 → 指数扩张。全局主窗口数
// (含正在创建的)达到上限即拒绝(TOO_MANY_WINDOWS)。取用户实际不会碰到的值;启动恢复 / 系统「打开文件夹」等
// 非 renderer 入口不经此 handler。
export const MAX_APP_WINDOWS = 32;
let windowsBeingCreated = 0;

async function createWindowHandler(
  input: IpcWindowCreateInput,
  createMainWindow: WindowIpcDeps['createMainWindow'],
): Promise<void> {
  if (windowSeqCount() + windowsBeingCreated >= MAX_APP_WINDOWS) {
    throw codedError(ERROR_CODES.TOO_MANY_WINDOWS, `too many windows open (max ${MAX_APP_WINDOWS})`);
  }
  windowsBeingCreated += 1;
  try {
    await createWindowNow(input, createMainWindow);
  } finally {
    windowsBeingCreated -= 1;
  }
}

async function createWindowNow(
  input: IpcWindowCreateInput,
  createMainWindow: WindowIpcDeps['createMainWindow'],
): Promise<void> {
  if (input.workspace !== undefined) {
    // 安全 + 健壮性校验:必须 absolute,实际存在的目录。
    // 防 renderer 注入相对路径 / 不存在的路径让新窗口启不来。
    if (!path.isAbsolute(input.workspace)) {
      throw codedError(ERROR_CODES.WORKSPACE_NOT_ABSOLUTE, `workspace must be absolute path: ${input.workspace}`);
    }
    // 性能:异步 stat —— 网络盘 / 休眠外置盘 / 失联挂载点上同步 stat 可卡数秒,冻结所有窗口的 IPC 与 PTY 输出。
    // 经全局目录判定闸:并发打开多个失联路径时不占满 libuv 线程池(其余 fs.promises 不排队)。
    let stat;
    try {
      stat = await statDirGated(input.workspace);
    } catch {
      throw codedError(ERROR_CODES.WORKSPACE_NOT_FOUND, `workspace not found: ${input.workspace}`);
    }
    if (!stat.isDirectory()) {
      throw codedError(ERROR_CODES.WORKSPACE_NOT_DIRECTORY, `workspace not a directory: ${input.workspace}`);
    }
  }

  await openWorkspaceWindowWith(createMainWindow, input.workspace);
}

/**
 * 开一个新主窗的单一规则:分配新 windowSeq;给了 workspace 则以它为 root 且 fresh(用户显式打开,不沿用该
 * seq 的历史持久化段 —— 漏写 fresh 即恢复成旧 workspace,见 index.ts MainWindowOpts.fresh),不给则空白新窗。
 * renderer window.new IPC 与 main 的菜单 / Dock 菜单 / argv / open-file / 冷启动多目录(index.ts
 * openWorkspaceWindow)共用。调用方负责校验 workspace。
 */
export async function openWorkspaceWindowWith(
  createMainWindow: WindowIpcDeps['createMainWindow'],
  workspace?: string,
): Promise<void> {
  const explorerFile = path.join(app.getPath('userData'), EXPLORER_FILE_NAME);
  let windowSeq: number;
  try {
    windowSeq = await allocateWindowSeq(explorerFile);
  } catch (err) {
    // 读写 explorer.json 的 node errno(ENOSPC / EACCES …)归到 FS_* 业务码:renderer window.create 的 notify 与
    // main 菜单路径(runWindowOpen)按同一 code 本地化,否则命令面板「新建窗口」失败只显示英文 errno 原文。
    const { code } = thrownFields(err);
    if (code !== undefined && Object.hasOwn(ERROR_CODES, code)) throw err;
    throw codedError(mapNodeErrnoCode(err), errorMessage(err));
  }
  createMainWindow(workspace === undefined ? { windowSeq } : { windowSeq, workspace, fresh: true });
}

const NotifyRootInput = z
  .object({
    root: z.string().nullable(),
  })
  .strict();

const NotifyThemeInput = z
  .object({
    theme: z.enum(['light', 'dark']),
  })
  .strict();

// 最近一次 renderer 上报的主题(主题设置所有窗口共享)。进程冷启动、尚无上报时 = 默认主题(dark)。
let windowTheme: ResolvedTheme = 'dark';

/** 新建主窗 / popout 用的底色:最近上报主题的画布色(VSCode ThemeMainService.getBackgroundColor 同思路)。 */
export function currentWindowBackgroundColor(): string {
  return WINDOW_BACKGROUND_COLORS[windowTheme];
}

export function registerWindowIpc(deps: WindowIpcDeps): void {
  safeHandle(
    WINDOW_CHANNELS.CREATE,
    CreateInput,
    (input) => createWindowHandler(input, deps.createMainWindow),
  );
  // workspace.root 变化时 renderer 推送 → main 维护 map,供 MCP agent terminal 路径 cwd 回退使用。
  // 这个 cwd hint 会成为 MCP/terminal create 未显式传 cwd 时 agent session 的回退工作目录,被污染会让
  // agent 的读写/安装/git 落到错误目录 —— 与兄弟入口一样走通用外壳(trusted-frame → bounded → zod),
  // 归属窗口由 main 从 sender 推断。
  safeHandleWithCtx(WINDOW_CHANNELS.NOTIFY_ROOT, NotifyRootInput, (input, { event }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const root = input.root;
    // 边界(E34):root 非空时须 absolute 且 ≤ROOT_MAX(防超长串驻留 map + 带进 cwd 回退路径)。
    if (root !== null && (root === '' || root.length > ROOT_MAX || !path.isAbsolute(root))) {
      console.warn('[window-ipc] notifyRoot BAD_ROOT win=%s root=%s', win?.id, summarizePath(root));
      throw codedError(ERROR_CODES.BAD_ROOT, 'root must be absolute non-empty path');
    }
    if (!win) throw codedError(ERROR_CODES.NO_WINDOW, 'no browser window');
    setWorkspaceRoot(win.id, root);
  });
  // 主题变化:记住并把所有已开窗口(主窗 + popout)的底色改为对应画布色。
  safeHandle(WINDOW_CHANNELS.NOTIFY_THEME, NotifyThemeInput, (input) => {
    windowTheme = input.theme;
    const color = WINDOW_BACKGROUND_COLORS[windowTheme];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(color);
    }
  });
  // 窗口关闭清 map(防泄漏)。
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => clearWindowRoot(win.id));
  });
}
