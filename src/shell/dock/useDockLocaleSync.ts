import { useEffect } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useLocale } from '@/i18n';
import { tWithFallback } from '@/i18n/translate';

/**
 * Dockview panel title 与 locale 同步（topic-19 P0-2）。
 *
 * DockShell mount 后跑：useLocale() 订阅 locale change → 遍历 api.panels
 * → 若 panel.params?.titleKey 存在则 setTitle(tWithFallback(titleKey, currentTitle))。
 *
 * SharedTab 已订阅 onDidTitleChange，setTitle 后 tab 自动 re-render。
 */
/**
 * 编辑器组面板 `editor:N`(拆分出的第 N 个组)标题带编号「编辑器 N」:popout / 浮动组里拆分(不能分栏)、拖进同一 dock 组时
 * 多个编辑器组面板叠成同组 tab,统一叫「编辑器」无法区分。第一个组 `editor` 不带编号。BDD: src/__tests__/editor-groups/
 */
function panelTitle(id: string, titleKey: string, current: string): string {
  const n = EDITOR_GROUP_NUMBER_RE.exec(id)?.[1];
  if (titleKey === 'panels.editor.title' && n !== undefined) {
    return tWithFallback('panels.editor.title_numbered', current, { n });
  }
  return tWithFallback(titleKey, current);
}

const EDITOR_GROUP_NUMBER_RE = /^editor:(\d+)$/;

export function useDockLocaleSync(api: DockviewApi | null): void {
  const locale = useLocale();

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      for (const panel of api.panels) {
        const params = panel.params as { titleKey?: string } | undefined;
        const titleKey = params?.titleKey;
        if (!titleKey) continue;
        const current = panel.api.title ?? '';
        const next = panelTitle(panel.api.id, titleKey, current);
        if (next !== current) panel.api.setTitle(next);
      }
    };
    sync();
    const off = api.onDidAddPanel(sync);
    return () => off.dispose();
  }, [api, locale]);
}
