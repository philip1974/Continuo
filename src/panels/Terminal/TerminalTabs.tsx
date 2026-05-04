import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';

interface TerminalTabsProps {
  onNewSession: () => void;
  onCloseSession: (id: string) => void;
}

export function TerminalTabs({ onNewSession, onCloseSession }: TerminalTabsProps) {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const switchSession = useTerminalStore((s) => s.switchSession);

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-line bg-panel">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {sessions.map((tab: TerminalSession) => {
          const isActive = tab.id === activeId;
          const isExited = tab.exitCode !== null;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchSession(tab.id)}
              className={[
                'group flex shrink-0 items-center gap-2 border-r border-line px-2 text-xs transition',
                isActive
                  ? 'border-b border-b-accent bg-canvas text-fg'
                  : 'text-fg-muted hover:bg-hover',
              ].join(' ')}
              title={isExited ? `${tab.title}(已退出 code=${tab.exitCode})` : tab.title}
            >
              <span className="max-w-[140px] truncate">
                {tab.title}
                {isExited && <span className="ml-1 text-fg-dim">(已退出)</span>}
              </span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(tab.id);
                }}
                className="rounded text-fg-dim opacity-0 transition hover:bg-hover hover:text-fg group-hover:opacity-100"
                aria-label="关闭终端"
              >
                <span className="block px-1 leading-none">×</span>
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNewSession}
        title="新建终端"
        aria-label="新建终端"
        className="shrink-0 border-l border-line px-3 text-fg-muted transition hover:bg-hover hover:text-fg"
      >
        +
      </button>
    </div>
  );
}
