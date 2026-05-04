// 单行 Header:左 tab 列表 / 右 mode 切换 + 自动保存提示 + 保存按钮。
// 替代原来的 Toolbar+TabBar 两行结构(避免文件名在 tab 与 toolbar 重复显示)。

import { useEditorStore, type EditorMode, type EditorTab } from '@/stores/editor.store';
import { Button, SegmentedControl, TabNav, TabNavItem } from '@/design';

interface EditorHeaderProps {
  activeTab: EditorTab | null;
  autoSaveEnabled: boolean;
  onCloseRequest: (tab: EditorTab) => void;
  onSave: () => void;
}

const MODE_OPTIONS: readonly { id: EditorMode; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'source', label: 'Source' },
  { id: 'preview', label: 'Preview' },
];

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
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-canvas">
      <TabNav className="min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabNavItem
            key={tab.id}
            active={tab.id === activeTabId}
            dirty={tab.dirty}
            title={tab.filePath ?? '未保存草稿'}
            onSelect={() => switchTab(tab.id)}
            onClose={() => onCloseRequest(tab)}
          >
            {basename(tab.filePath)}
          </TabNavItem>
        ))}
      </TabNav>

      <div className="flex shrink-0 items-center gap-2 border-l border-line px-3 text-xs">
        {autoSaveEnabled && (
          <SegmentedControl
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
            size="sm"
          />
        )}

        {autoSaveEnabled && activeTab && (
          <span
            className="text-[10px] text-fg-dim"
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
