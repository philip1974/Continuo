// macOS 顶部窗口标题栏:动态显示 workspace 名 · active file 名,
// 同时承担 -webkit-app-region:drag 让用户拖窗。
// 无 workspace / 无文件 → 兜底"Continuo"。

import { useMemo } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useT } from '@/i18n';

function basename(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

export function TitleBar() {
  const t = useT();
  const root = useWorkspaceStore((s) => s.root);
  // 只订阅派生 primitive(打磨 R22 + R43 合并优化 R44):标题只依赖 active tab 的
  // 有无 / filePath / dirty。R22 用 3 个 selector 各 some/find;R44 合并为单次 find
  // 构造 JSON 签名串(content/reloadEpoch 不进签名,保持「不因正文变化重渲」契约),
  // 再 useMemo 拆值。每次 editor 更新从 3 次扫描降为 1 次。
  const activeSig = useEditorStore((s) => {
    const found = s.tabs.find((tb) => tb.id === s.activeTabId);
    return JSON.stringify([
      found !== undefined,
      found?.filePath ?? null,
      found?.dirty ?? false,
    ]);
  });
  const { hasActiveTab, activeFilePath, activeDirty } = useMemo(() => {
    const [exists, filePath, dirty] = JSON.parse(activeSig) as [
      boolean,
      string | null,
      boolean,
    ];
    return { hasActiveTab: exists, activeFilePath: filePath, activeDirty: dirty };
  }, [activeSig]);

  const fileLabel = hasActiveTab
    ? `${basename(activeFilePath ?? t('panels.editor.untitled'))}${activeDirty ? ' ●' : ''}`
    : null;
  const wsLabel = root ? basename(root) : null;

  // 拼接:[file ●] · [workspace] || Continuo
  const parts = [fileLabel, wsLabel].filter(Boolean);
  const text = parts.length > 0 ? parts.join('  ·  ') : 'Continuo';

  return (
    <header className="flex h-9 shrink-0 items-center justify-center border-b border-line bg-panel/40 text-xs text-fg-muted select-none [-webkit-app-region:drag]">
      <span className="truncate px-12" title={activeFilePath ?? root ?? undefined}>
        {text}
      </span>
    </header>
  );
}
