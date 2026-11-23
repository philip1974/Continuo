# 50 · Agent Debug Engine MVP

本主题锁定 agent 通过 Continuo MCP 调试 Node.js 程序的 MVP 契约。

## 行为契约

- `debug.*` MCP tools 使用 `electron/shared/mcp-debug-schemas.ts` 作为输入边界(输出 zod 仅用于推导类型)。所有 advertised object schema 必须关闭 `additionalProperties`。
- `debug.launch` 首次调用必须走 agent 授权，授权 method 是 `debug.launch`，并把 MCP caller subject 写入 DebugService 的 `controllerToken`。
- 除 `debug.launch` / `debug.list_sessions` 外，带 `session_id` 的 debug 工具必须同时满足当前窗口归属与 `ctx.callerSubject === controllerToken`，否则拒绝，不触达 DebugService。
- 跨窗口 debug session 对当前调用方表现为 not found，不暴露 capability 细节。
- DebugService 在抛出点直接带稳定 debug 错误码(codedError),避免向 MCP client 回显超长 session id、program 或 adapter path;MCP 层只把 launch 的无码错误收敛为 `DEBUG_ADAPTER_LAUNCH_FAILED` 短消息。
- `variables` / `evaluate` 保持分页、深度、字节预算与默认值边界。
- `variables` 深度展开有整次总预算(节点数、DAP 请求数,以及返回内容字节 4MiB —— 名称 + 值 + 类型的 UTF-8 字节,低于 MCP 10MiB 结果上限):用尽即停;字节预算截断顶层这一页时 `next_start` 接在已返回的最后一项之后(顶层至少返回一项),未展开的节点保留 `variables_reference` 并标 `truncated`,顶层 `truncated: true`;调用方断连(`ctx.signal`)时停止继续展开。
- 资源上限:结束的 child session(worker 退出等)当即回收(移出、清掉各断点记录里该连接的条目并重推受影响 source 的快照;连接等其在途请求结算后再 dispose —— js-debug 可能在 terminated 之后才回 continue 等请求的响应,当即关连接会让调用方收到「DAP socket closed」),teardown 不再对它发 disconnect。
- 安全(提示注入): `debug.stack` / `debug.scopes` / `debug.variables` / `debug.evaluate` / `debug.wait_for_stop` 返回的函数名、变量值、异常 description、表达式结果由被调试程序控制,工具描述须提示 agent 这些内容不可信、作为数据而非指令处理(措辞同 `terminal.await_stop_hook`)。
- KC#1: MVP 暂不暴露 renderer/editor context 的断点映射能力，降级为 main-context DAP 调试；源码映射与编辑器联动留给后续批次。
- 安全(program-workspace 锁): `debug.launch` 的 `program`/`cwd` 来自 agent，必须落在 owner window 的 workspace root 内(realpath 规范化后比较，防 symlink 逃逸与 `..` 穿越)；窗口无 workspace 记录则 fail-closed 拒绝；`cwd` 省略时默认 workspace root，不回退 main 进程 cwd。校验通过的真实路径(program/cwd 的 realpath)即为之后 launch 使用的路径 —— 起跑推迟到 `wait_for_stop` 等调用，期间把软链改指工作区外不生效。该契约由 `electron/main/__tests__/debug-service.spec.ts` 覆盖。
- 安全(运行时 node 由 Continuo 解析): 被调试程序用哪个 node 由 main 进程按自身 PATH(启动时的环境，**不含** agent 传入的 `env`)查找并 realpath 成绝对路径(main PATH 找不到时，非 Windows 上执行一次用户登录 shell `$SHELL -ilc` 取其 PATH 再按同样规则查找 —— 覆盖 macOS 从 Finder 启动时 PATH 不含 Homebrew / nvm;仍是 Continuo 可信环境，成功结果缓存、失败不缓存)，作为 `runtimeExecutable` 固定写进父 / child 的 launch 参数 —— agent 的 `env`(含 `PATH`)只影响被调试程序自身，不影响用哪个 node(否则 js-debug 按 env 的 PATH 先执行 `<PATH>/node --version`，即工作区外任意代码执行)。找不到 node 时 launch 以 `DEBUG_NODE_RUNTIME_NOT_FOUND` 失败且不 spawn adapter。`env` 另有禁用规则作纵深防御(大小写不敏感):以 `DYLD_` / `LD_` / `OPENSSL_` 开头的变量整族拒绝，外加精确名 `NODE_OPTIONS` / `NODE_PATH` / `NODE_REPL_EXTERNAL_MODULE` / `GCONV_PATH`;名字含 `=` 或 NUL 一律拒绝(POSIX 按第一个 `=` 切分,`NODE_OPTIONS=--import` 会生成 `NODE_OPTIONS`);`NODE_ENV` 等普通变量照常放行。

- teardown 对父连接与全部 child 并行发 disconnect,共用一个总超时(`DEBUG_TEARDOWN_DISCONNECT_TIMEOUT_MS` = 2s),adapter 失联时不随 child 数量叠加等待,超时即进入进程组 / 进程树终止。
- `debug.disconnect` 始终终止 Continuo launch 的 debuggee(teardown 按 adapter 进程组整组回收);`terminate_debuggee` 只接受 `true` 或省略,`false` 在 schema 层显式拒绝(不再静默忽略),zod 与手写 JSON schema(`const: true`)一致。
- 清理不依据已失效的 pid 杀进程(PID 复用防护): debuggee 结束(该连接的 `exited` / `terminated`)即把它回报过的 pid 移出会话记录;整个会话结束时清空 debuggee pid 记录(terminated 会话可能保留到名额满才回收,其间 pid 会被无关进程复用);会话结束后迟到的 `process` 事件不再登记;adapter 子进程已退出则不再对其单个 pid 发信号;例外是 POSIX 的 adapter 进程组:adapter 存活时 teardown 按组终止;adapter 退出那一刻(`onServerExit` → `reapAdapterGroupOnExit`)立即枚举并终止组内残留成员(进程组存在期间 pgid 不会被重新分配),此后不再凭旧 pgid 枚举或发信号(见下文「adapter 退出那一刻回收其进程组」)(Windows 无组可枚举:adapter 已退出且无记录在案的 debuggee 时只释放连接资源)。关窗 / 退出 / 撤销 / disconnect 的清理因此不会杀到复用这些 pid 的无关进程(Windows `taskkill /T /F` 整树强杀尤甚)。残留风险:会话存活期间 debuggee 未经 DAP 通知就退出、且其 pid 恰被复用的极窄窗口(未做进程创建时间比对,Windows 上查询代价高)。
- 程序起跑时机: `debug.launch` 完成 DAP initialize 后返回 `state: "starting"`,此时程序尚未运行;`configurationDone` + `launch` 推迟到第一个要求程序运行的调用(`wait_for_stop` / `continue` / `step_*`)且只发一次,`set_breakpoint` 本身不让程序起跑 —— 起跑前设的多个断点都在程序运行之前就位。没设断点直接 `wait_for_stop`(如 `stop_on_entry`)也能起跑;尚无停点时 `continue` 即「让程序跑起来」。
- 断点按 source 维护完整集合(DAP `setBreakpoints` 语义): 同一文件的新断点与已有断点一起发送(同 file+line 去重),不覆盖;child session 建立时按 source 重放全部断点;返回值是本次新设断点的结果。同 session 同 source 的设置串行执行(集合与 `breakpoints-changed` 快照按调用顺序);请求失败 / 超时回滚本地记录后,尽力向父连接与存活 child 补发回滚后的完整集合(短超时、失败忽略,原错误照抛);快照按 adapter 校正后的 file:line 去重(保留首个),adapter 未逐项回报(空 / 短数组)时沿用该断点上次的校正结果。source 按平台归一分组(Windows 大小写不敏感、`/` 与 `\` 等价),发给 adapter 与推给 renderer 的路径用该 source 首次记录的拼写。
- 会话归属回收: stdio 连接断开后其 callerSubject 永久失效，该连接创建的 debug 会话立即回收(释放名额、结束 adapter)，其它连接的会话不受影响;HTTP 调用方的 subject 是终端 token(带 Mcp-Session-Id 时为 token + session id)，随 session 释放 / token 吊销 / 窗口关闭 / 授权撤销回收;终端专属 token(终端内 agent 经 HTTP MCP 调用)随终端退出吊销时，同步回收该 token 创建的 debug 会话(`terminal-exit`)。以上回收(撤销授权 / 终端退出 / stdio 断连)同样覆盖**在途** `debug.launch`(adapter 启动 / initialize 中、会话尚未登记):被吊销调用方的在途 launch 不登记会话、不返回 session_id,释放已起的 adapter 并以 `AGENT_NOT_AUTHORIZED` 结束;撤销授权枚举的调用方包含有在途 launch 的调用方;其它调用方的 launch 不受影响。吊销只取消吊销**当时**在途的 launch:吊销之后同一调用方(如 stdio 连接 subject 不变、用户重新授权)新发起的 launch 照常进行。窗口关闭(`killByOwner`)同样取消该窗口的在途 launch;应用退出(`cleanupAll`)取消全部在途 launch 并等待其结算(上限 5s),不遗留 detached adapter;退出清理一开始即拒绝此后发起的 launch(`AGENT_NOT_AUTHORIZED`,不 spawn adapter),结束前再查一遍会话登记表,拆除清理期间漏网登记的会话。
- 会话数上限(每窗 8 / 全局 32)在 spawn adapter 之前检查:在途 launch 在 spawn 前同步预占名额并计入上限,登记会话时转为正式名额,失败 / 取消时释放;并发 launch 同时 spawn 中的 adapter 不超过上限,超额请求在 spawn 前即被拒。名额被已自然结束的会话占满时先回收最旧的 terminated 会话再预占。
- DAP 入站帧必须是顶层带字符串 `type` 的 JSON 对象;`null` / 数组 / 标量等按畸形帧处理(结算在途请求并断开连接),不抛成主进程未捕获异常。
- DAP 入站单帧上限 8MiB:收包按 chunk 累积、凑够整帧才一次性拼接(无 O(n²) 复制);超限帧不缓冲、边收边丢 —— 能认出是响应时只让对应请求失败(如超大 `evaluate` 结果),事件等静默丢弃,连接与会话不断开。

## 规范文件

- `dap-framing.spec.ts`: DAP `Content-Length` framing 的编码/解码契约。
- `debug-schemas.spec.ts`: `debug.*` MCP schema 的 strict/bounds/defaults 契约。
- `mcp-debug-host.spec.ts`: MCP 授权、capability、错误码契约。
- `stdio-caller-closed.spec.ts`: stdio 连接断开时通知调用方失效(onCallerClosed)的契约。
- `terminal-token-revoke-kills-debug.spec.ts`: 终端专属 token 吊销时回收其 debug 会话的接线(源码钉)。
- `revoke-covers-inflight-launch.spec.ts`: 撤销 agent 授权时枚举的调用方含在途 launch 的接线(源码钉)。

DebugService 的真实 adapter 生命周期、wait/continue/teardown 幂等行为由 `electron/main/__tests__/debug-service.spec.ts` 覆盖，避免在 BDD 层重复慢路径。

## 打包前获取 js-debug adapter(终审 P1)

- adapter 不入 git;`build:pack`(所有 `build:app*` 都经由它)先执行 `scripts/fetch-debug-adapter.mjs`
  下载并校验固定版本 sha256。否则干净检出本地打包会产出调试功能不可用的安装包
  (electron-builder 对缺失的 extraResources 只警告)。规范:`build-fetches-debug-adapter.spec.ts`。
- 缓存完整性:tarball 下载到内存,sha256 校验与解包使用同一份 buffer(不落临时文件);解包后在
  `.adapter/.continuo-adapter-cache.json` 写入 adapter 版本、tarball sha256 与 `js-debug/` 目录树哈希。
  缓存命中须标记存在且三者全部吻合(含符号链接等非常规条目即不吻合),否则删除重下。
  这是一致性检查而非安全边界:树哈希与被校验目录放在一起(自证值),防意外损坏 / 误改 / 过期或半成品缓存,
  防不了有本地写权限、同时改目录和标记的人。规范:`fetch-debug-adapter-cache.spec.ts`。

## adapter 退出那一刻回收其进程组(终审 P1)

- POSIX:adapter 子进程退出时(`DapClient.onServerExit`)立即枚举其进程组并终止组内残留成员 —— 组只要还有成员
  就不会被复用,此刻存活的成员必是 adapter 派生、未脱离组的进程。
- 之后会话可保留很久,原组清空后 pgid 可被系统复用给无关进程组:teardown 在 adapter 已退出时**不再**凭旧 pgid
  枚举或发信号(Windows 仍只对记录在案、未结束的 debuggee 做 taskkill)。
- 残留窗口:exit 事件到达与枚举之间(毫秒级)组恰好清空且 pgid 被复用。
