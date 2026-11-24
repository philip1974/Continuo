# plugin-install-enable

插件**安装即启用**(对齐 VSCode:装好的扩展默认启用、无需重载窗口),并提供「立即重启」兜底:

- main `installFromGit`:**全新安装**(目标目录原本不存在)成功后把 id 写入 `_enabled.json`(经 `setEnabledId` 全局串行链);
  **更新 / 覆盖安装**保留用户原有的启停状态(已禁用的不被打开)。写启用状态失败不回滚安装(插件已在盘上,可在插件页手动启用)。
- renderer `PluginManager.adoptInstalled(id)`:本窗口刚装好的新插件不必重启 —— 重新列举该 id 的目录(与启动同一准入 / 选目录),
  登记进列表,并按 `_enabled.json` 的启用状态激活(激活照常走权限授权弹窗)。已在列表 → 无操作(更新由文件监视热重载)。
  同会话内卸载后重装同 id:重装是显式意图,清掉先前卸载留下的停用意图;之后到达的卸载 / 禁用照常生效。
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
| `src/plugins/settings/PluginsTabContent.tsx` | 待重启行「立即重启」 |
