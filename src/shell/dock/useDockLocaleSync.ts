import { useEffect } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { useLocale } from '@/i18n';
import { tWithFallback } from '@/i18n/translate';
import { publishEditorGroupNumbers } from '@/panels/Editor/editor-group-number';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { editorGroupNumbers } from './editor-group-order';

const EDITOR_TITLE_KEY = 'panels.editor.title';

function panelTitle(titleKey: string, current: string, n: number | undefined): string {
  if (titleKey === EDITOR_TITLE_KEY && n !== undefined && n > 1) {
    return tWithFallback('panels.editor.title_numbered', current, { n: String(n) });
  }
  return tWithFallback(titleKey, current);
}

/**
 * Dockview panel title 与 locale 同步（topic-19 P0-2）。
 *
 * DockShell mount 后跑：useLocale() 订阅 locale change → 遍历 api.panels
 * → 若 panel.params?.titleKey 存在则 setTitle(tWithFallback(titleKey, currentTitle))。
 *
 * SharedTab 已订阅 onDidTitleChange，setTitle 后 tab 自动 re-render。
 *
 * 编辑器组面板标题带编号「编辑器 N」:popout / 浮动组里拆分(不能分栏)、拖进同一 dock 组时多个编辑器组面板叠成同组 tab,
 * 统一叫「编辑器」无法区分。N = 该组在所在窗口里的空间位置(editorGroupNumbers:主窗网格从左到右、从上到下,同 ⌘1/⌘2/⌘3;
 * popout 子窗各自编号),第一位不带号(对齐 VSCode EditorGroupView「Group N」按 GRID_APPEARANCE 位置、增删 / 换位后重新编号);
 * 不用组 id 里的号码(nextEditorGroupId 复用最小空号)。同一来源同时发布读屏组号(publishEditorGroupNumbers)。
 * BDD: src/__tests__/editor-groups/
 */
export function useDockLocaleSync(api: DockviewApi | null): void {
  const locale = useLocale();

  useEffect(() => {
    if (!api) return;
    // 编辑器组面板各自的位置变化订阅(见下)
    const locationSubs = new Map<IDockviewPanel, { dispose(): void }>();
    let disposed = false;
    let queued = false;
    const sync = () => {
      const numbers = editorGroupNumbers(api);
      const aria = new Map<string, number>();
      for (const [id, { n, of }] of numbers) if (of > 1) aria.set(id, n);
      publishEditorGroupNumbers(aria);
      const live = new Set<IDockviewPanel>();
      for (const panel of api.panels) {
        if (isEditorGroupId(panel.api.id)) {
          live.add(panel);
          if (!locationSubs.has(panel)) locationSubs.set(panel, panel.api.onDidLocationChange(syncSoon));
        }
        const params = panel.params as { titleKey?: string } | undefined;
        const titleKey = params?.titleKey;
        if (!titleKey) continue;
        const current = panel.api.title ?? '';
        const next = panelTitle(titleKey, current, numbers.get(panel.api.id)?.n);
        if (next !== current) panel.api.setTitle(next);
      }
      for (const [panel, sub] of locationSubs) {
        if (live.has(panel)) continue;
        sub.dispose();
        locationSubs.delete(panel);
      }
    };
    // 位置变化在 dockview 移组途中同步触发(组可能还没挂进网格)→ 推到微任务里、合并后再算
    const syncSoon = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) sync();
      });
    };
    sync();
    // 新面板立即同步;组增删 / 换位 / 恢复布局后按 onDidLayoutChange 重算编号(dockview 对面板增删 / 移动等会合并触发它;
    // setTitle 只在变化时调用,频繁触发也无妨)。进出 popout 子窗(尤其重启恢复的子窗挂上 / 关闭)dockview 不保证发布局事件
    // → 另订阅每个编辑器组面板的 onDidLocationChange。
    const subs = [api.onDidAddPanel(sync), api.onDidLayoutChange(sync)];
    return () => {
      disposed = true;
      for (const sub of [...subs, ...locationSubs.values()]) sub.dispose();
    };
  }, [api, locale]);
}
