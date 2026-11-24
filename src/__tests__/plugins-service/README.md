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
- 目录名 ≠ manifest.id(手动 clone 成 `hello-plugin/` 而 id 为 `com.example.hello`)→ 跳过并告警一次:main 的卸载 / 授权写入 /
  saveData 都按 `plugins/<manifest.id>/` 定位,不一致时插件能激活却全部写入报「未安装」;manifest 无法解析的不在此判(交 renderer 报错)
- 跳过的每种原因(main 入口不可用的各类、目录名不一致)都在主进程记一条告警,按目录 + 原因只记一次
- 目录里的 styles.css 不读取,结果里没有 stylesText 字段
- 结果只含 `{ id: 目录名, manifestText, manifestHash }`,**不含 mainText**;main 可用性用 open + fstat 判定(普通文件且 ≤8MiB),
  与读取口径一致(main 是目录 / 超限 / 越界 / 缺失 → 跳过)
- 顺序:readdir 默认顺序(per-dir 读取有界并发 ≤8,结果仍按枚举顺序)

### readPluginMainByDir(baseDir, dirName, manifestHash)(perf:激活时才读 main 源码)

- 按**目录名**(列举结果的 id)读 manifest.main 指向的入口源码;按目录而非 id,不再做一次重复 id 选择
- 目录名为空 / 含 `/` `\` NUL / 为 `.` `..` / `.` `_` 前缀 → null(不读 baseDir 之外)
- 目录 / manifest / main 不可用(缺失、超 8MiB、越界)→ null
- 快照一致性(P1):`listPluginDirs` 每项带 `manifestHash`(manifestText 的 sha256 hex);读 main 前、后各复核当前
  manifest 哈希 == 入参令牌,不一致(列举后插件被更新)→ 抛 `PLUGIN_MANIFEST_CHANGED`,不返回新 main
- IPC:`plugins:read-main-by-dir`,入参 `{ dir, manifestHash }`(dir 1..255 字符;manifestHash 64 位小写 hex;strict)

### readEnabledIds(baseDir) → string[]

- 文件不存在 / 解析失败 → []
- 必须是 string[];非数组或含非 string → []

### 插件元数据表 plugin key 上限(读写对称)

- `_enabled.json` / `_permissions.json` / `_plugin-path-scopes.json` 的 plugin key 数上限统一为
  `PERMISSION_RECORD_LIMITS.PLUGIN_KEYS_MAX`(`electron/shared/permission-record-limits.ts`),读写两端同用
- 读端:超上限截断到前 `PLUGIN_KEYS_MAX` 个合法 key
- 写端:写入后 key 数会超上限(只可能是新增 key)→ 抛 `PAYLOAD_TOO_LARGE`,不触盘(`setEnabledId` / `writeEnabledIds` /
  `mutatePluginPermissions` / `writePermissions` / `writePluginPathScopes`);已有 key 的更新 / 删除不受影响
- 三表共用读取底层(有界读 → 仅 ENOENT 当缺文件 → JSON.parse → 形态校验,损坏留 `.corrupt` 快照);损坏后处理照旧:
  `_enabled.json` / `_permissions.json` 当空读取,`_plugin-path-scopes.json` 拒绝写入

### writeEnabledIds(baseDir, ids)

- baseDir 不存在 → 自动 mkdir -p 后写
- 写 `_enabled.json` 内容 `JSON.stringify(ids, null, 2)`

### uninstallPlugin(baseDir, id)(v4.6)

- id 不匹配 `[a-z0-9._-]+` → 抛 `INVALID_ID`(防路径穿越)
- 目录不存在 → 抛 `NOT_INSTALLED`
- rm -rf `baseDir/<id>/`,失败 → 抛 `RM_FAILED`
- 顺手从 `_enabled.json` 摘 id(若有),从 `_permissions.json` 删 key(若有)
