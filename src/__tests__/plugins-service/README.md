# plugins-service(主进程插件目录扫描)

行为契约:**`listPluginDirs(baseDir)` 扫子目录,每个含 `manifest.json` 即收;
判定 manifest.main(默认 'main.js')可用但不读源码(激活时经 `readPluginMainByDir` 按目录名读取)。
styles.css 不读取(renderer 不注入插件样式)**。
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
- 目录里的 styles.css 不读取,结果里没有 stylesText 字段
- 结果只含 `{ id: 目录名, manifestText }`,**不含 mainText**;main 可用性用 open + fstat 判定(普通文件且 ≤8MiB),
  与读取口径一致(main 是目录 / 超限 / 越界 / 缺失 → 跳过)
- 顺序:readdir 默认顺序(per-dir 读取有界并发 ≤8,结果仍按枚举顺序)

### readPluginDirByManifestId(baseDir, id)(perf:热重载只读目标插件)

- 结果与 renderer `findPluginDirByManifestId(listPluginDirs(baseDir), id)` 等价
- 目录名 == id 且 manifest.id 一致、main 可读 → 直接返回,不读其它插件文件
- 否则只读其它目录 manifest,取 manifest.id 匹配者中目录名字典序最小且 main 可读的
- `.` / `_` 前缀、损坏 manifest、缺 main 不参与;无匹配 / baseDir 缺失 → null

### readPluginMainByDir(baseDir, dirName)(perf:激活时才读 main 源码)

- 按**目录名**(列举结果的 id)读 manifest.main 指向的入口源码;按目录而非 id,不再做一次重复 id 选择
- 目录名为空 / 含 `/` `\` NUL / 为 `.` `..` / `.` `_` 前缀 → null(不读 baseDir 之外)
- 目录 / manifest / main 不可用(缺失、超 8MiB、越界)→ null
- IPC:`plugins:read-main-by-dir`,入参 `{ dir }`(1..255 字符,strict)

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
