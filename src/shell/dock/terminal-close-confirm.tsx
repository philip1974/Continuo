// 关闭仍有子程序在跑的终端前确认(VSCode terminal.integrated.confirmOnKill 默认 editor:编辑区终端有子进程时确认)。
// terminalCloseGuard 挂在 wrapPanelClose 的关闭守卫上:× / 中键 / Delete / ⌘W(closeActiveEditor)/ 任何 api.close()
// 都经过这里。确认框由 DockShell 渲染的 TerminalKillConfirmHost 显示(守卫在 React 之外被调用,经 store 交接)。
// BDD: src/__tests__/terminal-vscode-parity/

import type { IDockviewPanel } from 'dockview-react';
import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { getIndexedTerminalSessionById, useTerminalStore } from '@/stores/terminal.store';
import { sessionIdFromPanel } from './terminal-panel-id';

interface PendingKill {
  readonly title: string;
  readonly process: string;
  readonly resolve: (confirmed: boolean) => void;
}

export const useTerminalKillConfirmStore = create<{ pending: PendingKill | null }>(() => ({
  pending: null,
}));

function askKillConfirm(title: string, process: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 已有一个在等(另一终端的关闭):先按取消结束它,只保留最新一次询问。
    useTerminalKillConfirmStore.getState().pending?.resolve(false);
    useTerminalKillConfirmStore.setState({ pending: { title, process, resolve } });
  });
}

type GuardPanel = Pick<IDockviewPanel, 'params'> & {
  readonly view: { readonly contentComponent: string };
  readonly api: Pick<IDockviewPanel['api'], 'id' | 'title'>;
};

/**
 * 面板关闭守卫:非终端 / 会话已退出或不存在 → 同步放行;否则问 main 前台是否有 shell 以外的程序,有则确认。
 * 查询失败一律放行(确认只是保护,不能让终端关不掉)。
 */
export function terminalCloseGuard(panel: GuardPanel): boolean | Promise<boolean> {
  if (panel.view.contentComponent !== TERMINAL_PANEL_TYPE) return true;
  const sessionId = sessionIdFromPanel(panel);
  if (!sessionId) return true;
  const session = getIndexedTerminalSessionById(useTerminalStore.getState().sessions, sessionId);
  if (!session || session.exitCode !== null) return true;
  return coApi.terminal.runningProcess(sessionId).then(
    (r) => (r.ok && r.data.process ? askKillConfirm(panel.api.title ?? '', r.data.process) : true),
    () => true,
  );
}

/** DockShell 挂载一次:显示终端关闭确认框(破坏性,初始焦点在取消)。 */
export function TerminalKillConfirmHost() {
  const t = useT();
  const pending = useTerminalKillConfirmStore((s) => s.pending);
  const settle = (confirmed: boolean) => {
    useTerminalKillConfirmStore.setState({ pending: null });
    pending?.resolve(confirmed);
  };
  return (
    <ConfirmDialog
      open={pending !== null}
      title={t('panels.terminal.kill_confirm.title')}
      description={
        pending ? t('panels.terminal.kill_confirm.detail', { process: pending.process, title: pending.title }) : ''
      }
      confirmLabel={t('panels.terminal.kill_confirm.confirm')}
      destructive
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
