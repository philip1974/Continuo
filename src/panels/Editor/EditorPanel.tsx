// M-Editor Step E4:Editor 主容器编排。
// 顶部 Toolbar + TabBar + 主体(Milkdown / CodeEditor / Welcome)+ 关闭确认 Dialog。
//
// mode 路由(决策 #1/#3/#4):
//   activeTab 是 .md → mode=edit:Milkdown;source:CodeEditor markdown;preview:Milkdown readonly
//   activeTab 非 .md → 直接 CodeEditor(mode 不显示)
//   activeTab 为 null → Welcome

import { useCallback, useState } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { ConfirmDialog } from '@/panels/Explorer/ConfirmDialog';
import { CodeEditor } from './CodeEditor';
import { EditorHeader } from './EditorHeader';
import { EditorWelcome } from './EditorWelcome';
import { MilkdownEditor } from './MilkdownEditor';
import { useAutoSave, isAutoSaveEnabled } from './useAutoSave';
import { useEditorFile } from './useEditorFile';
import type { EditorTab } from '@/stores/editor.store';

function isMarkdownPath(p: string | null): boolean {
  if (!p) return true; // 未保存草稿默认按 markdown 处理
  return /\.(md|markdown)$/i.test(p);
}

function basename(p: string | null): string {
  if (!p) return '草稿';
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function EditorPanel() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const mode = useEditorStore((s) => s.mode);
  const updateContent = useEditorStore((s) => s.updateContent);
  const closeTab = useEditorStore((s) => s.closeTab);

  const activeTab: EditorTab | null =
    tabs.find((t) => t.id === activeTabId) ?? null;

  const { saveActive } = useEditorFile();
  const autoSaveEnabled = isAutoSaveEnabled(activeTab?.filePath ?? null);

  // 自动保存:Markdown 启用,代码不启用(决策 #3)
  useAutoSave(saveActive, { enabled: autoSaveEnabled });

  // 显式保存(Cmd+S 或 toolbar)
  const handleSave = useCallback(async () => {
    const r = await saveActive();
    if (!r.ok) {
      // UNSAVED_DRAFT / TAB_NOT_FOUND / FS_* 都到这里
      alert(`保存失败:[${r.code}] ${r.message}`);
    }
  }, [saveActive]);

  // 关闭脏 tab 二次确认
  const [closeCandidate, setCloseCandidate] = useState<EditorTab | null>(null);
  const onTabCloseRequest = useCallback(
    (tab: EditorTab) => {
      if (tab.dirty) setCloseCandidate(tab);
      else closeTab(tab.id);
    },
    [closeTab],
  );
  const confirmDiscard = useCallback(() => {
    if (closeCandidate) closeTab(closeCandidate.id);
    setCloseCandidate(null);
  }, [closeCandidate, closeTab]);

  // 判定主体渲染(根据 activeTab 类型 + mode)
  let body: React.ReactNode;
  if (!activeTab) {
    body = <EditorWelcome />;
  } else if (isMarkdownPath(activeTab.filePath)) {
    if (mode === 'source') {
      body = (
        <CodeEditor
          key={`${activeTab.id}-src`}
          value={activeTab.content}
          fileName={activeTab.filePath ?? ''}
          forceLanguage="markdown"
          onChange={(v) => updateContent(activeTab.id, v)}
        />
      );
    } else {
      body = (
        <MilkdownEditor
          key={`${activeTab.id}-${mode}`}
          defaultValue={activeTab.content}
          readonly={mode === 'preview'}
          onChange={(md) => updateContent(activeTab.id, md)}
        />
      );
    }
  } else {
    body = (
      <CodeEditor
        key={activeTab.id}
        value={activeTab.content}
        fileName={activeTab.filePath ?? ''}
        onChange={(v) => updateContent(activeTab.id, v)}
      />
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col bg-[#020617]"
      onKeyDown={(e) => {
        // Cmd/Ctrl+S 显式保存(Crepe 不会拦 ⌘S,所以可以放心)
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void handleSave();
        }
      }}
    >
      <EditorHeader
        activeTab={activeTab}
        autoSaveEnabled={autoSaveEnabled}
        onCloseRequest={onTabCloseRequest}
        onSave={handleSave}
      />
      <div className="min-h-0 flex-1">{body}</div>

      <ConfirmDialog
        open={closeCandidate !== null}
        title="放弃未保存的修改?"
        description={
          closeCandidate ? (
            <>
              <code className="text-neutral-200">
                {basename(closeCandidate.filePath)}
              </code>{' '}
              有未保存的修改。继续将永久丢失改动。
            </>
          ) : null
        }
        confirmLabel="不保存关闭"
        destructive
        onConfirm={confirmDiscard}
        onCancel={() => setCloseCandidate(null)}
      />
    </div>
  );
}
