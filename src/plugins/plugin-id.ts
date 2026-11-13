// plugin id 形态契约 renderer 侧入口(E110/E113/E123)。实现在跨进程单一来源
// electron/shared/plugin-id.ts(main isSafePluginId / plugin-data-store 同源):仅小写字母数字与
// `. _ -`,且非 `.`/`..`(纯点段=路径穿越语义)。renderer 侧使用点:
//   - ManifestSchema.id(本目录 manifest.ts,E123):本地/远端 manifest 解析,拒点段脏 id
//   - marketplace entry.id(../marketplace/types.ts,E110)
//   - reviews parseReview / isValidReview / isValidAggregate 的 pluginId(../marketplace,E113)
// pluginId 被用作 reviews aggregate byPid key、与 marketplace entry.id 对账、拼进 URL/路径、
// 写进 PluginManager 列表 → 每个抽取/校验入口都须统一收敛形态(三处历史漂移见 E123)。
/** plugin id 形态合法:仅小写字母数字与 `. _ -`,且非 `.`/`..`(路径段语义)。 */
export { isValidPluginId } from '../../electron/shared/plugin-id';
