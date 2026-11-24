// 关闭仍有子程序在跑的终端前确认(VSCode terminal.integrated.confirmOnKill 默认 editor:编辑区终端有子进程时确认)。
// terminalCloseGuard 挂在 wrapPanelClose 的关闭守卫上:× / 中键 / Delete / ⌘W(closeActiveEditor)/ 任何 api.close()
// 都经过这里。确认框由 DockShell 渲染的 TerminalKillConfirmHost 显示(守卫在 React 之外被调用,经 store 交接);
// 终端在 dockview popout 子窗时经 createPortal 画进该子窗文档(design Modal 不 portal,画在主窗则子窗里看不到),
// 同 TerminalContextMenu 按面板所在文档挂 portal。不放进面板内容:被关的可能是组里未激活(隐藏)的 tab。
// BDD: src/__tests__/terminal-vscode-parity/

import type { IDockviewPanel } from 'dockview-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';
import { getIndexedTerminalSessionById, useTerminalStore } from '@/stores/terminal.store';
import { sessionIdFromPanel } from './terminal-panel-id';
import { getPopoutDocuments, subscribePopoutDocuments } from './popout-documents';

interface PendingKill {
  readonly panelId: string;
  /** 询问时面板所在文档(popout 子窗的 document 或主窗 document)。 */
  readonly doc: Document;
  readonly title: string;
  readonly process: string;
  readonly resolve: (confirmed: boolean) => void;
}

export const useTerminalKillConfirmStore = create<{ pending: PendingKill | null }>(() => ({
  pending: null,
}));

function askKillConfirm(ask: Omit<PendingKill, 'resolve'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // 已有一个在等(另一终端的关闭):先按取消结束它,只保留最新一次询问。
    useTerminalKillConfirmStore.getState().pending?.resolve(false);
    useTerminalKillConfirmStore.setState({ pending: { ...ask, resolve } });
  });
}

// 每个面板进行中的守卫(查子进程 → 确认)的令牌:cancelTerminalCloseGuard 删掉后,查询回来不再弹确认框。
const inflightGuards = new Map<string, object>();

type GuardPanel = Pick<IDockviewPanel, 'params'> & {
  readonly view: { readonly contentComponent: string };
  readonly api: Pick<IDockviewPanel['api'], 'id' | 'title' | 'getWindow'>;
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
  const panelId = panel.api.id;
  const token = {};
  inflightGuards.set(panelId, token);
  const done = (ok: boolean) => {
    if (inflightGuards.get(panelId) === token) inflightGuards.delete(panelId);
    return ok;
  };
  return coApi.terminal.runningProcess(sessionId).then(
    (r) => {
      if (inflightGuards.get(panelId) !== token) return false; // 已被 cancelTerminalCloseGuard 撤销(面板已由别处关闭)
      if (!r.ok || !r.data.process) return done(true);
      return askKillConfirm({
        panelId,
        doc: panel.api.getWindow().document,
        title: panel.api.title ?? '',
        process: r.data.process,
      }).then(done);
    },
    () => done(true),
  );
}

/**
 * 撤销该面板进行中的关闭守卫(wrapPanelClose 在 reconciler 关闭绕过守卫时调用):确认框按「取消」结算并清掉;
 * 尚在查询子进程的,查询回来后不再弹框。
 */
export function cancelTerminalCloseGuard(panel: { readonly api: Pick<IDockviewPanel['api'], 'id'> }): void {
  const panelId = panel.api.id;
  inflightGuards.delete(panelId);
  const pending = useTerminalKillConfirmStore.getState().pending;
  if (pending?.panelId !== panelId) return;
  useTerminalKillConfirmStore.setState({ pending: null });
  pending.resolve(false);
}

/**
 * DockShell 挂载一次:显示终端关闭确认框(破坏性,初始焦点在取消)。终端在 popout 子窗 → portal 进该子窗;子窗在确认
 * 期间被关(文档不再是 popout)→ 改画在主窗,免得框看不见、关闭一直挂起。取消后焦点还给该终端。
 */
export function TerminalKillConfirmHost() {
  const t = useT();
  const pending = useTerminalKillConfirmStore((s) => s.pending);
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  const refocusPanelRef = useRef<string | null>(null);
  useEffect(() => {
    // 在 Modal 卸载(其 cleanup 还原打开前的焦点)之后执行:× 点击关闭时打开前焦点不在终端。
    if (pending !== null || refocusPanelRef.current === null) return;
    const panelId = refocusPanelRef.current;
    refocusPanelRef.current = null;
    focusTerminalPanel(panelId);
  }, [pending]);
  const settle = (confirmed: boolean) => {
    useTerminalKillConfirmStore.setState({ pending: null });
    if (pending && !confirmed) refocusPanelRef.current = pending.panelId;
    pending?.resolve(confirmed);
  };
  const dialog = (
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
  const popoutDoc = pending && popoutDocs.includes(pending.doc) ? pending.doc : null;
  return popoutDoc ? createPortal(dialog, popoutDoc.body) : dialog;
}
