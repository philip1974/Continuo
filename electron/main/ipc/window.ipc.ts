// Window IPC 注册(多窗口支持,issue #23)。
// renderer 通过 coApi.window.create 在已有 main process 内开新主窗口。
// Phase 2B:从 explorer.json 异步算 newWindowSeq,query string 注入,renderer 据此
// 持久化到自己段(windows[seq]),实现多窗状态隔离。

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  WINDOW_CHANNELS,
  type IpcWindowCreateInput,
  type IpcWindowCreateResult,
} from '../../shared/window-channels';
import { createMainWindow } from '../index';
import { allocateWindowSeq } from '../persistence';
import {
  clearWindow as clearWindowRoot,
  setWorkspaceRoot,
} from '../services/window-workspace-roots.service';

function summarizePath(p: string): string {
  return p.length > 60 ? p.slice(0, 50) + '...' : p;
}

const CreateInput = z
  .object({
    workspace: z.string().min(1).max(2048).optional(),
  })
  .strict();

async function createWindowHandler(
  input: IpcWindowCreateInput,
): Promise<IpcWindowCreateResult> {
  if (input.workspace !== undefined) {
    // 安全 + 健壮性校验:必须 absolute,实际存在的目录。
    // 防 renderer 注入相对路径 / 不存在的路径让新窗口启不来。
    if (!path.isAbsolute(input.workspace)) {
      throw Object.assign(
        new Error(`workspace must be absolute path: ${input.workspace}`),
        { code: 'WORKSPACE_NOT_ABSOLUTE' },
      );
    }
    let stat;
    try {
      stat = fs.statSync(input.workspace);
    } catch {
      throw Object.assign(
        new Error(`workspace not found: ${input.workspace}`),
        { code: 'WORKSPACE_NOT_FOUND' },
      );
    }
    if (!stat.isDirectory()) {
      throw Object.assign(
        new Error(`workspace not a directory: ${input.workspace}`),
        { code: 'WORKSPACE_NOT_DIRECTORY' },
      );
    }
  }

  const explorerFile = path.join(app.getPath('userData'), 'explorer.json');
  const newWindowSeq = await allocateWindowSeq(explorerFile);
  const win = createMainWindow({
    windowSeq: newWindowSeq,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  });
  return { windowId: win.id };
}

const NotifyRootInput = z
  .object({
    root: z.string().nullable(),
  })
  .strict();

export function registerWindowIpc(): void {
  safeHandle(
    WINDOW_CHANNELS.CREATE,
    CreateInput,
    createWindowHandler,
    defaultIsTrustedFrame,
  );
  // workspace.root 变化时 renderer 推送 → main 维护 map,供 MCP agent terminal
  // 路径 cwd 回退使用。main 端做 absolute + 非空校验; renderer 不可信.
  // 这是输入卫生 (input sanitation), 不是安全边界 — main 只存 cwd hint。
  ipcMain.handle(
    WINDOW_CHANNELS.NOTIFY_ROOT,
    (event: IpcMainInvokeEvent, raw: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const parsed = NotifyRootInput.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          '[window-ipc] notifyRoot BAD_INPUT win=%s',
          win?.id,
          parsed.error.issues,
        );
        return {
          ok: false as const,
          code: 'BAD_INPUT' as const,
          message: 'invalid input shape',
        };
      }
      const root = parsed.data.root;
      if (root !== null && (root === '' || !path.isAbsolute(root))) {
        console.warn(
          '[window-ipc] notifyRoot BAD_ROOT win=%s root=%s',
          win?.id,
          summarizePath(root),
        );
        return {
          ok: false as const,
          code: 'BAD_ROOT' as const,
          message: 'root must be absolute non-empty path',
        };
      }
      if (!win) {
        return {
          ok: false as const,
          code: 'NO_WINDOW' as const,
          message: 'no browser window',
        };
      }
      setWorkspaceRoot(win.id, root);
      return { ok: true as const };
    },
  );
  // 窗口关闭清 map(防泄漏)。
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => clearWindowRoot(win.id));
  });
}
