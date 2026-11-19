// plugin id 形态契约 **跨进程单一来源**(重构:此前 renderer plugin-id.ts、main plugins.service /
// plugin-data-store.service 各持一份逐字相同的字符扫描,三处历史漂移见 E123)。
//
// pluginId 被拼进 FS 路径(plugins 目录 / data 文件)、URL、reviews aggregate key → 每个入口都须
// 统一形态:仅小写字母数字与 `. _ -`,非空,且非 `.`/`..`(纯点段 = 路径穿越语义,审计 P1)。
//
// 首字符不得为 `.` / `_`(安全):plugins 目录里这两种前缀名是主进程元数据与临时目录的命名空间
//(_plugin-path-scopes.json / _permissions.json / _enabled.json / .staging-* / .<id>.old-*),列举逻辑也
// 跳过它们。放行此类 id 时,远程仓库可用 manifest.id 占住元数据文件位置(读写 EISDIR → 卸载卡在
// PATH_SCOPE_CLEANUP_FAILED、scope 持久化静默失效,且 UI 不可见无法清除),或伪造启动恢复流程的备份目录。
// 该规则同时覆盖纯点段 `.`/`..`。`-` 开头仍放行:不属上述命名空间,且此前一直合法 —— 一并拒绝会让已装的
// 这类插件被 renderer manifest 校验静默跳过(UI 不可见、无法卸载,目录永久残留)。
//
// 末字符不得为 `.`(安全,Windows):Win32 会去掉路径段尾部的点(与空格 —— 空格不在字符集内),`foo.` 与 `foo`
// 落到同一个安装目录与 data 文件,而安装互斥锁、权限记录、path scope 的键仍是两个 id。
//
// 不得是 Windows 保留设备名(con / prn / aux / nul / com0-9 / lpt0-9),含带扩展名的形式(`nul.x`:第一个点
// 之前的部分是设备名即算):作目录名时指向设备而不是目录。id 本就只有小写,无需再折叠大小写。
// 这两条各平台统一执行 —— 同一份 manifest 不因平台而一处能装一处不能装。
/** plugin id 形态合法:仅小写字母数字与 `. _ -`,首字符不为 `.` / `_`,末字符不为 `.`,且不是 Windows 保留设备名。 */
export function isValidPluginId(id: string): boolean {
  if (id.length === 0) return false;
  const first = id.charCodeAt(0);
  if (first === 46 || first === 95) return false;
  if (id.charCodeAt(id.length - 1) === 46) return false;
  if (isWindowsReservedDeviceName(id)) return false;
  return hasOnlyPluginIdChars(id);
}

const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set(['con', 'prn', 'aux', 'nul']);

/** 第一个点之前的部分是 Windows 保留设备名(只比小写:id 字符集没有大写)。 */
function isWindowsReservedDeviceName(id: string): boolean {
  const dot = id.indexOf('.');
  const stem = dot === -1 ? id : id.slice(0, dot);
  if (WINDOWS_DEVICE_NAMES.has(stem)) return true;
  if (stem.length !== 4) return false;
  const last = stem.charCodeAt(3);
  return (stem.startsWith('com') || stem.startsWith('lpt')) && last >= 48 && last <= 57;
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
