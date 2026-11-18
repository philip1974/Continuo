// plugin id 形态契约 **跨进程单一来源**(重构:此前 renderer plugin-id.ts、main plugins.service /
// plugin-data-store.service 各持一份逐字相同的字符扫描,三处历史漂移见 E123)。
//
// pluginId 被拼进 FS 路径(plugins 目录 / data 文件)、URL、reviews aggregate key → 每个入口都须
// 统一形态:仅小写字母数字与 `. _ -`,非空,且非 `.`/`..`(纯点段 = 路径穿越语义,审计 P1)。
//
// 首字符须为 [a-z0-9](安全):plugins 目录里 `.` / `_` 前缀名是主进程元数据与临时目录的命名空间
//(_plugin-path-scopes.json / _permissions.json / _enabled.json / .staging-* / .<id>.old-*),列举逻辑也
// 跳过它们。放行此类 id 时,远程仓库可用 manifest.id 占住元数据文件位置(读写 EISDIR → 卸载卡在
// PATH_SCOPE_CLEANUP_FAILED、scope 持久化静默失效,且 UI 不可见无法清除),或伪造启动恢复流程的备份目录。
// 该规则同时覆盖纯点段 `.`/`..`。
/** plugin id 形态合法:仅小写字母数字与 `. _ -`,且首字符为小写字母或数字。 */
export function isValidPluginId(id: string): boolean {
  if (id.length === 0 || !isAlnumLower(id.charCodeAt(0))) return false;
  return hasOnlyPluginIdChars(id);
}

function isAlnumLower(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function hasOnlyPluginIdChars(id: string): boolean {
  if (id.length === 0) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ok =
      isAlnumLower(code) ||
      code === 46 ||
      code === 95 ||
      code === 45;
    if (!ok) return false;
  }
  return true;
}
