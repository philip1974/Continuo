// plugin id 形态契约 **renderer 侧单一来源**(E110/E113/E123)。
// 与 electron/main isSafePluginId(plugins.service)同款语义:仅小写字母数字与 `. _ -`,且非
// `.`/`..`(纯点段=路径穿越语义)。renderer 不可 import electron/main,故 renderer 侧统一收敛于此:
//   - ManifestSchema.id(本目录 manifest.ts,E123):本地/远端 manifest 解析,拒点段脏 id
//   - marketplace entry.id(../marketplace/types.ts,E110)
//   - reviews parseReview / isValidReview / isValidAggregate 的 pluginId(../marketplace,E113)
// pluginId 被用作 reviews aggregate byPid key、与 marketplace entry.id 对账、拼进 URL/路径、
// 写进 PluginManager 列表 → 每个抽取/校验入口都须统一收敛形态(三处历史漂移见 E123)。
const PLUGIN_ID_RE = /^[a-z0-9._-]+$/;

/** plugin id 形态合法:仅小写字母数字与 `. _ -`,且非 `.`/`..`(路径段语义)。 */
export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_RE.test(id) && id !== '.' && id !== '..';
}
