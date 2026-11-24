import { useT } from '@/i18n';

/**
 * 输出面板:目前没有任何写入方(宿主与插件都不向它写日志),只显示空状态。此前写死「Continuo 就绪 / 已恢复停靠布局」
 * 两行假日志(首次启动用默认布局时仍显示「已恢复」),与插件页「输出日志面板」的描述都不实。
 */
export function Output() {
  const t = useT();
  return (
    <div className="h-full w-full overflow-auto p-3 font-mono text-xs text-fg-dim">{t('panels.output.empty')}</div>
  );
}
