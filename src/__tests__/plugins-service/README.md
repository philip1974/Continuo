# plugins-service(主进程插件目录扫描)

行为契约:**`listPluginDirs(baseDir)` 扫子目录,每个含 `manifest.json` 即收;
读 manifest.main(默认 'main.js'),读 styles.css 可选**。
缺 manifest / 缺 main 直接跳过该目录,不抛;baseDir 不存在返空数组。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/plugins.service.ts` | listPluginDirs / readEnabledIds / writeEnabledIds |

## 关键行为

### listPluginDirs

- baseDir 不存在 → []
- 子项以 `.` / `_` 开头 → 忽略(隐藏目录、_enabled.json 等)
- 非目录 → 忽略
- 缺 manifest.json → 跳过该项(不抛)
- 缺 main 入口(默认 `main.js`,可被 manifest.main 覆盖) → 跳过该项
- styles.css 缺失 → stylesText undefined,其它字段照返
- 顺序:readdir 默认顺序

### readEnabledIds(baseDir) → string[]

- 文件不存在 / 解析失败 → []
- 必须是 string[];非数组或含非 string → []

### writeEnabledIds(baseDir, ids)

- baseDir 不存在 → 自动 mkdir -p 后写
- 写 `_enabled.json` 内容 `JSON.stringify(ids, null, 2)`

### uninstallPlugin(baseDir, id)(v4.6)

- id 不匹配 `[a-z0-9._-]+` → 抛 `INVALID_ID`(防路径穿越)
- 目录不存在 → 抛 `NOT_INSTALLED`
- rm -rf `baseDir/<id>/`,失败 → 抛 `RM_FAILED`
- 顺手从 `_enabled.json` 摘 id(若有),从 `_permissions.json` 删 key(若有)
