// Diagnostics IPC(issue #33):breadcrumb + openLogsDir + relaunch。
// 三个 channel 都是 trusted-frame only,无业务输入校验只对必填字段轻量 zod。
//
// breadcrumb 失败静默 — 诊断辅助不能挂主流程。
// openLogsDir 用 shell.openPath;relaunch 走 app.relaunch + app.quit。

import { z } from 'zod';
import { app, shell } from 'electron';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { DIAGNOSTICS_CHANNELS } from '../../shared/diagnostics-channels';
import {
  appendBreadcrumb,
  getLogsDir,
} from '../lib/reload-breadcrumb';

// renderer 自由结构,但必须含 event:string;其余字段 passthrough。
const BreadcrumbInput = z
  .object({ event: z.string().min(1) })
  .passthrough();

const NoInput = z.object({}).strict();

export function registerDiagnosticsIpc(): void {
  safeHandle(
    DIAGNOSTICS_CHANNELS.BREADCRUMB,
    BreadcrumbInput,
    async (input) => {
      await appendBreadcrumb(input);
    },
    defaultIsTrustedFrame,
  );

  safeHandle(
    DIAGNOSTICS_CHANNELS.OPEN_LOGS_DIR,
    NoInput,
    async () => {
      const dir = getLogsDir();
      if (!dir) throw new Error('logs dir unavailable');
      const err = await shell.openPath(dir);
      if (err) throw new Error(`openPath failed: ${err}`);
    },
    defaultIsTrustedFrame,
  );

  safeHandle(
    DIAGNOSTICS_CHANNELS.RELAUNCH,
    NoInput,
    () => {
      app.relaunch();
      app.exit(0);
    },
    defaultIsTrustedFrame,
  );
}
