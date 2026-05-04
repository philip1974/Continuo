// macOS 顶部窗口标题栏:动态显示 workspace 名 · active file 名,
// 同时承担 -webkit-app-region:drag 让用户拖窗。
// 无 workspace / 无文件 → 兜底"LayoutMotion"。

import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

function basename(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

export function TitleBar() {
  const root = useWorkspaceStore((s) => s.root);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  const fileLabel = active
    ? `${basename(active.filePath ?? '未命名')}${active.dirty ? ' ●' : ''}`
    : null;
  const wsLabel = root ? basename(root) : null;

  // 拼接:[file ●] · [workspace] || LayoutMotion
  const parts = [fileLabel, wsLabel].filter(Boolean);
  const text = parts.length > 0 ? parts.join('  ·  ') : 'LayoutMotion';

  return (
    <header className="flex h-9 shrink-0 items-center justify-center border-b border-line bg-panel/40 text-xs text-fg-muted select-none [-webkit-app-region:drag]">
      <span className="truncate px-12" title={active?.filePath ?? root ?? undefined}>
        {text}
      </span>
    </header>
  );
}
