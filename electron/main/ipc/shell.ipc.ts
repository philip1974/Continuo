// Shell IPC 注册(plugin app.shell.exec 后端)。

import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { SHELL_CHANNELS } from '../../shared/shell-channels';
import { execShell } from '../services/shell.service';

const ExecInput = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    input: z.string().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict();

export function registerShellIpc(): void {
  safeHandle(SHELL_CHANNELS.EXEC, ExecInput, execShell, defaultIsTrustedFrame);
}
