import { EmptyState } from '@/design';
import { useT } from '@/i18n';

/**
 * 输出面板:目前没有任何写入方(宿主与插件都不向它写日志),只显示空状态。此前写死「Continuo 就绪 / 已恢复停靠布局」
 * 两行假日志(首次启动用默认布局时仍显示「已恢复」),与插件页「输出日志面板」的描述都不实。
 */
export function Output() {
  const t = useT();
  return (
    // 空态与 Debug 等相邻面板一致(design EmptyState);将来有写入方时日志区再用等宽字。
    // 没有任何控件:根是打开 / 显示输出后的焦点落点(只经脚本聚焦,不进 Tab 顺序;BDD: open-panel-focus)。
    <div tabIndex={-1} data-panel-focus-root="" className="flex h-full w-full overflow-auto outline-none">
      <EmptyState>{t('panels.output.empty')}</EmptyState>
    </div>
  );
}
