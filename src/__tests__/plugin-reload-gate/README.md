# plugin-reload-gate(插件启动期事件门控)

main 推送给窗口的三类插件事件 —— 文件变化(mtime watch → 热重载)、跨窗口卸载、跨窗口启停 —— 在 main-app 里一启动就订阅,
而 `PluginManager.init()` 是异步的:先扫描登记全部插件,再**逐个串行**激活,激活可能 await 授权弹窗 / 插件 `onload`
(不设超时)。

- R16:扫描完成前到达的 reload 因「Plugin not found」被丢弃,init 随后用旧快照激活 → 漏掉启动窗口期的变更。
- 此前的修法把三类事件缓冲到 **init 全部完成** 才放行:用户不理某个授权弹窗时 init 永不结束,整个会话里其它插件的热重载 /
  跨窗启用全部失效。

## 行为契约

- 门控在 `PluginManager` 内:`reload` / `handleUninstalled` / `handleEnabledChanged` 在**扫描完成**(`whenScanned`,
  扫描失败也算完成)前到达时先等扫描,之后经 per-id 生命周期锁处理;**不等**全部激活完。扫描完成后到达的事件同步进锁
  (不多让一拍)。扫描前到达的多个事件按到达顺序处理。
- 同步部分不等扫描 / 锁(见 plugin-capability-revoke 1b–1d):禁用 → `revokeImmediately`、启用 → `markEnabled`、
  卸载 → `markUninstalled`(取消授权弹窗)。
- 同 id 的事件与 init 激活经生命周期锁排序:init 正在激活 A(授权弹窗挂起)时收到 A 的 reload → 排在激活之后执行,先激活
  旧快照再热重载,单实例;收到 A 的禁用 → 授权返回后激活查到停用意图中止,不加载插件代码,落 `disabled`。
  轮到 init 激活时已被事件激活 / 禁用 / 卸载的条目由 init 跳过(见 plugin-manager `whenScanned`)。
- 已卸载(`'uninstalled'` 停用意图)的插件收到 reload → 直接返回,不报错(扫描完成前排队、随后收到卸载的 reload 等价于丢弃)。
- 接线 `wirePluginEvents(mgr, sources, onError)`(`src/plugins/plugin-events.ts`):main-app 先发起 `init()` 再接线;
  处理失败交给 `onError(where, err)`,不抛。

## 规范文件

- `plugin-reload-gate.spec.ts`:扫描完成前的 reload 在登记后执行;扫描前 reload + 卸载 → 不报错、卸载照常;扫描失败后事件
  照常处理;某插件授权弹窗挂起时其它插件的 reload / 跨窗启用 / 禁用 / 卸载立即生效、init 不重复激活;同 id reload / 禁用
  与挂起激活的排序;reload 失败走 onError。
