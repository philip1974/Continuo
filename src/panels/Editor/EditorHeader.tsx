// 单行 Header:左 tab 列表 / 右 mode 切换 + 自动保存提示 + 保存按钮。
// 替代原来的 Toolbar+TabBar 两行结构(避免文件名在 tab 与 toolbar 重复显示)。

import { useEditorStore, type EditorMode, type EditorTab } from '@/stores/editor.store';
import { Button } from '@/design';

interface EditorHeaderProps {
  activeTab: EditorTab | null;
  autoSaveEnabled: boolean;
  onCloseRequest: (tab: EditorTab) => void;
  onSave: () => void;
}

const MODE_LABEL: Record<EditorMode, string> = {
  edit: 'Edit',
  source: 'Source',
  preview: 'Preview',
};

function basename(p: string | null): string {
  if (!p) return '未命名';
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function EditorHeader({
  activeTab,
  autoSaveEnabled,
  onCloseRequest,
  onSave,
}: EditorHeaderProps) {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);

  if (tabs.length === 0) return null;

  const dirty = activeTab?.dirty ?? false;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-neutral-800 bg-neutral-950">
      {/* ── 左:tab 列表(可水平滚动) ─────────────────────── */}
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTab(tab.id)}
              className={[
                'group flex shrink-0 items-center gap-2 border-r border-neutral-800 px-3 text-xs transition',
                isActive
                  ? 'border-b border-b-sky-500 bg-neutral-900 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900',
              ].join(' ')}
              title={tab.filePath ?? '未保存草稿'}
            >
              <span className="max-w-[180px] truncate">{basename(tab.filePath)}</span>
              {tab.dirty && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400"
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

      {/* ── 右:mode 切换(仅 markdown) + 自动保存指示 + 保存按钮 ── */}
      <div className="flex shrink-0 items-center gap-2 border-l border-neutral-800 px-3 text-xs">
        {autoSaveEnabled && (
          <div className="flex items-center gap-0.5 rounded bg-neutral-800/60 p-0.5">
            {(['edit', 'source', 'preview'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={[
                  'rounded px-2 py-0.5 text-[11px] transition',
                  mode === m
                    ? 'bg-neutral-700 text-neutral-100'
                    : 'text-neutral-400 hover:text-neutral-200',
                ].join(' ')}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}

        {autoSaveEnabled && activeTab && (
          <span
            className="text-[10px] text-neutral-500"
            title="Markdown 文件 2 秒防抖自动保存"
          >
            {dirty ? '保存中…' : '已自动保存'}
          </span>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={onSave}
          disabled={!activeTab || !dirty}
          title="保存(⌘S)"
        >
          保存
        </Button>
      </div>
    </div>
  );
}
