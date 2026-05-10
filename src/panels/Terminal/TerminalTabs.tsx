import { useCallback, useState } from 'react';
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
  const customTitles = useTerminalStore((s) => s.customTitles);
  const renameSession = useTerminalStore((s) => s.renameSession);

  // 双击 tab 进入重命名(issue #19):同时只有一个 tab 处于编辑态。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = useCallback(
    (id: string, current: string) => {
      setRenamingId(id);
      setDraft(current);
    },
    [],
  );
  const commitRename = useCallback(() => {
    if (renamingId !== null) {
      renameSession(renamingId, draft);
    }
    setRenamingId(null);
    setDraft('');
  }, [renamingId, draft, renameSession]);
  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setDraft('');
  }, []);

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-line bg-panel">
      {/* tabs + 按钮一组,自然宽度 */}
      <div className="flex min-w-0 items-stretch overflow-x-auto">
        {showTabList && (
          <TabNav>
            {sessions.map((tab: TerminalSession) => {
              const isExited = tab.exitCode !== null;
              const isAgent = tab.originHint === 'agent';
              const displayTitle = customTitles.get(tab.id) ?? tab.title;
              const baseTitle = isAgent
                ? `${displayTitle}${tab.agentLabel ? ` · ${tab.agentLabel}` : ''}(agent)`
                : displayTitle;
              const isRenaming = renamingId === tab.id;
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
                  onSelect={() => {
                    if (isRenaming) return;
                    setActive(tab.id);
                  }}
                  onClose={() => onCloseSession(tab.id)}
                  onRename={() => startRename(tab.id, displayTitle)}
                >
                  {isAgent && !isRenaming && (
                    <span className="mr-1 text-accent" aria-hidden>
                      ●
                    </span>
                  )}
                  {isRenaming ? (
                    <input
                      autoFocus
                      type="text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      onBlur={commitRename}
                      // 借父 button 的字号 / 颜色,无边框,内联展现
                      className="w-32 bg-transparent text-fg outline-none border-b border-accent"
                      aria-label={`重命名终端 ${tab.title}`}
                    />
                  ) : (
                    <>
                      {displayTitle}
                      {isExited && (
                        <span className="ml-1 text-fg-dim">(已退出)</span>
                      )}
                    </>
                  )}
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
