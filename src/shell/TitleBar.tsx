// macOS 顶部窗口标题栏:动态显示 workspace 名 · active file 名,
// 同时承担 -webkit-app-region:drag 让用户拖窗。
// 无 workspace / 无文件 → 兜底"Continuo"。
// 主窗活动的是终端等非编辑器面板 → 显示该面板名(不显示被挡住的文件);窗口标题(document.title)同步。
// 文件取主窗正显示的编辑器组的活动 tab(useMainWindowEditorGroupId),不取全局活动 tab:活动编辑器组可能在 popout 子窗
// (子窗自己的原生标题见 popout-window-titles)。

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { coApi } from '@/lib/co-api';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useT } from '@/i18n';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import { basenameForChrome } from '@/lib/path-label';
import { useActiveNonEditorPanel, useMainWindowEditorGroupId } from '@/shell/dock/main-window-active-panel';
import { formatWindowTitle } from '@/shell/window-title';

// 界面缩放(⌘- / ⌘+)由 Chromium 页面缩放实现,变化时视口的 CSS 尺寸随之变化并派发 resize;缩放系数经 preload 的 webFrame 取。
function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
function readZoomFactor(): number {
  try {
    const factor = coApi.window.getZoomFactor();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1; // 无 preload(测试 / 非 Electron)
  }
}
const noSubscribe = (): (() => void) => () => {};
const unitZoom = (): number => 1;

/**
 * macOS hiddenInset 的红绿灯是原生控件、不随网页缩放:标题栏随缩小变矮时红绿灯伸出标题栏。标题栏里没有可缩放的自定义项,
 * 照 VSCode titlebarPart 的 counter-zoom(`zoom: calc(1 / var(--zoom-factor))`)按 1 / 缩放系数反向缩放 —— 高度与文字
 * 在任何缩放下都与 100% 时相同。其它平台是原生标题栏,不干预。返回 CSS zoom(无需时 undefined)。
 */
function useTitleBarCounterZoom(): number | undefined {
  const mac = detectPlatform() === 'mac';
  const factor = useSyncExternalStore(mac ? subscribeResize : noSubscribe, mac ? readZoomFactor : unitZoom);
  return factor === 1 ? undefined : 1 / factor;
}

export function TitleBar() {
  const t = useT();
  const root = useWorkspaceStore((s) => s.root);
  // 标题只依赖 active tab 的有无 / filePath / dirty(打磨 R22/R44 + 性能 P13)。
  // 旧实现每次 store 更新都 `tabs.find(...)+JSON.stringify`(O(tab 数)+小分配),虽阻止
  // 重渲但每按键计算照跑。现复用 P12 的 chromeVersion:订阅 activeTabId + chromeVersion
  // (均 O(1) 比较),仅 active 切换或 chrome 真变化(filePath/dirty/增删)时才从
  // getState() 读 active tab。持续输入已脏 tab(dirty 不变)→ 两 selector 都不变 → O(1) 跳过。
  const mainGroupId = useMainWindowEditorGroupId();
  const activeTabId = useEditorStore((s) => (mainGroupId === null ? null : groupActiveTabIdOf(s, mainGroupId)));
  const chromeVersion = useEditorStore((s) => s.chromeVersion);
  const { activeFilePath, activeDirty } = useMemo(() => {
    const found =
      findEditorFileTabById(useEditorStore.getState().tabs, activeTabId);
    return {
      activeFilePath: found?.filePath ?? null,
      activeDirty: found?.dirty ?? false,
    };
    // chromeVersion 作失效键:active tab 的 filePath/dirty 变化即 bump。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, chromeVersion]);

  const otherPanel = useActiveNonEditorPanel();
  const filePath = otherPanel ? null : activeFilePath;
  const dirty = otherPanel ? false : activeDirty;
  const fileName = otherPanel ? otherPanel.title || null : filePath !== null ? basenameForChrome(filePath) : null;
  const wsLabel = root ? basenameForChrome(root) : null;
  // 拼接:[file ●] · [workspace] || Continuo。dirty ● 仅视觉(aria-hidden),
  // 未保存语义改由视觉隐藏的本地化文本承载(a11y A40,同 A35/A37 dirty 族)。
  const sep = fileName && wsLabel ? '  ·  ' : '';
  const fallback = !fileName && !wsLabel ? 'Continuo' : '';
  // 窗口标题(Dock / 窗口菜单 / 任务切换器里显示)与标题栏一致
  const windowTitle = formatWindowTitle(fileName, dirty, wsLabel);
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);
  const counterZoom = useTitleBarCounterZoom();

  return (
    <header
      style={counterZoom === undefined ? undefined : { zoom: counterZoom }}
      className="flex h-9 shrink-0 items-center justify-center border-b border-line bg-panel/40 text-xs text-fg-muted select-none [-webkit-app-region:drag]">
      <span className="truncate px-12" title={filePath ?? root ?? undefined}>
        {fileName}
        {dirty && (
          <>
            <span aria-hidden="true"> ●</span>
            <span style={SR_ONLY_STYLE}> {t('statusbar.unsaved_changes')}</span>
          </>
        )}
        {sep}
        {wsLabel}
        {fallback}
      </span>
    </header>
  );
}
