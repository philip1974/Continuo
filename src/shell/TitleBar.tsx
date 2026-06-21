// macOS 顶部窗口标题栏:动态显示 workspace 名 · active file 名,
// 同时承担 -webkit-app-region:drag 让用户拖窗。
// 无 workspace / 无文件 → 兜底"Continuo"。

import { useMemo } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useT } from '@/i18n';
import { basenameForChrome } from './path-label';

export function TitleBar() {
  const t = useT();
  const root = useWorkspaceStore((s) => s.root);
  // 标题只依赖 active tab 的有无 / filePath / dirty(打磨 R22/R44 + 性能 P13)。
  // 旧实现每次 store 更新都 `tabs.find(...)+JSON.stringify`(O(tab 数)+小分配),虽阻止
  // 重渲但每按键计算照跑。现复用 P12 的 chromeVersion:订阅 activeTabId + chromeVersion
  // (均 O(1) 比较),仅 active 切换或 chrome 真变化(filePath/dirty/增删)时才从
  // getState() 读 active tab。持续输入已脏 tab(dirty 不变)→ 两 selector 都不变 → O(1) 跳过。
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const chromeVersion = useEditorStore((s) => s.chromeVersion);
  const { hasActiveTab, activeFilePath, activeDirty } = useMemo(() => {
    const found = useEditorStore
      .getState()
      .tabs.find((tb) => tb.id === activeTabId);
    return {
      hasActiveTab: found !== undefined,
      activeFilePath: found?.filePath ?? null,
      activeDirty: found?.dirty ?? false,
    };
    // chromeVersion 作失效键:active tab 的 filePath/dirty 变化即 bump。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, chromeVersion]);

  const fileLabel = hasActiveTab
    ? `${basenameForChrome(activeFilePath ?? t('panels.editor.untitled'))}${activeDirty ? ' ●' : ''}`
    : null;
  const wsLabel = root ? basenameForChrome(root) : null;

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
