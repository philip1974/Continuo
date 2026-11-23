# plugin-manager(插件目录扫描 + 启用禁用 + 生命周期编排)

行为契约:**给定插件根目录(实现注入,主进程通过 IPC 提供)+ 启用列表,
PluginManager 扫描所有候选 → 解析 manifest → 按 enabled.json 过滤 →
loadPluginModule → new PluginClass → activate;暴露 enable/disable/listAll 方法。**

I/O 全部抽象为接口注入(`ManagerHost`),便于 jsdom 单测。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/PluginManager.ts` | `PluginManager` class + `ManagerHost` 注入接口 |

## 关键行为

### 扫描

- `host.listPluginDirs()` 返回 `[{ id, manifestText, moduleUrl }]`
- 调 `parseManifest`,失败的跳过 + warn
- 调 `isVersionCompatible`(若 manifest 有 minLMVersion),不兼容跳过 + warn
- 多个目录声明同一 `manifest.id` → 只在**通过准入**(上两条)的目录中保留一个(目录名 == id 优先,否则目录名
  字典序第一个),其余跳过 + warn(防双激活留孤儿实例)
- 准入与选目录是同一个函数 `selectPluginDirs`,`reload` 也用它(重新列举全部目录后取目标 id):启动与热重载
  对同一份磁盘状态总是选同一目录、同样拒绝不兼容版本。热重载时目标 id 没有合格目录但仍有目录声明它 →
  条目 `failed`(manifest 错误码,或 `INCOMPATIBLE_VERSION`),不激活;没有任何目录声明它 → 抛 no longer exists

### 启用过滤

- `host.readEnabledIds()` 返回 `Set<string>`
- 不在集合内的解析成 "discovered but disabled",不激活

### 激活

- 对每个 enabled 插件:`loadPluginModule` → `new PluginClass(app, manifest)` → `_activate()`
- 任一插件 onload 抛错:**单插件失败不传染**,记录 error 并跳过
- 结果记在各插件 entry 的 `status`(`enabled` / `failed`,失败带 `error`)

### enable / disable 单插件

- `enable(id)`:若已 active 直接返回 ok;否则 load → new → activate,写入 enabled.json
- `disable(id)`:若不 active 直接返回 ok;否则 `_deactivate` + 移除 enabled.json
- 激活前先重试回收停用时保留的 plugin-fs token;仍失败 → 中止激活(不加载插件、不注册新 token),状态 `failed`、错误码 `PLUGIN_FS_TOKEN_REVOKE_FAILED`,残留 token 保留待下次重试

### uninstall 单插件(v4.6)

- `uninstall(id)`:若 enabled 先 disable,再调 `host.removePluginDir(id)`(主进程 rm -rf + 清 _permissions),最后从 entries map 删
- 删目录前重试回收停用时保留的 plugin-fs token;仍失败 → 抛 `PLUGIN_FS_TOKEN_REVOKE_FAILED`,不删目录、保留 entry(可重试)
- 不存在的 id → 抛 `not found`
- host 未实现 `removePluginDir` → 抛 `NOT_SUPPORTED`(向后兼容,jsdom 测试无需 mock 文件系统)

### listAll

- 返回 `[{ id, manifest, status: 'enabled' | 'disabled' | 'failed' }]`

### init

- `init()`:扫描 + 激活全部 enabled。两阶段:先登记全部插件 entry(`whenScanned()` resolve,`listAll()` 已含全部插件),
  再按同一顺序逐个在生命周期锁内激活;激活前在锁内重查 —— 已被卸载(entry 移除)/ 已禁用 / 有停用意图 → 不激活(落 `disabled`)
- `whenScanned()`:扫描完成信号,不等激活(某插件授权弹窗 / onload 挂起时 init 可能长时间不完成);init 扫描失败也 resolve。
  启动更新检查挂在它上面(见 marketplace-update-store)。规范:`when-scanned.spec.ts`
