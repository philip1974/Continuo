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
  MENU_COMMAND_IDS,
  MENU_HOTKEY_MAX,
  WINDOW_CHANNELS,
  WINDOW_VIEW_ACTIONS,
  type IpcWindowCreateInput,
  type WindowViewAction,
} from '../../shared/window-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  allocateWindowSeq,
  setRestoreAllWindowsOnLaunch,
} from '../persistence';
import { EXPLORER_FILE_NAME } from '../../shared/explorer-persistence-schema';
import { EXPLORER_CHANNELS } from '../../shared/persistence-channels';
import { broadcastToWindows } from '../lib/broadcast';
import { seedWindowFromWorkspaceSnapshot } from '../services/workspace-snapshot.service';
import {
  clearWindow as clearWindowRoot,
  getWorkspaceRoot,
  setWorkspaceRoot,
  workspaceRootEntries,
} from '../services/window-workspace-roots.service';
import {
  findWindowWithWorkspace,
  type WorkspaceWindowCandidate,
} from '../services/workspace-window-lookup.service';
import { clearWindow as clearEditorDocuments } from '../services/window-editor-documents.service';
import { codedError, errorMessage, thrownFields } from '../../shared/error-message';
import { mapNodeErrnoCode } from './fs/path-utils';
import { windowSeqCount } from '../services/window-seq.service';
import { WINDOW_BACKGROUND_COLORS } from '../../shared/window-background';
import { setMenuKeybindings } from '../menu-keybindings';
import { getWindowTheme, setWindowTheme } from '../services/window-theme.service';

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
  /** 重启应用:走正常退出流程(脏文件确认等),退出确定发生后再 relaunch(见 index.ts relaunchApp)。 */
  readonly relaunchApp: () => void;
  /** 重新加载窗口:与应用菜单 View → Reload(⌘R)同一的脏确认 + flush(见 index.ts reloadMainWindow)。 */
  readonly reloadWindow: (win: BrowserWindow) => void;
  /** 重建应用菜单(菜单命令的生效键位变化后;见 index.ts rebuildAppMenu)。 */
  readonly rebuildAppMenu: () => void;
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
 * seq 的历史持久化段 —— 漏写 fresh 即恢复成旧 workspace,见 index.ts MainWindowOpts.fresh),该文件夹有会话快照时
 * 改为按快照建段后非 fresh 打开(见 workspaceWindowOpts),不给则空白新窗。
 * renderer window.new IPC 与 main 的菜单 / Dock 菜单 / argv / open-file / 冷启动多目录(index.ts
 * openWorkspaceWindow)共用。调用方负责校验 workspace。
 */
export async function openWorkspaceWindowWith(
  createMainWindow: WindowIpcDeps['createMainWindow'],
  workspace?: string,
): Promise<void> {
  // 该文件夹已在某个主窗口打开 → 聚焦那个窗口,不再开第二个(VSCode 同)。
  if (workspace !== undefined && (await focusWindowWithWorkspace(workspace))) return;
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
  createMainWindow(await workspaceWindowOpts(windowSeq, workspace));
}

/**
 * 新主窗的打开参数(seq 已分配):给了 workspace 且快照表有这个文件夹 → main 先把快照写成该 seq 的窗口段,以非 fresh 打开
 *(renderer 按段恢复编辑器 / 展开 / 侧栏 / 搜索 / dock 布局,VSCode workspace storage 同),并广播置顶后的「最近打开」;
 * 没有快照 / explorer.json 缺失、损坏或读写失败 → 照旧 fresh。冷启动 dock 模式的 seq 0 同样经这里。
 * BDD: src/__tests__/workspace-snapshot/
 */
export async function workspaceWindowOpts(
  windowSeq: number,
  workspace?: string,
): Promise<{ windowSeq: number; workspace?: string; fresh?: boolean }> {
  if (workspace === undefined) return { windowSeq };
  const explorerFile = path.join(app.getPath('userData'), EXPLORER_FILE_NAME);
  let recentRoots: string[] | null = null;
  try {
    recentRoots = await seedWindowFromWorkspaceSnapshot(explorerFile, windowSeq, workspace);
  } catch (err) {
    console.warn('[window-ipc] workspace snapshot seed failed, opening fresh', err);
  }
  if (recentRoots === null) return { windowSeq, workspace, fresh: true };
  const payload = { recentRoots };
  broadcastToWindows(EXPLORER_CHANNELS.RECENT_CHANGED, () => payload, '[explorer] RECENT_CHANGED');
  return { windowSeq, workspace };
}

/**
 * 「文件夹已打开就聚焦那个窗口」(VSCode findWindowOnWorkspaceOrFolder → focus):在各主窗口当前 root 里找与 `root`
 * 同一目录(realpath + 平台语义比较)的窗口,找到则还原最小化并聚焦,返回 true。`excludeWindowId`:不把发起方自己算进去。
 * 关窗 / 退出流程中已隐藏的窗口不算(它马上消失,聚焦它等于没反应)。主窗打开文件夹的所有入口都经这里:
 * renderer 本窗口切换(window:focus-workspace-window)与新开窗口(openWorkspaceWindowWith)。
 */
export async function focusWindowWithWorkspace(root: string, excludeWindowId?: number): Promise<boolean> {
  const candidates: WorkspaceWindowCandidate[] = [];
  for (const [windowId, windowRoot] of workspaceRootEntries()) {
    if (windowId === excludeWindowId) continue;
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed() || (!win.isVisible() && !win.isMinimized())) continue;
    candidates.push({ windowId, root: windowRoot });
  }
  const id = await findWindowWithWorkspace(root, candidates);
  if (id === null) return false;
  const win = BrowserWindow.fromId(id);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.focus();
  return true;
}

const FocusWorkspaceWindowInput = z
  .object({
    root: z.string().min(1).max(ROOT_MAX),
  })
  .strict();

const SetRestoreWindowsInput = z.object({ enabled: z.boolean() }).strict();

const NotifyRootInput = z
  .object({
    root: z.string().nullable(),
  })
  .strict();

const CloseInput = z.object({}).strict();
const FocusInput = z.object({}).strict();
const RelaunchInput = z.object({}).strict();
const ViewActionInput = z.object({ action: z.enum(WINDOW_VIEW_ACTIONS) }).strict();
// 菜单命令的生效键位:键只限菜单命令 id(条数因此有界),值为归一后的 hotkey 或 null(未绑定 / 冲突落败)。
const SetMenuKeybindingsInput = z
  .object({ keybindings: z.partialRecord(z.enum(MENU_COMMAND_IDS), z.string().max(MENU_HOTKEY_MAX).nullable()) })
  .strict();

/** 缩放步长与 Electron 菜单 role zoomIn / zoomOut 相同(每次 ±0.5 级),resetZoom 归零。 */
const ZOOM_STEP = 0.5;

function applyWindowViewAction(win: BrowserWindow, action: WindowViewAction, reload: (win: BrowserWindow) => void): void {
  switch (action) {
    case 'reload':
      reload(win);
      return;
    case 'zoomIn':
      win.webContents.zoomLevel += ZOOM_STEP;
      return;
    case 'zoomOut':
      win.webContents.zoomLevel -= ZOOM_STEP;
      return;
    case 'resetZoom':
      win.webContents.zoomLevel = 0;
      return;
    case 'toggleFullScreen':
      win.setFullScreen(!win.isFullScreen());
      return;
  }
}

const NotifyThemeInput = z
  .object({
    theme: z.enum(['light', 'dark']),
    // 主题模式(可缺省):system 时 main 冷启动按 OS 当前外观决定首窗底色
    mode: z.enum(['light', 'dark', 'system']).optional(),
  })
  .strict();

/**
 * 新建主窗 / popout 用的底色:最近上报(冷启动时 = 上次持久化)主题的画布色
 * (VSCode ThemeMainService.getBackgroundColor 同思路,见 window-theme.service)。
 */
export function currentWindowBackgroundColor(): string {
  return WINDOW_BACKGROUND_COLORS[getWindowTheme()];
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
  // 本窗口要打开文件夹前问一句:已在别的主窗口打开 → 聚焦它、返回 true(发起方不再改自己的 root)。发起方当前打开的
  // 就是这个文件夹时返回 false(保持原行为),即使别的窗口也开着同一目录。
  safeHandleWithCtx(WINDOW_CHANNELS.FOCUS_WORKSPACE_WINDOW, FocusWorkspaceWindowInput, async (input, { event }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw codedError(ERROR_CODES.NO_WINDOW, 'no browser window');
    if (!path.isAbsolute(input.root)) return false;
    const own = getWorkspaceRoot(win.id);
    if (own !== null && (await findWindowWithWorkspace(input.root, [{ windowId: win.id, root: own }])) !== null) {
      return false;
    }
    return focusWindowWithWorkspace(input.root, win.id);
  });
  // 设置项「启动时恢复所有窗口」→ explorer.json 顶层启动偏好(main 启动恢复在任何 renderer 之前读)。
  safeHandle(WINDOW_CHANNELS.SET_RESTORE_WINDOWS, SetRestoreWindowsInput, async (input) => {
    await setRestoreAllWindowsOnLaunch(path.join(app.getPath('userData'), EXPLORER_FILE_NAME), input.enabled);
  });
  // 主题变化:记住(并持久化到 userData,供下次冷启动首窗)并把所有已开窗口(主窗 + popout)的底色改为对应画布色。
  safeHandle(WINDOW_CHANNELS.NOTIFY_THEME, NotifyThemeInput, (input) => {
    setWindowTheme(input);
    const color = WINDOW_BACKGROUND_COLORS[input.theme];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(color);
    }
  });
  // ⌘W 无可关面板 → 关闭发起方所在窗口。win.close()(非 destroy)触发 'close',走关窗脏确认 + flush。
  safeHandleWithCtx(WINDOW_CHANNELS.CLOSE, CloseInput, (_input, { event }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw codedError(ERROR_CODES.NO_WINDOW, 'no browser window');
    win.close();
  });
  // 命令面板的「重新加载窗口 / 缩放 / 全屏」(应用菜单 View 同款动作):作用于发起方所在窗口。
  safeHandleWithCtx(WINDOW_CHANNELS.VIEW_ACTION, ViewActionInput, (input, { event }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw codedError(ERROR_CODES.NO_WINDOW, 'no browser window');
    applyWindowViewAction(win, input.action, deps.reloadWindow);
  });
  // 菜单命令的生效键位(renderer 改键 / 解绑 / 命令注册变化后推送):有变化才重建菜单(accelerator 只作显示)。
  safeHandle(WINDOW_CHANNELS.SET_MENU_KEYBINDINGS, SetMenuKeybindingsInput, (input) => {
    if (setMenuKeybindings(input.keybindings)) deps.rebuildAppMenu();
  });
  // 激活发起方所在窗口(主窗 renderer 把面板 / 选择器打开在主窗、而系统焦点在 popout 子窗时 → 焦点随之进主窗)。
  safeHandleWithCtx(WINDOW_CHANNELS.FOCUS, FocusInput, (_input, { event }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw codedError(ERROR_CODES.NO_WINDOW, 'no browser window');
    win.focus();
  });
  // 「立即重启」(插件安装后):交给组合根走退出流程,不在这里直接 app.relaunch()/exit()(会绕过脏文件确认丢未保存内容)。
  safeHandle(WINDOW_CHANNELS.RELAUNCH_APP, RelaunchInput, () => {
    deps.relaunchApp();
  });
  // 窗口关闭清 map(防泄漏):工作区根、打开过的 Markdown 文档登记。
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      clearWindowRoot(win.id);
      clearEditorDocuments(win.id);
    });
  });
}
