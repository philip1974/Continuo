# user-settings-main-store(设置值与快捷键覆盖存在主进程文件)

此前设置值(`continuo.settings.values`)与快捷键覆盖(`continuo.keybindings.overrides`)存在 renderer localStorage。Chromium 延迟数秒
才把 localStorage 刷到磁盘:改完设置后数秒内主进程崩溃 / 被强杀 / 断电,刚改的设置丢失(实测改后 1.3s / 3.5s 强杀均丢,8s 后保留)。

对齐 VSCode:设置与快捷键存在 userData 下的文件(`User/settings.json` / `User/keybindings.json`),每次修改立即写盘
(`src/vs/workbench/services/configuration/common/configurationEditing.ts`、`.../keybinding/common/keybindingEditing.ts` 经 `Queue` 串行编辑并
`textFileService.save`;`src/vs/platform/files/node/diskFileSystemProvider.ts` 关闭写句柄前 `fdatasync`);多窗口各自监听文件变化
(`.../configuration/browser/configuration.ts` 的 `FileServiceBasedConfiguration` + 50ms `RunOnceScheduler`)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/user-settings.ts` | 通道、快照 / 广播形态与守卫、限幅常量(main / preload / renderer 共用) |
| `electron/main/services/user-settings.service.ts` | 权威存储:`userData/user-settings.json`、`userData/user-keybindings.json`;串行读-改-写、原子写盘、损坏隔离、迁入 |
| `electron/main/ipc/user-settings.ipc.ts` | 同步快照(只给受信 frame)、UPDATE / IMPORT(safe-handle + zod)、提交后广播 |
| `electron/preload/index.ts` `userSettings` | `snapshot()`(sendSync)/ `update` / `importLegacy` / `onChanged` |
| `src/plugins/storage/user-settings-record.ts` | renderer 侧:首帧初值、乐观写 + 增量发送、按版本收敛、一次性迁移 |
| `src/plugins/settings/values-store.ts` / `src/plugins/keybindings/keybindings-store.ts` | 两个 store(API 不变) |
| `src/theme/initial-theme.ts` | 首帧主题与 values-store 同一来源 |

## 行为

### 存储(`user-settings-service.spec.ts`)

- 文件名不与 main 自己的 `settings.json`(`{version, locale}` 严格 schema)冲突;两类记录各一个文件,格式为扁平 JSON 对象(同 values 结构)。
  不做设置 JSON 编辑器。
- 每次修改立即原子写盘(临时文件 + fsync + rename),**写调用回复之前文件已是新内容**:回复之后主进程被 kill -9 / 崩溃 / 断电都不丢;
  丢失窗口只剩「renderer 发起 → main rename 完成」这几毫秒(此前是 Chromium 刷 localStorage 的数秒)。不做延时合并。
- 读-改-写在 main 串行队列内,renderer 只发增量(设哪些 key、删哪些 key):多窗口同时改不同 key 都保留(顺带消除此前 localStorage 上
  跨窗 lost update,race R113)。无变化不写盘、不升版本、不广播。
- 缺文件 → 空记录,`needsImport`(待迁移)。
- 损坏(JSON 坏 / 非对象 / 有非法条目 / 超大 2 MiB):原文件隔离为 `.corrupt`(已有则 `.corrupt.<时间戳>`)留证,合法条目抢救出来立即写回
  (空也写:文件存在即「已迁移」,不会再从旧 localStorage 迁入陈旧值),之后照常写盘。
- 读不出来(权限 / IO,内容未知)→ 本次运行按空记录,`persistBlocked`:修改只留在内存(各窗口照常同步),**不写盘**、不接受迁入;renderer 在
  第一次修改后提示一次「本次修改不会保存」(同受信任的域 / 工作区信任的处理)。
- 超条目(10000)/ 超文件字节上限 → 拒写(`PAYLOAD_TOO_LARGE`),记录与文件不变;写盘失败同样不提交。

### IPC 边界(`user-settings-ipc.spec.ts`)

- 同步快照只给受信 renderer frame,不受信 → `null`;UPDATE / IMPORT 不受信 → `IPC_DENIED`。
- zod 限幅:scope 枚举;值只能是字符串(≤64 KiB)/ 有限数 / 布尔;key ≤256;单次 set / remove ≤1000 条;迁入 ≤10000 条;多余字段拒。
- 每次提交向所有窗口广播 `{scope, version, record}`,回复带同一状态。

### renderer ↔ main(`renderer-main-roundtrip.spec.ts`)

- 首帧:store 创建时(及入口模块定首帧主题时)经同步快照拿到当前值 —— 主题 / 语言 / 字号等首帧即正确,不闪默认值。
- 写:先乐观更新本窗内存,再发增量;main 拒写 / 写盘失败 → 回滚到上次有效状态(超限 warn,写盘失败通知)。
- 收敛:只接受比已知更新的版本(乱序到达的旧广播被忽略);本窗有未回复的写时不让别窗广播把乐观值改回去,全部回复后收敛到最新权威状态。
  快照与广播都经 store 原有的读端守卫(设置值原语 / 快捷键形态,E22 / E240)。
- 首次迁移:main 文件原本不存在、从未镜像过(见下)而旧 localStorage 有值 → 首帧即旧值,迁入文件(旧设置 id 一并改名);多个窗口同时迁入只生效一次;
  从未镜像过而文件已存在(含损坏后写回的)→ 以文件为准,不从旧 localStorage 猜改动。

### 旧版本兼容:降级 / 再升级(`renderer-main-roundtrip.spec.ts`「旧版本兼容」、`user-settings-service.spec.ts`「语言」)

0.2.15 只读写 localStorage 的 `continuo.settings.values` / `continuo.keybindings.overrides`。权威始终是 main 的文件,旧键只是给降级后的旧版本看的镜像:

- 镜像:每次拿到权威新状态(写回复 / 广播 / 启动时无待发改动)就把记录写回旧键 —— 改过名的设置写旧 id(`terminal.integrated.fontSize` →
  `terminal.fontSize`、`terminal.integrated.cursorStyle` → `terminal.cursorStyle`),快捷键键名 / 值格式与旧版相同 —— 并在 `<旧键>.mirror`
  记下写进去的原文。降级后旧版本看到的就是新版最后的设置。
- 再升级:旧键与 `.mirror` 不同 = 降级期间旧版本改过 → 把它相对镜像的改动(设 / 重置,旧 id 落到新 id)并进文件,新版独有的设置不丢;相同 =
  旧版本没动过,以文件为准。旧键整个不见了(旧版本当损坏清掉)不当成「全部重置」。
- 删除 `user-settings.json` / `user-keybindings.json` 后重启 = 恢复默认(VSCode 删 settings.json 同):镜像过且旧键未被改过 → 不回灌旧值,
  旧键随即镜像成空(降级后旧版本也是默认)。
- 权威仍是文件,镜像不会重新引入「强杀丢失」:镜像没落盘只让旧版本看到稍旧的值;旧键与 `.mirror` 在同一任务里写、同批落盘,不会被误判为旧版本改动。
- 读盘失败(`persistBlocked`)的运行不镜像、不并入。
- 语言:界面语言的权威在 main `settings.json`(`locale`),设置项 `general.language` 在 `user-settings.json`,平时两边一起改。启动建窗前若两者
  不一致,按文件修改时间较新者胜:`settings.json` 较新(降级期间旧版本改了语言,而它的 localStorage 没来得及落盘)→ 写进 `general.language`
  (等于系统默认则删掉);`user-settings.json` 较新 → 不动,renderer 照常把 `general.language` 推给 main。
- 无 main(单测 / 无 preload):按旧 localStorage 记录只读初始化,修改只留在内存。

### 端到端(`tests/e2e/settings-crash-durability.spec.ts`)

- 改设置 / 快捷键后立即 kill -9 自己的主进程,重启后保留;两个窗口经 main 同步;预置旧 localStorage 后首次启动迁入;损坏文件隔离后照常使用。

## 刻意差异

- VSCode 各窗口监听 `settings.json` 文件变化重载;这里由 main 串行写并直接广播(没有用户手改文件的入口,不需要文件监听)。
- VSCode 保存设置文件走普通写(`diskFileSystemProvider.writeFile` 只在调用方传 `atomic` 选项时才走临时文件 + rename);这里一律原子写
  (临时文件 + fsync + rename),写到一半崩溃也不会留下截断的文件。
- 不做 JSON 编辑器 / 不支持注释(用户已明确不做设置 JSON 编辑)。
