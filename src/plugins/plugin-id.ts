// plugin id 形态契约 renderer 侧入口(E110/E113/E123)。实现在跨进程单一来源
// electron/shared/plugin-id.ts(main isSafePluginId / plugin-data-store 同源,形态规则见该文件)。
// 只校验形态;需要同时限长度的入口(marketplace entry.id、reviews pluginId、fs scope 请求)直接用 shared 的
// isSafePluginId(形态 + 长度)。
// pluginId 被用作 reviews aggregate byPid key、与 marketplace entry.id 对账、拼进 URL/路径、
// 写进 PluginManager 列表 → 每个抽取/校验入口都须统一收敛形态(三处历史漂移见 E123)。
/** plugin id 形态合法(规则见 electron/shared/plugin-id)。 */
export { isValidPluginId } from '../../electron/shared/plugin-id';
