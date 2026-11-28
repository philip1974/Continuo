// Shell IPC 注册(plugin app.shell.exec 后端 + LM UI 跳转外链)。

import { z } from 'zod';
import { safeHandle, safeHandleWithCtx } from '../safe-handle';
import { SHELL_CHANNELS } from '../../shared/shell-channels';
import { attachShellExecWcGoneHook, execShell, openExternalUrl } from '../services/shell.service';
import { killPluginShellProcesses } from '../lib/plugin-shell-children';
import { PLUGIN_ID_MAX_LEN } from '../../shared/permission-record-limits';
import { ShellExecInputSchema as ExecInput } from '../../shared/shell-exec-schema';
import { MAX_EXTERNAL_URL_LEN } from '../../shared/url-limits';
import { BrowserWindow, type WebContents } from 'electron';
import {
  DEFAULT_TRUSTED_DOMAINS,
  TRUSTED_DOMAINS_MAX,
  TRUSTED_DOMAIN_MAX_LEN,
} from '../../shared/trusted-domains';
import {
  getUserTrustedDomains,
  onUserTrustedDomainsChanged,
  setUserTrustedDomains,
} from '../services/trusted-domains.service';
import { broadcastToWindows } from '../lib/broadcast';

const KillPluginProcessesInput = z
  .object({ pluginId: z.string().min(1).max(PLUGIN_ID_MAX_LEN) })
  .strict();

const OpenExternalInput = z
  .object({
    // 边界(E190 收口):外链长度上限用共享 MAX_EXTERNAL_URL_LEN(与 windowOpenHandler / Markdown 外链同源)。
    url: z.string().min(1).max(MAX_EXTERNAL_URL_LEN),
  })
  .strict();

const SetTrustedDomainsInput = z
  .object({ domains: z.array(z.string().max(TRUSTED_DOMAIN_MAX_LEN)).max(TRUSTED_DOMAINS_MAX) })
  .strict();

/** 确认框挂在哪个窗口:获焦窗口(点击发生在 popout 子窗时就是它,子窗界面由主窗 renderer 驱动),否则发送方窗口。 */
function dialogParent(sender: WebContents): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() ? focused : BrowserWindow.fromWebContents(sender);
}

export function registerShellIpc(): void {
  // 归属登记用 main 侧的发送方 webContents id(非 renderer 自报)。
  safeHandleWithCtx(
    SHELL_CHANNELS.EXEC,
    ExecInput,
    (input, { event }) => {
      // 窗口关闭 / 整页重载时回收该 sender 的 exec(终审 P1)。
      attachShellExecWcGoneHook(event.sender);
      return execShell(input, event.sender.id);
    },
  );
  // 终审 P1:插件停用/卸载 → 终止发送方窗口内该插件的全部 shell 进程(exec + 流式);
  // 范围限定在发送方 webContents 自己的进程,不能终止别的窗口的。
  safeHandleWithCtx(
    SHELL_CHANNELS.KILL_PLUGIN_PROCESSES,
    KillPluginProcessesInput,
    ({ pluginId }, { event }) => killPluginShellProcesses(event.sender.id, pluginId),
  );
  safeHandleWithCtx(SHELL_CHANNELS.OPEN_EXTERNAL, OpenExternalInput, (input, { event }) =>
    openExternalUrl(input, dialogParent(event.sender)),
  );
  safeHandle(SHELL_CHANNELS.TRUSTED_DOMAINS_GET, z.undefined(), async () => ({
    user: await getUserTrustedDomains(),
    defaults: DEFAULT_TRUSTED_DOMAINS,
  }));
  safeHandle(SHELL_CHANNELS.TRUSTED_DOMAINS_SET, SetTrustedDomainsInput, ({ domains }) => setUserTrustedDomains(domains));
  onUserTrustedDomainsChanged((list) =>
    broadcastToWindows(SHELL_CHANNELS.TRUSTED_DOMAINS_CHANGED, () => list, '[shell] TRUSTED_DOMAINS_CHANGED'),
  );
}
