# plugin-install-enable

插件**安装即启用**(对齐 VSCode:装好的扩展默认启用、无需重载窗口),并提供「立即重启」兜底:

- main `installFromGit`:**全新安装**(目标目录原本不存在)成功后把 id 写入 `_enabled.json`(经 `setEnabledId` 全局串行链);
  **更新 / 覆盖安装**保留用户原有的启停状态(已禁用的不被打开)。写启用状态失败不回滚安装(插件已在盘上,可在插件页手动启用)。
- renderer `PluginManager.adoptInstalled(id)`:本窗口刚装好的新插件不必重启 —— 重新列举该 id 的目录(与启动同一准入 / 选目录),
  登记进列表,并按 `_enabled.json` 的启用状态激活(激活照常走权限授权弹窗)。已在列表 → 无操作(更新由文件监视热重载)。
  同会话内卸载后重装同 id:重装是显式意图,清掉先前卸载留下的停用意图;之后到达的卸载 / 禁用照常生效。
  重装后 main 文件监视因卸载留下的 tombstone 必广播一次 `PLUGINS_CHANGED`:随后排队的 `reload(id)` 若该 id 的目录仍是
  adopt 时那份 manifest、main 未改(列举项带 main 入口 mtime,与文件监视同一信号)、且在 adopt 后 10 秒内,就跳过(已按它登记
  并激活,不再 onunload / onload 一遍);只跳过这一次,之后的文件变化照常热重载;manifest 或 main 已变照常重载。那次广播若先于
  登记到达(reload 因条目不存在而失败、跳过标记无人消费),之后只改 main.js 或过了时限的手动「重新加载」照常执行,不被静默吞掉。
  全新安装(无先前卸载)不受影响 —— 没有 tombstone,首个 reload 即真实文件变化。
- **跨窗口**(对齐 VSCode:其它窗口立即显示已安装):main `install-from-git` 成功后向**发起窗口以外**的窗口广播
  `plugins:installed { id }`(发起窗口已自行 adopt,不重复;失败不广播;更新 / 覆盖安装也发,已在列表即无操作)。收到的窗口经
  `wirePluginEvents` 调 `adoptInstalled(id, { prompt: false })`:登记进列表(插件页 / 市场卡片显示已安装)。授权弹窗只在发起
  窗口出现、不多窗同时弹:声明的权限尚有未决定的 → 只登记为禁用、不激活、不加载插件代码,用户在该窗口启用(授权已由发起窗口
  决定则不再弹)或下次启动时激活;无权限 / 已全部决定 → 照常激活。发起窗口授权后 main 广播 `plugins:permissions-changed`,
  只登记的窗口跟进:`_enabled.json` 仍记启用、无停用意图、已无未决定权限 → 直接激活(不弹窗;授权被拒则与发起窗口一样落 failed);
  仍有未决定的 → 继续等待;别处已禁用 → 不激活。等待期间插件页该行显示「已在其他窗口安装,等待该窗口授权后自动加载;也可点
  「启用」在本窗口授权并加载」(三语,`role=status`),本窗口尝试激活 / 禁用后消失(`cross-window-grant-follow.spec.tsx`)。
- `recordPendingInstall`(设置页 Git 安装、市场卡片、市场底部 Git URL 三个入口共用)在记待重启行的同时发起 `adoptInstalled`;
  插件进列表即摘除待重启行。热激活失败(如准入不过)时待重启行保留。
- 待重启行带「立即重启」按钮 → `coApi.window.relaunchApp()` → main 走**与 ⌘Q 相同的退出流程**(各窗口脏文件确认、flush、清理),
  全部通过后 `app.relaunch()` 再退出;用户在确认框点「取消」/ 保存失败 → 退出中止,重启请求一并作废(之后正常退出不会意外重启)。
- 文案(三语):安装成功「已安装并启用 …」;待重启行「已安装,需重启 Continuo 才能加载」。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/plugins.service.ts` | `installFromGit` 全新安装写启用状态 |
| `electron/main/quit-cleanup-guard.ts` | `requestRelaunch` / `cancel` 作废 / `relaunchRequested` |
| `electron/main/ipc/window.ipc.ts` + `electron/shared/window-channels.ts` | `window:relaunch-app` IPC |
| `electron/main/index.ts` | 组合根:`relaunchApp` = 记重启请求 + `app.quit()`;退出清理完成后 `app.relaunch()` |
| `src/plugins/PluginManager.ts` | `adoptInstalled` |
| `src/plugins/pending-installs-store.ts` | 安装后发起热激活 |
| `electron/main/ipc/plugins.ipc.ts` + `electron/shared/plugins-channels.ts` + `electron/preload/index.ts` | `plugins:installed` 广播(跳过发起窗口)/ `plugins.onInstalled` |
| `src/plugins/plugin-events.ts` | `onInstalled` → `adoptInstalled(id, { prompt: false })` |
| `src/plugins/settings/PluginsTabContent.tsx` | 待重启行「立即重启」;等待其他窗口授权的说明 |
| `src/lib/plugins-host.ts` + `electron/main/services/plugins.service.ts` | 列举项带 main 入口 mtime(重装后跳过 reload 的 main 校验) |
