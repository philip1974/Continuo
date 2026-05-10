// Window IPC 注册(多窗口支持,issue #23)。
// renderer 通过 coApi.window.create 在已有 main process 内开新主窗口。
// Phase 2B:从 explorer.json 异步算 newWindowSeq,query string 注入,renderer 据此
// 持久化到自己段(windows[seq]),实现多窗状态隔离。

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  WINDOW_CHANNELS,
  type IpcWindowCreateInput,
  type IpcWindowCreateResult,
} from '../../shared/window-channels';
import { createMainWindow } from '../index';
import { loadExplorer } from '../persistence';

const CreateInput = z
  .object({
    workspace: z.string().min(1).max(2048).optional(),
  })
  .strict();

/**
 * 从磁盘 explorer.json 算下一个 windowSeq:
 *   max(nextWindowSeq, max(windows[*].windowSeq)+1, 1)
 *
 * 1 是下限 — 主窗永远占 0,新窗最小从 1 起。
 *
 * 每次创建窗口前重读磁盘,因为多个 renderer 都可能写 explorer.json,main 端
 * 不维护 in-memory counter 避免与磁盘状态漂移。
 */
async function nextWindowSeqFromDisk(file: string): Promise<number> {
  const data = await loadExplorer(file);
  if (!data) return 1;
  const fromWindows = data.windows.reduce(
    (m, w) => Math.max(m, w.windowSeq + 1),
    1,
  );
  return Math.max(data.nextWindowSeq, fromWindows);
}

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
  const newWindowSeq = await nextWindowSeqFromDisk(explorerFile);
  const win = createMainWindow({
    windowSeq: newWindowSeq,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  });
  return { windowId: win.id };
}

export function registerWindowIpc(): void {
  safeHandle(
    WINDOW_CHANNELS.CREATE,
    CreateInput,
    createWindowHandler,
    defaultIsTrustedFrame,
  );
}
