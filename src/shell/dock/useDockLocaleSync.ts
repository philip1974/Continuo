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
        const next = tWithFallback(titleKey, current);
        if (next !== current) panel.api.setTitle(next);
      }
    };
    sync();
    const off = api.onDidAddPanel(sync);
    return () => off.dispose();
  }, [api, locale]);
}
