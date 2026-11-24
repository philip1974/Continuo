# plugin-editor-open-verified(插件 `app.editor.openFile`:校验与读取在同一把锁内)

## 背景(审计 L1)

此前插件的 `editor.openFile(path)` 是两步:renderer 先发 `plugin-fs:check-path`(主进程持共享锁做 scope 校验,
返回布尔值),通过后宿主编辑器经**受信**通道 `fs:read-file` 按插件给的原路径字符串再读一次。两步之间插件可以只用
SDK 并发 `rename(A → A_)` + `rename(L → A)`(L 是 scope 内既有的、指向 scope 外目录的链接;例如 `fs.cp('/Volumes', …)`
复制出的 `Macintosh HD -> /`),宿主按原路径就读到 scope 外的任意文件(包括受保护的 `<userData>/plugins/_permissions.json`),
显示在编辑器标签里。内容不回传插件,但用户随后保存 / 外部同步重载同样按路径进行。

## 行为

- 插件的 `editor.openFile` 改为主进程 `plugin-fs:read-for-editor`:在 plugin-fs 全局读写锁的共享锁内完成「scope 校验 +
  读取」(沿用 `readFile` 的打开后 fd 复核:fd 与复核到的文件 dev/ino 相同才读),返回已校验的 `canonicalPath` 与内容。
  读取规则与编辑器自己的读取入口一致:64 MiB 上限、非法 UTF-8 拒绝(`FS_NOT_UTF8`)、非普通文件拒绝(`FS_NOT_FILE`)。
  scope 外 / 不存在 / 受保护目录 → 同一个拒绝结果(`SCOPE_ERROR`,不可区分);身份错误(未知 token)照抛。
- renderer 用这份已校验内容在 `canonicalPath` 上开标签(宿主内部入口 `CoHostEditorApi.openVerifiedFile`,插件拿到的
  `app.editor` 只有 `openFile`),不再经 `fs:read-file` 另读。已开着同一路径的标签 → 只切换,不覆盖其内容。
  「同一路径」:canonical 路径或插件给的原路径,命中已有标签的打开路径(filePath)或其 realPath 任一即算 —— 用户经链接
  (macOS `/tmp` → `/private/tmp`、工作区软链、文件链接)打开的标签 filePath 不是 canonical,只比 canonical 会多开一个
  同文件标签、两份各自记脏。原路径只用于这次判重,不据它读取任何内容。
- SDK 对插件的返回值不变:成功 `{ ok: true, lineApplied, reason? }`;scope 拒绝 → `PERMISSION_DENIED`(消息同前);
  `FS_NOT_FILE` 等原样,其余 FS 码(`FS_NOT_UTF8` / `FS_FILE_TOO_LARGE`)归 `EXCEPTION`(与此前宿主读取失败的映射相同)。
- 之后的保存 / 保存前比对 / 外部同步重载:主进程记下插件打开过的 canonical 路径(每插件 1024、合计 4096,见下)。宿主 `fs:read-file` /
  `fs:write-file` 对这些路径在共享锁内先确认「realpath 仍等于自身」(途中没有被换入链接;文件已删时父目录仍 canonical
  且叶子不是悬空链接),确认与读 / 写在同一次持锁内;否则 `FS_DENIED`。其它路径直通(不取锁、不多任何系统调用)。
  - 为何不靠既有的保存前磁盘比对(`EDITOR_DISK_CHANGED`):它只比内容,用户点「仍然覆盖」(`force`)就会跳过比对、
    经链接写到 scope 外;且 scope 外文件内容恰好与原内容相同时比对也放行。
  - 为何比 realpath 而不比 (dev, ino):编辑器保存是「临时文件 + rename」,每次保存 inode 都变,正常的外部原子保存也一样;
    越出 scope 必须经过链接,比 realpath 正好。
- 记录与标签生命周期绑定、满额拒绝而不淘汰(审计 F2):此前按最近使用淘汰,插件再打开 4096 个别的文件就能把目标路径
  挤出记录、解除保护。现在每次成功的 `read-for-editor` 记一份(按发起窗口的 webContents 计数);renderer 用这份内容
  新建了标签 → 由该标签持有,标签以任何方式消失(关闭 / 删除文件 / 切 root / 整体清空)时经
  `plugin-fs:release-editor-path` 释放(`src/plugins/plugin-opened-tabs.ts` 订阅编辑器 store 对账);没有新建标签(已开着
  只切换 / 打开失败 / 插件已吊销)→ 当即释放。窗口关闭 / renderer 重载时主进程整窗释放;一个窗口释放不了别的窗口的记录。
  满额后新的 `read-for-editor` 返回 `FS_BUSY`(插件 `openFile` 得到 `EXCEPTION`),已有记录照常生效。
- 名额按插件:每插件至多 `PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX`(1024)份(同一插件各窗口 / 各实例合计),全部插件合计至多
  `PLUGIN_OPENED_PATHS_MAX`(4096)份。此前只有全局上限:一个插件连续 `openFile` 4096 个文件即让所有插件的 `openFile`
  失败,直到用户关标签。释放通道只带路径,同一窗口同一路径的多份按后进先出归还(「已开着只切换 / 被吊销」当即释放的
  正好是刚记的那份)。
- 插件打开的标签不进会话快照(审计 F1):上面的记录只在主进程内存里,重启后宿主按快照里的路径经 `fs:read-file` 重读
  时不再受确认保护 —— 插件在上次运行里换入的链接(`openFile(T=w/a/sub/x.md)` → `rename(w/a → w/a_)` →
  `rename(w/MH → w/a)`,MH 是 scope 内指向 scope 外的链接)会让恢复出的标签显示 scope 外的内容,保存也写到 scope 外。
  所以 `openFileWithContent` 新建的标签带 `pluginOpenedPath` 标记,`collectEditorSnapshot` 跳过这类标签(是活动标签时
  `activePath` 也不记)。用户之后从文件树再打开同一路径只是切换到这个标签,标记保留到标签关闭(简单保守);用户先打开、
  插件再打开同一路径则仍是用户的标签,照常持久化。行为变化:插件打开的标签重启后不再恢复。

## 残余

- 锁只管 plugin-fs 自己的调用(见 `plugin-fs-rw-lock` 残余):有 `shell` 权限的插件、用户自己的进程对目录的并发改动不在此列;
  外部进程把目录换成链接后,宿主对已记录路径的读 / 写会被拒(`FS_DENIED`),但在「确认 → 读 / 写」之间精确换入的外部
  竞态者理论上仍可通过。
- 名额按插件后,要 4 个以上插件各自开满才会触到全局上限;同一窗口两个插件开同一路径时名额归属按后进先出推断,
  偏差至多在同窗口的插件之间挪动名额(全局上限不受影响)。
- 反方向(插件先打开、用户再经链接路径从文件树打开)仍按用户给的路径判重:插件标签 filePath 是 canonical、无 realPath,
  用户的链接路径命中不了,会再开一个同文件标签。
- 插件打开的标签被重命名(用户在文件树里改名 / 移动其上级目录)后,标签换到新路径,主进程记录仍是旧路径 —— 新路径不受
  保存期确认保护(同用户自己打开的标签)。
- 修复前写入的旧快照里,插件打开的标签没有标记、无法与用户打开的区分,下次启动仍会按路径恢复(不受确认保护);
  属一次性残余 —— 恢复后再写快照时它就是普通标签了。
- 用户自己经 Explorer 打开同一路径的标签同样受此确认(路径被换成链接后保存被拒),属有意的 fail-closed。

## 规范

- `main-read-for-editor.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录:读取结果与规则、
  换入后再打开被拒、在读取的 `open` 上挂钩子并发换入(被挡在锁外)、3000 次并发打开 × 换入换出读穿 0 次;
  宿主 `fs:read-file` / `fs:write-file` 注册的是带确认的处理器、换入后读写被拒、悬空叶子链接、确认与写入同锁、外部进程换入。
- `scoped-open-end-to-end.spec.ts` —— 插件 scoped app → 真实主进程 handler → 真实编辑器 store → 真实保存:审计时序
  (scope 校验 IPC 一返回就换入)标签仍是良性内容、200 次错开时机的并发换入读穿 0 次、标签绑定 canonical 路径且不经
  `fs:read-file` 另读、已开标签不被覆盖、换入后普通保存与「仍然覆盖」都被拒;用户经目录链接 / 文件链接打开的文件,
  插件以原路径 / 真实路径再打开只切到用户的标签,不新建。
- `plugin-opened-lifecycle.spec.ts` —— 同上的端到端 + 真实快照 / 会话恢复:插件打开的标签不进快照、用户打开的照常、
  用户「接管」后标记保留、用户先开的不被打标记;审计重启序列(修复前恢复出的标签内容是 scope 外文件)修复后不恢复。
  记录上限:打开 T 后再打开 1024(每插件名额)个别的文件,超出的 `FS_BUSY`、换入后宿主读 T 仍被拒(修复前 T 被挤出、读到 scope 外);
  满额时 `openFile` → `EXCEPTION`;一个标签一份、关闭即释放、只切换不多占;反复开关 4106 次不泄漏;删除文件 / 整体清空
  同样释放;读取后插件被吊销当即释放;释放只作用于本窗口;webContents 消失整窗释放。名额按插件:A 开满自己的名额后
  B 的 `openFile` 照常;合计到 4096 后名额未满的插件也 `FS_BUSY`、释放一份即恢复;同窗口 A 开、B 再开同一路径(只切换)
  当即归还的是 B 的那份,关标签归还 A 的。
