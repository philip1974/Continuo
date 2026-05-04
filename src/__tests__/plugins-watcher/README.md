# plugins-watcher(mtime 自动 watch)

行为契约:**轮询每个 plugin main.js mtime,变化触发 onChange(pluginId)**;
首次扫只填表不 fire(避免启动即一次性触发所有 plugin)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/plugins.service.ts` 中 `createPluginsWatcher` | tick + start/stop |

## 关键行为

- `createPluginsWatcher(baseDir, onChange)` 返 `{ tick, start }`
- 第一次 `tick()` 只填 mtime 表,不 fire(防启动 boom)
- 第二次起 mtime 变 → 触发 `onChange(manifest.id)`(用 manifest.id,
  不用目录名)
- baseDir 不存在 / 无权限 → tick 静默返回,等下次重试
- 单 plugin manifest 解析失败 / main 文件缺失 → 跳过该 plugin,其它继续
- start(intervalMs) 启动 setInterval,返 dispose 停 timer
- 同 plugin 多次连续触发不去重(由 renderer 端节流;通常 mtime 跨 tick 变一次)
