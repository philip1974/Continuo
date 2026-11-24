// 打开「最近打开」里已不存在的目录时的询问框(VSCode:「路径 X 不存在。要从最近打开列表中删除它吗?」[删除] [取消])。
// EmptyWorkspace 的最近列表与 ExplorerHeader 的「打开最近」菜单共用。
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { useT } from '@/i18n';
import { forgetRecentRoot } from '@/lib/persist/explorer-persist';

export function useRecentRootMissingPrompt(
  /** 确认删除时调用;缺省 forgetRecentRoot(调用方需在删除后安排焦点时传入)。 */
  remove: (path: string) => void = forgetRecentRoot,
): { readonly onMissing: (path: string) => void; readonly dialog: ReactNode } {
  const [missing, setMissing] = useState<string | null>(null);
  const t = useT();
  const dialog = (
    <ConfirmDialog
      open={missing !== null}
      title={t('panels.explorer.recent_missing.title', { path: missing ?? '' })}
      description={t('panels.explorer.recent_missing.detail')}
      confirmLabel={t('panels.explorer.recent_missing.remove')}
      onCancel={() => setMissing(null)}
      onConfirm={() => {
        const p = missing;
        setMissing(null);
        if (p !== null) remove(p);
      }}
    />
  );
  return { onMissing: setMissing, dialog };
}
