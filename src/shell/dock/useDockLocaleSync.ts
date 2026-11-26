import { useEffect } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { useLocale } from '@/i18n';
import { tWithFallback } from '@/i18n/translate';
import { editorGroupIdsOf, useEditorStore } from '@/stores/editor.store';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';

/**
 * Dockview panel title 与 locale 同步（topic-19 P0-2）。
 *
 * DockShell mount 后跑：useLocale() 订阅 locale change → 遍历 api.panels
 * → 若 panel.params?.titleKey 存在则 setTitle(tWithFallback(titleKey, currentTitle))。
 *
 * SharedTab 已订阅 onDidTitleChange，setTitle 后 tab 自动 re-render。
 */
/**
 * 编辑器组面板标题带编号「编辑器 N」:popout / 浮动组里拆分(不能分栏)、拖进同一 dock 组时多个编辑器组面板叠成同组 tab,
 * 统一叫「编辑器」无法区分。N = 该组在编辑器组顺序(editor.store 组顺序,同 ⌘1/⌘2/⌘3 focusEditorGroup)里的位置,第一位不带号
 *(对齐 VSCode EditorGroupView「Group N」按位置、增删组后重新编号);不用组 id 里的号码(nextEditorGroupId 复用最小空号)。
 * 与 ⌘1/2/3 同口径只数主窗(grid / floating);popout 子窗里的组按各自子窗(dock 组)自己编号(⌘N 不在子窗分发,
 * VSCode 辅助窗口同样各自从「Group 1」编号)。BDD: src/__tests__/editor-groups/
 */
export function editorGroupTitleNumbers(api: Pick<DockviewApi, 'panels'>, order: readonly string[]): Map<string, number> {
  const panels = new Map<string, IDockviewPanel>();
  for (const p of api.panels) {
    if ((p.params as { titleKey?: string } | undefined)?.titleKey === EDITOR_TITLE_KEY && isEditorGroupId(p.api.id)) {
      panels.set(p.api.id, p);
    }
  }
  // 组顺序在前;不属于任何组的编辑器面板(恢复对齐前的短暂状态)按 dock 顺序排在后面
  const ids = [...new Set([...order.filter((id) => panels.has(id)), ...panels.keys()])];
  const counters = new Map<string, number>();
  const out = new Map<string, number>();
  for (const id of ids) {
    const panel = panels.get(id)!;
    const window = panel.api.location.type === 'popout' ? `popout:${panel.api.group.id}` : 'main';
    const n = (counters.get(window) ?? 0) + 1;
    counters.set(window, n);
    out.set(id, n);
  }
  return out;
}

const EDITOR_TITLE_KEY = 'panels.editor.title';

function panelTitle(titleKey: string, current: string, n: number | undefined): string {
  if (titleKey === EDITOR_TITLE_KEY && n !== undefined && n > 1) {
    return tWithFallback('panels.editor.title_numbered', current, { n: String(n) });
  }
  return tWithFallback(titleKey, current);
}

export function useDockLocaleSync(api: DockviewApi | null): void {
  const locale = useLocale();

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      const numbers = editorGroupTitleNumbers(api, editorGroupIdsOf(useEditorStore.getState()));
      for (const panel of api.panels) {
        const params = panel.params as { titleKey?: string } | undefined;
        const titleKey = params?.titleKey;
        if (!titleKey) continue;
        const current = panel.api.title ?? '';
        const next = panelTitle(titleKey, current, numbers.get(panel.api.id));
        if (next !== current) panel.api.setTitle(next);
      }
    };
    sync();
    // 新面板立即同步;组增删 / 换位 / 移入移出 popout / 恢复布局后按 onDidLayoutChange 重算编号(dockview 对面板增删 /
    // 移动 / popout 位置变化等都会合并触发它;setTitle 只在变化时调用,频繁触发也无妨)
    const subs = [api.onDidAddPanel(sync), api.onDidLayoutChange(sync)];
    const unsubscribe = useEditorStore.subscribe((s, prev) => {
      if (s.groups !== prev.groups) sync();
    });
    return () => {
      unsubscribe();
      for (const sub of subs) sub.dispose();
    };
  }, [api, locale]);
}
