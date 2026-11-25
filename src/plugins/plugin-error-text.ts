// 插件激活 / 渲染失败的可读文案(插件行、失败通知、市场卡片共用;BDD: src/__tests__/plugin-failure-notify/)。
// 对齐 VSCode 扩展视图显示可读的激活失败原因,不把原始错误码(`PERMISSION_DENIED: fs`)给用户看。

import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import type { PluginError } from './PluginManager';

export function localizePluginError(error: PluginError): string {
  switch (error.code) {
    case 'PERMISSION_DENIED':
      return t('plugins_tab.error.permission_denied', { perms: error.message });
    case 'IMPORT_FAILED':
      return t('plugins_tab.error.import_failed', { message: error.message });
    case 'RENDER_FAILED':
      return t('plugins_tab.error.render_failed', { message: error.message });
  }
  // catalog 收录的 code(loader 的 NO_DEFAULT_EXPORT、插件抛出的 FS_DENIED 等)用其本地化文案;未收录时 helper 回退 code。
  const byCode = localizeErrorByCode(error.code, error.code);
  if (byCode !== error.code) return byCode;
  return t('plugins_tab.error.activation_failed', { message: error.message || error.code });
}
