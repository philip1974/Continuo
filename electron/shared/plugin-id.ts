// plugin id 形态契约 **跨进程单一来源**(重构:此前 renderer plugin-id.ts、main plugins.service /
// plugin-data-store.service 各持一份逐字相同的字符扫描,三处历史漂移见 E123)。
//
// pluginId 被拼进 FS 路径(plugins 目录 / data 文件)、URL、reviews aggregate key → 每个入口都须
// 统一形态:仅小写字母数字与 `. _ -`,非空,且非 `.`/`..`(纯点段 = 路径穿越语义,审计 P1)。
/** plugin id 形态合法:仅小写字母数字与 `. _ -`,且非 `.`/`..`(路径段语义)。 */
export function isValidPluginId(id: string): boolean {
  if (id === '.' || id === '..') return false;
  return hasOnlyPluginIdChars(id);
}

function hasOnlyPluginIdChars(id: string): boolean {
  if (id.length === 0) return false;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ok =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 46 ||
      code === 95 ||
      code === 45;
    if (!ok) return false;
  }
  return true;
}
