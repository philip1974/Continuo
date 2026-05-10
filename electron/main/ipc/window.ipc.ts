// Window IPC 注册(多窗口支持,issue #23 Phase 1)。
// renderer 通过 coApi.window.create 在已有 main process 内开新主窗口。

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  WINDOW_CHANNELS,
  type IpcWindowCreateInput,
  type IpcWindowCreateResult,
} from '../../shared/window-channels';
import { createMainWindow } from '../index';

const CreateInput = z
  .object({
    workspace: z.string().min(1).max(2048).optional(),
  })
  .strict();

function createWindowHandler(input: IpcWindowCreateInput): IpcWindowCreateResult {
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

  const win = createMainWindow({ workspace: input.workspace });
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
