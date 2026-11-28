// 插件激活 / 渲染失败的可读文案(插件行、失败通知、市场卡片共用;BDD: src/__tests__/plugin-failure-notify/、
// src/__tests__/plugin-dev-experience/)。对齐 VSCode 扩展视图显示可读的激活失败原因,不把原始错误码(`PERMISSION_DENIED: fs`)给用户看。

import { t, tWithFallback, type TranslationKey } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import type { ManifestIssue } from './manifest';
import type { PluginError } from './PluginManager';

const MAIN_UNAVAILABLE_REASONS = new Set(['bad-name', 'unreachable', 'not-file', 'too-large', 'open-failed']);

/** manifest 字段级问题 → 本地化的一条(`version: 须是 1.2.3 形式的版本号`)。 */
export function localizeManifestIssue(issue: ManifestIssue): string {
  const params = { path: issue.path, message: issue.message, ...issue.params };
  return issue.code === 'other'
    ? t('plugins_tab.manifest_issue.other', params)
    : t(`plugins_tab.manifest_issue.${issue.code}` as TranslationKey, params);
}

function reasonOf(error: PluginError): string {
  const p = error.params ?? {};
  // 错误自带 catalog key(激活期插件代码抛的 PermissionError:未声明 / 用户拒绝)→ 与命令路径(localizeThrown)同一文案。
  if (error.i18nKey !== undefined) return tWithFallback(error.i18nKey, error.message || error.code, p);
  switch (error.code) {
    case 'PERMISSION_DENIED':
      // 激活前的权限门:params.perms 是被拒的权限列表。插件代码抛的 PERMISSION_DENIED(吊销等,不带 perms)→ 按原文显示。
      if (p.perms !== undefined) return t('plugins_tab.error.permission_denied', { perms: p.perms });
      break;
    case 'IMPORT_FAILED':
      return t('plugins_tab.error.import_failed', { message: error.message });
    case 'IMPORT_SYNTAX_ERROR':
      return t('plugins_tab.error.import_syntax', { message: error.message });
    case 'IMPORT_UNBUNDLED':
      return t(p.kind === 'bare' ? 'plugins_tab.error.import_unbundled_bare' : 'plugins_tab.error.import_unbundled_relative', {
        specifier: p.specifier ?? '',
      });
    case 'RENDER_FAILED':
      return t('plugins_tab.error.render_failed', { message: error.message });
    case 'INVALID_JSON':
      return t('plugins_tab.error.manifest_json', { message: error.message });
    case 'SCHEMA_ERROR':
      return t('plugins_tab.error.manifest_schema', {
        issues: error.issues && error.issues.length > 0 ? error.issues.map(localizeManifestIssue).join('; ') : error.message,
      });
    case 'INCOMPATIBLE_VERSION':
      if (p.required !== undefined && p.current !== undefined) {
        return t('plugins_tab.error.incompatible', { required: p.required, current: p.current });
      }
      break;
    case 'PLUGIN_DIR_NAME_MISMATCH':
      return t('plugins_tab.error.dir_name_mismatch', { dir: p.dir ?? '', declaredId: p.declaredId ?? '' });
    case 'PLUGIN_MAIN_UNAVAILABLE':
      return t('plugins_tab.error.main_unavailable', {
        main: p.main ?? '',
        reason: t(
          `plugins_tab.error.main_reason.${MAIN_UNAVAILABLE_REASONS.has(p.reason ?? '') ? p.reason! : 'unreachable'}` as TranslationKey,
        ),
      });
  }
  // catalog 收录的 code(loader 的 NO_DEFAULT_EXPORT、插件抛出的 FS_DENIED 等)用其本地化文案;未收录时 helper 回退 code。
  const byCode = localizeErrorByCode(error.code, error.code, error.params);
  if (byCode !== error.code) return byCode;
  return t('plugins_tab.error.activation_failed', { message: error.message || error.code });
}

/** 可读原因;有位置(文件:行:列)时附在后面。 */
export function localizePluginError(error: PluginError): string {
  const reason = reasonOf(error);
  return error.location ? t('plugins_tab.error.at_location', { reason, location: error.location }) : reason;
}
