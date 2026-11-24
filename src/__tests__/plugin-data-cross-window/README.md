# plugin-data-cross-window(插件 data.json 跨窗口缓存失效)

每个主窗口各跑一份插件实例,各有一个 `IpcPluginDataStore` 单例(`coApp.dataStore`),插件读过一次后
`read()` 返回本窗内存缓存。插件只能整份读-改-写 data.json。此前 main 写盘后不通知其它窗口:

> 窗口 B 先读到整份 data;窗口 A 改设置并保存;B 再用旧缓存改一处后整份写盘 → A 的改动被抹掉。

与 `_enabled` / `_permissions` 的写后广播同一模式(见 `plugin-permission-cross-window`)。

## 行为契约

### main(`electron/main/ipc/plugin-data.ipc.ts`)

- `plugin-data:save-serialized` 落盘成功后经 `broadcastToWindows` 推 `plugin-data:changed { id }`
  给**发起窗口以外**的所有窗口。发起窗口自己的缓存在 save 成功后已提交为新值,再失效只会多一次
  (最大 16MiB 的)整份重读,故跳过。popout 子窗不跑插件、不订阅,收到也无副作用(沿用既有广播规则)。
- 写失败(校验拒绝 / 未安装 / IO 错误)→ 不广播。

### preload(`electron/preload/plugin-data.preload.ts`)

- `pluginDataRaw.onChanged(cb)`:订阅上面的广播,payload 原样(`unknown`)交给 renderer,返回 unsubscribe。

### renderer(`src/plugins/PluginDataStore.ts`)

- `wirePluginDataInvalidation(store)`:订阅广播,payload 经 `{ id }` 守卫校验(畸形丢弃),对合法 id 调
  `store.forget(id)`:清本窗缓存,并作废在途 load / save 的回填代际;下一次 `read()` 重新从盘读。
  启动接线在 `src/main-app.ts`(popout 已早退,只主窗接)。
- SDK 没有 dataStore 变更事件,不新增插件 API:插件只保证下一次 `loadData()` 读到别窗写入的新值。

## 规范文件

- `main-broadcast.spec.ts`:save 成功 → 发给其它窗口、不发给发起窗口;失败不广播。
- `renderer-invalidate.spec.ts`:A 写后 B 的下一次 read 得到新值;B 的整份读-改-写不再抹掉 A 的改动;畸形 payload 被丢弃。
