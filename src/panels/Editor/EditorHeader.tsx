// 单行 Header:左 tab 列表 / 右 mode 切换 + 自动保存提示 + 保存按钮。
//
// 双 tab 行抑制策略:
//   tabs=0  → 整个 header 不渲染(EditorWelcome 接管)
//   tabs=1  → 紧凑模式:[文件名 ●] [Edit/Source/Preview] [auto-save 提示] [保存] [×]
//             不显 sky 下划线 tab 列表(避免与 Dockview 自身的 'Editor' tab 撞下划线)
//   tabs≥2  → 完整 TabNav + 右侧控制条

import { useEditorStore, type EditorMode, type EditorTab } from '@/stores/editor.store';
import {
  Button,
  IconButton,
  SegmentedControl,
  TabNav,
  TabNavItem,
} from '@/design';

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
  const showTabList = tabs.length >= 2;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-canvas">
      {showTabList ? (
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
      ) : (
        // 单 tab 紧凑模式:文件名 + dirty,无 tab 下划线
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs">
          <span
            className="truncate text-fg"
            title={activeTab?.filePath ?? '未保存草稿'}
          >
            {basename(activeTab?.filePath ?? null)}
          </span>
          {dirty && (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              aria-label="未保存修改"
              title="未保存修改"
            />
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-l border-line px-3 text-xs">
        {autoSaveEnabled && (
          <SegmentedControl
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
            size="sm"
          />
        )}

        {/* 自动保存模式静默(dirty 状态已由文件名旁的 ● 指示);
            手动保存模式才显按钮. */}
        {!autoSaveEnabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSave}
            disabled={!activeTab || !dirty}
            title="保存(⌘S)"
          >
            保存
          </Button>
        )}

        {/* 单 tab 时,close × 移到右侧控制区(普通 tab 列表自带 close) */}
        {!showTabList && activeTab && (
          <IconButton
            size="xs"
            onClick={() => onCloseRequest(activeTab)}
            title="关闭文件"
            aria-label="关闭文件"
          >
            ✕
          </IconButton>
        )}
      </div>
    </div>
  );
}
