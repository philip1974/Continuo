import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';
import { IconButton, TabNav, TabNavItem } from '@/design';

interface TerminalTabsProps {
  onNewSession: () => void;
  onCloseSession: (id: string) => void;
  /** 单 session 时隐藏 tab 列表(由父决策),但 + 按钮总在. */
  showTabList?: boolean;
}

export function TerminalTabs({
  onNewSession,
  onCloseSession,
  showTabList = true,
}: TerminalTabsProps) {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const setActive = useTerminalStore((s) => s.setActive);

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-line bg-panel">
      {/* tabs + 按钮一组,自然宽度 */}
      <div className="flex min-w-0 items-stretch overflow-x-auto">
        {showTabList && (
          <TabNav>
            {sessions.map((tab: TerminalSession) => {
              const isExited = tab.exitCode !== null;
              const isAgent = tab.originHint === 'agent';
              const baseTitle = isAgent
                ? `${tab.title}${tab.agentLabel ? ` · ${tab.agentLabel}` : ''}(agent)`
                : tab.title;
              return (
                <TabNavItem
                  key={tab.id}
                  active={tab.id === activeId}
                  muted={isExited}
                  title={
                    isExited
                      ? `${baseTitle}(已退出 code=${tab.exitCode})`
                      : baseTitle
                  }
                  onSelect={() => setActive(tab.id)}
                  onClose={() => onCloseSession(tab.id)}
                >
                  {isAgent && (
                    <span className="mr-1 text-accent" aria-hidden>
                      ●
                    </span>
                  )}
                  {tab.title}
                  {isExited && <span className="ml-1 text-fg-dim">(已退出)</span>}
                </TabNavItem>
              );
            })}
          </TabNav>
        )}
        <IconButton
          size="sm"
          onClick={onNewSession}
          title="新建终端"
          aria-label="新建终端"
          className="border-l border-line rounded-none shrink-0"
        >
          +
        </IconButton>
      </div>
      {/* 兜底空白:tabs 不多时占据右侧空间,让 + 按钮跟在 tabs 旁而非推到最右 */}
      <div className="flex-1" />
    </div>
  );
}
