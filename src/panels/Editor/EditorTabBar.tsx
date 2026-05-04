import { useEditorStore, type EditorTab } from '@/stores/editor.store';

interface EditorTabBarProps {
  onCloseRequest: (tab: EditorTab) => void;
}

function basename(p: string | null): string {
  if (!p) return '未命名';
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// 横向 tab 列表。dirty 用 ●,active 高亮 + 底部 sky 边。
// onCloseRequest 由 EditorPanel 处理脏 tab 确认。
export function EditorTabBar({ onCloseRequest }: EditorTabBarProps) {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex shrink-0 overflow-x-auto border-b border-neutral-800 bg-neutral-950">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchTab(tab.id)}
            className={[
              'group flex shrink-0 items-center gap-2 border-r border-neutral-800 px-3 py-1.5 text-xs',
              isActive
                ? 'border-b border-b-sky-500 bg-neutral-900 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-900',
            ].join(' ')}
            title={tab.filePath ?? '未保存草稿'}
          >
            <span className="max-w-[180px] truncate">{basename(tab.filePath)}</span>
            {tab.dirty && (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400"
                aria-label="未保存修改"
              />
            )}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onCloseRequest(tab);
              }}
              className="rounded text-neutral-500 opacity-0 transition hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
              aria-label="关闭"
            >
              <span className="block px-1 leading-none">×</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
