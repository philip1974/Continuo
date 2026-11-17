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
- `start(intervalMs, { immediate:false })` 不立即首扫(生产用法:冷启动不与启动 IO 争 libuv 线程池),首扫等第一个周期
- `ensureBaseline()`:基线已建立 → 立即返回;首扫在途 → 等它结束;未开始 → 立即扫一次并等待(失败也返回)
- `LIST_DIRS` 在列举前 `await ensureBaseline()`(串行):列举之后的插件修改必被下一轮 tick 广播 CHANGED,
  无「基线吞掉修改」的漏报窗口(`list-dirs-baseline.spec.ts`)
- 同 plugin 多次连续触发不去重(由 renderer 端节流;通常 mtime 跨 tick 变一次)
- manifest **内容**变化(哈希,同 LIST_DIRS 令牌)也 fire;只 touch、内容不变不 fire —— 激活时令牌不一致而失败的
  插件靠此广播重新加载
- 已被记录的目录改声明新 id → 对新 id fire(旧 id 记录清理)

## perf:manifest 解析缓存 + 有界并发

- manifest 的 (ino, size, mtime, ctime) 未变 → 不再读取 / JSON.parse,复用上次解析结果
- 原地改写(即使 mtime 被还原,ctime 必变)、原子替换(rename → 新 ino)、删除(stat 失败跳过)、新增 → 都会重新解析
- per-dir stat 有界并发(≤8);mtime 比较与 onChange 仍按目录枚举顺序串行
- manifest 超 1MiB → 跳过该目录,按 stat 签名缓存「跳过」:签名不变不再每轮 open + 告警(只告警一次),改小后重新解析;
  读失败(EACCES 等)不缓存,每轮重试
- 插件目录条目达枚举上限(1024)→ 截断告警每个 watcher 只在进入截断状态时打一次(回落到上限以下后再超限会再告警)

## 重复 manifest.id(防热重载风暴)

- 多个目录声明同一 manifest.id 时,每个 id 只看**唯一权威目录**:目录名 == id 优先,否则目录名字典序最小
  (与 `PluginManager.preferPluginDir` / `readPluginDirByManifestId` 同规则);非权威目录的 main 变化不 fire
- 候选口径与列举 `isPluginMainAvailable` 一致:main 须为普通文件且 ≤8MiB(仅凭 stat 判定,不逐轮 open;
  读权限不校验),否则不参与权威目录选择 —— 首选目录 main 无效时以合法后备目录为权威,其 main 变化 fire
- 各目录都未变化 → 多轮扫描都不 fire(此前 mtime 表以 id 为键,两目录轮流写入 → 每轮都广播)
- 权威目录切换(出现目录名 == id 的目录 / 原权威目录消失)→ fire 一次,之后稳定
- 记录所属目录改声明别的 id → 旧 id 的记录清理;目录暂时消失 / manifest 缺失 / main 暂不可 stat 时保留记录,
  重建后 main 已变仍 fire
- 缺失记录(tombstone)不限时保留:缺失再久,重建(main 已变)仍 fire;只按容量淘汰(记录总数超上限
  2×目录枚举上限时淘汰最早缺失的),每轮只按本轮出现的目录查 tombstone,不遍历全部缺失记录
- 缺失记录所属目录重建后改声明别的 id → 该缺失记录清理

## 首窗后提前建基线(baseline-prime-wiring.spec.ts)

- `registerPluginsIpc` 仍不在注册时首扫;index.ts 在首窗创建后调用 `primePluginsWatcherBaseline()`,
  在安装恢复完成后 `ensureBaseline()`。renderer 首次 `LIST_DIRS` 时基线通常已建好或在途,不再在插件 init
  关键路径上当场串行扫描。
