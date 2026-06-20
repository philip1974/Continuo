// 单行 Header:左 tab 列表 / 右 插件 actions。
//
// 与 VSCode 对齐:
//   - tabs=0  → 整个 header 不渲染(EditorWelcome 接管)
//   - tabs≥1 → 统一 TabNav,单 tab 也按内容宽收紧(TabNavItem flex-shrink:0
//              + max-width:220px),右侧 panel 留空,不再撑满整行。
//   - 不显文字「保存」按钮 — dirty 由 TabNavItem 自带的 ● 指示,⌘S 保存。
//   - markdown 模式切换(Edit/Source/Preview)已搬到 EditorPanel 中的 EditorModeBar
//     —— tab 行下方独立一行,与编辑器同宽,视觉上更干净。

import { memo, useMemo } from 'react';
import {
  getEffectiveMode,
  useEditorStore,
  type EditorMode,
  type EditorTab,
} from '@/stores/editor.store';
import { useT, t as translate } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';
import {
  Button,
  IconButton,
  TabNav,
  TabNavItem,
} from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import {
  filterVisible,
  type EditorActionSpec,
} from '@/plugins/registries/EditorActionRegistry';

interface EditorHeaderProps {
  activeTab: EditorTab | null;
  onCloseRequest: (tab: EditorTab) => void;
}

function basename(p: string | null): string {
  if (!p) return translate('panels.editor.untitled');
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 订阅 editorActions registry,渲染时按 ctx 过滤. */
function useEditorActions(): readonly EditorActionSpec[] {
  return useRegistry(coApp.editorActions);
}

/**
 * 抽出 actions 段为 memo 子组件:plugin 启停 actions 变化时,只本子组件
 * 重渲,父 EditorHeader 的 tabs 列表那段不动。
 *
 * memo 比较入参三个 primitive(filePath / dirty / mode)— 文件 / 脏态 /
 * 模式没变 + 子组件内 useEditorActions 订阅的 snapshot 也没变 → 跳过 reconcile。
 *
 * (filterVisible 仍每次 props 或 actions 变化时跑;空数组也安然 memo。)
 */
interface EditorActionsAreaProps {
  readonly filePath: string | null;
  readonly dirty: boolean;
  readonly mode: EditorMode;
}

const EditorActionsArea = memo(function EditorActionsArea({
  filePath,
  dirty,
  mode,
}: EditorActionsAreaProps) {
  const allActions = useEditorActions();
  const visibleActions = useMemo(
    () => filterVisible(allActions, { filePath, dirty, mode }),
    [allActions, filePath, dirty, mode],
  );
  return (
    <>
      {visibleActions.map((a) =>
        a.icon ? (
          <IconButton
            key={a.id}
            size="xs"
            // 插件贡献的编辑器 action,抛错经 runContributedAction 弹 error toast,不再
            // 静默吞(旧 `void a.fn()` 连 console 都没有)。见第二十一轮 P1-AX。
            onClick={() => runContributedAction(a.label, a.fn)}
            title={a.label}
            aria-label={a.label}
          >
            {a.icon}
          </IconButton>
        ) : (
          <Button
            key={a.id}
            variant="ghost"
            size="sm"
            onClick={() => runContributedAction(a.label, a.fn)}
            title={a.label}
          >
            {a.label}
          </Button>
        ),
      )}
    </>
  );
});

export function EditorHeader({
  activeTab,
  onCloseRequest,
}: EditorHeaderProps) {
  const t = useT(); // 订阅 locale 让 basename 改语言时 re-render
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);

  if (tabs.length === 0) return null;

  const dirty = activeTab?.dirty ?? false;
  const effectiveMode = getEffectiveMode(activeTab);

  return (
    <div className="flex h-9 shrink-0 items-stretch bg-canvas">
      <TabNav className="min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabNavItem
            key={tab.id}
            active={tab.id === activeTabId}
            dirty={tab.dirty}
            title={tab.filePath ?? t('panels.editor.unsaved_draft')}
            onSelect={() => switchTab(tab.id)}
            onClose={() => onCloseRequest(tab)}
          >
            {basename(tab.filePath)}
          </TabNavItem>
        ))}
      </TabNav>

      {/* empty:hidden — 当无可见插件 action 时,本 div 的 children 全是 falsy
          /空 fragment,DOM 上是 :empty。隐藏避免空边框 + padding 在 tab 右侧
          形成"奇怪小矩形"。 */}
      <div className="flex shrink-0 items-center gap-2 border-l border-line px-3 text-xs empty:hidden">
        {/* 与 VSCode 对齐:不显「保存」按钮,dirty 走 TabNavItem 自带 ● + ⌘S */}

        {/* 插件贡献的 editor action(memo 子组件,plugin 启停时只本段重渲) */}
        <EditorActionsArea
          filePath={activeTab?.filePath ?? null}
          dirty={dirty}
          mode={effectiveMode}
        />
      </div>
    </div>
  );
}
