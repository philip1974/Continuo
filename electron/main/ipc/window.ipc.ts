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
  type IpcWindowCreateResult,
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
import { codedError } from '../../shared/error-message';
import { windowSeqCount } from '../services/window-seq.service';

function summarizePath(p: string): string {
  return p.length > 60 ? p.slice(0, 50) + '...' : p;
}

// 边界(E34,E11/E33 同族):workspace root 路径长度上限(CreateInput.workspace 与 notify-root 的 root 共用)。root 经 notify-root
// 写入 windowId→root map 长期驻留主进程,并作为 MCP/terminal create 未传 cwd 时 agent session 的回退
// 工作目录;畸形超长 absolute 串会带进后续 resolve/stat 路径 + 错误消息 → 内存 + 同步 fs 检查开销。
const ROOT_MAX = 2048;

const CreateInput = z
  .object({
    workspace: z.string().min(1).max(ROOT_MAX).optional(),
  })
  .strict();

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
): Promise<IpcWindowCreateResult> {
  if (windowSeqCount() + windowsBeingCreated >= MAX_APP_WINDOWS) {
    throw codedError(ERROR_CODES.TOO_MANY_WINDOWS, `too many windows open (max ${MAX_APP_WINDOWS})`);
  }
  windowsBeingCreated += 1;
  try {
    return await createWindowNow(input, createMainWindow);
  } finally {
    windowsBeingCreated -= 1;
  }
}

async function createWindowNow(
  input: IpcWindowCreateInput,
  createMainWindow: WindowIpcDeps['createMainWindow'],
): Promise<IpcWindowCreateResult> {
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

  const explorerFile = path.join(app.getPath('userData'), EXPLORER_FILE_NAME);
  const newWindowSeq = await allocateWindowSeq(explorerFile);
  const win = createMainWindow({
    windowSeq: newWindowSeq,
    ...(input.workspace !== undefined
      ? { workspace: input.workspace, fresh: true }
      : {}),
  });
  return { windowId: win.id };
}

const NotifyRootInput = z
  .object({
    root: z.string().nullable(),
  })
  .strict();

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
  // 窗口关闭清 map(防泄漏)。
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => clearWindowRoot(win.id));
  });
}
