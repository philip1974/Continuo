// Terminal 主容器(M-Terminal Step T5)。
// 顶部 TerminalTabs(切换/新建/关闭)+ 主体多个 TerminalView(display:none/flex 切换,
// 不销毁 xterm 实例,scrollback 与滚动位置保留)。
// 首次 mount 自动 spawn 一个 session;PTY exit 事件标记 exitCode 但不自动关 tab。

import { useCallback, useEffect } from 'react';
import { useTerminalStore } from '@/stores/terminal.store';
import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { Button } from '@/design';

// 模块级单例标志(跨 React mount/unmount 持久;App 真重启 / Cmd+R reload renderer
// 时 module 重新加载自动复位)。
// 解决:React 19 StrictMode 双 mount + spawn 异步 → useEffect 跑 2 次都看到
// sessions=[] → 双 spawn 出 2 个 terminal 的 bug。
let __terminalAutoSpawned = false;

export function TerminalPanel() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const addSession = useTerminalStore((s) => s.addSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setExited = useTerminalStore((s) => s.setExited);

  // 默认 cwd:workspace root,无则系统 home(IPC 缺省也会用 homedir)
  const workspaceRoot = useWorkspaceStore((s) => s.root);

  const handleNew = useCallback(async () => {
    const r = await window.api.terminal.create({
      cwd: workspaceRoot ?? undefined,
    });
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn('[terminal] create failed:', r.code, r.message);
      alert(`新建终端失败:[${r.code}] ${r.message}`);
      return;
    }
    const idx = useTerminalStore.getState().sessions.length + 1;
    addSession({ id: r.data.id, title: `Terminal ${idx}` });
  }, [addSession, workspaceRoot]);

  const handleClose = useCallback(
    (id: string) => {
      // 主进程优雅 kill(3s grace period);renderer 立即从 store 移除
      void window.api.terminal.kill(id);
      removeSession(id);
    },
    [removeSession],
  );

  // 订阅 PTY exit 事件 → 标记 exitCode(tab 显示"已退出";不自动关)
  useEffect(() => {
    const unsub = window.api.terminal.onExit((id, payload) => {
      const code = payload.exitCode ?? -1;
      setExited(id, code);
    });
    return unsub;
  }, [setExited]);

  // 首次 mount 自动 spawn 一个 session(panel 一打开就有 terminal 可用)。
  // 用 module-level flag 防 StrictMode 双 mount 与异步 spawn 时序导致的双 spawn。
  // App 真重启时 module 重新加载,flag 自动复位 → 重新 spawn 一个新 terminal。
  useEffect(() => {
    if (__terminalAutoSpawned) return;
    if (useTerminalStore.getState().sessions.length > 0) {
      __terminalAutoSpawned = true;
      return;
    }
    __terminalAutoSpawned = true;
    void handleNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-canvas">
      <TerminalTabs onNewSession={handleNew} onCloseSession={handleClose} />
      <div className="relative min-h-0 flex-1">
        {sessions.map((sess) => (
          <div
            key={sess.id}
            className="absolute inset-0 flex"
            style={{ display: sess.id === activeId ? 'flex' : 'none' }}
          >
            <TerminalView termId={sess.id} />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <div className="text-xs uppercase tracking-wider text-fg-dim">
              无活跃终端
            </div>
            <Button variant="ghost" size="md" onClick={handleNew}>
              + 新建终端
            </Button>
            <div className="text-[10px] text-fg-dim">
              或点上方 Tab 栏右侧 +
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
