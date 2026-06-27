# 边界条件 / 畸形 / 极端输入健壮性审计(codex 协作,第十六 session 起)

方向:与前序 8 方向(安全/可维护/性能/数据安全/跨平台/i18n/a11y/race-condition)正交。范围:unchecked 下标/off-by-one、空集合与单元素退化、数值 parse/溢出/NaN/Infinity、畸形外部数据(plugin manifest/IPC payload/磁盘 JSON/env/剪贴板拖放)、极端尺寸(超大文件/超长终端输出/超长路径或字符串)、unicode/编码/代理对边界、除零/取模零、对抗性 regex(ReDoS)。协议:codex 一次报一个 `[P0/P1/P2] 文件:行 | 问题 | 影响 | 建议` + `###CODEX-DONE###`,收敛 `• 未发现问题`。编号 E1 起。

## E1 — stdio MCP NDJSON 残行/单行无字节上限,畸形输入致 main 进程 OOM (P1)

- **文件**: `electron/main/services/mcp-stdio-server.service.ts:324` sock.on('data')
- **问题**: stdio socket 的 NDJSON 残行 buffer `buf` 无大小上限。`splitNdjsonLines(buf, chunk)` 在无换行或超长单行输入下会把字符无限累积到 buf。畸形/恶意本地客户端(unix socket 0600 仅本用户,但 postinstall 等本用户进程亦可连)可让 Electron main 进程内存持续增长甚至 OOM 崩溃。HTTP MCP 早有 MAX_BODY_BYTES(1MB)保护,stdio 传输缺同等保护。
- **修复**: 加模块常量 `MAX_STDIO_LINE_BYTES = 1_000_000`(与 HTTP MAX_BODY_BYTES 对齐)。每次 data 后检查残行 buf 与本批任一完整行是否超限,超限则回 JSON-RPC parse 错误(`'line exceeds maximum size'`)并 `sock.destroy()`;buf 置空,lineChain/aborter/socketCtx 等由既有 close 处理统一清理。
- **测试**: ct-b3-socket-safety.spec +1(E1):真 socket 分两块发 1.6MB 无换行输入 → 断言回 parse error(若先于断开到达)+ 连接最终 destroyed + 工具不执行。中和(去字节上限检查)→ 连接不断、buffer 累积、socket 永不 destroyed → 测试 30s 超时失败确认回归。
- **沉淀**: 「外部输入的累积缓冲必须有字节上限」——任何 read-loop 把分片累积到 buffer 等待分隔符(换行/边界)的地方,无上限即 OOM 向量。已有保护(HTTP MAX_BODY_BYTES)的对偶传输入口(stdio)必须对齐(又一「防御未传播到所有兄弟入口」族:同一资源类别=外部 RPC 输入,两 transport 须同等 cap)。

## E2 — marketplace index.json 顶层数组未逐 entry 校验,畸形项崩面板 / 拼垃圾安装 URL (P1)

- **文件**: `src/marketplace/fetcher.ts:42` fetchMarketplaceIndex(+ types.ts isValidMarketplaceEntry)
- **问题**: index.json 来自远程仓库,代码只 `Array.isArray(entries)` 就强转 `MarketplaceEntry[]`,数组元素与 repo/name/id/author/tags 形态完全未校验;sessionStorage 缓存的 validate 同样只查 `Array.isArray`。畸形 entry(null、缺 repo、tags:{}、字段类型错)会通过缓存,在 `applyFilter()` / 卡片渲染 / 更新检查中触发 TypeError 崩插件市场面板,或 `entryToGitUrl` 拼出 `https://github.com/undefined.git`。
- **修复**: types.ts 加 `isValidMarketplaceEntry` 类型守卫(必填 string id/name/author 非空、repo 非空且含 '/';可选 description/authorUrl/branch=string、tags=string[]、verified=boolean,存在才校验)。fetch:`raw.filter(isValidMarketplaceEntry)` 丢弃畸形项(**过滤而非整体拒绝**——一个坏社区条目不应让整个市场不可用),丢弃数 console.warn;只缓存合法 entry。cache.validate 收紧为 `Array.isArray(d) && d.every(isValidMarketplaceEntry)`(persisted 缓存被篡改/旧格式则视为不可用、重拉)。顶层非数组仍抛 MARKETPLACE_INDEX_INVALID。
- **测试**: marketplace.spec +3(E2):混合 7 项(2 合法 + 5 畸形)→ 只留 2 合法 + warn「dropped 5 malformed」/ 全畸形→返空数组 fail-safe / sessionStorage 缓存含畸形→validate 弃用重拉网络。中和(去 filter)→ 前两测试失败确认回归(第三由 validate 收紧独立覆盖)。
- **沉淀**: 「来自外部(网络/磁盘/IPC)的 JSON 顶层容器校验通过 ≠ 元素校验」——`Array.isArray` / `typeof === 'object'` 只挡顶层,数组元素 / 嵌套字段须逐项类型守卫,否则畸形项在下游(渲染 / URL 拼接 / filter)炸。**有效降级=过滤合法子集**(resilient)优于整体拒绝(一个坏项不毁全部)。fetch 与 cache.validate 须用**同一**守卫(否则绕一边)。同仓已有正确先例:fetchPluginManifest 校验 id/name/version——index 路径漏了对偶校验。

## E3 — reviews sessionStorage 缓存浅校验,畸形/旧缓存渲染崩面板 (P2,E2 同族 reviews 侧)

- **文件**: `src/marketplace/reviews-fetcher.ts:25` reviewsCache.validate(+ reviews-types.ts isValidAggregateRecord)
- **问题**: E2 在 reviews 侧的孪生。reviews 缓存的 validate 只校验 `d 是非数组对象`就强转 `Record<string, PluginAggregateRating>`。畸形/旧格式缓存(如 `{p:{count:1,avg:"bad",reviews:{}}}`,可能来自旧版本写入或 sessionStorage 外部篡改)会被当新鲜或 stale fallback 返回,Marketplace 渲染时 `rating.avg.toFixed()` / `rating.reviews.length` 直接崩面板。
- **修复**: reviews-types.ts 加深度类型守卫 `isValidAggregateRecord`:逐 aggregate 校验 pluginId(string)、count/avg(有限数值,`Number.isFinite`)、reviews(数组)+ 每条 review 字段(pluginId/rating/body/url/createdAt string|finite、author.handle/avatarUrl/createdAt、可选 continuo/pluginVersion)。cache.validate 改用它,非法缓存当 cache miss(返 false → 重拉)。fresh fetch 路径经 parseReview→aggregate 本就干净,故只需收紧缓存信任边界。
- **测试**: reviews-fetcher.spec +3(E3):缓存 avg 非数值+reviews 非数组→cache miss 走 IPC / 某条 review rating 非数值→cache miss / 合法完整缓存(全字段)→深度校验通过命中不 IPC。中和(validate 退回浅校验)→ 前两测试失败确认回归。既有 hydrate 测试(reviews:[] 空数组)仍绿(空 every=true)。
- **沉淀**: 「缓存/持久化层信任边界须与数据源同等深度校验」——E2(index)+ E3(reviews)同一类:`createSessionCache` 的 validate 是 persisted 数据复活时的唯一闸门,浅校验(只查容器类型)放行畸形旧数据/被篡改数据 → 下游渲染崩。**凡 sessionStorage/localStorage/磁盘缓存 hydrate 回内存的 validate,必须深度校验到 UI 实际触碰的字段**(`.toFixed()` 须 finite number、`.length`/`.map` 须数组)。E1/E2/E3 连成「外部输入(网络 NDJSON / index JSON / 缓存 JSON)边界校验」族。

## E4 — nextWindowSeq 无上界校验,损坏巨值致计数器精度停滞、多窗共享持久化段 (P2)

- **文件**: `electron/main/persistence.ts:262` allocateWindowSeq(schema `electron/shared/explorer-persistence-schema.ts:108` nextWindowSeq)
- **问题**: nextWindowSeq schema 只 `z.number().int().nonnegative()`,不挡上界。损坏/篡改持久化里 `nextWindowSeq = 9007199254740992`(2^53,> Number.MAX_SAFE_INTEGER)时,`seq + 1 === seq`(IEEE754 双精度在此精度步长为 2)→ 计数器**卡死**,每个新窗口 `allocateWindowSeq` 反复拿到同一 windowSeq → 多个窗口共享同一持久化段、互相覆盖 workspace/layout/editor 状态。
- **修复**: allocateWindowSeq **运行时自愈**:`if (!Number.isSafeInteger(seq))` 则重算 `seq = max(现有段 windowSeq 中的安全值, 0) + 1`(主窗占 0、新窗 ≥1 且大于所有现存安全段 → 唯一不冲突),恢复唯一单调。**不选 schema `.safe()`**:那会让一个损坏 seq 使 loadExplorer 整文件校验失败→回退默认→丢全部 window 段/recentRoots/pinned(比原 bug 更糟);运行时自愈不丢任何持久化段。
- **测试**: window-seq-allocate.spec +2(E4):nextWindowSeq=2^53 → 自愈分配唯一单调安全 seq(a≥1、b===a+1、a≠b、落盘 nextWindowSeq 安全)/ 健康值 7 → 原样返回不触发自愈(行为保持)。中和(去自愈守卫)→ 损坏值测试失败(seq 卡死返 2^53、b===a 重复)确认回归。
- **沉淀**: 「单调计数器 / 数值累加器须防不安全整数(精度停滞)」——`seq + 1 === seq` 在 ≥2^53 时成立,任何来自持久化/外部的整数计数器都可能被损坏成巨值致 `+1` 停滞、ID 重复。`z.number().int()` 不挡上界。修复优选**运行时自愈到安全值**而非 schema 拒绝(后者使一处损坏字段毁整份持久化)。数值边界(溢出/精度)是 E1-E3「外部输入边界」族的数值维度延伸。

## E5 — session-cache 时间戳只校验 typeof number,畸形 Infinity/未来值致永久陈旧缓存 (P2)

- **文件**: `src/marketplace/session-cache.ts:40` readStorage(E2/E3 共用的缓存底层)
- **问题**: 缓存 wrapper `{fetchedAt, data}` 的 fetchedAt 只校验 `typeof === 'number'`。畸形/篡改 sessionStorage 可写 `1e309`(JSON.parse → Infinity,typeof 仍 'number')或超大未来值并通过校验;`Date.now() - fetchedAt < ttlMs` 在 fetchedAt=Infinity 时为 `-Infinity < ttl` 恒真,远未来值同理 → marketplace index/reviews **永久使用陈旧缓存**,远端更新/修复不可见直到手动清 sessionStorage。
- **修复**: readStorage 时间戳深校验:`typeof === 'number' && Number.isFinite(ts) && ts >= 0 && ts <= Date.now() + FUTURE_SKEW_MS`(FUTURE_SKEW_MS=60s 容时钟微调,拒明显未来)。非法 wrapper 返 null → cache miss → 触发重拉。单点修复同时覆盖 index(E2)与 reviews(E3)两个 cache 实例。
- **测试**: marketplace.spec +3(E5):缓存 fetchedAt=1e309(Infinity)/ 远未来(now+1e12)/ 负值 → 均当 cache miss 走网络。中和(退回只 typeof number)→ Infinity + 远未来两测试失败确认回归(负值因「看起来很旧」两实现都走网络,为行为文档)。
- **沉淀**: 「数值校验 typeof number 不够,须 Number.isFinite + 范围」——Infinity/NaN 都是 'number';JSON.parse 把溢出字面量(1e309)解析成 Infinity。时间戳类数值额外须范围约束(非负、非明显未来),否则「过期判断」被畸形值永久绕过。E5 是 E1-E4「外部输入边界」族在「缓存元数据数值」维度的延伸,与 E4(整数上界)互补(E4 防 +1 停滞,E5 防时间戳越界)。

## E6 — number setting 不按 spec.min/max clamp,越界值致 UI/xterm/autosave 异常 (P2)

- **文件**: `src/plugins/settings/SettingItemRow.tsx:101` onChange + `src/plugins/settings/values-store.ts:77` getSettingValue(helper `SettingItemRegistry.ts` clampSettingNumber)
- **问题**: number setting 的 onChange 只 `Number.isFinite(n)` 不按 `spec.min/spec.max` 约束;`<input type=number min/max>` 不阻止用户键入或脚本写入越界值。可把 terminal.fontSize / editor.fontSize / explorer.indentSize / autoSave.delayMs 写成 0 / 负 / 超大值 → UI 布局异常、xterm 配置异常、autosave 防抖退化。读路径(getSettingValue)也不校验,已持久化的越界/畸形值(损坏 localStorage / 旧版本)直接喂给消费者。
- **修复**: 新增 `clampSettingNumber(spec, n)`:非有限(NaN/Infinity)→ 回退 spec.default;再按 spec.min/max clamp。写路径 onChange `setValue(spec.id, clampSettingNumber(spec, n))`;读路径 getSettingValue 对 `spec.type==='number'` 的值同样 clamp。双路防御:写入挡新越界、读取兜底已持久化越界。
- **测试**: setting-item-registry.spec +clampSettingNumber 5 例(范围内原样 / <min→min / >max→max / NaN·Infinity→default / 无 min/max 仅过滤非有限)+ settings-values.spec +1(getSettingValue 对越界 override 9999→max、0→min)。中和(去 min/max clamp)→ clamp 测试 + 读路径测试失败确认回归。
- **沉淀**: 「HTML input 的 min/max/maxlength 等是 UI 提示,非约束」——用户可键入越界、脚本/持久化可绕过,**值必须在 JS 层 clamp/reject**。写路径(onChange)+ 读路径(get)双重校验:写挡新错误、读兜底历史/损坏数据。与 E3/E4/E5 同源——持久化层的数值都要范围约束(spec 既有 min/max 但没用上=声明了约束却不执行)。E1-E6 构成「外部/持久化输入边界」完整族(NDJSON 字节 / index 元素 / reviews 缓存 / 整数上界 / 时间戳 / setting 数值范围)。

## E7 — parseSemver 数字段无上界,畸形/超长 version 致 Infinity 比较与误判有更新 (P2)

- **文件**: `src/marketplace/semver.ts:38` parseSemver + `src/marketplace/update-store.ts:123` 更新检查
- **问题**: parseSemver 正则 `\d+` 允许任意长度数字段,`Number('99999999999999999999')` 超 Number.MAX_SAFE_INTEGER 变不安全整数/Infinity 仍参与 `>` 比较。畸形远端 marketplace manifest.version(`999…999.0.0`)被判定「有更新」→ 显示更新角标/按钮,甚至把不可表示版本写入已安装插件状态。
- **修复**: parseSemver 对 major/minor/patch 加 `Number.isSafeInteger` 校验,任一段不安全 → 返 null(不可解析)。导出 `isValidSemver(s)=parseSemver!==null`。update-store 更新检查在 isNewerVersion 之前 `if (!isValidSemver(remoteV)) continue` —— 远端版本不合法直接**跳过该插件更新**,不进入 isNewerVersion 的字符串 fallback(否则 `'999…'` 字符串序仍可能 > 安装版误显更新)。合法上界 MAX_SAFE_INTEGER 仍接受。
- **测试**: semver.spec +isValidSemver(合法/超长不安全整数 false/MAX_SAFE_INTEGER+1 false/四段·文字 false)+ isNewerVersion 不安全整数返布尔不抛;update-store.spec +1(远端 99999…0.0 → available 空)。中和(去 safe-int 校验 + 去 update-store 守卫)→ isValidSemver 超长测试 + update-store 误收录测试失败确认两层回归。
- **沉淀**: 「正则 `\d+` 解析数字 + Number() 无上界 = 不安全整数/Infinity 漏洞」——版本号/ID/计数等从外部字符串解析的数字必须 `Number.isSafeInteger` 校验(与 E4 整数上界、E5 时间戳同源数值边界族)。**解析失败的语义要看用途**:比较用途 string fallback 可能仍误判,安全用途(是否提示更新)应 fail-closed=跳过,而非降级比较。E1-E7 完成「外部/持久化输入边界」族,数值维度:E4(计数器上界)/E5(时间戳范围)/E6(setting 范围)/E7(版本号安全整数)。

## E8 — parseInitialWindowSeq 只 Number.isInteger,URL query 超大整数舍入进持久化索引 (P2,E4/E7 同族)

- **文件**: `src/lib/initial-workspace.ts:49` parseInitialWindowSeq
- **问题**: query `?windowSeq=N` 校验只用 `Number.isInteger`,未要求 safe integer。`?windowSeq=9007199254740993`(2^53+1,> MAX_SAFE_INTEGER)经 `Number()` 舍入成 9007199254740992,`Number.isInteger` 仍为 true → 接受。畸形/手工 URL 让 renderer 读写不可安全表示的 windowSeq 段,致段匹配 / windowSeq+1(见 E4)/ 后续窗口恢复精度碰撞。
- **修复**: `Number.isInteger` → `Number.isSafeInteger`,不安全整数按非法值回退 0(主窗位)。正好 MAX_SAFE_INTEGER 仍接受。
- **测试**: initial-workspace.spec +2(E8):`?windowSeq=9007199254740993` / `99999999999999999999` → 0;`9007199254740991`(MAX_SAFE_INTEGER)→ 原值。中和(改回 Number.isInteger)→ 超大整数测试失败确认回归。
- **沉淀**: 「外部字符串解析整数的第三个入口」(E4 持久化 nextWindowSeq、E7 远端 semver、E8 URL query windowSeq)——凡从外部(磁盘/网络/URL)`Number()` 解析整数都须 `Number.isSafeInteger`,`Number.isInteger` 不挡 ≥2^53 的舍入值。同一 windowSeq 概念在「分配端(E4 persistence)」与「读取端(E8 URL)」两处都要防不安全整数,否则一端防住另一端漏入(防御传播到所有入口)。

## E9 — plugin manifest parseVer 无安全整数校验,畸形版本污染兼容判断 (P2,E7 plugin manifest 侧孪生)

- **文件**: `src/plugins/manifest.ts:65` parseVer(isVersionCompatible 用)
- **问题**: E7(marketplace semver)在 plugin manifest 侧的孪生。manifest 的 version/minLMVersion 正则 `\d+` 允许任意长度数字段,parseVer 直接 `Number(...)` 不校验 safe integer。`999…999.0.0` → Infinity,不安全整数参与兼容比较。畸形 plugin manifest 可通过 schema 污染插件列表/兼容判断;minLMVersion 与 app version 比较在极端数字下语义不可靠。
- **修复**: parseVer 对三段加 `Number.isSafeInteger` 校验,任一不安全 → 返 null。isVersionCompatible 已对 `parseVer` null fail-closed(`if (!a || !p) return false`)→ 不安全版本自动保守拒载(不进失真比较)。最小局部修复,不耦合 marketplace semver。
- **测试**: plugin-manifest.spec +2(E9):appVersion / minLMVersion 含超长数字段(99999…/2^53+1)→ isVersionCompatible false(保守拒载);MAX_SAFE_INTEGER 段仍合法比较 true。中和(去 safe-int 校验)→ 不安全整数测试失败确认回归。
- **沉淀**: 「外部字符串解析整数的第四个入口」(E4 persistence / E7 marketplace semver / E8 URL query / E9 plugin manifest)——同一「`\d+` + Number() 无 safe-integer」漏洞模式遍布所有版本号/seq 解析点。**两套独立的 semver 解析(marketplace semver.ts + plugins manifest.ts)各自都要修**(防御传播到所有兄弟实现,非只改一处)。fail-closed 语义:版本不可解析时兼容判断保守拒载(安全方向),与 E7 update-check 跳过同理。

## E10 — execStream timeoutMs 无校验,NaN/负数致 setTimeout 立即触发杀合法命令 (P2)

- **文件**: `electron/main/services/plugin-shell-stream.service.ts:78` START handler
- **问题**: execStream 的 raw IPC 参数 `opts.timeoutMs` 无运行时 schema,只 `Math.min(opts?.timeoutMs ?? DEFAULT, MAX)`。插件传 NaN/负数/0/Infinity/非数字 → `Math.min(NaN, MAX)=NaN` 或负值 → `setTimeout(.., timeoutMs)` 把 NaN/负值强制为 0 → **立即触发** → 合法的流式 shell 命令一启动就被 SIGTERM,插件看到随机/立即退出;畸形参数无稳定反馈。
- **修复**: `typeof === 'number' && Number.isFinite && > 0` 才采用并 clamp 到 MAX_TIMEOUT_MS,否则回 DEFAULT_TIMEOUT_MS(fail-safe,不拒绝合法启动)。Infinity(>0 但非 finite)、NaN、负数、0、非数字全部落到默认值。
- **测试**: plugin-shell-stream.test +2(E10):timeoutMs=NaN / -5 启动长命令 → 200ms 内无 exit 事件(未立即被杀)。中和(退回 Math.min)→ 两测试失败(NaN/负 → 立即 SIGTERM 发 exit)确认回归。
- **沉淀**: 「raw IPC / 外部传入的数值参数喂给 setTimeout/setInterval 前必须 Number.isFinite && 范围校验」——NaN/负数被 setTimeout 静默当 0 → 定时器立即触发是隐蔽 DoS/误杀向量。与 E6(setting 范围)同源数值校验,但后果是控制流(立即超时)而非显示。raw IPC 参数无 schema 是通用风险,timeoutMs 是其中后果最直接的;codex 建议 START/ABORT 加 zod 全量校验为更大 follow-up,本修先封死已知误杀向量。

## E11 — terminal.create IPC 入参无长度/数量上限,超大 payload 致 spawn 失败/IPC 卡顿/UI 异常 (P2)

- **文件**: `electron/shared/terminal-create.ts:14` TerminalCreateInputSchema
- **问题**: terminal.create 的 args/env/title/name/agentLabel/workspaceRoot 均无长度或数量上限。畸形 renderer/plugin payload 可传超大 args/env 或超长标题;main 把这些值合进 PTY spawn 环境 + terminal session metadata,再广播给所有 renderer → spawn 失败、IPC 大对象传输卡顿、Dock/UI 渲染异常。
- **修复**: TerminalCreateInputSchema 加合理上限(远超真实用法,只挡滥用):args ≤1024 项 / 每项 ≤16384 字符;env key ≤1024、value ≤32768、条目 ≤1024(.refine 限条目数);title/name/agentLabel ≤512;shell/cwd/workspaceRoot ≤8192。超限 zod 校验失败 → 走 main 既有 BAD_INPUT 拒绝路径。
- **测试**: terminal-ipc.spec +E11 describe(6 例):args 数量/单项超长、title/name/agentLabel 超长、env 条目数/value 超长、workspaceRoot 超长 → fail;正常规模 payload 仍 ok。中和(去所有 .max + env refine)→ 5 个超限测试失败确认回归。
- **沉淀**: 「跨进程 IPC 入参的 schema 不能只校验类型/形状,还要校验大小」——string/array/record 无上限 = 大对象 DoS 向量(spawn 失败 / IPC 序列化卡顿 / UI 渲染卡死),尤其值会被 main 合并进环境/metadata 再广播放大。E11(IPC payload 尺寸)与 E1(stdio 行字节)同源:外部输入的**尺寸**边界。zod schema 是加尺寸上限的天然位置(类型校验处顺带 .max)。E1-E11 完成「外部/持久化输入边界」族:尺寸(E1/E11)+ 结构(E2/E3)+ 数值(E4-E10)。

## E12 — shell.exec ExecInput 无尺寸上限,超大 stdin/env/args 致 spawn E2BIG/内存卡顿 (P2,E11 兄弟入口)

- **文件**: `electron/main/ipc/shell.ipc.ts:8` ExecInput
- **问题**: E11(terminal.create)在 shell.exec 侧的孪生。ExecInput 的 cmd/args/cwd/env/input 无长度/数量上限。stdout/stderr 已 cap(第八 session R5 的 maxOutputBytes),但调用方仍可传超大 stdin / 超大 env / 巨量 args;main 先接收并持有这些大对象,再写入 stdin / 传给 spawn → IPC/内存卡顿、spawn E2BIG/失败、插件调用长时间异常。(同文件 OpenExternalInput.url 早有 `.max(2048)` 先例。)
- **修复**: 镜像 TerminalCreateInputSchema 给 ExecInput 加上限:cmd/cwd ≤8192;args ≤1024 项 / 每项 ≤16384;env key ≤1024 / value ≤32768 / 条目 ≤1024(.refine);input(stdin)≤1MB。导出 ExecInput 供测试。超限 → safeHandle 的 zod 校验失败 → BAD_INPUT 拒绝。
- **测试**: 新增 shell-exec-input-limits.spec(7 例):正常 payload ok;cmd 空 fail(既有 min);args 数量/单项超长、cmd/cwd 超长、stdin 超长、env 条目数/value 超长 → fail。中和(去所有 .max + env refine + stdin max)→ 5 个超限测试失败确认回归。
- **沉淀**: 「IPC 输入尺寸上限要传播到所有 spawn 子进程的入口」——terminal.create(E11)与 shell.exec(E12)是两个并行的「renderer 传参 → main spawn 子进程」入口,同一「外部 payload 尺寸边界」安全意图必须两处都加(本仓最高频「防御未传播到所有平行入口」族在 edge-case 方向复现)。stdout 已 cap 不代表 stdin/参数已 cap——输入输出两个方向都要 bound。E1-E12 完成外部输入边界族(尺寸 E1/E11/E12 + 结构 E2/E3 + 数值 E4-E10)。

## E13 — fs:writeFile / fs:writeBinary content 无大小上限,超大写入致内存峰值/IPC 卡顿 (P2,E11/E12 兄弟 fs 侧)

- **文件**: `electron/main/ipc/fs.ipc.ts:43` writeFileInputSchema / writeBinaryInputSchema
- **问题**: E11/E12 在文件写入侧的孪生。content(string / Uint8Array)无大小上限。IPC payload 先完整进入主进程,再由 atomicWriteFile 写临时文件 + fsync。畸形/误操作的超大 string/Uint8Array → 主进程内存峰值、IPC 卡顿、超大临时文件;比 terminal.write 已有的 2MB cap 更不受控。
- **修复**: content 加 64 MiB 上限(`z.string().max` / Uint8Array `.refine(length<=cap)`)。**关键权衡**:这是用户文档内容,cap 太低会致大文件保存失败=数据丢失。64 MiB 是「滥用/误操作 backstop」(32× terminal.write),远超 CodeMirror/Milkdown 能流畅编辑的体量(数 MB 已退化),不会破坏任何现实保存;真·大文件写入应另走流式/分块接口(follow-up)。超限 → safeHandle zod 校验失败 → BAD_INPUT。
- **测试**: fs-ipc-bridge.spec +E13(writeFile 正常 ok / >64MiB fail;writeBinary 正常 ok / 非 Uint8Array fail / >64MiB fail)。中和(去 .max + refine)→ 两个超限测试失败确认回归。cap 选 64MiB(非 256MiB)亦为测试可负担(避免 256MB+ 分配致 CI OOM)。
- **沉淀**: 「写入尺寸上限的特殊性:content 是用户数据,cap 必须高到不破坏合法保存」——与 E11/E12(参数/stdin 是控制数据,可较严)不同,文件内容 cap 是「数据丢失风险 ↔ DoS 防护」的权衡,取**远超现实用量的 backstop**而非紧致限制。三个 spawn/写入入口(terminal.create E11 / shell.exec E12 / fs.write E13)的尺寸边界全部补齐。E1-E13 完成外部输入边界族(尺寸 E1/E11/E12/E13 + 结构 E2/E3 + 数值 E4-E10)。

## E14 — explorer.json 持久化 schema 数组/路径无上限,损坏快照超大数组致启动卡顿/内存峰值 (P2,E11-E13 持久化侧)

- **文件**: `electron/shared/explorer-persistence-schema.ts`(V1/V2/V3 + writable 全套)
- **问题**: explorer 持久化 schema 对 openFilePaths / expandedPaths / recentRoots / pinned.paths / windows 等数组和路径字符串都无上限。损坏/畸形 explorer.json 只要 shape 对就通过校验;启动 loadExplorer/hydrate 接受超大数组,随后批量恢复 tab、展开树、写回快照 → 启动卡顿、IPC/JSON 写入膨胀、内存峰值。
- **修复**: schema 层加 cap(共享 `pathStr()`/`pathArray()` 原语 + 常量):路径串 ≤8192;expandedPaths/openFilePaths ≤100000;recentRoots ≤1000;pinned.paths ≤10000;windows ≤10000。应用到 V1/V2/V3/writable 全部 schema(经共享 EditorSessionSchema/WindowEntry* + 各 inline)。超限 → safeParse 失败 → loadExplorer 三级 safeParse 全 fail 返 null → 降级默认(原文件已存 .corrupt,不丢已存数据)。cap 远超现实工作区(深树/多 tab/多最近目录),不破坏合法快照。
- **测试**: persistence-schema.spec +E14(正常 ok;recentRoots>1000 / expandedPaths>100000 / 路径串>8192 / pinned>10000 → fail)。中和(去全部 cap)→ 4 测试失败确认回归。**踩坑**:base() 用 migrateV2ToV3(v2ValidPayload) 返回值与输入共享嵌套数组引用,测试 mutate 污染了 v2ValidPayload 致后续 disk-load 测试失败 → 改 structuredClone 深拷贝(测试隔离纪律:mutate 共享 fixture 前必深拷贝)。
- **沉淀**: 「持久化 schema 是 hydrate 时的尺寸闸门」——磁盘/缓存 JSON 的数组/字符串若无 .max,损坏文件的超大集合会在 hydrate→批量恢复时放大成启动 DoS。E13(单次写入尺寸)+ E14(持久化集合尺寸)互补,与 E2/E3(缓存深度校验)同属「外部持久化数据信任边界」。多版本 schema(V1/V2/V3)须全部加 cap(防御传播到所有迁移路径,旧版本文件也会被 loadExplorer 解析)。E1-E14 完成外部输入边界族。

## E15 — E14 漏改的 legacy v2 schema recentRoots/pinned 仍无上限 (P2,E14 自引入连带缺口)

- **文件**: `electron/shared/explorer-persistence-schema.ts:107` ExplorerSchema(v2)
- **问题**: E14 给路径数组加 cap 时,inline replace_all 只匹配单行形式(V3/writable),而 legacy v2 ExplorerSchema 的 workspace.recentRoots / pinned.paths 是**多行形式**未被替换,仍裸 `z.array(z.string())`。loadExplorer 接受 v2 后 migrateV2ToV3 原样搬到 v3 → 畸形 v2 explorer.json 仍可用超大 recent/pinned 数组绕过 E14 的新上限,启动 hydrate/写回路径造成同样的启动卡顿和 JSON/IPC 膨胀。
- **修复**: v2 ExplorerSchema 的 recentRoots/pinned 也改 `z.array(pathStr()).max(...)`;顺手把 v2/v3 window 的 root/activePath 统一为 `pathStr().nullable()`(E14 只改了 EditorSessionSchema 的 activePath 与 V1 root,window 层遗漏)。
- **测试**: persistence-schema.spec +2(E15):v2 schema recentRoots>1000 / pinned>10000 → fail。中和(v2 回裸 array)→ 两测试失败确认回归。
- **沉淀**: 「同一字段在多版本 schema(V1/V2/V3)以**不同代码形式**(单行 inline / 多行)出现时,replace_all 只覆盖一种形式 = 漏改」——E14 自引入的连带缺口被 codex 当轮逮到(同 race 方向 R102→R103/R111→R112 模式在 edge-case 方向复现)。修批量替换后必须 grep 确认**所有形式/所有版本**都改到(`grep 'z.array(z.string())'` 应归零)。换审计者(codex)捞自引入回归仍是最高价值。E1-E15 完成外部输入边界族,持久化 schema 全版本尺寸边界补齐。

## E16 — 插件权限 IPC schema 无长度/数量上限,畸形 payload 写超大 _permissions/_path-scopes (P2,E11-E15 兄弟)

- **文件**: `electron/main/ipc/plugins.ipc.ts:30` 权限/path-scope schemas
- **问题**: 插件权限 IPC schema 对 ids / decisions / pathScopes / plugin id / path / permission 字符串都无长度或数量上限。畸形 renderer payload 可把 _permissions.json / _path-scopes.json 写成超大对象或超长路径列表 → 主进程 RMW、atomic JSON 写入、启动水合、权限 UI 卡顿。
- **修复**: 加 cap:plugin id ≤256、permission ≤256、path ≤8192、git url ≤4096、enabled ids ≤10000、单插件 decisions ≤1000、单插件 pathScopes ≤10000、permission record 条目 ≤10000(.refine)。应用到 WriteEnabledInput/MutateEnabledInput/DecisionSchema/PathScopeSchema/PermissionRecordSchema/WritePermissionsInput/WritePluginPermissionsInput/InstallFromGitInput/UninstallInput。导出关键 schema 供测试。超限 → safeHandle zod 校验失败 → BAD_INPUT。
- **测试**: 新增 plugins-ipc-input-limits.spec(8 例):正常 ok;ids 数量/plugin id 长度/decisions 数量/pathScopes 数量/path 长度/record 条目数/git url 长度超限 → fail。中和(去所有 cap + refine)→ 7 个超限测试失败确认回归。
- **沉淀**: 「所有 renderer→main 写持久化的 IPC schema 都要尺寸边界」——terminal.create(E11)/shell.exec(E12)/fs.write(E13)/explorer 持久化(E14/E15)/plugin 权限(E16)。畸形 payload 写持久化文件 = 既污染磁盘又在下次启动 hydrate 放大成 DoS(写入 + 启动双重放大)。E1-E16 完成「外部/IPC/持久化输入边界」族全覆盖:尺寸(E1/E11/E12/E13/E14/E15/E16)+ 结构(E2/E3)+ 数值(E4-E10)。

## E17 — plugin MCP REGISTER payload 无长度/大小上限,超大 tool schema 反复广播膨胀 (P2,E16 兄弟)

- **文件**: `electron/shared/plugin-mcp-schemas.ts:13` RegisterPayloadSchema
- **问题**: plugin MCP REGISTER payload 的 pluginId/name/description/jsonSchema 无长度/深度/大小上限。jsonSchema 是任意对象、被 main 存进 tool registry,之后**每次** MCP tools/list 都把它序列化广播给 HTTP/stdio 客户端 → 恶意/畸形插件注册超大 tool schema 造成内存/IPC/网络输出膨胀(存一次、广播无数次,放大效应最强)。
- **修复**: pluginId/name ≤256、description ≤8192、requestId ≤256(InvokePayload)。jsonSchema 加序列化字节上限:`.refine(s => JSON.stringify(s).length <= 64KB)`(覆盖深度/属性数;序列化抛错=循环引用等不可序列化→非法)。UnregisterPayload/InvokePayload 的 name 同加上限。超限 → 拒绝注册(zod 校验失败)。
- **测试**: ipc-protocol.spec +E17(pluginId/name/description 超长、jsonSchema 序列化>64KB → fail;正常 schema ok)。中和(去 cap + jsonSchema refine)→ 4 测试失败确认回归。
- **沉淀**: 「存储 + 反复广播的数据,尺寸上限优先级最高」——register 的 jsonSchema 存一次但每次 tools/list 序列化广播,放大效应远超一次性 payload(E11-E16)。对「任意 JSON 对象」字段,序列化字节上限(JSON.stringify().length)是覆盖深度/属性数/总大小的单一有效闸门,且顺带验「可 JSON 序列化」。E1-E17 完成外部输入边界族,plugin MCP 注册面补齐。

## E18 — readFile 无大小上限,打开超大文件整文件读入内存致卡死/崩溃 (P2,E13 读侧对偶)

- **文件**: `electron/main/ipc/fs/read-file.ts:15` readFile
- **问题**: readFile 对目标文件无大小上限,直接 `fspReadFile(filePath, 'utf-8')` 整文件读入内存。用户打开超大文件或恢复多个超大 tab 时,主进程一次性分配巨大字符串并经 IPC 发送 → 卡死/崩溃。
- **修复**: 复用已有的 lstat `st.size` 做读前上限检查,超 64 MiB 抛 `FS_FILE_TOO_LARGE`(在 fspReadFile 之前拦截,不整文件读入)。上限取 64 MiB **与 fs.write 的 MAX_WRITE_BYTES(E13)一致** —— 可打开的文件都可保存,无「能开不能存」的数据丢失缺口。新增 ERROR_CODES.FS_FILE_TOO_LARGE + en/zh/ko catalog 三语(防 i18n 泄漏,topic-56);更新 error-codes-enum 计数 36→37。
- **测试**: fs-adapter.spec +1(E18):稀疏 truncate 扩展到 >64MiB(不写 64MB 实际数据)→ readFile 抛 FS_FILE_TOO_LARGE(size 检查在读之前)。中和(去 size 检查)→ 测试失败确认回归。
- **沉淀**: 「读/写尺寸上限必须成对且一致」——E13(write 64MiB)+ E18(read 64MiB)对偶:只 cap 写不 cap 读 → 仍可 OOM(读巨文件);read cap < write cap → 能存不能开;read cap > write cap → 能开不能存(数据丢失)。两者取同值 = 一致无缺口。复用已有 stat 的 size 字段做读前拦截零额外 syscall。新错误码必须同步三语 catalog + 计数测试(topic-56 i18n 纪律 + enum count 纪律)。E1-E18 完成外部输入边界族(IPC 写入 E11-E13/E16/E17 + 持久化 E14/E15 + 文件读 E18 + 结构 E2/E3 + 数值 E4-E10 + 流式 E1)。

## E19 — InvokeReply result/code/message 无大小上限,超大回传经 mcp-host 输出膨胀 (P2,E17 兄弟 reply 侧)

- **文件**: `electron/shared/plugin-mcp-schemas.ts:67` InvokeReplySchema
- **问题**: E17 在 invoke reply 侧的孪生。InvokeReplySchema 的 result/code/message 无大小上限,`result: z.unknown()` 通过后被 mcp-host 在 tools/call 路径 `JSON.stringify(result)` 输出给 HTTP/stdio 客户端。畸形/恶意插件可单次回传超大对象/字符串 → 主进程内存峰值、IPC/MCP 响应膨胀甚至卡死。
- **修复**: result 加 `.refine`:可 JSON 序列化(循环引用等 catch→非法)+ 序列化字节 ≤10MB(undefined 序列化为 undefined→按空结果放行);requestId ≤256、code ≤256、message ≤8192。超限 → 校验失败,reply 被拒不转发客户端。
- **测试**: ipc-protocol.spec +E19(result 序列化>10MB / 循环引用 / code·message 超长 → fail;正常 result ok)。中和(去 result refine + code/message max)→ 3 测试失败确认回归。
- **沉淀**: 「请求与回复两个方向都要尺寸边界」——E17 加了 register/invoke(请求侧),E19 补 invoke reply(回复侧)。reply.result 被 mcp-host JSON.stringify 转发给外部客户端,是「renderer→main→外部网络」的二次放大点。「任意 JSON 字段」(result/jsonSchema)统一用「可序列化 + 序列化字节上限」refine 兜底(E17 jsonSchema 64KB / E19 result 10MB,按用途定额)。E1-E19 完成外部输入边界族,plugin MCP 请求+回复双向尺寸边界齐。

## E20 — plugin-data store save/load 无序列化字节上限,超大插件数据 JSON.stringify/parse 内存峰值 (P2,E13/E18/E19 同族)

- **文件**: `electron/main/services/plugin-data-store.service.ts:73` save / :51 load
- **问题**: plugin-data:save 直接 atomicWriteJson(file, data),plugin-data:load 整文件 readFile + JSON.parse,对插件持久化 JSON 无大小/深度边界。畸形插件可保存超大对象,或磁盘上残留超大 data.json → 主进程 JSON.stringify/JSON.parse 内存峰值 + 长时间阻塞。
- **修复**: save 序列化前 `JSON.stringify(data)`(不可序列化→catch→拒)+ 字节 ≤16 MiB,超限抛 PAYLOAD_TOO_LARGE 不写;load 先 `stat.size`,超 16 MiB → rename 隔离为 .corrupt + 降级 {}(不整文件 readFile+parse)。16 MiB 远超现实插件结构化 KV 状态,save 封顶后正常磁盘文件不会超限,故 load 拦截只对外部写/损坏生效,非破坏合法数据。
- **测试**: plugin-data-store.test +3(E20):save 超 16MiB → 拒绝(未写出超大文件)/ save 循环引用 → 拒绝 / load 稀疏 truncate >16MiB → 隔离 .corrupt + 返 {} + 原文件移走。中和(去 save 上限 + load stat 拦截)→ save 超限 + load 隔离两测试失败确认回归。
- **沉淀**: 「读写持久化 JSON 两端都要序列化字节上限」——save(写出 + 下次 load 放大)与 load(整文件 parse)各是内存峰值点,两端同 cap(16MiB)闭合。`JSON.stringify` 既测大小又验「可序列化」(循环引用 catch)。E20 与 E14(explorer 持久化 schema)、E18(文件读)同属「持久化数据尺寸边界」,plugin-data 是第三类持久化面。E1-E20 完成外部/IPC/持久化输入边界族全覆盖。

## E21 — fs IPC path/name/exclude 无上限 + listDir exclude O(N) 扫描 (P2,E13 同族,我 E13 自引入缺口)

- **文件**: `electron/main/ipc/fs.ipc.ts:24` schemas + `electron/main/ipc/fs/list-dir.ts:45` walk
- **问题**: E13 只 cap 了 fs IPC 的 content,但 path/newName/name/dir/src/dest 及 listDir.options.exclude 仍无长度/数量上限(我 E13 的自引入覆盖缺口)。畸形 renderer/preload 调用可传超长路径或巨大 exclude 列表 → 在 IPC/zod/exclude 扫描路径耗内存+CPU;listDir 还对每个目录项做 `exclude.includes(d.name)` 即 O(N) 扫描(巨大 exclude × 宽目录 = 线性放大)。
- **修复**: 统一加 `fsPath()`(min1 max 8192)/`fsName()`(min1 max 1024)helper 应用到所有 path/newName/name/dir/parent/src/dest;`exclude: z.array(z.string().max(1024)).max(1000)`。listDir 内把 exclude 转 `Set`,`exclude.includes` → `exclude.has`(O(N)→O(1)),walk 签名 `readonly string[]`→`ReadonlySet<string>`。
- **测试**: fs-ipc-bridge.spec +E21(path>8192 / newName·name>1024 / src·dest>8192 / exclude 数量>1000 → fail;正常 ok)。fs-adapter listDir 既有 exclude 测试仍绿(Set 行为保持)。中和(去 path/name/exclude cap)→ 4 测试失败确认回归。
- **沉淀**: 「同一文件多字段加上限时,别只 cap 最显眼的(content),所有外部字符串/数组字段都要」——E13 我只 cap content,漏了 path/name/exclude,被 codex 同方向逮到(E14→E15、E13→E21 都是我自引入的部分覆盖缺口)。批量加 cap 后 grep `z.string().min(1)`(无 max)确认无残留。顺带把 O(N) 成员判断(includes)在热路径(每目录项)换 Set,尺寸边界 + 算法复杂度双修。E1-E21 完成外部输入边界族。

## E22 — readRecord 不校验 localStorage 记录的 value/key/条目数,畸形值致下游崩溃 (P2,结构维度)

- **文件**: `src/plugins/storage/local-storage-record.ts:8` readRecord(keybindings-store / values-store 调用)
- **问题**: readRecord「是 object 就强转 Record<string,V>」,不校验 key/value 类型、长度或条目数。畸形/篡改的 localStorage(如 continuo.keybindings.overrides 混入非字符串值)被读进内存,下游 getEffectiveHotkey → useCommandHotkeys 在 compileCombo(effective) 调 `effective.toLowerCase()` **崩溃**;大量/超长 key 也让 settings/keybindings store 初始化/同步卡顿。
- **修复**: readRecord 加可选 `opts: { valueGuard, maxEntries, maxKeyLength }`,逐条目过滤(非法 value 丢弃、超长 key 跳过、超条目数截断);**不传 opts 保持旧行为**(兼容未迁移调用方)。keybindings-store:valueGuard=string 且 ≤256、key≤256、≤10000 条(非法项→回退默认快捷键,不崩);values-store:valueGuard=原语(string/number/boolean,丢对象/数组,number 越界由 E6 clampSettingNumber 钳)、key≤256、≤10000 条。
- **测试**: 新增 local-storage-record-guard.spec(7 例:无 opts 旧行为 / valueGuard 过滤非字符串 / value 长度限制 / maxKeyLength 跳过 / maxEntries 截断 / 原语守卫 / 非对象→{})。中和(constrained=false)→ 5 测试失败确认回归。**顺带**:插入行使既有 globalThis.localStorage 命中行号位移,更新 web-compat-allowlist.json 行号(9→24/11→26/24→56/26→58)—— 行号钉死的 allowlist 在改动同文件后必同步(M21 web-compat 纪律)。
- **沉淀**: 「localStorage 记录读取的结构校验」补 E2/E3(缓存)、E14/E15(explorer 持久化)之外的第三类持久化读入面——renderer 通用 KV 记录。「是 object 就强转」放行畸形 value,在下游字符串方法(.toLowerCase / .startsWith)处崩。读入时即按消费者期望类型过滤(value guard),崩溃前移成「丢弃 + 降级默认」。E1-E22 完成外部输入边界族:尺寸(E1/E11/E12/E13/E14/E15/E16/E17/E18/E19/E20/E21)+ 结构(E2/E3/E22)+ 数值(E4-E10)。

## E23 — AttachTargetSchema panelId/windowId 无长度/安全整数边界 (P2,E11/E21 兄弟)

- **文件**: `electron/shared/terminal-attach.ts:7` AttachTargetSchema(+ renderer `src/stores/terminal.store.ts:25` isAttachTargetShape)
- **问题**: panelId 只 `.min(1)`、windowId 只 `.int()`,无长度/安全整数/非负边界。被 TerminalCreateInputSchema 复用 → MCP create_session 或 renderer 可传超长 panelId / 不安全巨大 windowId,该对象进 terminal session metadata 并随 sessions_changed 广播到所有 renderer → IPC/UI 膨胀,或窗口匹配逻辑在不安全整数上行为不可预测。
- **修复**: panelId `.min(1).max(256)`;windowId `.int().nonnegative().max(Number.MAX_SAFE_INTEGER)`(挡 ≥2^53 舍入值,同 E4/E7/E8)。同步 renderer isAttachTargetShape:panel 加 panelId.length≤256,window 加 Number.isSafeInteger + ≥0(codex 明确要求 main schema 与 renderer guard 双侧一致)。
- **测试**: 新增 attach-target-bounds.spec(6 例:active/panel/window 合法;panelId 超 256/空串、windowId 负/≥2^53/非整数 → fail)。中和(去 panelId max + windowId nonneg/max)→ 3 测试失败确认回归。
- **沉淀**: 「schema 校验有 main(zod)+ renderer(手写 guard)两套时,边界收紧必须双侧同步」——AttachTargetSchema(IPC ingress)与 isAttachTargetShape(sessions broadcast ingress)是同一形态的两个守卫入口,只改一侧 = 另一侧仍放行畸形(防御传播到所有兄弟实现,同 E15/E21 自审教训)。windowId 是 E4(persistence)/E8(URL query)之外的第三个 window 标识不安全整数面。E1-E23 完成外部输入边界族。

## E24 — 插件目录扫描读 manifest/main/styles 无文件大小上限,超大插件包致内存峰值/IPC 膨胀 (P2,E18 兄弟)

- **文件**: `electron/main/services/plugins.service.ts:150` listPluginDirs
- **问题**: 插件目录扫描对 manifest.json/main.js/styles.css 直接 `fs.readFile(.., 'utf-8')`,无文件大小上限。畸形/恶意插件包可放超大 manifest/main/styles;应用启动或插件列表刷新时主进程整文件读入并通过 IPC 传给 renderer → 内存峰值、卡死、崩溃。
- **修复**: 加 `readFileCapped(path, max)`:先 `stat.size`,超限 console.warn + 返 null(不读)。manifest ≤1MiB、main ≤8MiB(bundled 源码)、styles ≤4MiB。manifest/main 超限(返 null)→ 跳过整个插件(同既有缺失即 continue 语义);styles 超限 → 当无样式(undefined,不阻断插件)。不把超大源码/样式跨 IPC 传输。
- **测试**: plugins-service.spec +E24(稀疏 truncate:manifest>1MiB / main>8MiB → 跳过整插件;styles>4MiB → stylesText undefined 插件仍收)。中和(去 stat.size 拦截)→ 3 测试失败确认回归。
- **沉淀**: 「凡 readFile 整文件读入 + 跨 IPC 传输的入口都要 stat.size 上限」——E18(用户文件读)+ E20(plugin-data)+ E24(插件源码扫描)是三个不同的「读文件→内存→IPC」面,readFileCapped(stat 先于 read)是统一手法。复用既有 stat 或新增一次 stat,零~一 syscall 代价换掉 OOM 向量。E1-E24 完成外部输入边界族。

## E25 — isValidMarketplaceEntry 只校验字段类型,无长度/数量上限且 repo 未约束 GitHub 安全形态 (P2,E2 同族强化)

- **文件**: `src/marketplace/types.ts:47` isValidMarketplaceEntry(我 E2 的自引入覆盖缺口)
- **问题**: E2 的逐 entry 守卫只判字段类型(string/array/bool)非空、repo 含 '/',不限制 id/name/author/repo/branch/description/tags 的长度、tags 数量,也不约束 repo 为两段安全 GitHub owner/name。远程 index.json 可放超长字段或海量 tags,进 session cache 后在 applyFilter/排序/卡片渲染/manifest URL 拼接中放大 CPU/内存;畸形 repo(`a/b/c`、`../etc/passwd`、`owner/name?x=1`)还会被 entryToGitUrl/entryToManifestUrl 拼出异常 raw/github URL。
- **修复**: isValidMarketplaceEntry 增长度上限(id/name/author≤256、description≤4096、authorUrl≤2048、repo≤512、branch≤256、单 tag≤128)+ tags 数量≤64;repo 用 `^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$`(两段安全 owner/name,挡多段/空格/查询串/路径穿越),branch 用 `^[A-Za-z0-9._/-]+$`(GitHub 安全字符,允许 `release/v1.2`)。超限/非法 entry 返 false → 经 E2 既有 filter 过滤掉、不进缓存。
- **测试**: marketplace.spec +E25(guard 直测:合法 entry/超长 id·name·author·description/repo 非两段(no-slash、a/b/c、含空格、路径穿越、查询串)/branch 非安全字符与超长/tags 数量>64 与单 tag 超长;fetch 级:超长 name·海量 tags·三段 repo entry 被过滤不进缓存)。中和(MAX 设 1e9 + REPO_RE=`/\//`、BRANCH_RE=`/.*/`)→ 5 测试失败确认回归。
- **沉淀**: E2 我只做了「类型 + repo 含 '/'」的浅校验,放行超长字段/海量 tags/多段或带特殊字符的 repo(E14→E15、E13→E21、E2→E25 都是我自引入的部分覆盖缺口,codex 同方向逮到)。远程数据守卫不止判类型,还要判尺寸(长度/数量)与安全形态(用作 URL 片段的字段必须正则约束到安全字符集,挡路径穿越/查询注入)。E1-E25 完成外部输入边界族:尺寸(E1/E11-E21)+ 结构(E2/E3/E22/E25)+ 数值(E4-E10)。

## E26 — stop-hook broker readFile hook 事件文件无大小上限,超大 JSON 致内存峰值/事件循环阻塞 (P2,E18/E20/E24 兄弟)

- **文件**: `electron/main/services/mcp-tools-hook-bridge.ts:252` ingestFile
- **问题**: stop-hook event 文件由外部 CLI(claude/codex)的 Stop hook 经 `cat >` 写入,内容完全不可控。ingestFile 在 `stat` 之后直接 `readFile(.., 'utf8')` 整块读入再 `JSON.parse`,无文件大小上限;解析后的完整 `raw` 还被缓冲在 buffered entry(最多 maxEntries=500 条)并在 `include_raw=true` 时跨 MCP 传回 client。畸形 hook 文件或异常 CLI 输出可让主进程整块读入超大 JSON → 内存峰值 + 事件循环长时间阻塞 + buffered 累积放大。
- **修复**: 加 `MAX_HOOK_FILE_BYTES=1MiB`。ingestFile 在已有的 `fileStat`(stat 已就绪,零额外 syscall)之后即按 size 拦截:超限 console.warn + 标 processed + unlink 隔离(同 maxAge 分支语义:不重试、不留残留),不读不解析不缓冲。该上限同时反向钳住下游 `raw` / `last_assistant_message` / include_raw payload 的字节数(全部派生自被钳的 jsonText),无需对每个派生字段单独截断。
- **测试**: await-stop-hook.spec +E26(超大但合法 JSON,last_assistant_message 灌到 >1MiB → 从不投递,await 超时而非 status:'stop';隔离文件被 unlink 删除)。中和(`if (false && ...)`)→ E26 测试失败确认回归(超大文件被读入解析缓冲后误投递)。
- **沉淀**: 「凡 readFile 整文件读入 + 跨 IPC 传输的入口都要 stat.size 上限」第四个面——E18(用户文件读)+ E20(plugin-data)+ E24(插件源码扫描)+ E26(外部 CLI 写的 hook 事件文件)。E26 的 stat 本就为 maxAge 判定而存在,size 拦截是零成本复用。文件级单一上限优于对 raw/last_assistant_message 逐字段截断:所有派生数据都从 jsonText 来,钳住源头即钳住全部下游,符合极简原则且不改变投递契约(不截断真实消息,而是整文件拒收畸形输入)。E1-E26 完成外部输入边界族。

## E27 — installFromGit 读 clone 的 manifest.json 无大小上限(E24 的自引入兄弟缺口) (P2,E18/E20/E24 兄弟)

- **文件**: `electron/main/services/plugins.service.ts:632` installFromGit
- **问题**: E24 给 listPluginDirs 启动扫描的 manifest/main/styles 读加了 readFileCapped(stat.size 上限),但安装路径 installFromGit 验 manifest 时仍是裸 `fs.readFile(path.join(cloneDir, 'manifest.json'), 'utf-8')` + JSON.parse,无大小上限。clone 来自外部 git 仓库、内容不可控;畸形/恶意仓库可放超大 manifest.json → 主进程整块读入超大字符串 → 内存峰值(同 E24 的「读文件→内存」向量,只是另一个入口)。
- **修复**: 安装路径改用同一 `readFileCapped(.., MANIFEST_MAX_BYTES)`(1MiB,与 listPluginDirs 一致)。超限/缺失/不可读 → 返 null → 抛 `BAD_MANIFEST`,在任何 cp/rename 复制替换插件目录之前 fail-fast 中止(不污染 baseDir)。仅 manifest 需在此 cap:install 不把 main 读入内存(只 fs.access + 整目录 cp),main/styles 的内存读由装后的 listPluginDirs(E24 已 cap)负责。
- **测试**: install-atomic-overwrite.spec +E27(mock clone 加 oversize 开关写 >1MiB manifest:全新安装 → BAD_MANIFEST + 目标目录不创建、无 staging/backup 残留;覆盖安装 → BAD_MANIFEST + 旧版本原样保留)。中和(MANIFEST_MAX_BYTES→Number.MAX_SAFE_INTEGER)→ 2 测试失败确认回归。
- **沉淀**: E24→E27 又是「同一手法只应用到一个入口,漏了平行入口」族(同 E14→E15、E13→E21、E2→E25)——readFileCapped 当时只改了 listPluginDirs(扫描),漏了 installFromGit(安装)这个同样「读 manifest 入内存」的入口。**应用「修一类必 grep 所有兄弟入口」教训:codex 报 installFromGit 后我顺手 grep 全 plugins.service.ts 的 fs.readFile,发现第三处同源未覆盖入口 `createPluginsWatcher.runScan`(读 manifest 取 mainName/id 做变更检测)也是裸 readFile,一并改 readFileCapped(超限→跳过该插件目录),不等下一轮再报**。三处外部 manifest 读(扫描 E24 / 安装 E27 / watcher E27-sibling)现全 cap;另三处 readFile(:220/322/429)读 app 自有元数据(enabled ids/permissions,user-data 目录)非外部攻击面,不在此族。安装路径 fail-fast 抛在 cp/rename 之前,天然满足「不复制/替换插件目录」。E1-E27 完成外部输入边界族。

## E28 — plugin-fs:read-file 无大小上限(E18 主 fs:read-file 的平行入口漏网) (P2,E18 兄弟)

- **文件**: `electron/main/services/plugin-fs.service.ts:177` `plugin-fs:read-file` handler
- **问题**: plugin-fs:read-file 经 scope 校验后直接 `fs.readFile(canonicalPath(r), 'utf-8')`,没有像主 `fs:read-file`(E18:MAX_READ_BYTES=64MiB + FS_FILE_TOO_LARGE)那样的 stat.size 上限。已授权插件可读取超大文件 → 主进程整块读入巨大字符串并经 IPC 返回 renderer → 内存峰值/卡死。这是 E18「fs.readFile 大文件保护」的平行入口漏网(plugin-fs 是 Explorer fs 的平行入口)。
- **修复**: 复用主 fs:read-file 的 `readFile`(`../ipc/fs/read-file`)单一来源:读前 lstat.size 上限(64MiB)+ FS_FILE_TOO_LARGE + 目录守卫(FS_NOT_FILE)+ errno 映射。`return readFileCapped(canonicalPath(r))`。与 write-file 复用 `atomicWriteFile`(R4:plugin-fs 平行入口漏了原子写保护)完全同手法 —— Explorer fs 的每项保护都要传播到 plugin-fs 平行入口。其余 plugin-fs 读已安全:readGitBlob 早有 64MB 字节上限,cp 走 fs.cp 流式,stat/lstat/list-dir 不读内容。
- **测试**: 新建 plugin-fs-read-cap/read-file-size-cap.spec(经 StubIpcMain + registerPluginFsHandlers 真实走 handler:小文件正常读;稀疏 truncate >64MiB → FS_FILE_TOO_LARGE 读前拦截;读目录 → FS_NOT_FILE)。中和(改回裸 fs.readFile)→ 2 测试失败确认回归(oversize 返超大字符串不抛、目录抛 EISDIR≠FS_NOT_FILE)。
- **沉淀**: 「Explorer fs 的每项边界/安全保护都要 grep plugin-fs 平行入口确认传播」——这是 plugin-fs 平行入口漏防御的第三次(R4 原子写 / scope 路径 canonicalize / 现在 E28 大文件读)。write-file 的注释里早写明 R4 教训,但 read-file 当时没同步加保护。单一来源复用(直接调主 fs 的 readFile,而非复制 stat 逻辑)既修缺口又防未来漂移。E1-E28 完成外部输入边界族。

## E29 — plugin-fs:write-file content 无大小上限(E13 主 fs:write-file 的平行入口漏网,E28 写侧 twin) (P2,E13 兄弟)

- **文件**: `electron/main/services/plugin-fs.service.ts:188` `plugin-fs:write-file` handler
- **问题**: plugin-fs:write-file 经 scope 校验后把 `content` 直接交给 atomicWriteFile,无大小上限。主 `fs:write-file`(E13)早有 `content: z.string().max(MAX_WRITE_BYTES)`(64MiB),但 plugin-fs 平行入口漏了。已授权插件可经单次 IPC 发超大字符串 → 主进程 IPC 内存峰值 + 超大临时文件 + fsync/rename 长时间阻塞。是 E28(read-file 大小上限)的写侧对偶。
- **修复**: 从 fs.ipc.ts 导出 `MAX_WRITE_BYTES` 单一来源,plugin-fs:write-file 在进 atomicWriteFile 前 `if (content.length > MAX_WRITE_BYTES)` 抛 `FS_FILE_TOO_LARGE`(与 E28 读侧 twin 同错误码,已 i18n)。按 content.length 比较与主入口(zod string .max)语义一致。拒绝在写之前 → 不产生超大临时文件、不落盘。
- **测试**: plugin-fs-read-cap/read-file-size-cap.spec +E29(经 StubIpcMain 真实走 handler:正常 content 正常写;content 'x'.repeat(64MiB+1) → FS_FILE_TOO_LARGE 且目标文件未创建,同 E13 写测试的分配方式)。中和(`if (false && ...)`)→ E29 oversize 测试失败确认回归(超大内容被写入未拒)。
- **沉淀**: plugin-fs 平行入口漏 Explorer fs 保护的第四次(R4 原子写 / scope canonicalize / E28 读上限 / E29 写上限)——read/write 两侧 cap 是 twin,补一侧必同时补另一侧(E28 修读时其实就该顺手补写,这次被 codex 同方向逮到,又一「修一族未传播到对偶」)。单一来源复用 MAX_WRITE_BYTES(导出而非复制常量)防上限漂移。plugin-fs 全部读写大小入口现已覆盖:read-file(E28)/write-file(E29)/readGitBlob(早有 64MB)/cp 流式。E1-E29 完成外部输入边界族。

## E30 — plugin-fs:list-dir 无条目数上限,超大目录全量数组跨 IPC 卡顿 (P2,plugin-fs 平行入口第五)

- **文件**: `electron/main/services/plugin-fs.service.ts:219` `plugin-fs:list-dir` handler
- **问题**: list-dir 经 scope 校验后 `fs.readdir(.., {withFileTypes:true})` 整目录读入再全量 map 返回,无条目数量上限。已授权插件对超大目录(如 `/`、node_modules、生成的海量文件夹)调 listDir → 主进程一次性把全部 Dirent 物化进内存 + 构造巨大数组 + 经 IPC 全量返回 → 内存/CPU/IPC 卡顿。主 Explorer listDir 有 maxFiles(opt-in)/MAX_DEPTH_HARD_LIMIT,plugin-fs 平行入口无任何 backstop。
- **修复**: 改用 `fs.opendir` 惰性迭代(不先把全部 Dirent 物化),累计到硬上限 `MAX_LIST_DIR_ENTRIES=100_000` 即 **fail-closed 抛 FS_DIR_TOO_LARGE**(新增错误码 + en/zh/ko catalog)。**不静默截断**:截断会让插件误判「文件不存在」(对错误的列表做决策);fail-closed 让插件明确知道目录过大。100k 单层直接子项是滥用 backstop(远超任何现实插件目录)。for-await 抛出时自动调迭代器 return() 关闭 dir,无句柄泄漏。
- **测试**: plugin-fs-read-cap.spec +E30(正常目录正常返回;惰性 fake Dir 产生 cap+1 条目【spy opendir 免真建 10 万文件】→ FS_DIR_TOO_LARGE)+ error-codes-enum 37→38 + catalog 自动 +3 locale。中和(`if (false && ...)`)→ E30 over-limit 失败确认回归。
- **沉淀**: plugin-fs 平行入口漏 Explorer fs 保护的第五次(R4 原子写 / scope canonicalize / E28 读上限 / E29 写上限 / E30 列目录上限)。**「整集合读入内存 + 跨 IPC 返回」的入口除了文件大小(E18/E28/E29)还有集合基数(目录条目数)** —— readdir/map 全量物化是隐藏的 O(N) 内存+IPC 向量,opendir 惰性迭代 + 硬上限是无界目录的正解。新错误码走完整 i18n catalog(en/zh/ko)+ enum count 流程。E1-E30 完成外部输入边界族。

## E31 — plugin-fs:request-scope 的 scopes 无运行时校验,畸形数组放大 realpath/IPC/弹窗 (P2,IPC payload 校验族)

- **文件**: `electron/main/services/plugin-fs.service.ts:537` `plugin-fs:request-scope` handler
- **问题**: request-scope 接受 `scopes: readonly PathScope[]` 但无运行时形状/数量/路径长度/mode 校验,随后直接 `Promise.all(scopes.map(...canonicalizeScopePath))`(批量 realpath)+ 把原始 scopes 经 IPC 发 renderer 弹窗 + 可能进 registry/persist。畸形插件可传超大 scope 数组(批量 realpath + 大 IPC payload + 权限弹窗渲染卡顿)/超长路径/非法 mode(进 registry/persist 致后续授权匹配语义异常)。
- **修复**: handler 入口 fail-closed 校验(在 identity resolve 之后、canonicalize/covers/弹窗/持久化之前):`scopes` 必须是数组且 `length ≤ MAX_SCOPE_REQUEST_COUNT=64`;每个 entry 必须是 object、`path` 为非空 string 且 `≤MAX_SCOPE_PATH_LEN=8192`(与 fs.ipc fsPath 对齐)、`mode ∈ {'r','rw'}`。任一违反 → 抛 BAD_INPUT,绝不进入 canonicalize/弹窗/持久化。
- **测试**: plugin-fs-read-cap.spec +E31(合法 scope【已授权覆盖】→ grant 校验通过;数量 >64 / 路径 >8192 / 非法 mode 'admin' → BAD_INPUT)。中和(两处 `if (false && ...)`)→ 3 个 reject 测试失败确认回归(合法 case 仍 grant)。
- **沉淀**: plugin-fs 入口加固第六(R4/canonicalize/E28/E29/E30/E31)。**IPC payload 校验族**(E11 terminal-create / E12 shell exec / E16 plugins.ipc / E17 MCP register / E23 attach-target)新增 plugin-fs:request-scope —— 凡「插件/renderer 直传的数组/对象 IPC 参数,后续做批量 I/O(realpath)或跨 IPC 转发或进持久化」的 handler,都必须入口校验数量/长度/枚举,fail-closed 在放大动作之前。非法 mode 进 registry 是「畸形输入污染权限状态」的隐蔽变体(不止性能,还有授权语义正确性)。E1-E31 完成外部输入边界族。

## E32 — MCP create_session 绕过 TerminalCreateInputSchema 上限,协议包 schema 无尺寸限制 (P2,E11 平行入口 / 跨进程 schema 漂移)

- **文件**: `electron/main/services/mcp-tools-terminal.ts:191` makeCreateSessionTool.run(根因:`electron/main/index.ts:607` `ptyCreateHandler = makeCreateHandler()` 是 raw handler;协议包 `@continuo-terminal/protocol/src/schemas.ts` createSessionInputSchema 无上限)
- **问题**: MCP create_session 用协议包 `createSessionInputSchema` 校验输入(该 schema 对 cwd/name/agentLabel/autorun/target 无长度/数量上限,cols/rows 仅 positive),随后 Continuo 调 `createSessionForAgent` → **raw `ptyCreateHandler`**,**绕过**了有上限的 `TerminalCreateInputSchema`(E11,只在 IPC 路径经 safeHandle/zod 生效)。外部 MCP client 可传近 1MB 的 autorun/name/cwd → 写入 terminal session metadata 广播所有 renderer、或把超长 autorun 注入 PTY → IPC/UI/PTY 卡顿。两套 schema(协议包 vs Continuo)上限漂移 = 跨进程契约缺口。
- **修复**: **持久修复落在 Continuo 信任边界**(协议包是 file: 依赖、源在 ContinuoTerminal 兄弟仓,改 node_modules 不持久)。makeCreateSessionTool.run() 入口 fail-closed 校验 Continuo 实际使用的字段:cwd≤PATH_MAX(8192)、name/agentLabel≤LABEL_MAX(512)【从 terminal-create.ts 导出复用 E11 单一来源】、autorun≤64KB、target 经 AttachTargetSchema(E23)。**校验先于授权弹窗**(畸形请求不烦用户)且先于任何副作用,超限抛 BAD_INPUT。Continuo 忽略的协议字段(shell/args/env/cols/rows 未进 ptyInput)无需在此 cap。
- **跨仓 follow-up**: 协议包 createSessionInputSchema 应在源头(ContinuoTerminal 仓)补与 terminal-create.ts 对齐的 .max()/.safe(),作为纵深防御;但 Continuo 不能依赖外部包的校验守自己的信任边界,故 Continuo 侧 cap 是正解(即使协议包修了也保留)。
- **测试**: create-session.spec +E32(cwd/name/agentLabel/autorun/target.panelId 各超限 → BAD_INPUT 且不弹授权/不创建【校验先于 ensureAuthorized】;上限内正常入参 → 正常创建)。中和(两处 `if (false && ...)`)→ 5 个超限测试失败确认回归。
- **沉淀**: 「同一逻辑入口有多条路径(IPC safeHandle 路径 vs MCP raw handler 路径),校验只挂在其中一条 = 另一条裸奔」——E11 的 cap 只在 IPC 经 zod 生效,MCP 走 raw ptyCreateHandler 绕过。**信任边界校验不能依赖外部包/另一条路径的 schema**,每个 ingress 路径都要在自己入口 enforce。这是 plugin-fs 平行入口族(E28-E31)在「同进程不同调用路径」维度的变体。E1-E32 完成外部输入边界族。

## E33 — session:update-cwd 的 id/cwd 无长度上限,超长值膨胀会话表/广播/Dock (P2,E11/E23 同族)

- **文件**: `electron/main/ipc/terminal.ipc.ts:76` updateCwdInputSchema(+ 兄弟 write/resize/idOnly/attachRejected 的 id)
- **问题**: session:update-cwd 的 id/cwd 只 `.min(1)` 无长度上限,随后 updateCwd 直接把 cwd 写进 session metadata 并触发 sessions_changed 广播。畸形 renderer/terminal bridge 可把超长 cwd 写入主进程会话表 → 每次 session snapshot 广播 + Dock 渲染携带巨大字符串;错误路径还把超长 id 拼进错误消息。同 schema 文件里 session id 在 write/resize/idOnly/attachRejected 各处都是 `z.string().min(1)` 无上限(平行入口同缺)。
- **修复**: cwd `.max(PATH_MAX=8192)`(复用 create 的 E11 常量,从 terminal-create.ts 导出);id `.max(SESSION_ID_MAX=256)`(id 是 `term-<uuid>` 形态,256 远超真实)。**应用「修一族必 grep 所有兄弟入口」**:同文件 write/resize/idOnly/attachRejected 的 id/sessionId 一并加 256 上限,不只改 update-cwd 这一个被报的入口。超限 → safeHandle zod 校验失败 → BAD_INPUT。
- **测试**: terminal-ipc.spec +E33(update-cwd id>256 / cwd>8192 / 空 id·cwd → fail,正常 → ok;write·resize·idOnly id>256 → fail)。中和(SESSION_ID_MAX=1e9 + cwd .max(1e9))→ 5 测试失败确认回归。
- **沉淀**: IPC schema 边界族(E11 create / E23 attach / E16 plugins / E17 MCP / E31 request-scope)新增 terminal session 更新/操作通道。`.min(1)` 只挡空串不挡超长 —— 凡进 session metadata + sessions_changed 广播(放大到所有 renderer + Dock 渲染)的字段都要 `.max()`。session id 作为查找键 + 错误消息插值 + 广播载荷,在同文件多个 schema 重复出现,统一 SESSION_ID_MAX 一次覆盖全兄弟入口(codex 只报了 update-cwd,grep 同文件把 write/resize/idOnly 一并修,不等下轮)。E1-E33 完成外部输入边界族。

## E34 — window:notify-root 的 root 无长度上限,超长 cwd 回退驻留主进程 map (P2,E11/E33 同族)

- **文件**: `electron/main/ipc/window.ipc.ts:75` NotifyRootInput / notify-root handler
- **问题**: window:notify-root 的 root 只校验 nullable string + absolute/非空,无长度上限;随后 `setWorkspaceRoot(win.id, root)` 写入 windowId→root map 长期驻留主进程,并作为 MCP/terminal create 未显式传 cwd 时 agent session 的回退工作目录。畸形 renderer 可推送超长 absolute 字符串 → 长期驻留 map,后续 agent terminal 创建把该超长 cwd 带入错误消息/resolve/stat 路径 → 内存 + 同步 fs 检查开销。
- **修复**: root 加 `.max(ROOT_MAX=2048)`,与同文件 `CreateInput.workspace`(`.min(1).max(2048)`)对齐。校验放在既有 root-shape 块(与 absolute/非空 同组),超限返回 BAD_ROOT(语义归类正确,且复用既有 BAD_ROOT 路径/消息,不破 T7 等既有断言)+ 不落 map。
- **测试**: notify-root-validation.spec +E34(超长 absolute root【2049 字符】→ BAD_ROOT 且 setWorkspaceRoot 未调用;恰好上限【2048 字符】→ 接受并存储)。中和(ROOT_MAX→1e9)→ 超长拒绝测试失败确认回归。
- **沉淀**: IPC schema 边界族(E11/E23/E31/E33)再补 window cwd-hint 入口。**「长期驻留主进程状态 map + 作为下游路径回退源」的字段尤其要 cap**:不仅入站时大,还会在每次下游消费(terminal create resolve/stat/错误消息)被反复放大。对齐同文件已有兄弟字段(CreateInput.workspace=2048)是选 cap 值的天然依据,避免拍脑袋。E1-E34 完成外部输入边界族。

## E35 — CommandRegistry.register 不校验插件贡献项,超长字段/异常 hotkey 进全局 registry (P2,插件 API 边界)

- **文件**: `src/plugins/registries/CommandRegistry.ts:34` register
- **问题**: register 接受第三方插件的 id/title/titleKey/hotkey/category/categoryKey 后直接入全局 registry,无长度/形态上限。恶意/畸形插件可注册超长标题/分类/热键 → 命令面板排序与搜索、快捷键预编译(compileCombo)、日志 warning、UI 渲染都携带大字符串 → renderer 卡顿;异常 hotkey 还会被 compileCombo 当有效签名参与全局 keydown 扫描。plugin 经 `coApp.commands.register` 直连此 registry(无 scoped-app 包装层),故 register 本身是 API 信任边界。
- **修复**: register 入口 `validateCommandSpec`:id≤256 / title≤512 / titleKey·categoryKey≤256 / category≤256 / hotkey≤64 长度上限 + hotkey 形态(宽松正则 `^[^+\s]+(\+[^+\s]+)*$`:'+'-连接非空段、段内无空白,**允许 mod+, / mod+/ 等标点主键**——亲查真实 hotkey 含逗号,严格字符集会误伤)。非法 spec 抛可诊断 Error(由插件加载错误处理捕获),不入 registry。核心命令字段短,不触上限。
- **测试**: registries.spec +E35(标点主键 mod+,·mod+/·shift+mod+enter 合法;超长 title/id/category/titleKey/hotkey → 抛且不入 registry;空段 mod++s / 含空白 mod + s → 抛)。中和(`if (false) validateCommandSpec`)→ 4 reject 测试失败(合法 case 仍过)确认回归。全量 4002 PASS 无回归(核心命令注册不受影响)。
- **沉淀**: 插件 API 信任边界 = 插件直连的 host 方法(coApp.commands.register),不是 IPC/scoped-app。**宽松形态校验优于严格字符集**:亲查真实数据(hotkey 含逗号/斜杠标点主键)再定正则,只挡明确异常(空段/空白/超长),避免误伤合法贡献(同 E25 repo 正则但教训相反方向——这里要更宽松)。**兄弟 registry 同族待查**:PanelRegistry/RibbonRegistry/SettingTabRegistry/SettingItemRegistry 的 register 也接受插件字段,codex 亲读后选 CommandRegistry 为最高价值先报;同手法(贡献项长度/形态校验)可推广,后续轮次或主动补。E1-E35 完成外部输入边界族当前批次。

## E36 — SettingItemRegistry.register 不校验插件 SettingItemSpec,畸形枚举/数值/default 异常 (P2,E35 兄弟 registry)

- **文件**: `src/plugins/registries/SettingItemRegistry.ts:71` register
- **问题**: register 接受插件贡献的 SettingItemSpec 无运行时校验:id/category/title/group 长度、enum 数量与 option 长度、default 类型、min/max/step/priority 是否 finite 都不查。畸形插件可注册超大 select 枚举冻结设置页,或用 NaN/Infinity 的 priority/min/max/step、类型不匹配 default 让排序/输入控件行为异常(clampSettingNumber 对 NaN min/max 也算错)。E35 在 CommandRegistry 同族,这是 codex compact 后续扫的兄弟 registry(E35 doc 已预告)。
- **修复**: register 入口 `validateSettingItemSpec`:字符串长度(id/category/group≤256、title≤512、*Key≤256、description≤2048、unit≤64)+ type ∈ 枚举 + enum 数量≤256 与每 option value/label≤512 + min/max/step/priority 必 finite + min≤max + step>0 + default 与 type 匹配(boolean→boolean / number→有限 number / text·select→string)。非法抛可诊断 Error、不入 registry。核心设置项字段短/数值正常,不触限。
- **测试**: setting-item-registry.spec +E36(合法 ok;超长 id·title / enum>256 / option 超长 / 非有限 priority·min·max·step / min>max / step≤0 / default 类型不匹配 → 抛)。中和(`if (false)`)→ 6 reject 测试失败确认回归。全量 4009 PASS 无回归。
- **沉淀**: 插件贡献 registry 族(E35 Command / E36 SettingItem)统一手法 = register 入口校验贡献项。SettingItem 比 Command 多了 type/default/enum/数值参数 → 校验更全(类型匹配 + 数值 finite + 区间一致性 step>0/min≤max)。**「数值参数不止要 finite,还要语义一致性(min≤max、step>0)」**:NaN min 会让 clampSettingNumber 的比较恒 false 静默失效,Infinity step 让输入控件异常。剩余兄弟 registry(Panel/Ribbon/SettingTab)同族,后续轮次或主动补。E1-E36 持续推进外部输入边界族。

## E37 — PanelRegistry.register 不校验插件 PanelSpec,畸形 type/factory 崩 dock 渲染 (P2,E35/E36 兄弟 registry)

- **文件**: `src/plugins/registries/PanelRegistry.ts:27` register
- **问题**: register 接受插件 PanelSpec 无运行时校验:type/title/titleKey 无长度/非空上限,factory 也未确认是函数。畸形插件可注册超长 type 污染 Dockview components map / panel id 路径,超长标题卡住 tab/title 同步;factory 非函数会在 DockShell 渲染 panel 时直接抛 → dock 面板渲染崩溃。PanelRegistry 比文案列表影响更大(直接进 Dockview components map)。
- **修复**: register 入口 `validatePanelSpec`:type 非空 string ≤256、title 非空 string ≤512、titleKey ≤256、**factory 必须 typeof === 'function'**。非法抛可诊断 Error、不入 registry。type 用作 Dockview component key,只校验长度/非空(不限字符集,避免误伤合法 type,同 E35 宽松教训)。
- **测试**: registries.spec PanelRegistry +E37(合法 ok;超长 type/title/titleKey → 抛不入;空 type/title → 抛;factory 非函数 → 抛)。中和(`if (false)`)→ 3 reject 测试失败确认回归。全量 4013 PASS 无回归。
- **沉淀**: 插件贡献 registry 族第三(E35 Command / E36 SettingItem / E37 Panel)。**PanelSpec 比文案 spec 多一个 factory 函数字段 → 校验须含「callable 检查」**(factory 非函数在渲染期才崩,注册期 typeof 检查把崩溃前移到加载期、可诊断)。codex 亲读全部剩余 registry 后选「畸形输入直接影响核心布局/渲染路径」的 PanelRegistry 为最高价值。剩余 RibbonRegistry/SettingTabRegistry/StatusBarRegistry 同族待续。E1-E37 持续推进。

## E38 — 主 fs:list-dir maxFiles 默认 Infinity 无总条目硬上限,超宽目录卡死 (P1,plugin-fs E30 主侧 twin)

- **文件**: `electron/main/ipc/fs/list-dir.ts:49` listDir(walk)
- **问题**: maxFiles 是可选业务上限(只数文件、达标早停返部分,QuickOpen 用),但默认 Infinity;Explorer/open-recent/drop 等调用不传 maxFiles → 列超宽目录时 readdir + lstat(分块) + sort + IPC 返回完整巨大数组,主进程与 renderer 同时高内存/CPU 甚至卡死。同类 plugin-fs:list-dir 已有 MAX_LIST_DIR_ENTRIES(E30),主 fs 入口仍无硬上限。codex 标 **P1**(主 Explorer 路径,影响面比 plugin 大)。
- **修复**: 加 `MAX_TOTAL_ENTRIES=100_000` 总条目硬上限(**文件+目录都计数**,与只数文件的 maxFiles 正交),默认启用;walk 每 push 一项 totalCount++,超过即 fail-closed 抛 FS_DIR_TOO_LARGE(同 plugin-fs E30,不静默截断 —— Explorer 静默截断会让用户误判文件缺失)。QuickOpen 的 maxFiles(更低)在此之前早停,不触发本上限。新增可选 `maxTotalEntries`(ListDirOptions,默认硬上限)供进程内调用方调低 + 测试;**不在 listDirInputSchema 暴露**,renderer 无法绕过 backstop。
- **测试**: fs-adapter.spec +E38(maxTotalEntries=2 + 3 个顶层项 → 第 3 项触发 FS_DIR_TOO_LARGE;默认上限正常目录不受影响;恰好等于上限不抛验 `>` 边界)。中和(`if (false && ...)`)→ over-limit 测试失败确认回归。
- **沉淀**: E30(plugin-fs)→ E38(主 fs)是 list-dir 大小上限的 plugin/主双侧 twin,但侧重不同:plugin-fs 是单层 readdir 全量物化,主 fs 是递归 walk + maxFiles 早停语义。**「业务上限(opt-in、可放宽)≠ 安全 backstop(默认、硬)」**——maxFiles 是给 QuickOpen 调的业务参数,不能当安全上限(默认 Infinity);必须再加一个默认启用、不可经 IPC 绕过的硬上限。测试上限用可选 opts 注入(不暴露给 IPC schema)避免造 10 万真实文件。E1-E38 持续推进外部输入边界族。

## E39 — recent commands localStorage 读回只校验类型,无 finite-ts/id 长度/数量截断 (P2,E5/E22 持久化读回族)

- **文件**: `src/plugins/command-palette/recent.ts:39` readFromStorage / isRecentEntry
- **问题**: readFromStorage 只 filter(isRecentEntry),isRecentEntry 仅校验 id 是 string、ts 是 number,不限数组长度、id 长度,也不要求 ts finite。record() 写路径会 slice(0, MAX_RECENT),但读回路径(启动 + storage 同步)对篡改的 localStorage 不截断 → 超大 recent 数组完整读入,CommandPalette 构造巨大 recentIds + 重算排序卡顿;超长 id 放大内存/比较;非有限 ts(1e400→Infinity)排序异常(同 E5)。
- **修复**: isRecentEntry 加 `id.length>0 && ≤RECENT_ID_MAX(256,与 CommandRegistry id E35 一致) && Number.isFinite(ts)`;readFromStorage 在 filter 后 `.slice(0, MAX_RECENT)`(列表最近优先,头部即最近 N 条)。读回即过滤+截断,损坏项丢弃。导出 readFromStorage 作测试 seam。
- **测试**: recent.spec +E39(非有限 ts `1e400` 丢弃 / 超长 id>256 丢弃 / 超大数组 MAX_RECENT*3 读回截断到 MAX_RECENT)。中和(guard 退回类型-only + 去 slice)→ 3 测试失败确认回归。
- **沉淀**: 持久化读回族(E2 index / E3 reviews / E5 时间戳 / E22 localStorage record)再补 command-palette recent。**写路径有上限(record slice)≠ 读回路径有上限**:篡改/旧格式 localStorage 绕过写路径直接喂读回路径,读回必须独立 filter+截断+finite 校验(同 E38「业务上限≠安全 backstop」的持久化版:写时截断是正常流程,读时截断是防篡改 backstop)。Number.isFinite(ts) 是 E5 时间戳教训的第三处复用(typeof number 放行 Infinity)。E1-E39 持续推进。

## E40 — SettingTabRegistry.register 不校验插件 SettingTabSpec,畸形 render 崩 Settings 面板 (P1,E35/E36/E37 兄弟 registry)

- **文件**: `src/plugins/registries/SettingTabRegistry.ts:23` register
- **问题**: register 接受插件 SettingTabSpec 无运行时校验:id/title/titleKey 无长度上限,priority 可 NaN/Infinity,render 也未确认是函数。畸形 tab 一注册即进 getAll().sort() + 左侧导航;若成为 active,SettingsPanel 直接调 active.render(),非函数/异常 render 让整个 Settings 面板崩溃。codex 标 **P1**(崩整个面板)。
- **修复**: register 入口 `validateSettingTabSpec`:id 非空≤256、title 非空≤512、titleKey≤256、priority 必 finite(NaN/Infinity 让 sort 比较异常)、**render 必须 typeof === 'function'**。非法抛可诊断 Error、不入 registry。
- **测试**: setting-tab-registry.spec +E40(合法 ok;超长 id/title/titleKey → 抛不入;空 id/title → 抛;NaN/Infinity priority → 抛;render 非函数 → 抛)。中和(`if (false)`)→ 4 reject 测试失败确认回归。全量 4024 PASS 无回归。
- **沉淀**: 插件贡献 registry 族第四(E35 Command / E36 SettingItem / E37 Panel / E40 SettingTab),四个 register 入口统一加校验。**带 render/factory 函数字段的 spec(Panel.factory / SettingTab.render)校验必含「typeof function」**——非函数在渲染期崩,注册期检查把崩溃前移到加载期可诊断。priority 作 sort 键须 finite(NaN 比较恒 false 致排序未定义,同 E36 数值参数 finite)。codex 另建议渲染侧像 StatusBar 那样 try/catch 隔离单 tab render 异常(防「合法函数但运行时抛」)—— 属错误韧性维度,留作 follow-up(本族 register 校验已挡「非函数」这一最常见崩因)。E1-E40 持续推进。

## E41 — performDrop 拖入文件无大小/数量预检,renderer 在 IPC 校验前 OOM (P1,E13 读侧对偶)

- **文件**: `src/panels/Explorer/drop-handlers.ts:89` performDrop
- **问题**: performDrop 对拖入文件无数量/大小预检,直接 `await file.arrayBuffer()` 把整个文件读进 renderer 内存,再交 fs.writeBinary。主进程虽有 64MiB 写入上限(E13),但那只在 IPC **之后**生效 —— renderer 已先把整文件读进内存。用户/畸形拖放一个超大文件或海量文件时,renderer 在 IPC 校验前就高内存峰值/卡死/崩溃。codex 标 **P1**。
- **修复**: renderer 侧读前预检:单文件 `file.size > MAX_DROP_FILE_BYTES(64MiB,对齐 E13 写入上限)` → failed FS_FILE_TOO_LARGE(已 i18n),**绝不调 arrayBuffer()**;累计 `MAX_DROP_TOTAL_BYTES=512MiB` → DROP_TOTAL_TOO_LARGE;数量 `MAX_DROP_FILE_COUNT=1000` → DROP_TOO_MANY_FILES。后两个用字面 code(不在 catalog,localizeErrorByCode 回退展示 message,同既有 READ_ERROR/WRITE_ERROR 自由码模式)。超限项进 failed/不读不写。
- **测试**: drop-handlers.spec +E41(fake File 只给 size getter:单文件 >64MiB → FS_FILE_TOO_LARGE 且 arrayBuffer/writeBinary 均未调;9×60MiB 累计 540MiB → 第 9 个 DROP_TOTAL_TOO_LARGE、前 8 写;1001 文件 → 第 1001 DROP_TOO_MANY_FILES、前 1000 写;上限内正常文件不受影响)。中和(三上限 ×0+1e18)→ 3 测试失败确认回归。
- **沉淀**: **「主进程有上限 ≠ renderer 安全」**——主 fs.writeBinary 的 64MiB 写入上限(E13)在 IPC 之后才生效,renderer 在 `arrayBuffer()` 把整文件读进内存的那一刻已可能 OOM。读侧(renderer 把文件读入内存的入口)必须在读之前用 file.size 预检,与主侧写入上限对齐。这是 E18(读文件 stat.size)在「renderer 拖放读」维度的对偶:凡「整文件/整集合读入内存」的入口,无论主/渲染进程,都要在读之前用已知 size 拦截。file.size 是浏览器 File API 免费提供的、读前可得的大小,正是预检依据。E1-E41 持续推进。

## E42 — 终端文件拖放无文件数/写入长度上限,renderer 构造超大命令行 (P2,E41 终端 drop 兄弟)

- **文件**: `src/panels/Terminal/useTerminalDragDrop.ts:78` onDrop
- **问题**: 终端文件拖放把 dataTransfer.files 全量 Array.from,逐个 getPathForFile 取 OS 路径,再对全部路径 quotePaths()+joinWithTrailingSpace() 一次性构造写入字符串;renderer 侧无文件数/输出长度上限。拖入海量文件/超长路径时,即使主 terminal.write 最终用 2MB schema 拒绝,renderer 已先做大量 getPathForFile IPC + 构造超大命令行字符串 → UI 卡顿/内存峰值。是 E41(Explorer drop)的终端 drop 兄弟。
- **修复**: 读路径时累计两个上限:文件数超 `MAX_TERMINAL_DROP_FILES=1000` 的项**不再 IPC 取路径**(省 getPathForFile 往返);累计写入长度超 `MAX_TERMINAL_DROP_CHARS=1_000_000`(低于主 2MB 写入上限留 quote 余量,每条 +3 估算 quote/空格)的项不再加入。超限项计入 droppedForLimit → partial_skip 提示。边界:若全部被丢弃致 paths 空(如单条 >1MB 路径),区分 partial_skip 与 no_os_path(不误报)。
- **测试**: drag-drop.spec +E42(3×600KB 路径累计 1.8MB → 第 1 条写、第 2/3 丢弃、写入串 ≤上限、partial_skip:2;1005 文件 → 仅前 1000 调 getPathForFile、partial_skip:5)。中和(两上限 ×0+1e18)→ 2 测试失败确认回归。
- **沉淀**: E41(Explorer drop)→ E42(Terminal drop)是「renderer 在 IPC 校验前构造大对象」的两个 drop 入口。不同点:E41 是 arrayBuffer 读文件内容入内存,E42 是把路径 join 成超大命令行字符串。**凡 renderer 把外部输入聚合成大对象(buffer/string/array)再过 IPC 的入口,都要在聚合过程中按已知 size/count 早停**,不能依赖 IPC 端的上限(那在聚合之后)。「累计长度边构造边检查」比「构造完再整体拒绝」省内存(后者已 OOM)。E1-E42 持续推进。

## E43 — IpcPluginDataStore.write 在 renderer 先 JSON.stringify 无大小上限,主进程 cap 来不及 (P1,E41/E42 同族 + E20 读侧对偶)

- **文件**: `src/plugins/PluginDataStore.ts:51` IpcPluginDataStore.write(+ InMemoryDataStore.write)
- **问题**: write() 先在 renderer `JSON.stringify(data)` 做可序列化校验,无大小上限;主进程 plugin-data-store.service 虽限 16MiB(E20),但 renderer 已先完整序列化任意插件传入对象。畸形/恶意插件调 app.dataStore.write() 传超大对象/字符串时,在 renderer 侧产生巨大临时字符串 + CPU 峰值 → 插件宿主 UI 卡死/内存暴涨,主进程上限在 IPC 之后才生效、来不及保护。codex 标 **P1**。
- **修复**: 抽 `serializeWithinLimit(data)`:JSON.stringify 后立即按 `MAX_PLUGIN_DATA_BYTES` 预检,超限抛、不发 IPC(save)、不提交 cache。常量从 plugin-data-store.service 局部移到 **shared 单一来源** `electron/shared/plugin-data-limits.ts`,main(E20 读盘 stat + 写盘 serialized.length)与 renderer(E43 stringify 后)复用同值,防漂移(codex 明确要求「共享常量」)。两个 DataStore 实现(IPC + InMemory)行为对齐。
- **测试**: ipc-plugin-data-store.spec +E43(超 MAX → 抛 too large 且不调 save / 上限内正常 save)+ plugin-data.spec InMemory +E43(超限抛、不写入)。中和(上限 ×0+1e18)→ 2 测试失败确认回归。全量 4033 PASS。
- **沉淀**: E41(drop arrayBuffer)/E42(drop join 命令行)/E43(dataStore stringify)是「renderer 在主进程 cap 前先构造大对象」族的三个面:读文件内容、拼命令行、序列化对象。共性:主进程的 cap 在 IPC **之后**生效,renderer 在构造/序列化那一刻已可能 OOM。**凡 renderer 把外部输入序列化/聚合成大字符串再过 IPC 的入口,都要在序列化后、发 IPC 前用同一上限预检**,且上限须 main/renderer 共享常量(否则两侧漂移)。stringify 本身不可避免(校验可序列化需要),但「stringify 后立即检查、拒绝在 IPC 之前」挡住了 IPC 传输 + 主进程 parse + cache 保留的下游放大。E1-E43 持续推进。

## E44 — scoped-app fs.writeFile 在 renderer 无 content/path 预检,IPC structured-clone 已先放大 (P1,E29 renderer 侧对偶)

- **文件**: `src/plugins/scoped-app.ts:70` makeFs().writeFile
- **问题**: app.fs.writeFile(path, content) 在 renderer scoped API 里不做 content 长度预检,直接把插件传入的大字符串交给 ipcRenderer.invoke;主进程 plugin-fs:write-file 虽有 64MiB 上限(E29),但 IPC structured clone 已先在 renderer/preload 发生(序列化大对象)。畸形插件可传超大字符串致 renderer/preload IPC 序列化内存峰值/卡顿,主进程 schema 拒绝来得太晚。codex 标 **P1**。
- **修复**: makeFs().writeFile 发 IPC 前预检:content.length > MAX_WRITE_BYTES → 抛、不发 IPC;path.length > FS_PATH_MAX(8192)→ 抛。常量从 fs.ipc.ts(E13/E29)移到 **shared 单一来源** `electron/shared/fs-limits.ts`,main(fs.ipc writeFile/writeBinary schema + plugin-fs.service E29)与 renderer(scoped-app E44)复用同值。**顺带**:scoped-app 插入行使既有 globalThis 注释行号位移,更新 web-compat-allowlist.json(160→175)——行号钉死的 allowlist 改同文件后必同步(M21/E22 纪律)。
- **测试**: scoped-app.spec +E44(content 超 MAX → 抛 content too large 且不调 pluginFsRaw.writeFile / path 超 FS_PATH_MAX → 抛 path too long 不发 IPC / 上限内正常透传)。中和(两上限 ×0+1e18)→ 2 reject 测试失败确认回归。全量 4036 PASS。
- **沉淀**: E29(main plugin-fs:write-file cap)→ E44(renderer scoped-app 发 IPC 前 cap)是同一写入路径的 main/renderer 双侧上限。**renderer 的 IPC 包装层(scoped-app)是 plugin→IPC 的第一道关,主进程 cap 在 structured-clone 之后**:E41(drop arrayBuffer)/E42(drop join)/E43(dataStore stringify)/E44(fs writeFile)四者共性 = renderer 在「把外部输入交给 IPC」的那一步之前必须预检,且上限须 main/renderer 共享常量(fs-limits/plugin-data-limits)防漂移。E1-E44 持续推进外部输入边界族。

## E45 — plugin-shell-stream START 无 cmd/args/cwd/streamId 上限,流式 spawn 入口漏 (P1,E12 shell.exec 同族)

- **文件**: `electron/main/services/plugin-shell-stream.service.ts:56` START handler
- **问题**: plugin-shell-stream 的 START handler 对 cmd/args/cwd/streamId 没有运行时上限校验(只 E10 修了 timeoutMs);spawn(cmd, args, {cwd}) 前会完整接收任意长数组和字符串。畸形插件经 app.shell.execStream() 传巨量 args/超长 cwd/cmd → IPC structured clone、主进程内存/CPU 放大,或触发 spawn 的 E2BIG/路径异常。同仓 shell.exec(E12)已有 ARG/ENV/PATH/STDIN 上限,但流式入口(更重的实际 spawn 面)漏了。codex 标 **P1**。
- **修复**: START 在 spawn 前手写校验(raw IPC 入口,同 E10 timeoutMs 风格):streamId 非空≤256、cmd 非空≤PATH_MAX(8192)、args 数组且 ≤ARGS_MAX_COUNT(1024)且单项≤ARG_MAX_LEN(16384)、cwd 可选≤8192,与 shell.exec(E12)对齐。任一违反抛 BAD_INPUT,绝不进入 spawn。
- **测试**: plugin-shell-stream.service.spec +E45(streamId>256 / cmd>8192 / args>1024 / 单arg>16384 / cwd>8192 → BAD_INPUT 且不 spawn)。中和(badInput 改 no-op)→ 5 测试失败确认回归。全量 4041 PASS。
- **沉淀**: 「同一能力的两个入口(exec 一次性 vs execStream 流式),安全校验只加在一个」——E12 给 shell.exec 加了输入上限,但 plugin-shell-stream:start 这个真正 spawn 子进程的流式平行入口漏了(E10 当时只修了 timeoutMs 这一个字段,没顺带补齐其余)。**spawn 子进程的入口尤其要校验**(E2BIG / 命令行长度是 OS 级硬限,畸形输入直接触发 spawn 失败或异常)。修一个能力的输入校验须 grep 该能力的所有入口(exec/execStream/terminal create 都 spawn)。E1-E45 持续推进外部输入边界族。

## E46 — scoped-app shell.exec/execStream 在 renderer 先 [...args] 展开无预检 (P1,E44/E45 同族 + E12 renderer 侧对偶)

- **文件**: `src/plugins/scoped-app.ts:191` makeShell().exec(+ execStream)
- **问题**: app.shell.exec(cmd,args,opts) 在 renderer wrapper 里先 `args: [...args]` 展开,但无数量/长度预检;主进程 shell.exec schema(E12)虽有 ARGS_MAX_COUNT/ARG_MAX_LEN/STDIN_MAX/ENV_MAX_ENTRIES,renderer 已先展开任意 iterable/巨量数组并 structured-clone env/input。畸形插件可传超大 args iterable、超长 stdin/env,在到达 main 校验前卡住 renderer 或造成 IPC 序列化内存峰值;**`[...args]` 对非数组 iterable(如无限 generator)还可能无限/超大展开**。execStream(E45 主侧已修)的 renderer wrapper 同样把 args 直传 IPC(structured-clone 前置放大)。codex 标 **P1**。
- **修复**: `validateShellInput(cmd, args, opts)`:cmd≤8192、**args 必须 Array.isArray(挡非数组 iterable 的无限 spread)** 且 ≤1024 项、单项≤16384、cwd≤8192、input≤1MB、env(entries≤1024 + key≤1024 + val≤32768)。exec 在 `[...args]` 前调、execStream 在 raw IPC 前调(经 startPromise reject 由 done/chunks 错误路径上抛,保留 stream 契约)。超限抛 BAD_INPUT、不 spread、不发 IPC。常量从 shell.ipc.ts(E12)移到 **shared 单一来源** `electron/shared/shell-limits.ts`,main(shell.exec E12 + plugin-shell-stream E45)+ renderer(scoped-app E46)复用同值。**顺带**:scoped-app 插入行使 globalThis 注释行号再位移,更新 web-compat-allowlist(175→233)。
- **测试**: scoped-app.spec +E46(args>1024 / 单arg>16384·input>1MB·cmd>8192 / 非数组 args / 正常透传)。中和(bad→no-op)→ reject 测试失败确认回归。全量 4045 PASS。
- **沉淀**: renderer 「把外部输入交给 IPC 前先处理」族(E41 arrayBuffer / E42 join / E43 stringify / E44 fs.writeFile / E45 主侧 spawn / E46 shell exec+execStream)收尾——**最隐蔽的是 `[...iterable]` spread**:类型写 `string[]` 但运行时插件可传无限 generator,spread 当场 OOM,必须 `Array.isArray` 先于 spread。三个 shell 输入上限点(exec/execStream main E12·E45 + renderer E46)经 shared/shell-limits 单一来源,彻底消除主/渲染/流式三处漂移。E1-E46 持续推进外部输入边界族。

## E47 — mergeDecorations 信任插件 decorator 返回值,畸形 badge/tooltip 卡 FileRow 渲染 (P2,插件输出校验)

- **文件**: `src/plugins/registries/ExplorerDecoratorRegistry.ts:90` mergeDecorations
- **问题**: mergeDecorations 信任插件 decorator 返回值:badge/tooltip/textColor/badgeColor 不校验类型和长度,tooltips 无数量/总长度上限,最后直接 `tooltips.join(' · ')` 塞进每个 FileRow 的 title。畸形 decorator 可对每个可见文件返回超长 tooltip/badge 或非字符串值 → 虚拟列表滚动时反复拼接巨大 title 卡顿;非字符串 badge 还进 React 渲染路径触发异常/怪异输出。
- **修复**: `decString(v, max)` 守卫(非空字符串且 ≤max 才采用)应用到 badge(≤64)/badgeColor·textColor(≤64)/tooltip(≤1024);tooltip 数量 ≤32、合并后总长 ≤4096(join 后 slice 兜底)。非法字段丢弃,badge 改 first-VALID-wins(首个合法赢,非法不占位)。保留既有单 decorator try/catch 隔离。icon 是 ReactNode(React 自身渲染边界)不在此校验。
- **测试**: explorer-decorator.spec +E47(非字符串 badge/tooltip/textColor 丢弃 → null;超长 badge 丢弃 first-valid 后续赢;超长 tooltip 丢弃;tooltip 数量>32 截断;合并总长>4096 slice 兜底)。中和(decString 透传)→ 3 字段校验测试失败;中和(count/total 上限 →1e9)→ 2 数量/总长测试失败,均确认回归。全量 4050 PASS。
- **沉淀**: 插件**输出**校验(区别于 E35-E40 的注册**输入**校验):decorator fn 每次渲染对每个可见文件调用,返回值直接进 React title/badge,**热路径 × 不可信输出**双重放大。registry 此前只隔离了 fn 抛错(try/catch),没校验返回值的类型/长度/数量 —— 不抛错但返回畸形值(超长串/非字符串)同样致渲染卡顿/异常。凡「插件回调的返回值进 UI 渲染热路径」都要 type+length+count 三重校验,非法字段丢弃而非整体拒绝(保留其余合法装饰)。E1-E47 持续推进。

## E48 — ExplorerContextMenuRegistry.register 不校验插件菜单 spec,畸形 when/fn 坏右键菜单 (P2,E35/E36/E37/E40 兄弟 registry)

- **文件**: `src/plugins/registries/ExplorerContextMenuRegistry.ts:56` register
- **问题**: register 接受插件右键菜单 spec 无运行时校验:id/label/group 无长度上限,priority 可 NaN/Infinity,when/fn 也未确认是函数。畸形项进 getAll().sort() + 菜单打开时 groupPluginItems() 对超长/异常 group 做 localeCompare/分组渲染;非函数 when/fn 在打开菜单或点击时抛错,影响整个右键菜单可用性。
- **修复**: register 入口 `validateContextMenuItemSpec`:id 非空≤256、label 非空≤512、group≤256、priority finite、**when?(若有)与 fn 必须 typeof === 'function'**。非法抛可诊断 Error、不入 registry。菜单渲染层(filterVisible)保留单项 when try/catch 隔离不变。
- **测试**: explorer-context-menu.spec +E48(合法 ok;超长 id/label/group → 抛不入;空 id/label → 抛;NaN priority / when 非函数 / fn 非函数 → 抛)。中和(`if (false)`)→ 3 reject 测试失败确认回归。全量 4054 PASS。
- **沉淀**: 插件贡献 registry 族第五(E35 Command / E36 SettingItem / E37 Panel / E40 SettingTab / E48 ExplorerContextMenu),五个 register 入口统一校验。带回调字段(when/fn 谓词+动作)的 spec 校验须含「全部 callable 检查」——非函数在渲染/点击期才崩,注册期 typeof 前移到加载期可诊断;priority 作 sort 键须 finite。registry 注册期校验(spec 入)+ 渲染期 try/catch(fn 抛)是两道独立防线:前者挡畸形 spec(非函数/超长),后者挡合法函数运行时抛——都需要。E1-E48 持续推进。

## E49 — RibbonRegistry.register 不校验插件 RibbonActionSpec,畸形项坏 Activity Bar (P2,E35/E36/E37/E40/E48 兄弟 registry)

- **文件**: `src/plugins/registries/RibbonRegistry.ts:21` register
- **问题**: register 接受插件 RibbonActionSpec 无运行时校验:id/title 无长度上限,priority 可 NaN/Infinity,onClick 也未确认是函数。畸形插件一注册即进 Activity Bar(IconSidebar)排序+渲染;超长 title 污染 NavRailButton tooltip/aria-label,NaN priority 让排序比较器失真,非函数 onClick 点击时才抛错。
- **修复**: register 入口 `validateRibbonActionSpec`:id 非空≤256、title 非空≤512、priority finite、**onClick 必须 typeof === 'function'**。非法抛可诊断 Error、不入 registry。
- **测试**: ribbon-registry.spec +E49(合法 ok;超长 id/title → 抛不入;空 id/title → 抛;Infinity priority / onClick 非函数 → 抛)。中和(`if (false)`)→ 3 reject 测试失败确认回归。全量 4058 PASS。
- **沉淀**: 插件贡献 registry 族第六(E35 Command / E36 SettingItem / E37 Panel / E40 SettingTab / E48 ExplorerContextMenu / E49 Ribbon),六个 register 入口全部统一校验(长度 + priority finite + 回调字段 typeof function)。codex 沿 registry 逐个扫(每轮一个),已覆盖六个主要贡献点 registry;剩余可能还有 StatusBar/EditorAction 等(codex 提到「与 Command/Panel/SettingTab 等 registry 边界一致」)。registry 校验三要素稳定成型:**字符串长度上限(防 UI/排序放大)+ priority/数值 finite(防比较器失真)+ 回调字段 callable 检查(防渲染/点击崩)**。E1-E49 持续推进。

## E50 — StatusBarRegistry.register 不校验插件 StatusBarItemSpec,非法 side 成脏条目 (P2,E35-E49 兄弟 registry)

- **文件**: `src/plugins/registries/StatusBarRegistry.ts:21` register
- **问题**: register 接受插件 StatusBarItemSpec 无运行时校验:id 无长度上限,side 可为非 'left'/'right',priority 可 NaN/Infinity,render 未确认是函数。畸形 item 注册后进全局排序;**非法 side 变成不可见但常驻 Map 的脏条目(getBySide('left'/'right') 永不命中,却占 id 槽位 + 参与 getAll sort)**,NaN priority 让排序比较器失真,非函数 render 虽被渲染侧 try/catch 兜住但每次状态栏重渲反复告警/跳过。
- **修复**: register 入口 `validateStatusBarItemSpec`:id 非空≤256、**side ∈ {'left','right'}**、priority finite、render 必须 typeof === 'function'。非法抛可诊断 Error、不入 registry。
- **测试**: registries.spec StatusBarRegistry +E50(合法 ok;超长/空 id → 抛不入;非法 side 'middle' → 抛;NaN priority / render 非函数 → 抛)。中和(`if (false)`)→ 3 reject 测试失败确认回归。全量 4062 PASS。
- **沉淀**: 插件贡献 registry 族第七(E35 Command / E36 SettingItem / E37 Panel / E40 SettingTab / E48 ExplorerContextMenu / E49 Ribbon / E50 StatusBar),七个 register 入口全部统一校验。**StatusBar 新增「枚举字段校验」维度**:side 是判别字段,非法值不报错但变成永不渲染的常驻脏条目(比崩溃更隐蔽——占内存 + 参与 sort 但用户永远看不到)。registry 校验要素扩展为:字符串长度 + 数值 finite + 回调 callable + **判别/枚举字段值域**。codex 沿 registry 清单逐个收口,StatusBar 后或还剩 EditorAction。E1-E50 持续推进。

## E51 — EditorActionRegistry.register 不校验插件 EditorActionSpec,畸形 action 坏 editor header (P2,E35-E50 兄弟 registry)

- **文件**: `src/plugins/registries/EditorActionRegistry.ts:34` register
- **问题**: register 接受插件 EditorActionSpec 无运行时校验:id/label 无长度上限,priority 可 NaN/Infinity,when/fn 未确认是函数。畸形 action 进 editor header 排序+渲染;超长 label 污染按钮文本/aria-label,NaN priority 让排序比较器失真,非函数 when/fn 在渲染过滤(filterVisible)或点击执行时反复抛错。
- **修复**: register 入口 `validateEditorActionSpec`:id 非空≤256、label 非空≤512、priority finite、when?(若有)与 fn 必须 typeof === 'function'。非法抛可诊断 Error、不入 registry。渲染层 filterVisible 单项 when try/catch 隔离保留。
- **测试**: editor-action.spec +E51(合法 ok;超长 id/label → 抛不入;空 id/label → 抛;Infinity priority / when 非函数 / fn 非函数 → 抛)。中和(`if (false)`)→ 3 reject 测试失败确认回归。全量 4066 PASS。
- **沉淀**: 插件贡献 registry 族**第八(收官)**:E35 Command / E36 SettingItem / E37 Panel / E40 SettingTab / E48 ExplorerContextMenu / E49 Ribbon / E50 StatusBar / E51 EditorAction —— 全部八个 register 入口统一校验完毕。codex 沿 registry 清单逐轮收口(每轮一个),从最高价值(Command/Panel/SettingTab P1)到次要(Ribbon/StatusBar/EditorAction P2),八轮覆盖全部贡献点 registry。统一校验范式定型:**字符串长度上限 + priority/数值 finite + 回调字段(fn/when/render/onClick/factory)callable 检查 + 判别字段(side/type)枚举值域**,非法 spec 注册期抛(可诊断、不入),渲染期保留单项 try/catch(挡合法函数运行时抛)。E1-E51 持续推进外部输入边界族。

## E52 — app.notifications.show 不校验 message/code,单条超大通知绕过队列上限放大 (P2,插件 API 输入校验)

- **文件**: `src/plugins/co-app.ts:153` notifications.show
- **问题**: app.notifications.show() 对插件传入的 message/code 没有类型与长度上限,直接进入 notify() → console mirror → Toast DOM 渲染。畸形/恶意插件可传超大字符串,**单条通知绕过 MAX_NOTIFICATIONS 队列上限**(队列限的是条数不是单条大小),造成 renderer 内存膨胀、console/DOM 卡顿。
- **修复**: CoNotificationsApi.show 入口运行时校验:message 必须非空 string 且截断到 `NOTIFY_MESSAGE_MAX=4096`(非字符串/空 → 不渲染,不传垃圾给 notify);code 必须非空 string 且 ≤`NOTIFY_CODE_MAX=256`,否则丢弃(降级为无 code 通知)。
- **测试**: notifications-show-raw.spec +E52(超长 message 截断到 4096;非字符串/空 message 不调 notify;超长/非字符串 code 丢弃降级)。中和(上限 ×0+1e18 + 去类型守卫)→ 5 测试失败确认回归。全量 4071 PASS。
- **沉淀**: 「队列/集合有条数上限 ≠ 单元素有大小上限」——MAX_NOTIFICATIONS 限通知**条数**,但单条 message 无大小限,一条超大通知即可放大内存/DOM(同 E38「业务上限≠安全 backstop」的另一面:限了数量没限尺寸)。插件 API 入口(co-app 的 notifications/editor/dock 等直接面向插件的方法)与 registry 注册入口、scoped-app IPC wrapper 并列为三类插件输入面,都要 type+length 校验。E1-E52 持续推进外部输入边界族。

## E53 — PluginMcpRegistry.register 不在 renderer 侧预检,超大 jsonSchema 先卡 IPC 才被 main 拒 (P1,E17 renderer 侧对偶)

- **文件**: `src/plugins/registries/PluginMcpRegistry.ts:132` register
- **问题**: registerMcpTool 对插件传入的 name/description/jsonSchema 不做 renderer 侧边界校验,直接 `upstream.register(...)` 发 IPC;main 的 RegisterPayloadSchema(E17:name≤256/desc≤8192/jsonSchema≤64KB)虽限制,但校验发生在 structured-clone 进 main 之后。畸形插件可传超大 jsonSchema/描述,先卡住 renderer/preload→main IPC 与内存,再被 main 拒绝;main 侧上限太晚,无法保护发送端。codex 标 **P1**。
- **修复**: register 入口 `validateToolSpec`(发 IPC + 写本地 entry 之前):name 非空 string ≤TOOL_NAME_MAX、description string ≤DESC_MAX、jsonSchema 可 JSON 序列化且字节 ≤SCHEMA_BYTES_MAX(同 main refine,提前到发送端)、run 必须函数、inputSchema 必须有 safeParse 方法。超限抛 INVALID_PARAMS,不发 IPC、不写本地 entry。三个上限常量从 plugin-mcp-schemas.ts(E17)导出 **shared 单一来源**,main(RegisterPayloadSchema)+ renderer(PluginMcpRegistry)复用同值。**顺带**:更新 scoped-app.spec 的 mcp.register stub fixture(原 `inputSchema:{}`/缺 jsonSchema 现不合法 → 补全为有 safeParse + 可序列化 jsonSchema)。
- **测试**: registry.spec +E53(超长 name/description / jsonSchema>64KB / 循环引用不可序列化 / run 非函数 / inputSchema 无 safeParse → INVALID_PARAMS 且不发 IPC;正常 spec 正常发)。中和(`if (false)`)→ 5 测试失败确认回归。全量 4077 PASS。
- **沉淀**: renderer 在 IPC 校验前构造/克隆大对象族(E43 dataStore / E44 fs.writeFile / E46 shell exec / E53 mcp register)收尾——凡 renderer wrapper 把插件输入交给 IPC 的入口,都要在发 IPC 前用 main/renderer **共享常量**预检(plugin-mcp-schemas/fs-limits/shell-limits/plugin-data-limits 四组 shared 上限)。validateToolSpec 还含「inputSchema 鸭子类型检查(有 safeParse)」——zod schema 在 renderer 留作 invoke 用,非 schema 会在反向调用期才崩,注册期 typeof 检查前移。E1-E53 持续推进。

## E54 — ExplorerDecoratorRegistry.register(fn) 不校验 fn 是函数 + 无数量上限 (P2,E47 输入侧对偶)

- **文件**: `src/plugins/registries/ExplorerDecoratorRegistry.ts:42` register
- **问题**: register(fn) 仍信任插件输入,没有校验 fn 是函数,也没有注册数量上限;E47 只限制了 decorator 的**输出**字段(返回值)。畸形插件传非函数会在每个可见 FileRow 的 mergeDecorations 中反复抛 TypeError 并刷 console.warn(虽被 per-fn try/catch 兜住但每行每滚动反复);注册成千上万个 decorator 会让文件树每行渲染变成无界 O(N) 调用(mergeDecorations 遍历全部 fns × 可见行数),滚动/展开卡顿。
- **修复**: register 入口校验 `typeof fn === 'function'`(非函数抛、不入表),+ 全局数量上限 `MAX_DECORATORS=256`(超限抛、不入表)。
- **测试**: explorer-decorator.spec +E54(非函数 fn 抛不入表;注册满 256 后再注册抛;上限内正常)。中和(`if (false)` + 上限 ×0+1e9)→ 2 测试失败确认回归。全量 4080 PASS。
- **沉淀**: **同一 registry 的输入侧(register 参数)与输出侧(回调返回值)是两个独立校验面**——E47 修了 decorator 的输出(mergeDecorations 返回字段),但 register 的输入(fn 本身)漏了:非函数 + 无数量上限。修了「插件回调的返回值」别忘「插件回调本身 + 注册数量」。decorator registry 特殊在 mergeDecorations 是**每可见行 × 每 decorator** 的二维热路径,数量上限直接关乎滚动性能(O(rows × decorators)),不止内存。E1-E54 持续推进外部输入边界族。

## E55 — co:// 深链 URL 无长度上限 + pending 队列无条数上限,外部输入无界占内存 (P1,E1/E8 外部输入族)

- **文件**: `electron/main/protocol-dispatch.ts:78` routeProtocolUrl(+ renderer `src/plugins/protocol/handler.ts:41` parseProtocolUrl)
- **问题**: 外部 co:// 深链 URL(恶意网页 / 命令行 / 聊天链接可触发,经 OS 协议 → main)没有长度上限,且无就绪窗口时 `pending.push(url)` 队列也没有条数上限;后续还会原样 IPC 到 renderer,并在 parseProtocolUrl 中 new URL/遍历 query/日志打印完整 URL。恶意方可传超长 co://... 或连续触发多次 deep link,在窗口加载期间无界占用 main 内存,窗口就绪后再放大为 IPC/renderer 解析和 console 输出压力。codex 标 **P1**。
- **修复**: main routeProtocolUrl 入口统一校验:单 URL ≤`MAX_PROTOCOL_URL_LEN=8192`(超长丢弃 + 短日志,不入队/IPC/解析)、pending 队列 ≤`MAX_PENDING_PROTOCOL_URLS=100`(满则丢弃,两个 push 点都受约束)。renderer parseProtocolUrl 也加防御性 URL 长度上限 + params 数量上限(≤256,for-of break),挡绕过 main 的测试/未来入口。超限丢弃不抛(不阻塞合法深链)。
- **测试**: protocol-dispatch.test +E55(超长 URL 丢弃不入队不 send / pending 连发封顶 100 不无界 / 正常深链正常投递)+ protocol-url.spec +E55(超长 URL→null / 海量 params 截断到 256)。中和(4 处 cap ×0+1e9 / `if (false)`)→ 4 测试失败确认回归。全量 4085 PASS。
- **沉淀**: co:// 深链是 E1(stdio NDJSON)/E8(URL query initialWorkspace)之外的第三个**跨应用边界外部输入**面。**外部输入有「单元素大小」+「队列/累积条数」两个维度都要 cap**(同 E52「队列限条数≠限单条尺寸」的镜像:这里两者都缺)。main 入口 cap(权威)+ renderer 解析 cap(防御性,挡绕过 main 的入口)双层 —— 与 E23(AttachTargetSchema main+renderer 双侧)同纪律。E1-E55 持续推进外部输入边界族。

## E56 — EventBus.on/emit 不校验事件名/listener,无数量上限 (P2,插件 API 输入校验)

- **文件**: `src/plugins/EventBus.ts:13` on(+ emit)
- **问题**: EventBus.on/emit/clear 对插件传入的事件名和 listener 没有运行时校验,也没有事件名数量/单事件 listener 数量上限。畸形插件可注册超长/非字符串事件名或成千上万个监听器;emit() 会 `Array.from(set)` 拷贝并同步逐个调用,导致单次事件触发内存峰值和 renderer 卡顿,非函数 listener 还会在每次 emit 反复抛错刷日志。
- **修复**: on 入口校验 name 为非空 string ≤`EVENT_NAME_MAX=256` + listener 为函数 + 总事件名 ≤`MAX_EVENT_NAMES=1024` + 每事件 listener ≤`MAX_LISTENERS_PER_EVENT=1024`,非法/超限抛、不注册。emit 对非字符串 name no-op(listener 数已由 on cap,emit 遍历天然有界)。clear 的 delete(非字符串) 本就无害。
- **测试**: event-bus.spec +E56(超长/空/非字符串 name 抛;非函数 listener 抛;单事件 listener>1024 抛;事件名总数>1024 抛;emit 非字符串 no-op 不抛)。中和(name/listener check `if(false)` + 两 cap ×0+1e9)→ 4 校验测试失败确认回归(emit no-op 仍过)。全量 4090 PASS。
- **沉淀**: 插件 API 输入面第三类(co-app 直接方法 E52 / scoped-app IPC wrapper / **EventBus 注册**)。EventBus 是「注册→热触发」结构:on 注册无界则 emit 每次触发 O(listeners) 放大,**unbounded 注册的代价在 emit 时引爆**(同 E54 decorator registry 的「注册无界→渲染热路径放大」)。caps 加在注册侧(on),触发侧(emit)随之有界。E1-E56 持续推进外部输入边界族。

## E57 — GitHub reviews 响应无大小/字段/节点上限,外部仓库数据多级放大 (P1,E2/E3 外部网络输入族)

- **文件**: `electron/main/services/marketplace-reviews.service.ts:105` fetchReviewNodes(+ renderer `src/marketplace/reviews-parser.ts:33` parseReview)
- **问题**: GitHub GraphQL reviews 响应直接 `await r.json()` 并把最多 50×100=5000 nodes 原样返回,没有限制响应体大小、节点数之外的字段长度,title/body/url/author.* 无 shape/长度校验;renderer 随后 `parseSections(raw.body)` 对每条 `body.split(/\r?\n/)`。远端仓库 discussion body(任意 plugin 作者填写)可很大,5000 条节点会在 main JSON 解析、IPC 传输、renderer split/aggregate/sessionStorage 缓存中多次放大,导致主进程或 renderer 卡顿/OOM。codex 标 **P1**。
- **修复**: main 拉取层:`clampStr` 逐字段截断(title≤1024/body≤16384/url≤2048/author 字段≤512)+ 类型守卫(thumbsUp 非 finite→0)+ 节点累计上限 `MAX_TOTAL_NODES=2000`(内+外双 break,满则停翻页)+ 响应体 Content-Length 预检(>8MiB throw,best-effort)+ `Array.isArray(nodes)` 守卫。renderer parseReview:非字符串 body/title→null + body/title 截断(≤16384/1024,split/extract 前)。值 main/renderer 对齐。
- **测试**: security-marketplace-token-main.spec +E57(超长 body→截断 16384 / 节点>2000→封顶且 fetch≤20 页 / Content-Length 超限→throw)+ reviews-parser.spec +E57(非字符串 body/title→null / 超长 评论正文 section→body≤16384)。中和(4 处 cap)→ 对应测试失败逐一确认回归。全量 4095 PASS。**测试细节**:翻页 mock 必须 `mockImplementation` 每次返新 Response(Response body 只能读一次,mockResolvedValue 复用同一对象第二页 r.json() 抛 "Body already read")。
- **沉淀**: 外部网络输入族(E1 stdio NDJSON / E2 index.json / E3 reviews cache / E57 reviews 网络响应)。**外部数据的放大是多级链**:main JSON parse → IPC structured-clone → renderer split → aggregate → sessionStorage 缓存,每级都放大,**截断要在最上游(main 拉取层逐字段)做一次,下游全链受益**;renderer parseReview 再加防御性截断挡 cache-hydrate/绕过 main 的入口(同 E55 main+renderer 双层)。逐字段截断 + 节点数上限 + 响应体预检三管齐下,因为单一手段都不够(字段截断不挡海量节点,节点上限不挡单条超大,Content-Length 可能缺省)。E1-E57 持续推进外部输入边界族。

## E58 — 启动目录(argv / OS open-file)无数量/路径长度上限,冷启动同步 I/O + 批量开窗 (P1,E55 外部输入族)

- **文件**: `electron/main/services/cli-args.service.ts:20` pickArgvFolders(+ sibling `startup-mode.service.ts:13` pickStartupMode)
- **问题**: 启动目录输入(process.argv 拖文件夹 / macOS open-file 缓冲)没有数量或路径长度上限:pickArgvFolders 对 argv.slice(start) 全量遍历并同步 stat(isExistingDir),pickStartupMode 同样遍历 pendingOpenPaths 逐个 stat;随后 index.ts 为每个 extra 目录逐个 allocateWindowSeq + createMainWindow。畸形命令行 / OS file-open 可塞大量绝对路径或超长路径,冷启动阻塞主进程做大量同步 I/O,并批量创建窗口、写爆 explorer window 段。codex 标 **P1**。
- **修复**: 两个收集器统一加 `MAX_STARTUP_DIRS=32`(目录数封顶,break 停止收集→停止同步 stat + 下游开窗)+ `MAX_STARTUP_DIR_PATH_LEN=8192`(**超长路径先跳过,绝不对其 isExistingDir 同步 stat**)。常量从 cli-args.service 导出,startup-mode.service 复用同值(两个启动入口对齐)。
- **测试**: cli-args-folder.spec +E58(目录数>32 封顶 + isExistingDir 调用 ≤32 / 超长路径跳过且不 stat)+ startup-mode.spec +E58(同样两例)。中和(两文件各 2 cap ×0+1e9/1e18)→ 4 测试失败确认回归。全量 4099 PASS。
- **沉淀**: E55(co:// 深链)→ E58(argv/open-file 启动目录)是两个**冷启动外部输入**面。**「先跳过超长再 stat」的顺序很关键**:path-length 检查必须在 isExistingDir(同步 stat)之前,否则对每个超长路径都先 stat(stat 本身就是攻击放大点)。数量上限的 break 同时砍掉「收集」+「同步 I/O」+「下游批量开窗」三重成本。两个启动收集器(argv / open-file 缓冲)是 sibling,修一个必同步另一个(grep-siblings;codex 也明确点名 pickStartupMode 兜底)。E1-E58 持续推进外部输入边界族。

## E59 — 运行期 macOS open-file 直开窗绕过 E58 启动目录上限 (P2,E58 运行期 sibling)

- **文件**: `electron/main/index.ts:579` openPathInNewWindow(open-file handler 在 app ready 后调用)
- **问题**: macOS open-file 在 app 已 ready 后直接调 openPathInNewWindow(filePath),该入口没有复用 E58 的 MAX_STARTUP_DIR_PATH_LEN/MAX_STARTUP_DIRS:对任意 filePath 先同步 statSync,若是目录就立即 allocateWindowSeq + createMainWindow。畸形/自动化 open-file 事件可在运行中连续送入大量目录或超长路径,**绕过冷启动 pendingOpenPaths/pickStartupMode(E58)的数量上限**,造成主进程同步 I/O 卡顿和批量开窗。
- **修复**: 抽 `isWithinStartupPathLimit(p)` 纯导出 helper(string + 长度守卫),**三处启动路径入口共用**(pickArgvFolders / pickStartupMode 替换 inline 检查 + openPathInNewWindow 新增),statSync 前过滤超长路径。openPathInNewWindow 另加运行期并发开窗上限 `openInFlight >= MAX_STARTUP_DIRS` → 跳过 + 短日志(冷启动靠 pickStartupMode 上限,运行期靠此 in-flight 计数挡 open-file 洪水)。
- **测试**: cli-args-folder.spec +E59(isWithinStartupPathLimit:正常 true / 空·非字符串 false / 超长 false 恰好上限 true)。中和(helper 上限 ×0+1e18)→ 同时打挂 E58(pickArgvFolders+pickStartupMode)+E59 共 3 测试,证明 helper 单一来源覆盖三处。openPathInNewWindow 的并发计数在 index.ts 主入口(无单测)内联,helper 路径长度部分经导出 helper 测试覆盖。全量 4102 PASS。
- **沉淀**: E58(冷启动 argv/open-file 缓冲)→ E59(运行期 open-file)是**同一能力的冷启动 vs 运行期两条路径**(同 E45 exec vs execStream、E12 IPC vs MCP raw)。冷启动有缓冲池上限,运行期直开窗是漏网兄弟。**抽 helper 单一来源**(isWithinStartupPathLimit)让三处入口同步、neutralize 一处打挂全部测试(证明真单一来源)。修一能力的边界必 grep 该能力的所有触发路径(冷启动缓冲 + 运行期事件)。E1-E59 持续推进外部输入边界族。

## E60 — 启动恢复 pickWindowsToRestore 无窗口数上限,restore-all 批量开窗阻塞启动 (P1,E58/E59 启动外部输入族)

- **文件**: `electron/main/services/window-restore.service.ts:31` pickWindowsToRestore
- **问题**: pickWindowsToRestore() 在 restoreAllWindowsOnLaunch:true 时遍历 data.windows 并对每个非主窗同步 isExistingDir(ws),所有命中段返回给 index.ts 逐个 createMainWindow;而 ExplorerSchemaV3 允许 windows 最多 10,000 段。畸形/手工编辑的 explorer.json 只要开 restore-all,就能在启动时做成千上万次同步 stat + 批量创建窗口,阻塞主进程甚至拖垮桌面会话。codex 标 **P1**。
- **修复**: 启动恢复单独加现实上限 `MAX_RESTORE_WINDOWS=16`(达标 break,停止收集 + 停止同步 stat),+ 复用 `isWithinStartupPathLimit`(E59 helper,超长 workspace 路径先跳过、绝不 stat)。**持久化 schema 的 10,000 段继续用于数据保留,但 ≠ 启动开窗上限**。
- **测试**: window-restore.spec +E60(恢复窗口数>16 封顶 + isExistingDir 调用 ≤16 / 超长 workspace 路径跳过且不 stat)。中和(count cap ×0+1e9 + path guard `if (false)`)→ 2 测试失败确认回归。全量 4104 PASS。
- **沉淀**: 启动外部输入族第三个面:E58(argv/open-file 缓冲)/ E59(运行期 open-file)/ E60(持久化 windows 段恢复)。`isWithinStartupPathLimit` 现已四处复用(pickArgvFolders/pickStartupMode/openPathInNewWindow/pickWindowsToRestore)= 启动路径长度守卫的真正单一来源。**「持久化数据保留上限 ≠ 启动消费上限」**:explorer.json 可存 10,000 段(历史保留合理),但启动时一次性 stat+开窗必须有更低的消费上限(同 E38「业务上限≠安全 backstop」、E52「队列条数≠单条尺寸」的第三个变体:存储容量≠启动消费量)。E1-E60 持续推进外部输入边界族。

## E61 — execStream 输出无背压上限,慢/不消费的插件让 preload 缓冲无界增长 (P1,流式背压)

- **文件**: `electron/preload/plugin-shell-stream.preload.ts:83` execStream chunkQueue.push
- **问题**: app.shell.execStream() 的输出没有任何总字节或缓冲队列上限:main 端对 stdout/stderr 每个 chunk 直接 send,preload 端在消费者没及时 next() 时无界 `chunkQueue.push(item)`。插件只启动高输出命令但不消费/慢消费 chunks,即可让 renderer/preload 内存随输出持续增长;命令最长可跑 5-30 分钟,IPC 和 renderer 都可能被输出流拖垮。codex 标 **P1**。
- **修复**: 给流式 shell 加背压边界:`queuedBytes` 跟踪 chunkQueue 中未消费字节(push 累加、next() shift 释放),超 `MAX_STREAM_QUEUE_BYTES=16MiB` → 自动 ABORT 子进程(IPC)+ synthesizeExit({exitCode:-1})合成错误 exit + 摘 EVENT listener(停止接收更多 chunk)。已缓冲的 chunk 仍可被消费者 drain(next 先查 queue)。**ABORT 子进程后 main 停止产出,preload 背压上限即透传约束 main 端**(无需额外 main 端 cap)。
- **测试**: 新建 plugin-shell-stream-backpressure.spec(mock ipcRenderer:不消费灌 17×1MiB → ABORT invoke + done 收敛 {exitCode:-1};上限内正常消费 → 不 ABORT)。中和(上限 ×0+1e18)→ over-limit 测试失败确认回归(正常消费仍过)。全量 4106 PASS,`pnpm bdd:index`(201 主题)。
- **沉淀**: 流式 API 的「慢消费者」背压 —— 生产端(main send chunk)快于消费端(plugin next())时,中间缓冲(preload chunkQueue)无界堆积。这是 E1(NDJSON 累积 buffer)的「流式输出」对偶:E1 是入站累积无上限,E61 是出站缓冲无上限。**有界缓冲 + 超限 fail-closed(ABORT 源头)是背压标准解**;preload 背压通过 ABORT 反向约束 main 生产,一处 cap 全链收敛。execStream 此前已修读完即 ABORT(R94)+ 提前 break ABORT(P2-AM)+ reject 合成 exit(R93),E61 补「慢消费缓冲上限」最后一块。E1-E61 持续推进外部输入边界族。

## E62 — runGit 的 git stderr 无限累积,超大错误输出膨胀内存 + 撑爆 Error message (P2,E1/E61 累积缓冲族)

- **文件**: `electron/main/services/plugins.service.ts:796` runGit
- **问题**: runGit 对 git 子进程 stderr 用 `stderr += String(d)` 无限累积,且失败时把完整 stderr 拼进 Error message。恶意/异常 git 远端或协议错误可产生超大 stderr → main 进程内存膨胀,并把巨大错误串继续传到 renderer/UI。codex 标 P2。
- **修复**: stderr 累积上限 `MAX_GIT_STDERR_BYTES=64KB`(保留前 64KB,git fatal 行通常在前部),超限停止追加(`stderrTruncated` 标记)。失败 message 用截断后的 stderr + ` …(stderr truncated)` 标记。**关键:不 kill 子进程**——git clone 进度本就走 stderr,大仓库进度可合法 >64KB,kill 会误伤合法克隆;只 bound 内存,clone 继续。
- **测试**: install-atomic-overwrite.spec +E62(mock git 子进程发 200KB stderr 后 exit 1 → Error message 截断到 <70KB + 含 'stderr truncated' / 正常短 stderr 完整保留无截断标记)。中和(上限 ×0+1e18)→ over-limit 测试失败确认回归。全量 4108 PASS。
- **沉淀**: E1(stdio NDJSON 残行)/ E61(execStream 慢消费缓冲)/ E62(git stderr 累积)同族 = **子进程/socket 输出累积无上限**。但 E62 的关键区别:**不能 kill 源头**(git 进度合法走 stderr 可大),只能截断累积 buffer 保 clone 继续;而 E61 可 kill(execStream 是插件输出,超限即异常)。「截断 vs kill」取决于源头输出是否合法可大:合法大输出(git 进度)只截断 buffer,异常大输出(插件慢消费)kill 源头。错误 message 拼接外部输出前必先截断(否则 message 本身成放大向量,经 IPC/toast 二次放大)。E1-E62 持续推进外部输入边界族。

## E63 — plugin-fs:read-git-blob 的 sha 无 hex/长度校验,超长 sha 进 git cat-file argv (P1,E62 同族 + 亲读分流)

- **文件**: `electron/main/services/plugin-fs.service.ts:471` read-git-blob handler(+ readGitBlob stderr 累积)
- **codex 报告含一处误报(亲读分流)**:codex 称「readGitBlob 没有 child.on('error') 处理」——**亲读发现 line 121 已有 `child.on('error', (err) => fail(err))`**,该子声明不实,不改。其余两项属实并修复。
- **问题(真实部分)**: (1) plugin-fs:read-git-blob 对插件传入的 sha 没有长度/hex 校验,sha 直接作为 `git cat-file blob <sha>` 的 argv 进入 spawn,超长 sha 触发 E2BIG/spawn error + argv 内存放大。(2) readGitBlob 的 stderr `stderr += chunk.toString()` 无限累积(E62 同款,失败时拼进 ScopeError message)。
- **修复**: (1) IPC 入口校验 sha 为 `^[0-9a-fA-F]{4,64}$`(git 缩写 4 到完整 SHA-1 40/SHA-256 64),非法/超长在 spawn 前抛 ScopeError(target 也截断到 64)。(2) stderr 累积上限 `GIT_BLOB_STDERR_MAX=64KB`,超限停追加(同 E62)。child.on('error') 已存在,不动。
- **测试**: plugin-fs-read-cap.spec +E63(超长 sha>64 / 非 hex(含 `; rm -rf /`)/ 空 sha → invalid git blob sha 且不 spawn)。中和(sha 校验 `if (false)`)→ 3 测试失败确认回归。read-git-blob-bounds.spec 既有测试(40-hex 不存在 sha)仍绿(readGitBlob 自身不校验 sha,只 IPC 入口校验,无回归)。全量 4111 PASS。
- **沉淀**: **codex 报告须亲读分流**——codex 的三项子声明里一项(child.on('error') 缺失)不实(已存在),验证后只修真实两项(sha 校验 + stderr cap),不盲从。这是「与既有代码/注释矛盾或一致须亲读分流」纪律在外部审计者维度的体现(审计者误报率非零)。sha 进 argv 是 E58/E59(路径进 argv)之外的「外部值进子进程 argv」面:固定形态(hex)校验比纯长度更强(挡 argv 注入式滥用)。stderr 累积是 E62(runGit)在 readGitBlob 的第二处同族(spawn stderr 累积无上限是反复出现的族,修一个必 grep 所有 spawn 入口的 stderr 处理)。E1-E63 持续推进外部输入边界族。

## E64 — marketplace fetcher (renderer) 的 index.json/manifest.json 无响应体上限 + 顶层数组无条目数上限 (P2,E57 reviews renderer 同族 / E2/E25 仅解析后过滤)

- **问题**: `src/marketplace/fetcher.ts` 的 `fetchMarketplaceIndex` / `fetchPluginManifest` 直接 `await r.json()` 解析远程仓库 index.json/manifest.json,无响应体字节上限,index 顶层数组也无条目数硬上限(E2/E25 的逐 entry 校验只在**全量解析之后**过滤)。恶意/异常响应(超大 JSON / 超长数组)可让 renderer 一次性解析超大对象树 → 内存/CPU 峰值、UI 卡死,且超大数组会进 filter/排序/渲染/sessionStorage 缓存被放大。这是 E57(marketplace-reviews 主进程侧 Content-Length + 节点数上限)在 **renderer 网络输入侧**的平行入口。
- **修复**: 新增 `readJsonCapped(r, maxBytes)` helper —— 读 text 前先按 `Content-Length` 拦,再按 `text.length` 拦(挡把超大字符串解析成更大对象树),超限抛 `MARKETPLACE_RESPONSE_TOO_LARGE`,再 `JSON.parse`。`MAX_INDEX_BYTES=4MiB` / `MAX_MANIFEST_BYTES=1MiB`(对齐 main MANIFEST_MAX_BYTES)。index 顶层数组在逐 entry 校验**之前**先 `slice(0, MAX_INDEX_ENTRIES=4096)` 截断(超限 console.warn),再 filter / 缓存,防超大数组放大。失败仍走既有 cache fallback。
- **测试**: marketplace.spec +E64 三例(index 响应 Content-Length>4MiB → 无 cache 时抛 MARKETPLACE_RESPONSE_TOO_LARGE / index 数组 MAX_INDEX_ENTRIES+50 → 结果截断到 4096 / manifest Content-Length>1MiB → 抛)。中和(两处字节 cap 改 `>1e18` + slice 改 `raw`)→ 3 测试失败确认回归,恢复后全量 4116 PASS。
- **沉淀**: 「外部网络 JSON 无响应体上限 + 解析后才过滤」是反复族:E57 在主进程 reviews 修过一次,E64 是其 **renderer 平行入口**(修一个边界族必 grep 所有 fetch+JSON.parse 入口)。两道闸:Content-Length(声明值,可被伪造但低成本先拦)+ text.length(真实字节,权威),再 JSON.parse;顶层数组额外加条目数硬上限(防 filter/缓存/渲染放大),且截断须在逐项校验**之前**(E2/E25 的过滤发生在解析后,不解决解析本身的放大)。E1-E64 持续推进外部输入边界族。

## E65 — marketplace-reviews (main) GraphQL 响应只做 Content-Length 预检后仍 await r.json(),缺/伪造/chunked 时 cap 失效 (P1,E57 同入口补强 / E64 readJsonCapped 同款)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:143` 的 `fetchReviewNodes` 在 E57 已加 `MAX_RESPONSE_BYTES=8MiB` 的 Content-Length 预检,但**预检之后仍直接 `await r.json()`**。Content-Length 是声明值:header 缺省时 `?? '0'` 放行、被伪造成小值、或 chunked 传输无 content-length 时,预检全部失效,`r.json()` 仍会无界读入并解析超大 JSON → main 进程内存/CPU 峰值(字段截断 clampStr 发生在**完整解析之后**,救不了解析本身)。E57 注释自己就写了「best-effort:header 缺省=0 放行」—— 即此缺口。
- **修复**: 改 `await r.json()` 为 `const text = await r.text()` + `if (text.length > MAX_RESPONSE_BYTES) throw 'MARKETPLACE_RESPONSE_TOO_LARGE'` + `JSON.parse(text)`,与 E64 `fetcher.ts` 的 `readJsonCapped` 同款。Content-Length 预检保留作便宜的早退(声明值低成本先拦),`text.length` 是真实字节的权威闸(挡缺省/伪造/chunked)。
- **测试**: security-marketplace-token-main.spec +E65(伪造 `content-length:'10'` 但响应体 9MiB → 仍在 JSON.parse 之前抛 MARKETPLACE_RESPONSE_TOO_LARGE)。中和(text.length cap 改 `>1e18`)→ E65 失败确认回归,恢复后全量 4117 PASS。
- **沉淀**: 「Content-Length 预检 ≠ 字节闸」—— 声明值可缺省/伪造/chunked,只能当便宜早退,真正的硬上限必须读 text 后按真实 length 拦(再 parse)。E57 当时只做了预检留了缺口,E65 是同一入口的补强,与 E64(renderer fetcher)收口成同一双闸模式(Content-Length 早退 + text.length 权威 + parse)。修一个外部网络 JSON 入口的边界,必把同款双闸推到所有 fetch+JSON.parse 入口(E57 reviews / E64 index+manifest / E65 reviews 补强,均已对齐)。E1-E65 持续推进外部输入边界族。

## E66 — install_stop_hook 的 mergeClaudeCodeSettings/mergeCodexConfig 读工作区配置文件无大小上限 (P1,E26 同款 / E18 stat-before-read 族)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts` 安装 stop-hook 时,`mergeClaudeCodeSettings`(541)直接 `readFile('.claude/settings.local.json','utf8')` 后 JSON.parse,`mergeCodexConfig`(616)直接 `readFile('.codex/config.toml','utf8')` 后跑 regex/replace —— 两处都是用户**工作区外部输入**,但无文件大小上限。畸形/超大配置会在 main 进程装 hook 时内存/CPU 峰值,`.codex/config.toml` 还会让正则在超大文本上跑并随后构造更大的写入串。E26 已给 ingestFile(hook 输出文件)加过 `MAX_HOOK_FILE_BYTES`,这两处配置读入是其平行入口却漏了。
- **修复**: 新增共用 `readConfigCapped(filePath)` helper —— 先 `stat.size` 预检(`MAX_CONFIG_FILE_BYTES=1MiB`),超限返回 `{kind:'too-large'}`,不进 readFile/parse/regex/atomicWrite;返回判别联合 `ok|missing|too-large|read-error`(ENOENT→missing 保留「新建」语义,其他错误→read-error 保留「读失败当空→写覆盖」族的 fail-closed)。两 merge 函数改用该 helper,too-large → 新增 reason `config-too-large`(诊断用,不进 i18n catalog,只 `installed` 布尔上抛)。
- **测试**: install-stop-hook-read-error-fail-closed.spec +E66(settings.local.json / config.toml 超 1MiB → config-too-large 且原文件不被覆盖;超大但合法 JSON 证明拦在 parse 之前)。既有 EACCES→read-error 测试仍绿(helper stat 成功、readFile mock 抛 → read-error,语义保持)。中和(size cap 改 `>1e18`)→ 2 测试失败确认回归,恢复后全量 4119 PASS。
- **沉淀**: 「外部文件读入无 stat.size 上限」是反复族:E18(主 fs:read-file)/E26(hook 输出)/E28(plugin-fs read)修过多次,E66 是 stop-hook **配置读入**的平行入口(修一个边界族必 grep 所有 readFile 外部文件入口)。stat-before-read 比读后判更省:超大文件根本不进内存。共用 capped-read helper(codex 建议)消两入口漂移,too-large/read-error fail-closed 与既有「读失败当空→写覆盖」数据安全族同闸(都绝不进 atomicWrite 覆盖)。E1-E66 持续推进外部输入边界族。

## E67 — persistence.ts loadExplorer 整块读 explorer.json + JSON.parse,大小上限只在 safeParse 后生效 (P1,E18/E26/E66 stat-before-read 族)

- **问题**: `electron/main/persistence.ts:216` 的 `loadExplorer()` 直接 `fs.readFile(explorer.json,'utf-8')` + JSON.parse,大小/数组/字符串上限都在解析后的 `ExplorerSchemaV3.safeParse` 才生效;损坏处理 `preserveCorruptExplorer` 还会把完整 raw 再写入 `.corrupt`。畸形或手工放大的 explorer.json 可在启动、窗口恢复、布局读写前造成 main 进程内存/CPU 峰值,保留 corrupt 快照时还二次放大 I/O。`migrateExplorerFileToV3:332` 的二次读(no-op 检测)也裸 readFile。
- **修复**: 抽共用 `readExplorerCapped(filePath)`(单一来源,loadExplorer + migrate 二次读共用,消漂移)—— 先 `stat.size` 硬拦 `MAX_EXPLORER_FILE_BYTES=16MiB`(多窗口 + dockview 布局仅 KB~MB 级,16MiB 留足余量),超限 **throw**(同 EACCES「当前态未知」分支:绝不返 null 触发 `?? default` 覆盖,也不进 readFile/JSON.parse/preserveCorrupt 整块读);ENOENT→null(首次启动),其它读错误→throw。
- **测试**: explorer-corrupt-preserve.spec +E67(mock stat 谎报 17MiB → throw `too large`、readFile 未被调用、不写 .corrupt)。既有 EACCES→throw 测试同步改造(stat-before-read 后需先建真文件让 stat 成功再 mock readFile EACCES)。中和(size cap 改 `>1e18`)→ E67 失败确认回归,恢复后全量 4120 PASS(`stop-hook-unknown-window-no-crosstalk` 已知 flake,rerun 即过)。
- **沉淀**: stat-before-read 边界族第 4 处(E18 主 fs / E26 hook 输出 / E66 stop-hook 配置 / E67 explorer 持久化)—— 凡读外部/磁盘文件后整块 parse 的入口都须先 stat.size 拦,超大根本不进内存。**too-large 的失败语义要与既有数据安全族对齐**:loadExplorer 早有「读失败当未知→throw,绝不返 null 触发 `?? default` 覆盖」的契约(EACCES 分支),too-large 复用同一 throw 路径而非走 corrupt(返 null)路径——后者会让超大但可能可恢复的文件被默认值覆盖。共用 capped loader 消两读入口漂移(codex 建议)。E1-E67 持续推进外部输入边界族。

## E68 — plugins.service 插件元数据 _enabled/_permissions/_path_scopes.json 整块读 + JSON.parse,无 stat.size 上限 (P1,E18/E26/E66/E67 stat-before-read 族第 5 处)

- **问题**: `electron/main/services/plugins.service.ts` 的 `readEnabledIds`(220)/`readPermissions`(322)/`readAllPathScopes`(429)都裸 `fs.readFile + JSON.parse` 读插件持久化元数据,数量/字段/路径上限都在解析后(IPC schema 校验)才生效;`readAllPathScopes` 损坏还把完整 text 写 `.corrupt`。畸形或手工放大的元数据文件可在启动/list/权限写入前撑爆 main 内存或长阻塞,`.corrupt` 备份二次放大 I/O。同文件已有 `readFileCapped`(E24,给 manifest/main/styles)但这三个读点漏了。
- **修复**: 新增共用 `readMetadataCapped(filePath)`(`METADATA_MAX_BYTES=1MiB`),三处替换裸 readFile。**关键**:与 `readFileCapped`(返 null 吞所有错误)不同,此 helper **透传错误**以保留三处既有的数据安全语义 —— `fs.stat` 的 ENOENT 透传给调用方既有 catch(`code==='ENOENT'`→空表=首次启动);too-large 抛**无 ENOENT code** 的普通 Error → 调用方 catch 走「非 ENOENT→throw」路径(当前态未知,**绝不当空表降级**,否则 writeEnabledIds/writePluginPermissions/writePluginPathScopes 基于空表 RMW 会抹掉其它 plugin 的启用/授权/scope);且 too-large 在 readFile/JSON.parse/.corrupt 之前 fail-fast,不整块读入。
- **测试**: plugins-service.spec +E68×2(readEnabledIds/readPermissions:mock stat 谎报 2MiB → 抛 `too large`、readFile 未被调用、不当空表降级)。既有 EACCES→throw 测试因都先 `writeFileSync` 建真文件,stat 成功后 mock readFile 抛 → 仍绿。顺手给 afterEach 加 `vi.restoreAllMocks()`(防断言失败时 spy 泄漏到后续测试)。中和(size cap 改 `>1e18`)→ E68 失败确认回归,恢复后全量 4122 PASS。
- **沉淀**: stat-before-read 边界族第 5 处(E18 主 fs / E26 hook 输出 / E66 stop-hook 配置 / E67 explorer 持久化 / E68 插件元数据)。**同文件已有 capped helper 不代表所有读点都用了**——E24 给 manifest/main/styles 加了 readFileCapped,但元数据三读点平行漏改(修一个边界族必 grep 同文件所有 readFile)。**too-large 的失败语义必须匹配该读点既有的「读失败」契约**:这三处是「读失败当未知→throw 防 RMW 抹他人」族(非 listPluginDirs 的「读失败→跳过=null」族),故新 helper 透传错误而非吞成 null —— 不能盲套现成的 readFileCapped(语义相反)。E1-E68 持续推进外部输入边界族。

## E69 — settings.service loadSettings 整块读 settings.json + JSON.parse,无 stat.size 上限 (P2,E18/E26/E66/E67/E68 stat-before-read 族第 6 处)

- **问题**: `electron/main/services/settings.service.ts:59` 的 `loadSettings()` 直接 `fs.readFile(settings.json,'utf-8')` + JSON.parse,`SettingsSchema` 只在完整解析后生效。该文件语义上只有 `{version, locale}`(正常仅数十字节),却无任何读前大小上限。畸形/手工放大的 settings 文件会在启动和语言水合时阻塞 main 进程、制造内存峰值,解析失败路径也已付出整块读取/解析成本。
- **修复**: `loadSettings` 在 readFile 前加 `fs.stat` 预检,`MAX_SETTINGS_FILE_BYTES=64KiB`(数十字节正常值的天文余量)。超限 → 当 corrupt 隔离(`rename .corrupt.<ts>` + 重置默认,与既有 parse/schema 损坏路径同型),但**绝不整块读入**。stat 的 ENOENT→默认+cache(首次启动)、EACCES→默认不 cache(当前态未知可重试),与既有 readFile 错误路径同语义;readFile catch 保留作 TOCTOU 兜底。
- **失败语义选择**: settings.json 与 E67/E68 不同 —— 它是「读失败/损坏→重置默认,永不抛」契约(无 RMW 抹他人风险,且 {version,locale} 可重生),故 too-large 走 **corrupt 隔离(rename + 默认)** 而非 throw。这与 E67(explorer,数据不可重生→throw 防覆盖)/E68(元数据,RMW 抹他人→throw)的失败语义**有意不同**:每个读点的 too-large 处理必须匹配该文件既有的「读失败」契约。
- **测试**: settings-service.spec +E69(盘上放合法小文件 'ko' + mock stat 谎报 100KB → 证明按 size 拦而非 parse:返回默认 'zh'、readFile 未被调用、原文件 rename 为 .corrupt)。既有 EACCES→默认不 cache 测试因先 writeFile 建真文件、stat 成功后 mock readFile 抛 → 仍绿。中和(size cap 改 `>1e18`)→ E69 失败确认回归,恢复后全量 4123 PASS。
- **沉淀**: stat-before-read 边界族第 6 处(E18/E26/E66/E67/E68/E69)。**too-large 的失败动作必须按读点既有「读失败」契约分流**(throw 防覆盖 vs rename-corrupt 重置默认 vs 返 null 跳过)——不是所有 too-large 都该 throw;settings 可重生且无 RMW 风险,corrupt 隔离比 throw 更符合「永不抛启动契约」。E1-E69 持续推进外部输入边界族。

## E70 — readRecord 对完整 localStorage 字符串 JSON.parse 后才过滤,无解析前原始串长度上限 (P2,E64/E67/E68 解析前上限族 / renderer localStorage 变体)

- **问题**: `src/plugins/storage/local-storage-record.ts:26` 的 `readRecord()` 先 `getItem(key)` + `JSON.parse(raw)` 完整解析,再按 E22 的 maxEntries/maxKeyLength/valueGuard 过滤。这些守卫都在**解析后**生效,挡不住「解析前」成本。settings values-store 与 keybindings overrides-store 都复用此 helper。被篡改或旧版本残留的超大 localStorage JSON 会在 renderer 启动 + `storage` 跨窗同步事件时造成 parse/Object.entries 枚举卡顿,条目上限无法阻止解析前成本。
- **修复**: 新增 `maxRawLength` opt + `DEFAULT_MAX_RAW_LENGTH=1MiB`,在 `JSON.parse` 之前按 `raw.length` 拦,超限直接返 `{}`(同既有 catch→{} 降级语义)。默认上限对所有调用方生效(含未传 opts 者)—— 纯防御天花板,settings/keybindings 正常值仅数 KB,1MiB 不误伤(不破坏「不传 opts 保持旧行为」对合法尺寸输入的契约,只拒病态超大输入)。
- **测试**: local-storage-record-guard.spec +E70×2(显式 maxRawLength:超限→{}、放宽→正常解析;默认 1MiB:>1MiB 合法 JSON 未传 opts 也→{} 不强转超大对象)。同步更新 web-compat-allowlist.json 中该文件 4 处 globalThis.localStorage 行号(24/26/56/58 → 33/35/67/69,因插入 const + 检查行位移)。中和(raw cap 改 `>1e18`)→ E70 两测失败确认回归,恢复后全量 4125 PASS。
- **沉淀**: 「解析前无上限」族的 renderer localStorage 变体(E64 fetcher / E67 explorer / E68 元数据是磁盘/网络侧,E70 是 localStorage 侧)。**形态/条目守卫在 parse 后 ≠ 解析前防护**:E22 加的 per-entry 守卫挡不住超大串本身的 parse/枚举成本,必须再加原始串长度闸。**编辑 web-compat allowlist 钉行号的文件后必同步更新行号**(M21 既定联动,否则 allowlist 测试红)。E1-E70 持续推进外部输入边界族。

## E71 — createSessionCache 对完整 sessionStorage 缓存 JSON.parse 后才 validate,无解析前原始串长度上限 (P2,E70 sessionStorage 孪生 / 解析前上限族)

- **问题**: `src/marketplace/session-cache.ts:41` 的 `readStorage()` 先 `getItem(key)` + `JSON.parse(raw)` 完整解析,`validate()` 的字段/条目限制只在解析后生效。marketplace index(fetcher.ts)与 reviews(reviews-fetcher.ts)都复用此 helper。被篡改或旧版本残留的超大 sessionStorage 缓存会在 Marketplace 打开时阻塞 renderer。
- **修复**: 新增 `maxRawLength` opt + `DEFAULT_MAX_RAW_LENGTH=16MiB`,`JSON.parse` 之前按 `raw.length` 拦,超限 → cache-miss(返 null)+ `removeItem` 清毒(避免坏缓存反复触发解析)。默认 16MiB 覆盖最大合法缓存(index ≤4MiB E64 / reviews 多节点数 MiB),调用方可按需传更紧的值。
- **测试**: 新建 marketplace/session-cache.spec.ts(E71×3:正常往返 / 显式 maxRawLength 超限→cache-miss+removeItem / 默认 16MiB 超限→cache-miss+removeItem)。`pnpm bdd:index`(200→201 主题)。**jsdom sessionStorage 有 5MB 配额无法 setItem 16MiB → 默认上限测试改 `vi.spyOn(Storage.prototype,'getItem')` 返超大串绕配额**(spy 实例不拦截,jsdom Storage 方法在 prototype 上)。中和(raw cap 改 `>1e18`)→ 2 cap 测试失败(往返测试仍绿)确认回归,恢复后全量 4128 PASS。
- **沉淀**: 「解析前无上限」族 sessionStorage 变体(E70 localStorage 孪生)。两 helper(localStorage-record/session-cache)同病:形态/条目守卫在 parse 后,须各自加原始串长度闸。**jsdom Storage quota(5MB)+ 方法在 prototype**:测超大 storage 须 spy `Storage.prototype` 返串绕过 setItem 配额,spy 实例无效。E1-E71 持续推进外部输入边界族。

## E72 — command-palette recent 列表独立 localStorage 读路径,JSON.parse 后才 slice(MAX_RECENT),无解析前原始串长度上限 (P2,E70/E71 解析前上限族)

- **问题**: `src/plugins/command-palette/recent.ts:49` 的 `readFromStorage()` 是独立于 readRecord 的 localStorage 读路径:`getItem` + `JSON.parse(raw)` 后才 `filter(isRecentEntry).slice(0, MAX_RECENT)`。E39 的 MAX_RECENT 只限制解析后结果,挡不住超大 raw/超大数组的解析成本。被篡改的 `continuo:command-palette:recent` 会在 renderer 启动、`storage` 跨窗同步、以及**每次 `record()`(读 live 列表合并)**时反复 parse 卡顿。
- **修复**: 新增 `MAX_RECENT_RAW_LENGTH=256KiB`(列表仅 20 条 × {id≤256, ts},正常数 KB),`JSON.parse` 之前按 `raw.length` 拦,超限 → 返 [] 并 `removeItem` 清毒(避免每次 record/storage 同步反复解析坏缓存)。
- **测试**: recent.spec +E72(12000 条合法小条目使序列化 raw >256KiB → 解析前返 []、key 被清,区别于 E39「60 条 <256KiB → 截断到 MAX_RECENT」)。中和(raw cap 改 `>1e18`)→ E72 失败确认回归,恢复后全量 4129 PASS。
- **沉淀**: 「解析前无上限」族第 4 个 storage 读点(E70 readRecord / E71 session-cache / E72 recent)。**独立手写的 localStorage 读路径不受共享 helper 的 cap 保护**——recent 没走 readRecord(E70)故 E70 的 maxRawLength 救不到它,必须各自加(或迁到共享 bounded helper;此处选最小改动各自加 cap)。修一个解析前上限族必 grep 所有 `JSON.parse(localStorage.getItem(...))` 独立读点。E1-E72 持续推进外部输入边界族。

## E73 — safeHandle/safeHandleWithCtx/mcp-host zod 校验失败时全量 join error.issues 当 message,无 issue 数/长度上限 (P2,E57/E62 错误串放大族)

- **问题**: `electron/main/safe-handle.ts:81`(processIpcCall)+ `:157`(processIpcCallWithCtx)+ `electron/main/services/mcp-host.service.ts:302`(工具入参校验)在 zod 失败时都 `parsed.error.issues.map((i) => i.message).join('; ')` 当错误 message 返回。无 issue 数 / 总长上限。对 `.strict()` schema,畸形 payload 带大量未知 key 时 zod 生成一条列出全部 key 的 `unrecognized_keys` issue → 单条 message 无界放大;大量独立校验错误则 issue 条数无界。坏 IPC 输入虽被拒,仍可构造很大错误串经 IPC 返 renderer 并进入日志/通知链路 → 内存 + UI 放大;**所有 safeHandle 通道共享该风险**。
- **修复**: 抽共享 `electron/main/lib/format-zod-error.ts` 的 `formatZodErrorCapped(error)`(单一来源,三处共用)—— 双闸:`MAX_ZOD_ISSUES=20`(issue 条数,超出追加 `+N more issues`)+ `MAX_ZOD_MESSAGE_LENGTH=2048`(拼接总长,超出追加 `…(truncated)`)。两路互补:大量独立 issue 走条数闸,单条超大 message(unrecognized_keys 列全部 key)走长度闸兜底。
- **测试**: ipc-safe-handle/safe-handle.spec +E73×3(.strict() + 2000 未知 key → message ≤2048+标记;formatZodErrorCapped 50 缺字段 → 20 条 + `+30 more issues`;少量 issue → 无截断标记)。中和(两 cap 改 1e9)→ 2 cap 测试失败(无截断测试仍绿)确认回归,恢复后全量 4132 PASS。
- **沉淀**: 「错误串放大」族(E57 reviews GraphQL errors join / E62 git stderr 累积 / E73 zod issues join)—— 凡把外部可控数量/长度的片段 join 成单错误串经 IPC/日志/UI 传播的入口,都须 cap 条数 + 总长。**zod `.strict()` 的 unrecognized_keys 是单条 issue 但 message 含全部 key**,故仅 cap issue 条数不够,必须叠加 message 长度闸。共享 helper 消三处漂移。E1-E73 持续推进外部输入边界族。

## E74 — ManifestSchema 字段无长度/数量上限,主进程只限 manifest 文件总大小 (P2,E24/E35 字段上限族)

- **问题**: `src/plugins/manifest.ts:14` 的 `ManifestSchema` 对 name/main/description/author/authorUrl/permissions 无字段长度或数组数量上限。主进程只限 manifest 文件总大小(E24 MANIFEST_MAX_BYTES=1MiB)。畸形本地插件可用接近 1MiB 的单个 name/description,或大量重复 permissions,通过 schema 进入 PluginManager / PluginsTab / 权限弹窗 / 错误状态 → renderer 渲染/状态放大卡顿(文件大小限制挡不住「单字段占满 1MiB」)。
- **修复**: 给每字段加合理 `.max()`(name/author 256、main 512、description 8192、url 2048、version 128),permissions `.max(PERMISSION_KEYS.length)`(枚举去重后不可能更多项,超出必为重复刷量/畸形)。超限 → SCHEMA_ERROR 拒载。
- **测试**: plugin-manifest.spec +E74×4(超长 name>256 / 超长 description>8192 / permissions 6 项>5 → SCHEMA_ERROR;正常 manifest 仍 ok)。中和(NAME_MAX/DESC_MAX→1e9、permissions .max→1e9)→ 3 cap 测试失败(正常测试仍绿)确认回归,恢复后全量 4136 PASS。
- **沉淀**: 字段上限族(E25 marketplace entry / E35 registry id / E74 manifest)—— **文件/响应总大小上限 ≠ 单字段上限**:E24 限了 manifest 文件 ≤1MiB,但单个字段可占满整个预算流入 UI,故 schema 每字段仍须各自 .max()。枚举数组按 enum 基数封顶(去重后的天然上限)。E1-E74 持续推进外部输入边界族。

## E75 — marketplace-reviews GraphQL errors 数组无界 join 进 Error message (P2,E73 错误串放大族延伸)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:151` 在 GraphQL 响应含 errors 时 `json.errors.map((e) => e.message).join('; ')` 拼进 Error message,无错误条数 / 单条长度 / 总长上限。errors 来自外部响应(E65 已限响应体 ≤8MiB,但 8MiB 内可塞大量错误或超长 message)。畸形/代理响应的大 errors 数组被放大成超长错误串,经 safeHandle / renderer 错误状态 / 通知链路继续传递 → UI 卡顿、内存浪费。
- **修复**: 把 E73 的 `formatZodErrorCapped` 重构出泛型 `capJoinedMessages(messages, moreLabel?)`(条数 `MAX_JOINED_ITEMS=20` + 总长 `MAX_JOINED_LENGTH=2048` 双闸 + 截断标记),formatZodErrorCapped 改为其薄封装(保留「more issues」文案)。marketplace-reviews 复用 `capJoinedMessages(json.errors.map((e) => String(e?.message ?? '')))`(message 强制 String 化,外部数据可能非 string)。codex 建议的「统一 capped-error formatter」落地。
- **测试**: security-marketplace-token-main.spec +E75(100 条 ×~115 字符 errors → 错误 message ≤2048+标记,远小于未截断 ~11.5K)。E73 三测复用同一 helper 仍绿(重构保留「more issues」文案)。中和(两 cap → 1e9)→ E75 + E73 长度测试同时失败确认回归(证明单一来源),恢复后全量 4137 PASS。
- **沉淀**: 错误串放大族(E57/E62/E73/E75)第 4 处,且**首次把同族两处(zod issues + GraphQL errors)收口到同一泛型 helper** —— 中和一处 cap 即同时打挂两处测试,证明单一来源生效(对抗未来某入口私自绕过 helper 漂移)。外部数据 join 进错误串前先 `String()` 化防非字符串。E1-E75 持续推进外部输入边界族。

## E76 — PluginMcpRegistry (renderer) plugin MCP 工具入参校验失败裸 join issues,无上限 (P2,E73/E75 跨进程同族)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:156`(renderer 侧)plugin MCP 本地 tool 的 `inputSchema.safeParse` 失败后仍 `parsed.error.issues.map((i) => i.message).join('; ')` 无 issue 数/总长上限抛 INVALID_PARAMS。外部 MCP client 传畸形 arguments(.strict() schema 大量未知 key → 单条超大 unrecognized_keys issue)时,renderer 构造超长错误串,经 reply schema/IPC/日志路径放大或因超限丢失真实错误。E73(main safeHandle)/E75(main GraphQL)同族但 **renderer 路径**。
- **修复**: 把泛型 `capJoinedMessages` 从 `electron/main/lib/format-zod-error.ts` 提升到 `electron/shared/cap-joined-messages.ts`(**跨进程单一来源**——renderer 不可 import main 代码,故放 shared)。format-zod-error.ts re-export 它;PluginMcpRegistry 直接 `import { capJoinedMessages } from '../../../electron/shared/cap-joined-messages'` 并用 `capJoinedMessages(parsed.error.issues.map((i) => i.message), 'more issues')`。
- **测试**: plugin-mcp-registry/registry.spec +E76(.strict() schema + 2000 未知 key → INVALID_PARAMS message ≤2048+标记)。中和共享 helper 的两 cap(1e9)→ **E73 + E75 + E76 四测同时失败**(跨 main+renderer 两进程),恢复后全量 4138 PASS。
- **沉淀**: 错误串放大族(E57/E62/E73/E75/E76)收口完成——**三处 zod/errors join 入口(main safeHandle、main GraphQL、renderer plugin MCP)现共用 `electron/shared` 的单一 capJoinedMessages**,中和一处 cap 即同时打挂横跨两进程的全部相关测试,是「单一来源」最强证明。**跨进程共享 helper 必放 electron/shared**(renderer 不可 import electron/main)。E1-E76 持续推进外部输入边界族。

## E77 — parseManifest SCHEMA_ERROR 裸 join issues,无上限(E74 .max(count) 未覆盖元素长度) (P2,E73/E75/E76 错误串放大族最后一处 zod-join)

- **问题**: `src/plugins/manifest.ts:70` 的 `parseManifest` SCHEMA_ERROR 仍 `parsed.error.issues.map((i) => \`${path}: ${i.message}\`).join('; ')` 无 issue 数/总长上限。**关键**:zod enum 校验错误会**回显 received 值**(`Invalid enum value. Expected ..., received '<value>'`),而 E74 给 permissions 加的 `.max(PERMISSION_KEYS.length)` 只限**数组条数**、不限**元素长度** —— 故 `permissions: ['<3000 字符>']`(长度 1 过 .max)会触发 enum 错误并回显 3000 字符 → 单条 issue.message ~3KB → 进 PluginManager.entry.error / PluginsTab 渲染放大。1MiB 文件内可构造。
- **修复**: 复用共享 `capJoinedMessages`(electron/shared,E76 提升)收口 manifest SCHEMA_ERROR message。这是错误串放大族最后一处裸 zod-join,至此 main(safeHandle/GraphQL)+ renderer(plugin MCP/manifest)全部 zod/errors join 入口统一经单一来源。
- **测试**: plugin-manifest.spec +E77(`permissions: ['z'×3000]` 长度 1 过 .max 但元素超长 → enum 回显 → message ≤2048+标记 + 含 truncated)。先用 `node -e` 实证 zod 确实回显 received 值(3058 字符)。中和共享 helper 长度 cap(1e9)→ E73+E75+E76+E77 四测同时失败,恢复后全量 4139 PASS。
- **沉淀**: **字段 `.max(count)` ≠ 元素 `.max(length)`** —— E74 限了 permissions 数组条数,但单个元素长度无限,且 zod enum 错误回显该值放大错误串,是 E74 留下的相邻缺口(同字段两个维度:条数 vs 元素长度)。错误串放大族(E57/E62/E73/E75/E76/E77)至此收口:所有 zod/errors join 入口(跨 main+renderer 两进程 5 处)共用 electron/shared/cap-joined-messages 单一来源。E1-E77 持续推进外部输入边界族。

## E78 — mcp-host parseRpcMessage 接受任意长度 JSON-RPC id/method,tools/call params.name 仅校验非空,失败路径回显原值 (P2,回显面 + 错误串放大族)

- **问题**: `electron/main/services/mcp-host.service.ts:136` 的 `parseRpcMessage` 只校验 method 非空、id 为 string|number,无长度上限;`tools/call` 的 `params.name` 也只校验非空。失败路径把原值拼进 `method not found: ${rpc.method}`(:334)、`tool not found: ${name}`(:280),并在响应里回显 id。恶意本地 MCP client 可在 1MB body 上限内构造超长 method/name/id,让错误响应 + 日志路径放大、占主进程 CPU/内存。
- **修复**: `MAX_RPC_FIELD_LEN=1024`(method/id/name 都是短标识符)。parseRpcMessage:method 超长 / string id 超长 → 返 null(走既有固定 PARSE_ERROR + id:null,不回显原超长串);number id 无放大风险不限。tools/call:params.name 超长 → 固定 INVALID_PARAMS 文案(不回显)。capped 后 line 280/334 回显的值必 ≤1024。
- **测试**: agent-terminal-mcp-dispatcher.spec +E78×5(parseRpcMessage:正常 ok / method>1024→null / string id>1024→null / number id 不受限;dispatchRpc:name>1024→INVALID_PARAMS 且 message 不含超长串、长度<200)。中和(MAX_RPC_FIELD_LEN→1e9)→ 3 cap 测试失败(正常/number id 测试仍绿),恢复后全量 4144 PASS。
- **沉淀**: 「外部输入回显进错误串/响应」是错误串放大族的另一面(E73-E77 是 join 数组,E78 是单个标识符回显)。**未信任输入的标识符在拼进错误消息/日志/响应前须长度封顶**,且超限时走「固定文案不回显」而非「回显被截断的串」(parseRpcMessage 返 null → 固定 PARSE_ERROR,根本不带原值)。number id 无字符串放大风险,精确豁免避免误伤合法大数 id。E1-E78 持续推进外部输入边界族。

## E79 — plugin-mcp-bridge handleRegister 无注册 tool 数量上限(per-wc + 全局) (P2,E54/E47 注册表数量上限族)

- **问题**: `electron/main/services/plugin-mcp-bridge.service.ts:282` 的 `handleRegister` 只校验单个 tool 的 name/description/jsonSchema 大小(E53),没有限制每个 plugin/webContents 或全局注册的 tool 数量。恶意插件可循环注册成千上万个合法小 tool,主进程 entries/host.tools 持续增长,tools/list 与 list_changed 广播输出被放大到卡顿/OOM。
- **修复**: 新增 `MAX_TOOLS_PER_WC=256` + `MAX_TOOLS_GLOBAL=2048`,handleRegister 前查 `entries.size`(全局,O(1))+ per-wc 计数(`perWcCount` Map,O(1) 维护),超限抛新 error code `TOO_MANY_TOOLS`。per-wc 计数在 register/unregister/wcGone 三处同步增减,归零删 key(Map 排空回收防泄漏),用计数 Map 而非 register 时 O(n) 遍历 entries(避免攻击下 O(n²))。
- **测试**: plugin-mcp-multi-window.spec +E79×4(单 wc 257 个→TOO_MANY_TOOLS 且 host.tools 仍 256 / unregister 释放名额可再注册 / wcGone 释放整 wc 名额 / 8 wc×256=2048 满后第 2049→TOO_MANY_TOOLS)。中和(两 cap→1e9)→ 2 cap 测试失败(释放名额测试仍绿),恢复后全量 4148 PASS。
- **沉淀**: 注册表数量上限族(E47 decorator / E54 MAX_DECORATORS=256 / E79 MCP tools)—— **单条目大小校验 ≠ 条目数量上限**:E53 限了单 tool 字段大小,但数量无界仍可撑爆。per-wc + 全局双层(全局 O(1) entries.size,per-wc 用计数 Map 维护避免 O(n²),且与 unregister/wcGone 对称增减 + 归零回收)。E1-E79 持续推进外部输入边界族。

## E80 — fetchPluginManifest 远端 manifest id/name/version 仅 string 类型校验,无长度/semver 上限 (P2,E74 字段上限族跨端延伸)

- **问题**: `src/marketplace/fetcher.ts` 的 `fetchPluginManifest` 对远端 manifest 的 id/name/version 只做 `typeof === 'string'` 校验,没有复用本地 ManifestSchema(E74)的字段长度 + semver 上限。E64 限了响应体 ≤1MiB,但 1MiB 内可返超长 version(如 `999.999.999-<超长后缀>`)/超长 name,通过类型校验进 update-store 的 remoteVersions/available.to,在更新按钮 tooltip/文案中放大渲染。
- **修复**: `RemoteSnapshotSchema = ManifestSchema.pick({ id:true, name:true, version:true })`(复用 E74 的 id/name/version 校验:`.max` + `SEMVER_RE` + id regex,**单一来源避免漂移**),`fetchPluginManifest` 改用 `safeParse`,不合规 → 抛(caller 当该插件 update-check 失败跳过)。比旧版严格(旧版 version 是任意 string,现要求合法 semver,与本地 manifest 校验一致)。
- **测试**: marketplace.spec +E80×3(version 超长非法 semver / version 非 semver → 抛;合规远端 manifest 仍正常返回)。既有「缺字段→抛」测试消息从「manifest 缺...」改为「remote manifest invalid...」(message 同步)。中和(safeParse 守卫 `if(false)`)→ 3 throw 测试失败(合规测试绿),恢复后全量 4151 PASS。
- **沉淀**: 字段上限族(E25/E35/E74/E80)跨端延伸 —— **本地 manifest 已校验 ≠ 远端 manifest 已校验**:E74 给本地 ManifestSchema 加了 .max+semver,但远端 update-check 的 RemoteManifestSnapshot 是独立的轻量类型校验路径,漏了同样约束。用 `ManifestSchema.pick(...)` 复用本地 schema 是消跨端漂移的最优解(远端 = 本地子集)。E1-E80 持续推进外部输入边界族。

## E81 — PathScopeRegistry mergeScopes 无 per-plugin/全局 scope 数量上限 (P2,E79 注册表数量上限族)

- **问题**: `electron/main/services/path-scope-registry.service.ts:130` 的 `mergeScopes` 只按 path 合并去重,无 per-plugin / 全局累计上限。单次 request-scope 虽限 64 条(E31),但插件可多次请求不同路径,把 `pluginScopes` 与 `_plugin-path-scopes.json` 持续撑大。此后每次 `check()` 线性扫描 scopes、`covers()` 是 requested×scopes、启动 hydrate / 持久化都随授权数线性增长,畸形插件可放大主进程 CPU/内存与元数据文件。
- **修复**: `MAX_SCOPES_PER_PLUGIN=256` + `MAX_SCOPES_GLOBAL=4096`,在 `mergeScopes`(grant + hydrate 的唯一合并 choke point)统一执行。已存在 path 放宽 mode(rw>r)不增计数、不受限;新 path 超 per-plugin 或全局 → fail-closed 丢弃(不无界增长)。全局唯一-path 计数 `totalScopes` O(1) 维护(merge 加 delta、revokeAll 减),避免每次遍历全表求和。hydrate 也经 mergeScopes → 读持久化同样按上限过滤(codex 建议)。
- **测试**: path-scope-registry.spec +E81×3(单 plugin grant 300 → 截断 256 / 已存在 path r→rw 升级不增计数 / 16 plugin×256 占满全局后新 plugin 授权丢弃,revokeAll 释放名额后可入)。中和(两 cap→1e9)→ 2 cap 测试失败(mode 升级测试绿,因它只依赖 path 去重),恢复后全量 4154 PASS。
- **沉淀**: 注册表数量上限族(E47 decorator / E54 / E79 MCP tools / E81 path scopes)—— **单次请求限额 ≠ 累计上限**:E31 限了单次 request-scope 64 条,但多次累积无界(类比 E79「单 tool 大小 ≠ tool 数量」)。在唯一去重 choke point(mergeScopes)统一执行 per-plugin + 全局双层,O(1) 计数维护 + revoke 对称回收 + hydrate 路径同闸。E1-E81 持续推进外部输入边界族。

## E82 — 插件目录枚举 listPluginDirs/recoverInterruptedInstalls/createPluginsWatcher 各自 fs.readdir 全量,无条目数上限 (P2,E30/E79 数量上限族)

- **问题**: `electron/main/services/plugins.service.ts` 的 `listPluginDirs`(:180)/`recoverInterruptedInstalls`(:91)/`createPluginsWatcher` runScan(:890)都 `fs.readdir(baseDir)` 全量物化整个 userData/plugins 目录,无条目数上限。被污染/畸形的 plugins 目录放入海量条目时,首次 LIST_DIRS 被启动恢复 + 插件扫描整目录读入长时间阻塞,watcher 还每轮重复全量扫,放大主进程 CPU/I/O。
- **修复**: 新增共用 `readPluginDirEntriesCapped(baseDir)`(`MAX_PLUGIN_DIR_ENTRIES=1024`)—— `opendir` 惰性迭代,累计到上限即 break + 告警(超大目录**不整目录读入**,区别于 readdir 一次性物化),三处共用单一来源。baseDir 缺失/不可读 → [](循环 no-op,等价旧版早返语义)。
- **测试**: plugins-service.spec +E82(mock opendir 返 fake Dir 产 5000 dirent → 惰性消费 ≤1024 即停 + 告警,免真实创建 5000 目录)。中和(cap→1e9)→ E82 失败(消费全 5000)确认回归,恢复后全量 4155 PASS。既有 listPluginDirs/watcher/install 测试全绿(opendir 替 readdir 行为等价)。
- **沉淀**: 数量上限族(E30 plugin-fs list-dir / E79 MCP tools / E81 path scopes / E82 plugin dir 枚举)—— **readdir 全量物化 vs opendir 惰性 + 早停**:E30 已用 opendir 惰性给 plugin-fs list-dir 加上限,plugins.service 的目录枚举是同源平行入口却仍裸 readdir(修一个枚举上限族必 grep 所有 readdir 入口)。三处共用 helper 消漂移。E1-E82 持续推进外部输入边界族。

## E83 — hook 目录枚举(start 扫描 + cleanupStale)无文件数上限 (P2,E82/E30 数量上限族)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts` 的 `start()` 初始扫描(:396)与 `cleanupStale()`(:343)都 `readdir(hookEventsDir)` 后遍历每个文件做 stat/read/parse/unlink。`maxEntries` 只限解析后 buffer、`MAX_HOOK_FILE_BYTES` 只限单文件大小,目录文件**数量**无界。畸形/堆积的 cc_*/codex_* 文件让 MCP host 启动 + 每轮 cleanupStale 被海量 per-file 操作拖垮,主进程 I/O/CPU 被外部目录状态放大。
- **修复**: 新增共用 `readHookDirCapped(dir, max)`(`MAX_HOOK_DIR_ENTRIES=4096`,经 broker config `maxDirEntries` 可注入)—— readdir 后超 max 则截断 + 告警(`slice(0, max)`),封住主导开销的 per-file 循环;超限轮次留给周期性 cleanupStale 后续轮继续削。start 扫描 + cleanupStale 共用单一来源。
- **设计权衡(opendir vs readdir+slice)**: 初版用 opendir 惰性枚举(不整目录读入,理论最优),但 R108/R90 race 测试与主 resolve 测试 `vi.mock('node:fs/promises')` 精确提供 `readdir` 来控制扫描时序的 start/stop 竞态;换 opendir 会使这些 mock 失效、破坏重要竞态测试。改回 readdir + slice:per-file 循环(主导开销)仍被封顶,readdir 物化的是文件名数组(次级开销),且保住竞态测试。E82(plugins.service)无此约束故用 opendir。
- **测试**: await-stop-hook.spec +E83(注入 `maxDirEntries: 5` + 写 8 真文件 → start 扫描 `truncated to 5` 告警)。中和(cap→1e9)→ E83 失败确认回归,恢复后全量 4156 PASS;R108/R90 竞态 + 主 resolve 测试(依赖 readdir mock)全绿。
- **沉淀**: 数量上限族(E30/E79/E81/E82/E83)。**测试可见性约束反向决定实现**:同族 E82 用 opendir,E83 因竞态测试钉死 readdir mock 改用 readdir+slice —— 修复手段须兼容既有 mock 契约,否则破坏正交的竞态保护(宁可次优实现保住竞态测试)。limit 经 config 注入便于低成本测试(免造 4096 真文件)。E1-E83 持续推进外部输入边界族。

## E84 — ExplorerSchemaV3 不校验 windowSeq 唯一,重复段致多窗共享同段互相覆盖会话 (P1,数据完整性)

- **问题**: `electron/shared/explorer-persistence-schema.ts:191`(及 v2 ExplorerSchema、ExplorerWritableSnapshotSchema)的 `windows: z.array(...).max(WINDOWS_MAX)` 只限数量,不校验 `windowSeq` 唯一。畸形/手工编辑的 explorer.json 可含多个相同 windowSeq 段并通过 safeParse;`ensureWindowEntry`/`find` 按 windowSeq 命中**首个**段,后续 layout/explorer 写都覆盖同一段;启动恢复(pickWindowsToRestore)还会为每个重复段各开一窗共享同一 seq → workspace/layout/editor 会话错乱或丢失。
- **修复**: load 后 canonicalize(非 fatal refine)—— `loadExplorer` 经新增 `dedupeWindowsBySeq` 对三条解析分支(v3 / v2→v3 / v1→v3)去重,同 windowSeq 只保留**首段**(与 find「命中首个」语义一致)+ 告警。`pickWindowsToRestore` 加防御性 `seenSeq` 去重(同 seq 只恢复一次)。**选 canonicalize 而非 schema refine**:refine 会因一个重复段令整个 explorer.json safeParse 失败 → 落 corrupt → 默认值覆盖(丢 recentRoots/pinned/全部窗口),与 loadExplorer 数据保留原则相悖。
- **测试**: explorer-corrupt-preserve.spec +E84(v3 含两个 windowSeq=1 段 → 去重保留首段 '/first'、windows seqs [0,1,2]、告警、不落 .corrupt)+ window-restore.spec +E84(重复 seq 只恢复首个 workspace)。中和(两处去重守卫 `if(false)`)→ 2 测试失败,恢复后全量 4158 PASS。
- **沉淀**: 数据完整性 —— **被当作「键」用的列表字段(windowSeq)须校验唯一**:schema 限了数量但未限唯一,而 find/ensureWindowEntry 按它命中首个,重复段制造「幽灵共享段」。**fatal refine vs canonicalize 的取舍**:对「读失败即保留」契约的持久化文件,用 load-canonicalize(保留其余状态)而非 refine(整文件 corrupt→默认覆盖);主防在 load 端、恢复端再加防御性去重(双层)。E1-E84 持续推进外部输入边界族。

## E85 — readEnabledIds 只校验 array-of-string,不校验 id 格式/数量,1MiB 内可塞海量/非法 id (P2,E74 字段上限族 / 数据完整性)

- **问题**: `electron/main/services/plugins.service.ts` 的 `readEnabledIds` 读 `_enabled.json` 后只 `Array.isArray && every(typeof string)` 就原样返回(E68 已限文件 ≤1MiB,但 1MiB 内可塞数十万短串或非法/超长 id)。这些经 startup `readEnabledIds → new Set → PluginManager.init` 放大 CPU/内存;`setEnabledId` 的 RMW(也走 readEnabledIds)把非法/超量 id 原样写回,**绕过写 IPC schema 上限**。
- **修复**: 保留既有「含非 string → 整体 []」契约(every 守卫),对全 string 数组追加 canonicalize —— 仅保留 `isSafePluginId(x)` 且 `length ≤ PLUGIN_ID_MAX(256)` 的 id、去重(Set)、数量 `≤ MAX_ENABLED_IDS(4096)`。真实安装的插件 id 必满足 isSafePluginId(install/manifest 强制 `^[a-z0-9._-]+$`),故合法 id 不误伤;读盘 canonicalize 同时覆盖 setEnabledId RMW(读端过滤 → 写端只写合法集合)。
- **测试**: plugins-service.spec +E85×2(含大写/空格/超长/`..`/重复 id → 只留合法去重 ['com.good','com.also-ok'] / 5000 id → 截断 4096)。既有「含非 string → []」「往返 ['a','b']」测试仍绿(every 守卫保留 + 合法 id 通过)。中和(过滤守卫 `if(false)` + 数量 cap 1e9)→ 2 测试失败,恢复后全量 4160 PASS。
- **沉淀**: 字段上限族 / 数据完整性 —— **「类型合法」≠「值合法」**:array-of-string 校验挡不住非法格式 / 海量 / 超长 id。**读端按写端同一契约 canonicalize 是收口 RMW 绕过的关键**:setEnabledId 经 readEnabledIds 读 → 读端过滤即保证 RMW 写回的也是合法集合(无需在每个写入口重复校验)。与 E84(windowSeq 去重)同属「持久化读盘 canonicalize 而非 fatal」族。E1-E85 持续推进外部输入边界族。

## E86 — readAllPathScopes 不校验 key 格式/path 长度/数量,1MiB 内可塞非法 key/超长 path/超量 scope (P2,E85/E74 数据完整性族)

- **问题**: `electron/main/services/plugins.service.ts` 的 `readAllPathScopes` 读 `_plugin-path-scopes.json` 后只「value 是数组 + isIpcPathScope(仅校验 path 为 string + mode r/rw)」就保留(E68 已限文件 ≤1MiB)。手工/旧残留元数据可塞大量非法 key、超长 path、超量 scope 通过 → readPluginPathScopes→hydrate→mergeScopes 前先构造整表,且 writePluginPathScopes 的 RMW(也读 readAllPathScopes)把其它非法/超量 plugin 条目原样写回(绕过写端契约)。
- **修复**: (1) `isIpcPathScope` 追加 `path.length ≤ PATH_SCOPE_PATH_MAX(8192)`(单点强化,覆盖所有调用点)。(2) readAllPathScopes 读盘 canonicalize:key 须 `isSafePluginId && len≤PLUGIN_ID_MAX`(与 writePluginPathScopes 写端 `isSafePluginId` 门控一致)、每插件 scope 数 `slice(0, MAX_PERSISTED_SCOPES_PER_PLUGIN=256)`(对齐 PathScopeRegistry E81)、plugin key 数 `≤ MAX_PERSISTED_PLUGIN_KEYS(4096)`。读端 canonicalize 同时收口 RMW(writePluginPathScopes 读 → canonical → 写回干净)。
- **测试**: plugins-service.spec +E86×3(超长 path 读盘过滤 / 非法 key 'Bad Key' RMW 写回清理整表 / 每插件 5000 scope → 截断 256)。中和(key 守卫 `if(false)` + path-len `true` + 数量 cap 1e9)→ 3 测试失败,恢复后全量 4163 PASS。
- **沉淀**: 数据完整性族(E84 windowSeq 去重 / E85 enabled-ids canonicalize / E86 path-scopes canonicalize)—— **持久化读盘按写端同一契约 canonicalize** 是统一手法:读端过滤 → 收口所有经该读函数的 RMW 写回(无需每个写入口重复)。**共享 type guard(isIpcPathScope)加长度上限是单点强化覆盖所有调用点**。E1-E86 持续推进外部输入边界族。

## E87 — readPermissions 不校验 id/permission 枚举/decidedAt/数量,非枚举权限致渲染崩 + RMW 绕过写端上限 (P2,E85/E86 数据完整性族)

- **问题**: `electron/main/services/plugins.service.ts` 的 `readPermissions` 读 `_permissions.json` 后原样保留:plugin id 不走 isSafePluginId、decision 数无 cap、`isDecision` 只 `typeof permission==='string'`(非 PERMISSION_KEYS 枚举校验)+ `typeof decidedAt==='number'`(允许 Infinity/NaN)。非枚举 permission → renderer `PERM_LABEL_KEYS[perm]=undefined` 渲染崩;`writePluginPermissions` 的 RMW(读 readPermissions)把非法/超量记录原样写回,绕过 IPC 写端 DECISIONS_MAX/PLUGINS_MAX。
- **修复**: (1) `isDecision` 强化(单点,覆盖 readPermissions/writePluginPermissions/isPermissionRecordObject):permission 须 `PERMISSION_KEY_SET.has`(业务枚举成员)+ `Number.isFinite(decidedAt)`(同 E5)。(2) readPermissions canonicalize:key 须 isSafePluginId+len≤PLUGIN_ID_MAX、key 数 ≤MAX_PERMISSION_PLUGIN_KEYS(10000,对齐 IPC PLUGINS_MAX)、每插件 decisions slice 至 MAX_DECISIONS_PER_PLUGIN(1000,对齐 IPC DECISIONS_MAX)、pathScopes slice 至 256。读端 canonicalize 收口 writePluginPermissions RMW。
- **测试**: plugins-service.spec +E87×3(非枚举 permission 记录丢弃 / decidedAt 1e400→Infinity 丢弃 / 非法 key 丢 + decisions 1500→截断 1000)。既有 fs/network/shell + 对象形态 round-trip 测试仍绿。中和(isDecision 枚举+finite 守卫 + key 守卫 + decisions cap)→ 3 测试失败,恢复后全量 4166 PASS。
- **沉淀**: 数据完整性族(E84 windowSeq / E85 enabled-ids / E86 path-scopes / E87 permissions)读盘 canonicalize 统一手法收官。**业务枚举校验在读端是防渲染崩的关键**(写端 IPC schema 只 `z.string().max` 不 enum,读端补 PERMISSION_KEYS 成员校验防 PERM_LABEL_KEYS undefined)。**强化共享 type guard(isDecision)单点覆盖所有调用点**(同 E86 isIpcPathScope)。E1-E87 持续推进外部输入边界族。

## E88 — ThemeProvider 绕过 localStorage try/catch 兜底,storage 禁用/受限时 getItem/setItem 抛崩 renderer (P2,健壮性 / local-storage-record 同款)

- **问题**: `src/theme/ThemeProvider.tsx` 的 `readStoredMode`(:33)与 `setMode`(:82)只 `typeof globalThis.localStorage === 'undefined'` 守卫,但 `getItem`/`setItem` 在 localStorage **被禁用/损坏/受限**(SecurityError、隐私模式、QuotaExceeded)时会**抛**(不只是返 null)。`useState(readStoredMode)` 在渲染期抛 → renderer 崩;`setMode` 切换主题时抛 → 主题按钮操作中断。local-storage-record helper 已吞这类异常,但 ThemeProvider 自实现绕过了兜底。
- **修复**: readStoredMode 的 getItem 包 try/catch → 失败回退默认 'dark';setMode 的 setItem 包 try/catch → 写失败只忽略持久化,内存态(setModeState)+ DOM class(useEffect applyThemeClass)始终更新。
- **测试**: design-system/theme-provider.spec +E88×2(`vi.spyOn(Storage.prototype,'getItem')` 抛 → mount 不崩 + 兜底 dark;setItem 抛 → setMode 不崩 + resolved='light' + html.dark 移除)。中和(去两处 try/catch)→ 2 测试失败,恢复后全量 4168 PASS。
- **沉淀**: 健壮性 —— **localStorage getItem/setItem 会抛,不只返 null**:`typeof localStorage === 'undefined'` 守卫挡不住「存在但受限」(SecurityError/Quota)。自实现的 storage 访问须比照共享 helper(local-storage-record E22/E70)同样 try/catch 兜底(读失败回退默认、写失败保内存态+DOM)。**绕过共享 helper 的自实现是兜底盲区**(同 E72 recent 绕过 readRecord)。E1-E88 持续推进外部输入边界族。

## E89 — layout:write 对 dockview layout(LayoutSchema .passthrough())无序列化大小上限,可撑爆 explorer.json 致 E67 拒读 (P1,E67 对偶 / 数据完整性)

- **问题**: `electron/shared/explorer-persistence-schema.ts:31` 的 `LayoutSchema = z.object({version}).passthrough()` 对 dockview 序列化输出无大小/深度/字段上限。`layout:write`(electron/main/ipc.ts)把任意巨大 layout 合并进 explorer.json。畸形 renderer/dockview 状态可写入超大 explorer 持久化文件 → **下次 loadExplorer 命中 16MiB 上限(E67)拒读**(throw)→ 布局/窗口/会话恢复整体失效,且后续写路径在 file-mutex 内 reject = fail-closed 卡死持久化。这是 E67(读端 16MiB cap)的写端对偶缺口。
- **修复**: layout:write 写盘前对 `JSON.stringify(layout)` 做字节上限校验 `MAX_LAYOUT_BYTES=2MiB`(远小于 explorer 16MiB,确保写入后整文件仍可读),超限抛 `PAYLOAD_TOO_LARGE` → write 中止(atomicWriteJson 不执行)→ 旧 layout 原样保留。**选 write-time cap 而非 LayoutSchema refine**:refine 会令已在盘的超大 layout 整个 explorer.json safeParse 失败 → corrupt → 默认覆盖(同 E84 取舍)。
- **测试**: layout-ipc.spec +E89(layout blob >2MiB → PAYLOAD_TOO_LARGE + 旧 layout 'old-A' 保留)。中和(cap→1e9)→ E89 失败,恢复后全量 4169 PASS(`stop-hook-unknown-window` 已知 flake)。
- **沉淀**: **读端 cap 必有写端对偶**:E67 给 loadExplorer 加了 16MiB 读 cap,但写端(layout:write)无 cap 可主动写出超过读 cap 的文件 → 自锁(写得进、读不出)。写端 cap 必须严格小于读端 cap(2MiB ≪ 16MiB)留余量给文件其余部分。`.passthrough()` 无界 schema 的大小风险须在写入口按序列化字节兜底。E1-E89 持续推进外部输入边界族。

## E90 — ThemeProvider matchMedia 订阅假定 addEventListener 总存在,旧环境只有 addListener 时 mount effect 抛崩 (P2,健壮性 / E88 同文件相邻)

- **问题**: `src/theme/ThemeProvider.tsx` 的 useEffect `mql.addEventListener('change', handler)` 假定 MediaQueryList 一定有 addEventListener/removeEventListener。旧版 WebKit/Electron、受限测试环境或畸形 polyfill 只提供 `addListener/removeListener`(甚至都无)时,根 Provider 挂载 effect 抛错 → 主题系统乃至 renderer 启动链路被打断。effect 也未守 matchMedia 自身存在性(resolveSystemPreference 守了,effect 没守)。
- **修复**: effect 先守 `typeof matchMedia === 'function'`(与 resolveSystemPreference 同);再对订阅 API feature-detect:优先现代 `addEventListener('change')`,回退旧 `addListener`,两者都无则跳过订阅(cleanup 对称返回)。
- **测试**: theme-provider.spec +E90×2(`vi.spyOn(window,'matchMedia')` 返仅 addListener 的 fakeMql → mount 不崩 + 回退旧 API 订阅;返无任何订阅 API 的 fakeMql → mount 不崩 + 跳过)。中和(feature-detect → 裸 addEventListener)→ 2 测试失败,恢复后全量 4171 PASS(`stop-hook-unknown-window` 已知 flake)。
- **沉淀**: 健壮性 —— **浏览器/DOM API 的方法存在性不可假定**:MediaQueryList 订阅 API 跨环境分裂(现代 addEventListener vs 旧 addListener),根 Provider 的 mount effect 抛错会打断整个 renderer 启动,故须 feature-detect + 优雅降级。与 E88(同文件 localStorage getItem/setItem 会抛)同属「ThemeProvider 根级 effect/init 须对环境能力缺失健壮」。lint「unused eslint-disable directive」是 0-warning baseline 的一部分:`no-deprecated` 未触发时不可留无用 disable 注释。E1-E90 持续推进外部输入边界族。

## E91 — pickWindowsToRestore 不拒非安全整数 windowSeq,main/renderer 段编号认知不一致 (P2,E4/E9 安全整数族 + E84 数据完整性)

- **问题**: `electron/main/services/window-restore.service.ts:45` 的 pickWindowsToRestore 只跳过 windowSeq===0 + 重复(E84),不拒非安全整数。ExplorerSchemaV3 也只校验 `int().nonnegative()`,故畸形 explorer.json 的 `windowSeq: 9007199254740993`(>MAX_SAFE_INTEGER)能过 schema 进恢复流程。main 用此不安全 seq 创建窗口 + 注入 query,但 renderer 的 `parseInitialWindowSeq` 会把同一值判非法回退为 0 → main/renderer 对窗口段编号认知不一致 → 恢复窗口按主窗段 hydrate 或后续写入命不中自己的段。
- **修复**: pickWindowsToRestore 加 `if (!Number.isSafeInteger(entry.windowSeq)) continue` —— 启动恢复跳过不安全 seq,不传给 createMainWindow(codex「至少启动恢复应跳过」)。
- **测试**: window-restore.spec +E91(windowSeq = MAX_SAFE_INTEGER+2 → 跳过,只恢复安全 seq 段)。中和(守卫 `if(false)`)→ E91 失败,恢复后全量 4172 PASS。
- **沉淀**: 安全整数族(E4 nextWindowSeq / E9 semver 段 / E91 windowSeq 恢复)—— **`z.number().int()` 不等于 safe integer**:int() 允许 >MAX_SAFE_INTEGER 的整数,凡作为「跨进程标识符/键」的数字字段都须额外 Number.isSafeInteger 校验(否则 main/renderer 或序列化两端对同一值判定分裂)。这是 E84 windowSeq 去重的相邻缺口(去重不防越界值)。E1-E91 持续推进外部输入边界族。

## E92 — DecisionSchema.decidedAt 写端 z.number() 接受 Infinity,写读契约不对称致权限重启静默丢失 (P1,E87 读端对偶 / E4/E9 安全整数族)

- **问题**: `electron/main/ipc/plugins.ipc.ts:47` 的 `DecisionSchema.decidedAt = z.number()` 接受 Infinity/NaN。但持久化 `JSON.stringify(Infinity)=null`,且读盘层(E87 isDecision)按 `Number.isFinite` 校验丢弃该 decision → 畸形 IPC 写入让 grant/deny **本次看似成功**,重启后权限记录**静默丢失**。写端(接受 Infinity)与读端(E87 拒非有限)契约不对称。
- **修复**: `decidedAt: z.number().finite().nonnegative()`。`.finite()` 与读端 `Number.isFinite` 对齐(消不对称),`.nonnegative()` 钳住时间戳语义(更严的前门)。
- **测试**: plugins-ipc-input-limits.spec +E92×3(decidedAt=Infinity → fail / 负数 → fail / 有限非负 → ok)。中和(`.finite().nonnegative()` → `z.number()`)→ 2 cap 测试失败(有限值测试绿),恢复后全量 4175 PASS。
- **沉淀**: **写端 schema 必与读端校验对称**:E87 给读盘加了「decidedAt 须有限」,但写端 IPC schema 仍 `z.number()` → 写得进读不出(权限静默丢)。`z.number()` 接受 Infinity/NaN,凡序列化后会经 JSON(Infinity→null)+ 读端有限校验的数字字段,写端须 `.finite()`。这是 E87 读端 canonicalize 的写端对偶(同 E67↔E89 读 cap↔写 cap 对偶思路)。E1-E92 持续推进外部输入边界族。

## E93 — marketplace reviews thumbsUp 只校验 finite,接受负数/小数点赞数(显示+排序+缓存污染) (P2,E4/E9/E91 安全整数族)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:88` 的 `toNode` 把 reactions.totalCount 仅按 `number && Number.isFinite` 取 thumbsUp,未校验非负整数。畸形 GraphQL 响应可把 thumbsUp 设成负数或小数 → renderer 显示/缓存 👍-3、👍1.5 等无效点赞数,并影响「Helpful」排序;renderer 缓存校验(reviews-types.ts isValidReview)也只 `isFiniteNumber(thumbsUp)`,继续接受脏缓存。
- **修复**: (1) main toNode canonicalize:`Number.isSafeInteger(rawThumbs) && rawThumbs >= 0 ? rawThumbs : 0`。(2) renderer reviews-types isValidReview:新增 `isNonNegSafeInt` 守卫,thumbsUp 非非负安全整数 → 该 review 整条视为脏缓存(validate 返 false → cache miss → 重拉)。两端对齐。
- **测试**: security-marketplace-token-main.spec +E93(totalCount -5/1.5/3 → thumbsUp [0,0,3])+ reviews-fetcher.spec +E93(缓存 review thumbsUp -3 → cache miss 走 IPC)。中和(两端改回 finite)→ 2 测试失败,恢复后全量 4177 PASS。
- **沉淀**: 安全整数族(E4/E9/E91/E93)—— **finite ≠ 非负整数**:计数类字段(点赞/数量)`Number.isFinite` 仍放行负数/小数,须 `Number.isSafeInteger && >= 0`。**源头 canonicalize + 读缓存校验两端对齐**(同 E87/E92 写读对称思路):main 取数处归一 + renderer 缓存校验拒脏值,任一端漏则脏值经另一路径(直接 IPC 或旧缓存)仍渗入。E1-E93 持续推进外部输入边界族。

## E94 — reviews 缓存 isValidReview/isValidAggregate 只校验 finite,未校验业务值域(rating/count/avg) (P2,E93 同族延伸 / 数据完整性)

- **问题**: `src/marketplace/reviews-types.ts` 的缓存深度校验把 rating/count/avg 只当 `Number.isFinite` 校验,未要求 rating∈1..5 整数、count 非负安全整数、avg∈1..5。篡改/旧 sessionStorage 缓存可被当新鲜数据用:UI 出现 999.0 stars、负评价数、`aria-label="999 stars"` 等畸形展示,并污染「Helpful」排序/缓存续写。
- **修复**: isValidReview 的 rating 改为 `Number.isInteger && 1..5`(parseRating 的值域);isValidAggregate 的 count 改 `isNonNegSafeInt` 且 **`count === reviews.length`**(aggregate 构造不变量:count=rs.length),avg 改 `isFiniteNumber && 1..5`。非法 → 该 aggregate 校验失败 → cache miss → 重拉。
- **测试**: reviews-fetcher.spec +E94×4(rating 999 / count 不一致 / avg 9 → cache miss;合法值域 → 命中不 IPC)。**顺手修既有「sessionStorage 新鲜命中」测试的不一致 fixture**(`count:1, reviews:[]` → 补完整合法 review,因新 count===length 不变量正确地拒了旧 lazy fixture)。中和(三项改回 finite + 去 count===length)→ 3 测试失败,恢复后全量 4181 PASS。
- **沉淀**: 数据完整性 —— **「有限数」≠「业务合法值」**:rating/avg/count 各有业务值域(评分 1-5、计数非负整数、count===length 不变量),只 isFinite 放行 999/负数/不一致。缓存深度校验须按业务值域而非仅类型。**强化校验会暴露既有 lazy 测试 fixture 的不一致**(count≠length 的占位 fixture)——这正是校验生效的证明,修 fixture 使其符合真实不变量(不是放宽校验)。E1-E94 持续推进外部输入边界族。

## E95 — parseRpcMessage number id 接受 Infinity/非安全整数,JSON.stringify 序列化致响应 id ≠ 请求 id (P2,E78 + E91/E92 安全整数族)

- **问题**: `electron/main/services/mcp-host.service.ts` 的 parseRpcMessage 对 number id 仅 `typeof id === 'number'`(E78 注释甚至误判「number id 无放大风险」)。Infinity/NaN/超 MAX_SAFE_INTEGER 经 formatRpcResult/formatRpcError 的 `JSON.stringify` 会序列化成 `null` 或被舍入 → 外部 MCP client 收到的响应 id 不再等于请求 id → 请求/响应无法关联。stdio 与 HTTP 两条入口共用此 parser,都受影响。
- **修复**: parseRpcMessage 加 `if (typeof id === 'number' && !Number.isSafeInteger(id)) return null`(→ 固定 parse error)。string id 保持 E78 长度上限。
- **测试**: dispatcher.spec parseRpcMessage +E95×4(id=Infinity / >MAX_SAFE_INTEGER / 小数 → null;安全整数 → 解析成功)。中和(守卫 `if(false)`)→ 3 测试失败,恢复后全量 4185 PASS。
- **沉淀**: 安全整数族(E4/E9/E91/E92/E93/E95)—— **会被 JSON.stringify 回传的数字标识符须 Number.isSafeInteger**:Infinity→null、unsafe→舍入,使序列化往返不保值 → 跨进程/跨端 id 关联断裂。这是 E78(只管了 id 长度/回显放大,漏了 number id 的序列化保值)的相邻缺口 —— **「无放大风险」的旧注释判断是盲区(放大不是唯一风险,序列化保值同样关键)**。E1-E95 持续推进外部输入边界族。

## E96 — plugin-fs:scope-decision 裸 ipcMain.handle,requestId/decision 无校验直进 correlator.resolve (P2,IPC 入口校验族 E11/E12/E16/E31 + 错误串放大 E78)

- **问题**: `electron/main/services/plugin-fs.service.ts:678` 的 `plugin-fs:scope-decision` 是裸 `ipcMain.handle`,requestId/decision 仅 TS 类型标注、无运行时 schema 校验。畸形 renderer 可传超长 requestId 或非 `'grant'|'deny'` 值直接进 `correlator.resolve`。超长未知 requestId 被塞进 ScopeRequestTimeoutError 经 IPC reject/log/toast 链路放大;非法 decision 若命中 pending 会 resolve 成非预期值,调用方当非 grant 处理但破坏授权决策契约。
- **修复**: 入口 fail-closed 校验(同 E31 request-scope 的 fsError(BAD_INPUT) 模式)—— requestId 须非空 string 且 ≤ `MAX_REQUEST_ID_LEN(256)`,decision 须 enum `'grant'|'deny'`;非法抛 BAD_INPUT,**固定文案不把原始 requestId 拼进错误**(防 E78 式回显放大)。
- **测试**: plugin-fs-read-cap.spec +E96×4(超长 requestId → BAD_INPUT 且不回显原串 / 空 requestId → BAD_INPUT / 非法 decision → BAD_INPUT / 合法格式但未知 requestId → 非 BAD_INPUT,证明通过入口校验进 correlator)。中和(两守卫 false)→ 3 cap 测试失败,恢复后全量 4189 PASS。
- **沉淀**: IPC 入口校验族(E11/E12/E16/E17/E23/E31/E96)—— **裸 ipcMain.handle 是校验盲区**:TS 参数类型不等于运行时校验,renderer 可传任意值。凡 ipcMain.handle 收 renderer 输入都须 schema/手动校验(非空 + 长度 + 枚举),非法固定 BAD_INPUT 不回显原值(融合 E78 错误串放大防御)。E1-E96 持续推进外部输入边界族。

## E97 — plugin-fs:_register-plugin 裸接收 pluginId 直接进 IdentityRegistry,绕过 id 规则与持久化 canonicalize 前门 (P2,IPC 入口校验族 E96 + isSafePluginId 前门)

- **问题**: `electron/main/services/plugin-fs.service.ts:171` 的 `plugin-fs:_register-plugin` 裸接收 `pluginId: string` 后直接 `identityRegistry.register`,无长度/字符集校验。畸形 renderer 可注册超长/非法 pluginId,随后 request-scope/persist/broadcast 都携带该 id → 主进程 Map 长期驻留 + 路径 scope 持久化键污染 + IPC payload 放大。**它绕过了 manifest id 正则与 E86/E87 的持久化 canonicalize 前门**(install 时 id 合法,但 register 入口不校验 → 运行期可注入任意 id)。
- **修复**: 注册入口复用 `isSafePluginId`(`^[a-z0-9._-]+$` 且非 `.`/`..`)+ `MAX_PLUGIN_ID_LEN(256)`;非法固定 BAD_INPUT,不进 IdentityRegistry。复用 plugins.service 的 isSafePluginId(单一来源,与 install/manifest/E85/E86 同规则;无循环依赖)。
- **测试**: plugin-fs-read-cap.spec +E97×4(合法 id → 注册成功 / 超长>256 / 非法字符(大写空格) / 路径穿越 `..` → BAD_INPUT)。中和(校验守卫 false)→ 3 cap 测试失败(合法 id 测试绿),恢复后全量 4193 PASS。
- **沉淀**: IPC 入口校验族(E96/E97)+ **id 规则前门一致性**:isSafePluginId 是 install/manifest/持久化 canonicalize(E85/E86)共用的 id 前门,但**运行期注册入口(_register-plugin)是独立路径,漏了同一前门** → 非法 id 经此绕入污染下游所有 id-keyed 结构(IdentityRegistry/PathScopeRegistry/持久化键)。凡接收 pluginId 的入口都须过 isSafePluginId(单一来源规则复用)。E1-E97 持续推进外部输入边界族。

## E98 — parseProtocolUrl 限了 URL 总长/params 数量,但无 action/target/param 单字段长度上限 (P2,E55 字段级补强 / E78 错误串放大)

- **问题**: `src/plugins/protocol/handler.ts:62` 的 parseProtocolUrl 有 URL 总长(E55 MAX_PARSE_URL_LEN=8192)+ params 数量(256)上限,但无 action/target/param key/value 单字段长度上限。8KB 内的 `co://<8k-host>/<8k-target>?<huge-key>=<huge-value>` 会完整放进返回对象;拒绝路径又把 parsed.target/整 URL 拼进 console.warn → 日志/UI 调试输出放大,且未来非 command action 复用 parser 时继承无字段上限。
- **修复**: 字段级 cap —— action/target ≤256(超限→null)、param key ≤128 / value ≤1024(超限→跳过该 param 不进返回对象);console.warn 用 `truncForLog`(截断到 128 字符 + 标长度)只打摘要,不回显超长 url/字段。
- **测试**: protocol-url.spec +E98×4(超长 target/action → null;超长 value/key → 跳过该 param 但保留合法 param)。中和(action/target 守卫 false + param 守卫 false)→ 4 cap 测试失败,恢复后全量 4197 PASS。
- **沉淀**: 字段级 vs 整体上限 —— **总长/数量上限 ≠ 单字段上限**(同 E74「文件总大小 ≠ 单字段」/ E79「条目数 ≠ 单条大小」):8KB 总长内单字段仍可占满。解析外部 URL 的每个结构字段(action/target/param)都须各自 cap,且拒绝路径的日志须截断(融合 E78 错误串放大防御:不把超长原值拼进 console.warn)。E1-E98 持续推进外部输入边界族。

## E99 — handler.ts unsupported action 分支仍把完整 url 拼进 console.warn(E98 日志截断未传播到兄弟分支) (P2,E98 自引入连带 / 错误串放大)

- **问题**: `src/plugins/protocol/handler.ts:122` —— E98 给 invalid URL 路径加了 truncForLog,但 unsupported action 分支(`unsupported action "${action}" in ${url}`)仍把完整 `url`(可达 8KB)拼进 console.warn。合法但不支持的 `co://panel/...?<长>` 绕过 invalid 分支,在此分支完整输出 → 日志放大。这是 E98 同一「外部 URL 日志放大」修复**未传播到兄弟分支**(我自己 E98 修复的连带缺口)。
- **修复**: 该分支也改 `truncForLog(url)`(parsed.action 已被 parseProtocolUrl 截到 ≤256,url 截断)。
- **测试**: protocol-url.spec +E99(co://panel/editor?d=<4000 字符> → warn 不含完整 url、message <400 字符)。中和(truncForLog(url) → url)→ E99 失败,恢复后全量 4198 PASS。
- **沉淀**: **「修一族必 grep 所有兄弟入口」在自己刚做的修复上同样成立**:E98 在同一文件加了日志截断,但只改了 invalid 分支,漏了 unsupported-action 兄弟分支 —— codex 立刻捞出这个自引入连带缺口(与 memory 里「审计者捞自引入回归最高价值」一致)。同文件多处 console.warn 拼外部值,改一处日志截断必 grep 同文件所有 console.warn 拼 url/外部字段的点。E1-E99 持续推进外部输入边界族。

## E100 — installFromGit 安装路径不复用 ManifestSchema,与启动扫描契约不一致(安装成功但重启不可用) (P1,E74 字段上限族 / 契约对称)

- **问题**: `electron/main/services/plugins.service.ts:773` 的 installFromGit 只检查 id/name/version 是 string + id 安全,没复用 ManifestSchema 的字段长度/semver/permissions 枚举数量/main 长度等完整校验。远程仓库可安装 version 非 semver、name 近 1MiB、permissions 畸形的插件:安装 UI 显示「安装成功」,但下次扫描 listPluginDirs→parseManifest(E74 ManifestSchema)按 schema 拒载,或把超长 name/version 带进 marketplace/插件列表放大 →「安装成功但重启/刷新不可用」。
- **修复**: install 路径改用 `parseManifest(text)`(ManifestSchema.safeParse),与启动扫描同契约;失败 → BAD_MANIFEST,用 parsed data 取 id/name/version/main。**关键叠加**:ManifestSchema 的 id 正则 `^[a-z0-9._-]+$` **允许纯点段 `..`**(不挡路径穿越),故 parseManifest 之后**仍须 isSafePluginId(manifest.id)**(额外拒 `.`/`..`,install→rename 覆盖父目录的穿越向量,与 uninstall 对称)。配套:tsconfig.node.json include 加 `src/plugins/manifest.ts`(electron/main 跨 import 需在 composite 项目 file list)。
- **测试**: install-atomic-overwrite.spec +E100×3(version 非 semver / name 超长 → BAD_MANIFEST 不安装;id `..` → BAD_MANIFEST,注明 ManifestSchema 正则放行但 isSafePluginId 拦)。中和(parseManifest → 旧 typeof 检查)→ semver/name 两测失败(`..` 仍绿,因 isSafePluginId 独立保留),恢复后全量 4201 PASS。
- **沉淀**: **写入端(install)与读取端(startup scan)必须同一校验契约**(同 E87/E92 写读对称、E67/E89 读写 cap 对偶):install 用宽松 typeof、scan 用严格 ManifestSchema → 产生「装得进、载不出」的不一致态。复用 parseManifest 单一来源消契约漂移。**复用 schema 时须复核 schema 是否覆盖所有旧手动校验**:ManifestSchema 正则不挡 `..`,直接换掉 isSafePluginId 会**重新打开路径穿越**——schema 复用要叠加而非替换更严的既有守卫。E1-E100 持续推进外部输入边界族。

## E101 — createPluginsWatcher 取 manifest.id 只 typeof+非空,未复用 isSafePluginId/长度上限 (P2,E97/E100 id 前门一致性族)

- **问题**: `electron/main/services/plugins.service.ts:1006` 的 createPluginsWatcher 从 manifest 取 id 时只 `typeof m.id === 'string' && m.id.length > 0`,未复用 isSafePluginId/长度上限/parseManifest。畸形本地插件可用超长/非法 manifest.id 当 mtimes Map key,并在文件变更时经 PLUGINS_CHANGED 广播到 renderer;PluginManager 按该 id reload 找不到合法 entry,或把超长 id 带进日志/状态 → watcher Map/IPC payload 放大 + 热重载错位。
- **修复**: manifest.id 复用 `isSafePluginId(m.id) && m.id.length <= PLUGIN_ID_MAX(256)`;非法则回退**目录名**(`pluginId = id`,与 listPluginDirs 用目录名一致)而非 skip(保留 watch 能力)。
- **测试**: plugins-watcher.spec +E101×2(manifest.id 超长 / `..` → onChange 用目录名 'mydir' 而非非法 id)。中和(改回 typeof+非空)→ 2 测试失败,恢复后全量 4203 PASS。
- **沉淀**: id 前门一致性族(E97 register / E100 install / E101 watcher)—— **pluginId 进入运行期结构(IdentityRegistry / mtimes Map / 广播 / 持久化键)的每个入口都须过 isSafePluginId + 长度**。E97(register)、E100(install)、E101(watcher)是同一 id 前门的三个独立入口,逐个补齐。codex 建议的 `readPluginManifestIdentity` 共享 helper 是后续优化方向(当前三处各自复用 isSafePluginId 已消除漏洞,helper 抽取可进一步消重)。E1-E101 持续推进外部输入边界族。

## E102 — getPluginMainName 对 manifest.main 无长度上限,弱于 ManifestSchema.main.max(512) (P2,E74 字段上限族 / 契约对称)

- **问题**: `electron/main/services/plugins.service.ts:61` 的 getPluginMainName(list/install/watch 三入口共用的 main 选择器)只要求 manifest.main 非空 string,无长度上限。畸形本地/远程 manifest 可用近 1MiB 的 main 字段经 resolvePluginMainPath 的 split/resolve 放大主进程字符串处理,并拼进 install 的 BAD_MAIN 错误消息。这弱于 renderer ManifestSchema 的 `main.max(512)`(E74),且 install/list/watch 三入口与 manifest schema 不一致。
- **修复**: getPluginMainName 加 `main.length <= MAIN_NAME_MAX(512)`(对齐 ManifestSchema main.max),超长 → 退默认 `main.js`。单点修复覆盖三入口(共用 helper),同时把下游 BAD_MAIN 错误消息钳到 ≤512(无需单独截断)。
- **测试**: plugins-service.spec +E102(manifest.main = 600 字符 + 提供真实 main.js → 退默认 main.js,插件以 main.js 收入)。中和(去 length 上限)→ E102 失败(超长 main 找不到文件 → 插件被跳过),恢复后全量 4204 PASS。
- **沉淀**: 字段上限族 + 契约对称 —— **共用 helper 的字段校验须对齐 schema 上限**:getPluginMainName 是 main 选择器单一来源,但其字段校验(非空)弱于 ManifestSchema(≤512),造成主进程三入口比 renderer schema 宽松。**单点修共用 helper = 一次覆盖所有入口**(对比 E97/E100/E101 各入口逐个补 id 校验,因 id 取值未走单一 helper)。E1-E102 持续推进外部输入边界族。

## E103 — PluginDataStore/plugin-data-store JSON.stringify 当「可序列化」校验,静默改写 Infinity/undefined → 持久化静默损坏 (P1,数据完整性)

- **问题**: `src/plugins/PluginDataStore.ts:14`(renderer serializeWithinLimit)+ `electron/main/services/plugin-data-store.service.ts:96`(main save)都用 `JSON.stringify` 当「可序列化」校验。但 JSON.stringify **不抛** Infinity/NaN/undefined/function —— 它**静默改写**:NaN/Infinity→null、undefined/function/symbol 属性被丢弃(只对 BigInt/循环引用才抛)。插件 `saveData({ x: Infinity, y: undefined })` 表面保存成功、renderer cache 留原值,但重启从磁盘读到 x:null 且 y 消失 = 持久化数据静默损坏/前后不一致。
- **修复**: 新增共享 `electron/shared/assert-json-value.ts` 的 `assertJsonValue(value)` —— 递归校验:number 必须 finite,拒绝 undefined/function/symbol/bigint,数组/对象递归(深度上限 256 防爆栈)。renderer serializeWithinLimit 预检 + main save handler 兜底都复用(跨进程单一来源,renderer 不可 import main);拒绝后不写盘、不提交 cache。
- **测试**: plugin-data.spec +E103×5(Infinity/NaN/含 undefined 属性/嵌套数组内 Infinity → 抛不写;合法 JSON 安全值 → 正常往返)。中和(assertJsonValue no-op)→ 4 拒绝测试失败(合法值测试绿),恢复后全量 4209 PASS。
- **沉淀**: 数据完整性 —— **`JSON.stringify` 不是「可序列化」校验**:它对 Infinity/NaN/undefined/function 静默改写而非抛错(常见误用,代码注释甚至误写「不可序列化值在此早抛」)。要拒绝这些值须显式递归 assertJsonValue。renderer 预检 + main 兜底两端共用同一 helper(同 E73/E76 cap-joined-messages、E87/E92 写读对称思路:写入端校验须两端一致)。E1-E103 持续推进外部输入边界族。

## E104 — marketplace BRANCH_RE 允许 `..`/前导斜杠/连续斜杠,entryToManifestUrl 路径穿越 (P1,E25 字段校验强化 / 路径穿越)

- **问题**: `src/marketplace/types.ts:45` 的 `BRANCH_RE = /^[A-Za-z0-9._/-]+$/` 允许 `..`、前导/尾随 `/`、连续 `//` 等非法 Git ref/path 段。`entryToManifestUrl()` 直接把 branch 拼进 `raw.githubusercontent.com/${repo}/${branch}/manifest.json`。畸形 marketplace index 可让 `branch: "../../other/repo/main"` 通过校验 → 更新检查/manifest 拉取 URL **逃出 owner/repo/<branch>/manifest.json 结构** → 拉错 manifest、错误更新提示、安装元数据错位。
- **修复**: BRANCH_RE 改为段级 `isValidBranch(b)` —— 非空 + ≤MP_BRANCH_MAX、无前导/尾随 `/`、无连续 `//`、每段 `[A-Za-z0-9._-]+` 且非 `.`/`..`。charset 已排除控制字符且 URL-safe(无需额外 encode)。合法多段 branch(`feature/foo-bar`)仍通过。
- **测试**: marketplace.spec E25 branch 测试 +E104(`../../other/repo/main` / `..` / `a/../b` / `/main` / `main/` / `a//b` / `.` → false;`feature/foo-bar` → true)。中和(isValidBranch 改回旧 charset 正则)→ E104 失败,恢复后全量 4210 PASS。
- **沉淀**: 路径穿越 / 字段校验强化 —— **charset 正则 ≠ 路径段安全**:`[A-Za-z0-9._/-]+` 允许 `/` 和 `.` 即放行 `..`/`//` 路径穿越(同 E5/E55 教训:拼进 URL/路径的字段须段级校验而非仅 charset)。凡用户/远程提供的值拼进 URL path/文件路径,都须逐段拒 `.`/`..`/空段/前后导分隔符(与 isSafePluginId 拒 `.`/`..`、E6 stripRootPrefix 同族)。E1-E104 持续推进外部输入边界族。

## E105 — plugin MCP jsonSchema 的「JSON-serializable」校验只 JSON.stringify,静默改写致 tools/list schema 不一致 (P1,E103 同族延伸 — 复用 assertJsonValue)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:97`(renderer validateToolSpec)+ `electron/shared/plugin-mcp-schemas.ts` RegisterPayloadSchema 的 jsonSchema refine,都只用 JSON.stringify 当「JSON-serializable」校验。同 E103:Infinity/NaN→null、undefined/function 属性被丢弃(只对循环引用才抛)。插件可注册一个表面成功但对 MCP client 输出被静默改写的 inputSchema → tools/list 中 schema 与插件自认为注册的不一致 → LLM/client 按错误 schema 调 tool。
- **修复**: 两端复用 E103 的共享 `assertJsonValue`。renderer validateToolSpec:jsonSchema 须纯 JSON object(非 null/数组)+ assertJsonValue + 字节上限;main RegisterPayloadSchema 的 refine 内先 assertJsonValue 再字节上限。
- **测试**: registry.spec +E105×3(jsonSchema 含 Infinity/undefined → register reject INVALID_PARAMS 不发 IPC;数组 → reject)+ ipc-protocol.spec RegisterPayloadSchema it.each +E105×2(Infinity/undefined → fail)。中和共享 assertJsonValue(no-op)→ **9 测试同时失败**(E105 ×4 跨 renderer+main + E103 ×4 plugin-data + 1),恢复后全量 4215 PASS —— 单一来源横跨两进程两特性族最强证明。
- **沉淀**: E103(plugin data)与 E105(MCP jsonSchema)是**同一「JSON.stringify 静默改写」缺陷的两个独立入口**,共用 `electron/shared/assert-json-value.ts` 单一来源收口。**发现一个 JSON.stringify-as-validation 误用后必 grep 所有 `JSON.stringify` 当「可序列化校验」的点**(E103 找到 plugin-data 两端,E105 codex 续报 MCP jsonSchema 两端)。E1-E105 持续推进外部输入边界族。

## E106 — marketplace reviews GraphQL node/pageInfo 逐元素强转无形态守卫,单坏节点崩整次拉取 (P1,外部响应运行时守卫)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:164` 只校验 `d.nodes` 是数组,就逐元素当 GraphqlNode 传给 `toNode()`;若某 node 为 null/非对象,toNode(null) 读 `n.reactions`/`n.title` 直接抛 → 单个畸形 review 节点让**整次 reviews 拉取失败**,Marketplace 评分/评论整体不可用并退回 stale/error,而非跳过坏节点。`d.pageInfo.hasNextPage`(:169)同样未判 pageInfo 形态,畸形/缺失 pageInfo 也抛。
- **修复**: 逐节点 `if (node === null || typeof node !== 'object') continue`(坏节点跳过,toNode 内部各字段已有 typeof 守卫,非空对象即安全);pageInfo 先判 object + `hasNextPage === true` 再读,`endCursor` 须 string 否则停止翻页。
- **测试**: security-marketplace-token-main.spec +E106×2(nodes 含 null + 'not-an-object' + 1 合法 → 只返合法 1 条不整次失败;pageInfo null → 不抛返回已收集)。中和(去 node guard + pageInfo guard)→ 2 测试失败,恢复后全量 4217 PASS(`stop-hook-unknown-window` 已知 flake)。
- **沉淀**: 外部响应运行时守卫 —— **`Array.isArray(nodes)` ≠ 元素形态安全**:数组校验通过不代表每个元素是预期形态,逐元素强转 `as GraphqlNode` 是 TS 谎言,null/非对象元素在解引用处抛。外部数据数组须逐元素 typeof 守卫 + 坏元素跳过(而非整批失败);嵌套对象(pageInfo)解引用前先判形态。「一个坏社区数据不应让整个功能不可用 → 过滤而非整体拒绝」(同 E2 marketplace index 逐 entry 过滤)。E1-E106 持续推进外部输入边界族。

## E107 — marketplace REPO_RE 字符集含 '.' 放行 `../x`/`a/..` 点段,entryToGitUrl URL 归一化路径穿越 (P1,E104 同类 / 路径穿越)

- **问题**: `src/marketplace/types.ts:44` 的 `REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` 只校验 owner/name 字符集,字符集含 `.` 故放行 `../x`、`a/..`、`./x`(两段中含点段)。`entryToGitUrl()`/`entryToManifestUrl()` 直接拼 URL,WHATWG URL 把 `/../x.git` 归一化成 `/x.git` → repo 逃出预期两段 GitHub 仓库路径,clone/manifest 指向错误仓库。延续 E104 branch 同类 URL path-segment 漏洞。
- **修复**: REPO_RE → `isValidRepo(r)`:`split('/')` 须正好 2 段,每段 `[A-Za-z0-9._-]+` 且非 `.`/`..`(段级校验,与 E104 isValidBranch 同手法,共用 REPO_SEG_RE 字符集)。
- **测试**: marketplace.spec repo 测试 +E107(`../x`/`a/..`/`./x`/`x/.`/`..` → false;`owner.x/repo-y` → true)。**既有测试只覆盖 3 段 `../etc/passwd`(被 2-slash 拒),漏了 2 段 `../x`(owner='..')—— 正是 E107 真漏洞**。中和(isValidRepo 回旧 REPO_RE 正则)→ E107 失败,恢复后全量 4218 PASS。
- **沉淀**: 路径穿越族(E104 branch / E107 repo)—— **charset 正则含 `.` 即放行点段路径穿越**:`[A-Za-z0-9._-]+` 单段也匹配 `..`/`.`。凡拼进 URL/path 的多段字段都须 split 后逐段拒 `.`/`..`(charset 校验挡不住)。**既有测试覆盖 3 段穿越但漏 2 段点段** = 测试盲区(测了"段数超标"未测"段数正确但段是点段"),codex 精确捞出 2-段 owner='..' 这个变体。E1-E107 持续推进外部输入边界族。

## E108 — marketplace authorUrl 只校验长度不校验 scheme,javascript:/file: 等危险协议进 <a href> (P1,XSS/危险协议 / 外链白名单)

- **问题**: `src/marketplace/types.ts:96` 的 authorUrl 只校验 string + 长度(MP_URL_MAX),不校验 URL scheme。UI 直接渲染 `<a href={entry.authorUrl} target="_blank">`。畸形/恶意 index 可放 `javascript:`、`file:`、`smb:` 等协议 → DOM 里出现不可信可点击 URL(虽 Electron windowOpenHandler 拦一部分 OS 打开,但不应依赖拦截链,且不符合 index 数据契约)。
- **修复**: `isHttpUrl(u)`(`new URL(u)` 解析 + protocol 须 `http:`/`https:`)。isValidMarketplaceEntry 的 authorUrl 校验加 `!isHttpUrl(e.authorUrl)` → 非法 scheme/不可解析 → 该 entry 丢弃(与其它畸形字段一致;authorUrl 可选,undefined 仍合法)。
- **测试**: marketplace.spec +E108(`javascript:`/`file:`/`smb:`/非 URL → false;http/https → true;undefined → true)。中和(去 isHttpUrl)→ E108 失败,恢复后全量 4219 PASS。
- **沉淀**: 危险协议 / 外链白名单 —— **进 `<a href>`/openExternal 的 URL 须 scheme 白名单(http/https)**,长度/字符校验挡不住 `javascript:`/`file:`。不依赖下游拦截链(windowOpenHandler),在数据契约入口(isValidMarketplaceEntry)就拒。与 S6(openExternal 移除 file:)同族 —— 外部提供的 URL 字段一律 scheme 白名单。E1-E108 持续推进外部输入边界族。

## E109 — reviews review.url / author.avatarUrl 只校验 string,危险协议进 <a href>/<img src>(E108 兄弟) (P1,危险协议)

- **问题**: `src/marketplace/reviews-types.ts:64`(isValidReview)对 review.url 只校验 string,MarketplaceTab.tsx 渲染 `<a href={r.url} target="_blank">`;author.avatarUrl 同样只 string 校验,渲染 `<img src>`。畸形 GraphQL 响应或被篡改的 sessionStorage reviews 缓存可放 `javascript:`/`file:`/`smb:` 等非 http(s) URL → DOM 出现不可信可点击外链 / 危险 src,依赖 Electron 拦截链兜底。与 E108 authorUrl 同族。
- **修复**: 抽共享 `src/marketplace/url-safety.ts` 的 `isHttpUrl`(E108 的 local 实现提升为共享单一来源),types.ts(entry authorUrl)+ reviews-types.ts(review.url + avatarUrl)共用。isValidReview 的 url/avatarUrl 加 `!isHttpUrl(...)` → 非法 review 当 cache miss / 不渲染。
- **测试**: reviews-fetcher.spec +E109×2(缓存 review.url=javascript: / avatarUrl=file: → cache miss 走 IPC)。中和共享 isHttpUrl(protocol 检查 no-op)→ **E108 + E109×2 三测同时失败**(跨 types.ts + reviews-types.ts),恢复后全量 4221 PASS —— 共享单一来源证明。
- **沉淀**: 危险协议族(E108 authorUrl / E109 review.url+avatarUrl)收口到共享 `url-safety.isHttpUrl`。**发现一个 URL scheme 校验缺口后必 grep 所有进 DOM(href/src)/openExternal 的外部 URL 字段**(E108 找到 authorUrl,E109 codex 续报 reviews url/avatarUrl 同族)。E1-E109 持续推进外部输入边界族。

## E110 — marketplace entry.id 只校验非空/长度,未按 manifest id 契约 → 状态索引错配 + query 注入 (P1,契约/注入)

- **问题**: `src/marketplace/types.ts:75` isValidMarketplaceEntry 对 entry.id 只校验非空 + 长度 ≤256,**未按文档契约**(本文件顶部注释:"反 DNS 唯一 id,与 plugin manifest.id 一致")校验形态。畸形/恶意 index 可放含空格/`&`/`#`/`/`/`./..` 的 id。MarketplaceTab 用 entry.id 建安装/pending/reviews/update 状态索引(`installed.has` / `install.pending.has` / `updateByPid.get` / `reviewsByPid.get`),而真实安装结果按 manifest.id 索引 → id 不合契约时卡片状态长期错配(永久 pending/未安装);且 "See all" 链接 `discussions_q=%5B${entry.id}%5D`(MarketplaceTab.tsx:913)把 entry.id **直接插值进 query 未 encode**,畸形字符可破坏/注入查询。
- **修复**: isValidMarketplaceEntry 的 id 校验加 `isValidPluginId`(charset `/^[a-z0-9._-]+$/` + 拒 `.`/`..`),与 manifest `ManifestSchema.id` 正则 + `isSafePluginId` 的 `.`/`..` 分离检查同款契约。charset 收敛后 entry.id 即 URL/路径安全,transitively 关闭 query 注入与索引错配根因。非法 id 整条 entry 丢弃(不缓存)。
- **DEFER(架构,已标注)**: codex 建议 part 2「拉 manifest 后要求 `manifest.id === entry.id` 否则拒 entry」——属安装流运行时跨检(touches installFromGit/fetcher 网络流),非边界纯逻辑;格式校验已治本「id 不合契约」的报告主因。该等值跨检 DEFER。
- **测试**: marketplace.spec +E110(合法 `com.example.foo-bar_1` → true;空格/`&`/`#`/`/`/`../x`/大写/`[bracket]`/`.`/`..` → false)。中和 `isValidPluginId`(return true)→ E110 失败,恢复后 4222 PASS。
- **沉淀**: 外部字段被用作**索引键或拼进 URL/query** 时,凡有文档契约(注释承诺"与 X 一致")就必在数据边界按该契约校验,不能只 string+长度。entry.id 与 manifest.id 是同一 plugin-id 契约的两端(E107 repo / E108 authorUrl / E109 review.url+avatarUrl / E110 id —— marketplace entry 全字段边界族收敛)。renderer 不可 import electron/main 的 isSafePluginId,故 charset 在 types.ts 本地实现(注释指明镜像 manifest 契约,标记 drift 源)。

## E111 — reviews 缓存深度校验缺字段长度/数量上限(E57 写端截断的读端对偶) (P1,资源放大)

- **问题**: `src/marketplace/reviews-types.ts` 的 isValidReview/isValidAggregate/isValidAggregateRecord 此前只校验类型 / rating 值域(E94)/ URL scheme(E109)/ count===length(E94),**不校验字段长度与数量**。reviews 从 sessionStorage 缓存读出经 isValidAggregateRecord 校验;被篡改的缓存只要整体 < raw cap(16MiB)即可塞入超长 body/handle/url、超多 reviews 或超多 aggregate key 全部通过 → Marketplace 打开后直接渲染到 DOM → 面板卡顿/冻结。main `marketplace-reviews.service.ts`(E57)写端早已 clampStr 逐字段截断 + MAX_TOTAL_NODES,**读端(缓存校验)是缺失的对偶**。
- **修复**: isValidReview 镜像 main 上限:body ≤16384、url/avatarUrl ≤2048、handle/createdAt ≤512、pluginId ≤256、continuo/pluginVersion ≤128(`isStrMax` helper);isValidAggregate 加单插件 reviews ≤2000(对齐 MAX_TOTAL_NODES);isValidAggregateRecord 加 aggregate key 总数 ≤2000。超限当 cache miss(validate 返 false → 重拉,main 侧再 clamp)。renderer 不可 import electron/main,故本地镜像常量(注释指明对齐 main E57)。
- **测试**: reviews-fetcher.spec +E111×4(body 超 16384 / handle 超 512 / url 超 2048 / 单插件 reviews 超 2000 → 全 cache miss 走 IPC)。中和 isStrMax + reviews 数量上限 → 4 测同时失败,恢复后 4226 PASS。
- **沉淀**: **写端有逐字段截断/数量上限(E57),读端(持久化/缓存校验)必有同款上限镜像** —— 否则绕过写端的 cache-hydrate 路径让畸形数据直达 DOM。这是「读/写契约对称」族在 reviews 链路的体现(对偶于 E57 写端)。reviews-parser.ts 已镜像 body/title(E57 注释),但缓存校验 reviews-types.ts 漏镜像 → 本轮补全。marketplace 全链路边界族:E25/E104/E107(repo/branch)+ E108/E109/E110(URL/id)+ E94/E111(reviews 值域/长度数量)。

## E112 — review.author.handle 只校验 string,拼进 github.com 个人主页 + maintainer 判断 (P2,URL/身份)

- **问题**: `src/marketplace/reviews-types.ts:73` review.author.handle 此前只校验 string(+E111 长度)。MarketplaceTab.tsx:953 `href={`https://github.com/${r.author.handle}`}` 直接拼个人主页链接,且 line 937 `MAINTAINERS.has(r.author.handle)` / new-account 徽章基于同一值。畸形 GraphQL 或篡改缓存可放 `../user`(WHATWG URL 归一化指向错误账号)、`a/b`、`x?tab=repositories` 等非 GitHub login → 渲染指向错误账号/路径的可点击链接 + 错误身份徽章。**fresh-fetch 路径(parseReview→render)不经 isValidReview**,只 cache-read 经 → 须两端都修。
- **修复**: 新增 `isGitHubLogin`(导出共享):GitHub login 规则 1–39 字符、仅字母数字与单中横线、首尾非 `-`、无连续 `--`(正则 `/^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/`,收敛后即 URL/路径安全)。isValidReview(cache-read)+ parseReview(fresh-fetch)两端共用:非法 handle 跳过该 review。
- **测试**: reviews-parser.spec +E112(合法 alice/a/philip1974 → 成功;`../user`/`a/b`/`x?tab=`/`-foo`/`foo-`/`a--b`/空格/超39 → null);reviews-fetcher.spec +E112(缓存 handle=`../user` → cache miss)。中和 isGitHubLogin → parser + cache 两测同时失败(共享 helper 证明),恢复后 4229 PASS。
- **沉淀**: 外部字段拼进 URL/用作身份判断时,凡有**形态规则**(GitHub login)就按该规则校验,不止 string+长度。关键:**同一数据有 fresh-fetch 与 cache-read 两条进 DOM 路径时,校验须在两端都加**(parseReview 漏则首次拉取直达 DOM,只修 cache-read 不够)—— 与 E111 写端/读端对偶互补的「双进 DOM 路径」教训。marketplace 全字段边界族:repo/branch(E25/104/107)+ URL/id(E108/109/110)+ reviews 值域/长度数量(E94/111)+ handle login(E112)。

## E113 — review pluginId 形态不收口(body 路径无校验)+ aggregate key/pluginId 一致性缺失 (P2,标识符污染)

- **问题**: `src/marketplace/reviews-parser.ts:52` review 的 Plugin ID body section 只 `trim()` 后接受,**未复用 plugin id 形态校验**;而 title fallback(extractPluginIdFromTitle)反而有 `[a-z0-9._-]+` 约束 → **两路径不对称**。畸形 pluginId(空格 / `/` / `..` / 超长 / 大写)进 `aggregate()` 作为 byPid key → 与真实 entry.id(E110 已校验)不匹配致评分错配、污染 sessionStorage,多条畸形 review 放大 Map/JSON 写入。且 isValidReview/isValidAggregate 只校验 pluginId 长度(E111)不校验形态,isValidAggregateRecord 不校验 record key 与 aggregate.pluginId 一致性。
- **修复**: 抽共享 `src/marketplace/plugin-id.ts` 的 `isValidPluginId`(E110 的 types.ts local 提升为共享单一来源)。(1)parseReview 的 body+title 两路径统一 `isValidPluginId(pluginId)` 否则跳过;(2)isValidReview 校验 r.pluginId 形态;(3)isValidAggregate 校验 g.pluginId 形态 + **每条 review.pluginId === g.pluginId**;(4)isValidAggregateRecord 校验 **record key === agg.pluginId**(aggregate 构造时 key=pluginId=每条 review.pluginId 是不变式,亲读 reviews-fetcher.ts:88-103 确认,篡改缓存违反则拒)。
- **测试**: reviews-parser.spec +E113(合法 com.example.foo → 成功;`../bad`/`a/b`/空格/大写/`.`/`..` → null);reviews-fetcher.spec +E113×2(review.pluginId=`../x` → cache miss;record key 'p' ≠ agg.pluginId 'q' → cache miss)。中和共享 isValidPluginId → **E110(entry.id)+ E113 parser 同时失败**(跨 types.ts + reviews-parser 证明单一来源);中和一致性检查 → key 不一致测试失败(load-bearing)。恢复后 4233 PASS。
- **沉淀**: 同一形态契约(plugin id)散落多入口(entry.id / parser body / parser title / isValidReview / isValidAggregate)时,**一处发现缺口必抽共享 helper 收口全部入口**(E110 只修了 entry.id,E113 codex 续报 reviews 链路同契约其余入口未收 → 提升为共享 plugin-id.ts)。标识符用作聚合 key 时,除形态校验外还须校验 **key 与实体内 id 字段的一致性**(构造时的不变式在读端必复验,防篡改错配)。marketplace 全字段边界族至此:repo/branch(E25/104/107)+ URL/id(E108/109/110)+ reviews 值域/长度/数量(E94/111)+ handle login(E112)+ pluginId 形态/一致性(E113)。

## E114 — 全窗口 workspace drop 无文件数/路径长度上限(Terminal/Explorer drop cap 的对偶) (P2,资源放大)

- **问题**: `src/lib/window-drop.ts` 的 `pickDroppedDirectory` 对 `dataTransfer.files` **全量逐个** `getPath` + `isDir`(IPC `coApi.fs.listDir`)探测,直到找到第一个目录;`src/shell/App.tsx` 的 onDrop 同步 `hadDirectory = Array.from(dt.items).some(webkitGetAsEntry)`。两处都**无文件数/路径长度上限**。畸形/超大拖放(成千上万文件,无目录或目录在末尾)→ renderer 物化大量 File/Item 并发起成百上千次 IPC 探测 → UI 卡顿。同类 Terminal(`MAX_TERMINAL_DROP_FILES=1000`)/ Explorer(`MAX_DROP_FILE_COUNT=1000`)drop 早有数量上限,**window-drop 是缺失的对偶**。
- **修复**: window-drop 加 `MAX_DROP_FILES=1000`(对齐 Terminal/Explorer)+ `MAX_DROP_PATH_LEN=4096`(PATH_MAX 量级)。pickDroppedDirectory 最多探测 MAX_DROP_FILES 个(超出 break),超长路径不发起 isDir IPC 直接跳过;App.tsx hadDirectory 探测 `slice(0, MAX_DROP_FILES)` 上限(`.some` 短路但无目录时仍遍历全部)。
- **测试**: window-drop.spec +E114×2(MAX_DROP_FILES+1 个文件、唯一目录在 cap 之外 → null 且 isDir 调用 ≤ 上限;超长路径 >4096 → 不发起 isDir、跳过后命中下一目录)。中和 cap + 路径长度检查 → 两测同时失败,恢复后 4235 PASS。
- **沉淀**: **多个同类入口(Terminal/Explorer/window 三处 drop)做同款防御时,新增的第四入口必查是否漏了已有的 cap** —— window-drop 因「只取第一个目录」语义看似无需 cap,实则无目录/目录在末尾的畸形拖放仍逐个 IPC 放大。逐项发起 IPC/昂贵调用的循环必有迭代上限 + 单项代价前置守卫(路径长度先于 IPC)。这是「防御建了未传播到所有兄弟入口」族在 drag-drop 链路的体现。

## E115 — Explorer partitionDropItems 数量上限只在 performDrop 生效(太晚),partition 阶段无界物化 (P2,资源放大)

- **问题**: `src/panels/Explorer/drop-handlers.ts` 的 `partitionDropItems` 遍历**完整** DataTransferItemList,逐项 `webkitGetAsEntry` + `getAsFile`,把所有 File 收进数组;数量上限 `MAX_DROP_FILE_COUNT`(E41)只在后续 `performDrop`(写入侧)生效。畸形/超大拖放可在读文件前就物化巨大 File 数组 + 大量 webkitGetAsEntry → renderer 先卡顿/内存峰值。E114(window-drop)的兄弟:Terminal / window-drop 已在取路径前限数量,Explorer partition 是缺失的「cap 太晚」点。
- **修复**: 把数量上限**提前到 partition 阶段**。partition 多收 1 个 File(`files.length > MAX_DROP_FILE_COUNT` 即 break)→ 下游 performDrop 的现有 MAX_DROP_FILE_COUNT 检测仍能反馈 "too many",**无需新增返回字段/UI/i18n**;另加总扫描上限 `MAX_DROP_SCAN_ITEMS=4000`(覆盖 file/dir/string 各 kind,防超大列表在 partition 循环里 webkitGetAsEntry / skippedDirs 膨胀)。MAX_DROP_FILE_COUNT 导出供测试。常量统一上移到文件顶部(避免 use-before-define)。
- **测试**: drop-handlers.spec +E115×2(5000 文件项 → files 截断到 MAX_DROP_FILE_COUNT+1 且 getAsFile 调用数同;100000 目录项 → entryCalls/skippedDirs 远小于 N,受总扫描上限约束)。中和 partition cap → 两测同时失败,恢复后 4237 PASS。
- **沉淀**: **数量/大小上限要尽量前置到「最早物化点」而非「最终消费点」**——performDrop 的 cap 虽正确,但 partition 已先物化全部 File 数组就晚了。「多收 1 个让下游已有检测反馈 too-many」是保留既有 UX 同时前置防御的零plumbing技巧。drag-drop 三入口(Terminal/window/Explorer)逐步对齐:E114 补 window-drop,E115 把 Explorer cap 前置到 partition。

## E116 — Terminal drop 在 cap 前全量 Array.from(dataTransfer.files) 物化 FileList (P2,资源放大)

- **问题**: `src/panels/Terminal/useTerminalDragDrop.ts:87` 在数量上限生效前先 `Array.from(dataTransfer.files)` **同步全量物化** FileList(DataTransfer.files 仅事件期有效,必须同步捕获),后续循环才按 MAX_TERMINAL_DROP_FILES 跳过。昂贵的 getPathForFile IPC 此前已被循环 cap 挡住,但超大拖放仍在任何 cap 前复制完整 FileList 引用数组(N 个)+ DEV 日志读总长。drag-drop 第三兄弟:window-drop(E114)/Explorer(E115)已把数量限制前移到物化点,Terminal 是最后一个。
- **修复**: 同步捕获时即按上限截断 —— 循环只 push 到 MAX_TERMINAL_DROP_FILES + 1(多 1 个让下游 getPathForFile 循环的 cap 检测仍触发 partial_skip),不全量 Array.from;未捕获的超限数记入 `overLimitExtra` 并 seed 进 `droppedForLimit`,保证 partial_skip 计数与旧实现完全一致(外部行为不变,纯前置物化优化)。DEV 日志改读 `dataTransfer.files.length`(真总数)。
- **测试**: drag-drop.spec +E116(Proxy 计 filesProxy 的 numeric index 访问:5000 文件项 → index 读取 ≤ cap+2、远小于 N,且仍 partial_skip)。中和(还原 Array.from)→ index 读取变 N → 测试失败,恢复后 4238 PASS。**外部行为(getPathForFile cap、partial_skip 计数)旧新一致,故测试用 Proxy 探针观测内部物化界限才能 neutralize-verify**。
- **沉淀**: 纯内部优化(外部行为不变)的 neutralize-verify 须用探针(Proxy 计 index 访问)观测被改变的内部量,否则无法构造红测。「DataTransfer 仅事件期有效须同步捕获」与「不全量物化」可兼得:同步循环截断到 cap+1 + 超限数另计。drag-drop 三入口数量上限全部前移到物化点(E114 window / E115 Explorer / E116 Terminal),「cap 太晚」族收敛。

## E117 — InvokeReplySchema result 只 JSON.stringify 判大小,未 assertJsonValue(E105 兄弟入口) (P1,静默改写)

- **问题**: `electron/shared/plugin-mcp-schemas.ts:89` InvokeReplySchema 的 `ok:true.result` refine 此前只用 `JSON.stringify` 判大小/循环(E19),**未复用 assertJsonValue**。插件 MCP tool 返回 `{x: Infinity, y: undefined}` 会通过校验,但 mcp-host 转给 MCP client 时 JSON.stringify 把 Infinity/NaN→null、丢 undefined 字段 → 插件看到「调用成功」而客户端收到**损坏结果**。同文件 RegisterPayloadSchema.jsonSchema(E105)已修过这类 JSON.stringify 有损问题,reply 分支是漏掉的**兄弟入口**。
- **修复**: result refine 先 `assertJsonValue(r)` 递归拒非 JSON 安全值(non-finite number / undefined / function / symbol / bigint),再字节上限。保留既有语义:**top-level undefined = 空结果**(JSON.stringify 返 undefined)显式放行(不递归校验);非 undefined 值必须 assertJsonValue 通过。
- **测试**: ipc-protocol.spec +E117×3(result 含 Infinity/NaN → fail;嵌套 undefined 字段 → fail;top-level undefined 空结果 → 仍放行)。中和共享 assertJsonValue 的 non-finite 检查 → **E117(reply)+ E105(register)+ E103(data-store)跨 3 文件同时失败**,恢复后 4241 PASS —— 共享单一来源证明。
- **沉淀**: **JSON.stringify 不是「可序列化」校验**(静默 Infinity/NaN→null、丢 undefined/function)—— 凡跨进程/网络转发前用 stringify 判大小的入口,都须先 assertJsonValue。一处修过(E103 data-store / E105 register)必 grep 所有「stringify-as-validation」兄弟入口(E117 reply 是第三处)。这是 E103/E105 同族的延续,assertJsonValue 已成跨 3 子系统(data-store/mcp-register/mcp-reply)的共享 JSON-safe 校验单一来源。

## E118 — window-drop 调用点 Array.from(dt.files) 全量物化(E114 残留,绕过其 cap) (P2,资源放大)

- **问题**: `src/shell/App.tsx:115` 窗口级 drop 在 async IIFE 里 `{ files: Array.from(dt.files) }` **全量物化** FileList 传给 resolveDroppedWorkspace。E114 我在 pickDroppedDirectory 内部加了 MAX_DROP_FILES 探测上限 + hadDirectory `slice` 上限,**却漏了这个调用点的 Array.from** —— 超大拖放仍在进入上限逻辑前同步分配/遍历全部 File,绕过 E114 防护。且 Array.from 在 async 内访问 dt.files 有「DataTransfer 仅事件期有效」的潜在隐患。E114 残留 + E116(Terminal Array.from)同款。
- **修复**: 抽共享 helper `captureBoundedFiles(files, max)`(同步按索引最多捕获 max 个,不全量 Array.from)。App.tsx **同步**(进 async 前)`captureBoundedFiles(dt.files, MAX_DROP_FILES)` —— 既有界(对齐 pickDroppedDirectory 探测上限)又规避 dt.files 异步失效。
- **测试**: window-drop.spec +E118×2(少于 max → 全捕获;5000 文件用 Proxy 计 index 访问 → 截断到 MAX_DROP_FILES 且只读 ≤ MAX_DROP_FILES 个 index,远小于 N)。中和 captureBoundedFiles 的 max 上限 → 截断测试失败,恢复后 4243 PASS。
- **沉淀**: **「在内部函数加 cap」不等于「所有调用点都安全」—— 调用点若先全量物化再传入,内部 cap 只省了后续遍历,前置物化已放大**。修一个 cap 必 grep 该数据的所有物化点(E114 改了 pickDroppedDirectory 内部 + hadDirectory,漏了 files 调用点 → E118 补)。这是「防御未传播到所有兄弟入口」族在同一功能内部/调用点间的体现。drag-drop 物化前置上限至此覆盖:window 调用点(E118)+ window 探测(E114)+ Explorer(E115)+ Terminal(E116)。

## E119 — layout:write 对 .passthrough() layout 只 JSON.stringify 判大小,未 assertJsonValue (P1,静默改写/持久化)

- **问题**: `electron/main/ipc.ts:100` layout:write 对 `LayoutSchema`(`.passthrough()`)的 Dockview layout 只用 `JSON.stringify(layout)` 判大小(E89 MAX_LAYOUT_BYTES),**未 assertJsonValue**。renderer/dockview 状态若含 Infinity/NaN/undefined(structured-clone 经 IPC 可保留这些值),写盘时 atomicWriteJson 的 stringify 会静默改成 null / 丢字段 → 重启后 `loadExplorer` 恢复的 dock layout / 面板 params 与内存态**不一致**。E105/E117 同族(stringify-as-validation)在持久化路径的又一处。
- **修复**: 大小检查前 `assertJsonValue(layout)`(try/catch → 非 JSON 安全值抛 `BAD_INPUT`,拒写并保留旧 layout)。import 共享 assert-json-value。
- **测试**: layout-ipc.spec +E119×2(layout 含 Infinity/NaN/嵌套 undefined → BAD_INPUT 且旧 layout 保留;正常 JSON-safe layout → 仍写入)。中和 layout 的 assertJsonValue 调用 → E119 测试失败,恢复后 4245 PASS。
- **沉淀**: **持久化写盘前(atomicWriteJson)同样是 stringify,passthrough/unknown 的值若未 assertJsonValue 会静默损坏存档** —— 不止跨网络转发(E117),写盘也是。assertJsonValue 现覆盖 data-store(E103)/ mcp-register(E105)/ mcp-reply(E117)/ layout-persist(E119)四子系统。stringify-as-validation 族在「校验大小、转发、写盘」三类出口全部收口。

## E120 — mcp-host tools/call 对 undefined 结果 JSON.stringify → text:undefined 不合法 MCP content (P1,E117 配套)

- **问题**: `electron/main/services/mcp-host.service.ts:335` tools/call 把 tool result 包成 `content: [{ type:'text', text: JSON.stringify(result) }]`。E117 让 InvokeReplySchema 显式放行**顶层 undefined 作为「空结果」**,但 `JSON.stringify(undefined) === undefined`(JS 值非字符串)→ `text: undefined` → 最终 JSON-RPC 响应序列化时 text 字段被省略成 `{type:'text'}`(text 必填)→ 产出**不合法 MCP text content**,客户端解析失败/丢结果。E117 放行 undefined 的下游配套缺口(顶层 function/symbol 也会让 stringify 返 undefined)。
- **修复**: `const serialized = JSON.stringify(result); text: serialized === undefined ? '' : serialized` —— 空结果显式回退空字符串(合法 MCP content),兼顾 result=undefined 与 stringify→undefined 两种来源。
- **测试**: plugin-mcp-e2e.spec +E120(注册 run 返回 undefined 的 tool,经完整链路 registry→IPC→bridge→host,tools/call → content[0].text === '' 且 `'text' in content[0]`)。中和(还原直接 JSON.stringify)→ E120 失败,恢复后 4246 PASS。
- **沉淀**: **改了校验层的「放行规则」(E117 放行顶层 undefined)必查所有下游消费者是否能正确处理该值** —— E117 让 undefined 合法,但 host 序列化成 text 时 undefined 产出非法 content。`JSON.stringify(x)` 在 x=undefined/function/symbol 时返回 undefined(非字符串),凡把其结果直接当字符串字段用都要兜底。这是 E117 同一 session 内自引入的连带缺口(放行规则变更未传播到消费端)。

## E121 — marketplace index 缓存读端漏 MAX_INDEX_ENTRIES 数量上限(E111 读/写不对称同族) (P2,资源放大)

- **问题**: `src/marketplace/fetcher.ts:49` indexCache.validate 只 `Array.isArray(d) && d.every(isValidMarketplaceEntry)`,**漏数量上限**。网络 fresh path(line 78-79)把 index 截到 MAX_INDEX_ENTRIES(4096),但被篡改/旧版本 sessionStorage 可塞 raw cap(16MiB)内的大量合法小 entry,通过 getFresh/getStale 后直接进入过滤/排序/渲染/update-check 放大 UI 卡顿。与 E111(reviews 缓存数量上限读端缺失)完全同族。
- **修复**: indexCache.validate 加 `d.length <= MAX_INDEX_ENTRIES`(镜像 fresh path 的截断上限),超量当 cache miss(返 false → 重拉,网络侧再截)。
- **测试**: marketplace.spec +E121(seed sessionStorage 塞 MAX_INDEX_ENTRIES+1 个合法 entry → fetchMarketplaceIndex cache miss 走网络,返网络结果非超大缓存)。中和数量上限 → E121 失败,恢复后 4247 PASS。
- **沉淀**: **凡「fresh/write path 有数量/大小截断」的缓存,其 validate(read path)必镜像同款上限** —— 否则绕过 write 的 cache-hydrate(篡改/旧格式)让超量数据直达消费端。E111(reviews 数量)→ E119(layout 写盘 JSON-safe)→ E121(index 数量)是同一「读/写契约对称」族在 marketplace 三类缓存的系统性收敛。所有 createSessionCache 的 validate 都应对照其 fresh path 截断逻辑核对数量上限。

## E122 — useSettingValue hook 绕过 clampSettingNumber(getSettingValue 读路径不对称) (P1,越界值喂消费者)

- **问题**: `src/plugins/settings/values-store.ts:106` `useSettingValue(id, fallback)` hook 直接返 `s.values[id] ?? fallback`,**绕过** `getSettingValue(spec)`(E6)的 clampSettingNumber 读路径。React 消费者(useTerminal `terminal.fontSize` / CodeEditor·MilkdownEditor `editor.fontSize` / EditorPanel `autoSave.delayMs` / FolderTree `explorer.indentSize`)全走 hook → 篡改/旧版本 localStorage 的越界 number(如手改 `{"terminal.fontSize":1e100}`)或 `setValue(id, Infinity)` 写入的 in-memory 非有限值,直接喂给 xterm/CSS/autosave timer 致异常。注:JSON 落盘会把 Infinity stringify 成 null,但 **in-memory store(setValue 后)与手改的有限越界值仍可达 hook**。readStored 的 number guard 也漏 `Number.isFinite`。
- **修复**: (1)useSettingValue 对 number 值按注册 spec(`coApp.settingItems.get(id)`)clampSettingNumber,与 getSettingValue 读路径对齐;spec 未注册则原样返回(graceful)。(2)readStored valueGuard 的 number 分支加 `Number.isFinite`(拒非有限,防其它入口/未来格式)。
- **测试**: values-store.spec +E122×2(renderHook:注册 min8/max40 的 number spec,override 9999→40、0→8、Infinity→default 13;未注册 spec → 原样返回不崩)。中和 hook 的 clamp → E122 失败,恢复后 4249 PASS。
- **沉淀**: **同一持久化值有「非 hook getter(getSettingValue)」与「React hook(useSettingValue)」两条读路径时,防御性 clamp/校验必两条都加** —— E6 只给了 getSettingValue,hook 是漏的对偶(与 E112 fresh-fetch/cache-read 双路径、E118 内部 cap/调用点同构)。读/写及多读路径契约对称族延续。clampSettingNumber 单一来源被两路径共用。

## E123 — ManifestSchema.id 裸正则放行 ./..(plugin id 契约三处漂移,收口 renderer 单一来源) (P1,契约/路径穿越)

- **问题**: `src/plugins/manifest.ts:28` ManifestSchema.id 只用裸正则 `/^[a-z0-9._-]+$/`,**放行 `.`/`..`**(纯点段=路径穿越语义),与 main `isSafePluginId`(plugins.service,拒点段)、marketplace `isValidPluginId`(E110/E113,拒点段)契约**三处漂移**。手工放入本地插件目录的畸形 manifest(id=`..`)可经 renderer parseManifest 进入 PluginManager 列表,仅启用时 main `_registerPlugin` 才拒 → 出现不可正常启用/卸载、语义不一致的脏 entry。安装路径(E100)已在 parseManifest 之上叠加 isSafePluginId,但 renderer 启动扫描的 parseManifest 本身未叠。
- **修复**: 把 `src/marketplace/plugin-id.ts` 的 `isValidPluginId` **上移到 `src/plugins/plugin-id.ts`**(plugin id 是 plugins 核心概念,非 marketplace;避免 plugins→marketplace 反向层依赖),作 renderer 侧 plugin id 形态契约单一来源。ManifestSchema.id 改用 `.refine(isValidPluginId)`(charset + 拒 ./..);marketplace types/reviews-types/reviews-parser 三处 import 改指新路径。tsconfig.node.json 补 plugin-id.ts(composite,electron/main 经 manifest 可达,同 E100)。
- **测试**: plugin-manifest.spec +E123(id=`.`/`..` → SCHEMA_ERROR;`a.b`/`com.example.foo`/`a.._b` 等含点非纯点段 → 仍通过)。中和共享 isValidPluginId → **E110(marketplace)+ E113(parser)+ E123(manifest 含原大写测试)跨 3 文件失败**,恢复后 4251 PASS —— 共享单一来源证明。
- **沉淀**: **同一契约散落 N 处(zod 裸正则 / main helper / 另一 feature helper)= N 处漂移源;发现一处缺口必把所有 renderer 侧入口收口到一个 leaf 模块**(E110 抽 marketplace 局部 → E113 复用 → E123 上移到 plugins 核心并纳入 manifest)。helper 归属应放在最基础的层(plugins 核心)而非首次使用的 feature(marketplace),避免反向层依赖。main 侧 isSafePluginId 为跨进程副本(renderer 不可 import electron/main),作有注释的有意保留。

## E124 — readJsonCapped 读后才判大小 + text.length 当字节数(响应体上限可绕过/内存放大) (P1,DoS/字节语义)

- **问题**: `src/marketplace/fetcher.ts:35` readJsonCapped(+ `marketplace-reviews.service.ts` 同模式)两缺陷:(1)`await r.text()` 在大小检查**之前**就把整个 body 读入内存 —— Content-Length 缺失/伪造/chunked(预检 cl=0 放行)时超大响应已被完整读入才拒,内存/CPU 放大(DoS 面);(2)`text.length` 是 UTF-16 code unit 数**非字节**,多字节 UTF-8(CJK 3 bytes/字)响应真实字节数可远大于 text.length → 字节上限被绕过(byteLength > max 但 text.length ≤ max)。
- **修复**: 抽共享 `electron/shared/read-capped.ts` 的 `readResponseTextCapped(r, maxBytes, tooLargeError)`:Content-Length 诚实时早退;否则**流式 reader** 累计 `chunk.byteLength`,超 maxBytes 即 `cancel()` + 抛(不全读);读完整体 `TextDecoder.decode`(正确还原跨 chunk 多字节字符)。无 body stream 的环境回退 `r.text()` + `TextEncoder` 真实字节校验。renderer(fetcher)+ main(reviews.service)共用,reviews 两分支错误统一为 MARKETPLACE_RESPONSE_TOO_LARGE(与 fetcher 一致)。
- **测试**: marketplace.spec +E124×4(多字节 UTF-8 byteLength 150>100 但 text.length 50≤100 → 抛;无 Content-Length 流式累计超限 → 抛;Content-Length 预检超限 → 抛;正常小响应 → 原样返回)。中和(还原 text()+text.length)→ 多字节测试失败(精确观测字节语义修复),恢复后 4255 PASS。E65 reviews 测试改为统一 MARKETPLACE_RESPONSE_TOO_LARGE 且现经流式路径。
- **沉淀**: **「读全部再判大小」对不可信响应是反模式 —— 上限必在读取过程中流式硬截断,否则恶意/缺 Content-Length 响应已先吃满内存**。`String.length`(UTF-16 code unit)≠ 字节数,凡按「字节上限」校验文本都须用 byteLength(TextEncoder / chunk.byteLength),不能用 .length。Content-Length 是 best-effort 提示不是权威闸(可缺失/伪造)。

## E125 — *_BYTES 字符串上限用 String.length(UTF-16 code unit)当字节数,多字节绕过 (P1,字节语义/写盘放大)

- **问题**: `electron/main/ipc/fs.ipc.ts:64` writeFileInputSchema 用 `z.string().max(MAX_WRITE_BYTES)`——zod `.max()` 校验的是字符串 length(UTF-16 code unit 数),**不是字节**。含 CJK(3 bytes/字)/emoji(4 bytes/2 code unit)的内容在 `content.length ≤ 64MiB` 时真实 UTF-8 字节可达数倍,绕过写盘 backstop → 超大临时文件/fsync/IPC 内存放大。同类「.length 当字节」漂移遍及 write/persist 全家:plugin-fs.service(content)/ scoped-app(content,renderer)/ plugin-data-store.service + PluginDataStore(serialized)/ ipc.ts layout(serialized)。E124(响应体)的写盘侧对偶。
- **修复**: 抽共享 `electron/shared/utf8-byte-length.ts`(`utf8ByteLength` 全量 + `utf8BytesExceed` 带提前退出,纯 code-point 迭代 O(1) 空间,renderer+main 共用)。6 个写/持久化字节入口全部改用真实 UTF-8 字节校验:fs.ipc(refine)/ plugin-fs / scoped-app / plugin-data ×2 / layout。
- **测试**: plugin-data.spec +E125×4(helper 直测:ASCII byteLength===length;CJK 50 字=150 bytes;emoji=4 bytes;utf8BytesExceed 按字节判超限——`'中'×50` byteLength 150>100 但 length 50≤100 旧会误放行)。中和 helper 的多字节分支(每字符当 1 byte)→ CJK/emoji/exceed 3 测失败,恢复后 4259 PASS。web-compat allowlist 联动:scoped-app globalThis hit 行号 233→235(加 import+注释行)同步更新。
- **沉淀**: **`String.length` ≠ 字节数(UTF-16 code unit);凡按「字节上限」校验文本(zod .max / .length 比较)都必用真实 UTF-8 字节**(utf8ByteLength / Buffer.byteLength / TextEncoder)。E124(读响应)+ E125(写盘/持久化)合并收口 byte-vs-char 语义族。不变式:UTF-8 byteLength >= UTF-16 length(故 length>max 可 O(1) 提前判超限)。改 src/plugins 的 import/行数须同步 web-compat allowlist(行号锚)。

## E126 — utf8-byte-length helper 对 lone surrogate 误判(E125 自引入回归,字节上限再漂移) (P1,自引入)

- **问题(E125 自引入)**: `electron/shared/utf8-byte-length.ts` 的 utf8ByteLength/utf8BytesExceed 遇到**任意**高代理(0xD800-0xDBFF)就无条件 `+4 bytes` 并 `i++` 跳过下一 code unit,**未确认下一位是否低代理**。但 JS 字符串可含不成对代理:lone 高代理经 TextEncoder/fs 实际编码为 U+FFFD(3 bytes)且不消费下一字符。`'\uD800中'` 真实 6 bytes(lone 高代理 3 + 中 3),helper 却算 4 bytes(+4 跳过中)→ 严重 undercount,所有刚由 E125 收口的真实字节上限仍可被「lone 高代理 + 多字节字符」绕过。
- **修复**: 高代理分支仅在**紧跟低代理**(0xDC00-0xDFFF)时按合法 astral pair 4 bytes/跳过;否则按 lone surrogate U+FFFD 3 bytes 且不跳过(两函数同改)。与 TextEncoder 完全对齐。
- **测试**: plugin-data.spec +E126×2(8 个含 lone 高/低代理、合法 pair、混合的串逐一 `utf8ByteLength(s) === TextEncoder.encode(s).byteLength`;`'\uD800中'` 真 6 → max=5 判超限 true、max=6 false)。中和(还原无条件 +4/跳过)→ 两测失败,恢复后 4261 PASS。
- **沉淀**: **换审计者捞自引入回归是最高价值**——E125 同一 session 刚加的 helper 即被 codex 揪出代理对边界 bug(纯函数写错会让刚修的整族上限再次失效)。代理对处理必区分「合法 pair」与「lone surrogate」:lone surrogate(高/低均)→ U+FFFD(3 bytes),不可假设成对。任何手写 UTF-8 字节计数都应以 `TextEncoder.encode().byteLength` 为黄金对照做属性测试。

## E127 — mcp-stdio 行上限用 .length 当字节(E125 同族,我当时 DEFER 的入口) (P2,字节语义/输入背压)

- **问题**: `electron/main/services/mcp-stdio-server.service.ts:336` stdio JSON-RPC 单行/残行上限声明为 `MAX_STDIO_LINE_BYTES`(1MB),但实际用 `buf.length` / `line.length`(UTF-16 code unit)判断。本地 MCP stdio 客户端发 CJK/emoji 大行时,真实 UTF-8 字节可数倍超 1MB 仍放行/继续累积 → 削弱 E1 的 main 进程输入背压,超大 JSON 进 parse。**这正是 E125 我判定为「separate protocol」DEFER 的入口** —— codex 续报确认它属同族,不应豁免。
- **修复**: 改用共享 `utf8BytesExceed(buf/line, MAX_STDIO_LINE_BYTES)`(E125/E126 的真实 UTF-8 字节 helper)。
- **测试**: socket-safety.spec +E127(真实 socket:发 400k '中' = 1.2MB UTF-8 字节、length 400k ≤ 1MB、无 \n → 按字节上限 parse 错误 + 断开、工具不执行)。中和(还原 `.length` 比较)→ E127 失败(旧 length 400k ≤ 1M 放行不断开),恢复后 4262 PASS。
- **沉淀**: **审计中「同族但判定为豁免/DEFER」的入口,换审计者会复查并可能推翻** —— E125 我以「separate protocol」DEFER mcp-stdio,codex 下一轮即指出它是 byte-vs-char 同族真缺口。豁免判定要有充分理由,否则就是盲区。byte-vs-char 字节上限族至此覆盖:响应读(E124)+ 写盘/持久化 6 入口(E125)+ helper 代理对正确性(E126)+ stdio 输入背压(E127)全部收口于共享 utf8 helper。

## E128 — plugin-mcp-schemas jsonSchema/result 字节上限用 JSON.stringify().length(E125 同族漏网) (P1,字节语义)

- **问题**: `electron/shared/plugin-mcp-schemas.ts:39` RegisterPayloadSchema.jsonSchema(SCHEMA_BYTES_MAX 64KB)与 InvokeReplySchema.result(RESULT_BYTES_MAX 10MB,E117 touched)仍用 `JSON.stringify(...).length`(UTF-16 code unit)判字节上限。含大量 CJK/emoji 的 tool schema / result 在真实 UTF-8 字节超 64KB/10MB 时仍通过 → 放大 tools/list 广播、IPC、MCP HTTP/stdio 输出。E125 byte-vs-char 字节上限族在 MCP schema 的漏网点(E105/E117 同文件先前只改了 JSON-safe,未改字节语义)。
- **修复**: 两 refine 改用共享 `utf8BytesExceed(JSON.stringify(...), MAX)`(真实 UTF-8 字节)。
- **测试**: ipc-protocol.spec +E128×2(jsonSchema 含 23K '中'≈69KB 字节 length~23K≤64KB → fail;result 含 3.5M '中'≈10.5MB 字节 length~3.5M≤10MB → fail)。中和(还原 `.length`)→ 两测失败,恢复后 4264 PASS。
- **沉淀**: **修一个语义族(byte-vs-char)时,同一文件里「形似但当时只改了另一维度」的入口易漏** —— E105/E117 改了 plugin-mcp-schemas 的 JSON-safe(assertJsonValue),但字节上限维度(.length→byteLength)当时未动,E125 改写盘族也没扫到这里(它在 schema 层非写盘层)。codex 跨轮把 byte-vs-char 族扫到 MCP schema 收尾。所有 `JSON.stringify(x).length <= *_BYTES` 模式都须 grep 全仓收口(响应/写盘/持久化/MCP schema 四类已全覆盖共享 utf8 helper)。

## E129 — shell exec stdin 字节上限用 .max()/.length 当字节(E125 同族,2 入口) (P1,字节语义/输入背压)

- **问题**: `electron/main/ipc/shell.ipc.ts:33` ExecInput.input 用 `z.string().max(STDIN_MAX)`(SHELL_STDIN_MAX 语义 stdin ≤ 1MB)按 UTF-16 code unit 校验;renderer `src/plugins/scoped-app.ts:76` 同样 `opts.input.length > SHELL_STDIN_MAX`。插件传大量 CJK/emoji stdin 时真实 UTF-8 字节可数倍超 1MB 仍进 main 并写给 child stdin,无法兑现 shell 输入 backstop。E125 byte-vs-char 字节上限族的 shell-stdin 入口(codex 提到的 plugin-shell-stream 经核实无 stdin/input 参数,不在列)。
- **修复**: 两处改用共享 `utf8BytesExceed(input, SHELL_STDIN_MAX)`(shell.ipc refine + scoped-app 预检)。
- **测试**: exec-input-limits.spec +E129×2(CJK 334k 字 ≈1.002MB 字节 length 334k≤1MB → fail;CJK 100 字 → ok);scoped-app.spec +E129(scoped shell.exec 同款 CJK stdin → BAD_INPUT 且不发 IPC)。中和两处(还原 .max/.length)→ 3 测失败,恢复后 4267 PASS。web-compat allowlist 行号联动 235→237。
- **沉淀**: byte-vs-char 字节上限族在 shell-stdin 入口收口(E124 响应读 / E125 写盘 6 入口 / E126 helper 代理对 / E127 stdio 行 / E128 MCP schema / E129 shell stdin)。**所有 `z.string().max(*_BYTES)` 与 `.length > *_BYTES` 都须按真实 UTF-8 字节**——zod `.max()` 同样是 code unit 数,不是字节。codex 报告的关联入口仍须亲读核实(plugin-shell-stream 实际无 stdin 参数,未盲改)。

## E130 — PluginMcpRegistry renderer 预检 jsonSchema 字节用 .length(E128 的 renderer 侧对偶) (P1,字节语义/防放大)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:112` renderer 侧 validateToolSpec 仍用 `JSON.stringify(spec.jsonSchema).length` 校验 SCHEMA_BYTES_MAX。E128 已把 main 侧 RegisterPayloadSchema 改真实 UTF-8 字节,但 renderer **发 IPC 前预检**会误放行 CJK/emoji 大 schema → 仍先在 renderer stringify 并 structured-clone 发 IPC 到 main(main E128 才拒),违背「发 IPC 前预检防放大」契约(预检的全部意义就是不让超大 payload 进 IPC)。
- **修复**: renderer registry 改用共享 `utf8BytesExceed(serialized, SCHEMA_BYTES_MAX)`,与 main RegisterPayloadSchema 完全一致。
- **测试**: registry.spec +E130(jsonSchema 含 23K '中'≈69KB 字节 length~23K≤64KB → INVALID_PARAMS 且 registerCalls 为 0)。中和(还原 `.length`)→ E130 失败,恢复后 4268 PASS。
- **沉淀**: **同一上限有 main(权威)+ renderer(发 IPC 前预检)两道闸时,语义修复必两道都改** —— E128 修了 main schema,renderer 预检是漏的对偶(与 E122 getSettingValue/useSettingValue、E112 fresh-fetch/cache-read 双路径同构)。预检闸若比权威闸宽松就失去「防放大」意义。byte-vs-char 族七轮(E124-E130)全收口:响应读/写盘6/helper代理对/stdio行/MCP schema(main)/shell stdin/MCP schema renderer预检。

## E131 — git stderr 累积用 String(chunk)/.length(byte-vs-char + 跨 chunk 解码拆坏,E125 我 DEFER 的入口) (P2,字节语义/乱码)

- **问题**: `electron/main/services/plugins.service.ts:929` runGit 用 `stderr += String(d)` 逐 chunk 解码 + `stderr.length > MAX_GIT_STDERR_BYTES` / `slice()` 截断。两缺陷:(1)`stderr.length`(UTF-16 code unit)≠ 字节,多字节 stderr 突破 64KB 字节上限;(2)逐 chunk `String(d)` 把**跨 chunk 边界**的多字节 UTF-8 字符各自解码 → 两半都成 U+FFFD(安装失败错误载荷乱码)。**E125 我以「ASCII-dominated + 截断语义」DEFER 此入口,codex 续报(同 E127)指出 git 输出可含多字节且跨 chunk 拆坏是真问题。**
- **修复**: 抽 `electron/main/lib/byte-capped-buffer.ts` 的 `createByteCappedBuffer(maxBytes)`——累积原始 Buffer、按真实字节计数/截断,`text()` 时 `Buffer.concat(...).toString('utf8')` **整体解码**(跨 chunk 多字节正确还原)。runGit 改用之。(runGit 用 module-level `spawn`,mock 重;抽 helper 让逻辑可单测——同 E83「test-visibility reverse-decides implementation」。)
- **测试**: 新增 byte-capped-buffer.spec(README + bdd:index)×4(跨 chunk '中' 拆 [E4]/[B8 AD] → 整体 decode 还原 '中' 不乱码;多字节超字节上限按字节截断 + truncated;ASCII 正常;截断后 push 忽略)。中和(还原 String(chunk)+.length)→ 跨 chunk + 字节截断 2 测失败,恢复后 4272 PASS。
- **沉淀**: **流式逐 chunk 文本累积有双 bug:逐 chunk decode 拆坏跨界多字节(须累积 Buffer 整体 decode 或用 streaming TextDecoder)+ .length 当字节(byte-vs-char)**。E125 的「DEFER 判定」再次被换审计者推翻(E127 mcp-stdio / E131 git stderr 都是我以「ASCII/separate」豁免、codex 复查推翻)——豁免=盲区,同族入口不应凭直觉豁免。

## E132 — readGitBlob stderr 同 E131 缺陷(byte-vs-char + 逐 chunk decode);复用 E131 helper (P2,字节语义/乱码)

- **问题**: `electron/main/services/plugin-fs.service.ts:117` readGitBlob(git cat-file)的 stderr 累积与 E131 完全同构:`stderr += chunk.toString()` 逐 chunk 解码 + `stderr.length`/`slice()` 按 UTF-16 code unit 截断。GIT_BLOB_STDERR_MAX(64KB)被多字节 stderr 突破,且跨 chunk 多字节字符 toString 拆坏成乱码(拼进 ScopeError message)。E131(runGit)的兄弟入口 —— 同 session 抽出 helper 后 codex 即扫到第二处。
- **修复**: 复用 E131 的共享 `createByteCappedBuffer(GIT_BLOB_STDERR_MAX)`(累积原始 Buffer 整体解码)。stderr 累积/截断/decode 三处替换。
- **测试**: 字节/跨 chunk 正确性由 E131 的 byte-capped-buffer.spec(neutralize-verified)单一来源覆盖;readGitBlob 集成由既有 read-git-blob-bounds.spec(真 git repo:正常读 / 超 maxBytes / 不存在 sha → `git cat-file failed` 经 stderrCap.text() 拼 message)验证仍通过 → 4272 PASS。多字节 git stderr 无法用真 git 确定性触发,故不造 bespoke 集成测试,改由共享 helper 测试覆盖逻辑(诚实记录:此处无独立 neutralize 测,依赖 E131 helper 的 neutralize 证明)。
- **沉淀**: **抽出共享 helper 修一处(E131 runGit)后,必 grep 同模式的所有兄弟入口收口**(readGitBlob 是第二个 git-stderr 累积点)。helper 化的好处:第二处修复零新逻辑、零新风险,只换调用。byte-vs-char 字节语义族(E124-E132)全收口于 utf8-byte-length + byte-capped-buffer 两个共享 helper。

## E133 — MCP create_session autorun 64KB backstop 用 .length 当字节(E125 同族) (P2,字节语义/PTY 注入)

- **问题**: `electron/main/services/mcp-tools-terminal.ts:208` MCP create_session 工具入口的 autorun 64KB backstop(MCP_AUTORUN_MAX,注释明确「字节」)用 `input.autorun.length`(UTF-16 code unit)校验。外部 MCP client 可用 CJK/emoji autorun 传入真实 UTF-8 字节数倍超 64KB 并注入 PTY,绕过 intended 上限 → 更大 IPC/PTY 输入峰值。(同入口的 cwd/name/agentLabel 用 PATH_MAX/LABEL_MAX 字符上限,非字节语义,不在列。)
- **修复**: autorun 改用共享 `utf8BytesExceed(input.autorun, MCP_AUTORUN_MAX)`。
- **测试**: create-session.spec 的 E32 入参尺寸 fail-closed 参数化用例 +E133(autorun '中'×22K≈66KB 字节 length 22K≤64KB → BAD_INPUT 且不弹授权/不创建)。中和(还原 `.length`)→ E133 失败,恢复后 4273 PASS。
- **沉淀**: byte-vs-char 字节语义族延续到 MCP 工具入口的 autorun-注入-PTY 路径。**凡注释/常量名带「字节/BYTES」但实现用 `.length`/`.max()` 的上限都是缺口**——全仓 grep `*_MAX/*_BYTES` 字符串校验逐一核对(E124-E133 已覆盖响应读/写盘/持久化/MCP schema 双侧/shell stdin/stdio 行/git stderr ×2/autorun)。

## E134 — terminal drop 写入长度上限用 quote 前 path.length+3 估算,quote 膨胀可绕过 (P2,资源放大)

- **问题**: `src/panels/Terminal/useTerminalDragDrop.ts:130` drop 累计写入长度上限(MAX_TERMINAL_DROP_CHARS 1M)在 **quote 之前**用 `path.length + 3` 估算。但 POSIX/PowerShell 单引号转义把每个 `'` 展开成 `'\''`(4 字符),含大量单引号的路径 quote 后显著膨胀 → 仍可构造出远超上限的 `joinWithTrailingSpace(quoted)`,renderer 先分配超大命令行字符串再被 terminal.write 拒绝/卡顿。估算闸挡的是 raw,真正进 PTY 的是 quoted。
- **修复**: quote 后(`quotePaths`)按 **真实 quoted 长度** 逐项复核累计上限(`realLen + q.length + 1 > MAX`),超限丢弃 → cappedQuoted;空检查与 `joinWithTrailingSpace` 都用 cappedQuoted。estimate 闸保留作 raw 预过滤,真实闸在 quote 后。
- **测试**: drag-drop.spec +E134(单路径 `/Users/me/` + 300K 个 `'`:raw ~300K 过估算闸,POSIX quote 后 ~1.2M > 1M → 不 write + partial_skip:1)。中和(还原用 quoted)→ E134 失败(写出 1.2M 命令行),恢复后 4274 PASS。
- **沉淀**: **「转换前估算」的上限对会膨胀的转换(quote/encode/escape)不可靠 —— 上限必在转换后按真实输出复核**(同 E124「读后判大小」、E118「物化点」的时机原则:在最终形态处卡)。estimate 可作廉价预过滤,但权威闸必在真实输出。terminal drop 双闸:raw 数量/估算(E42/E116)+ quote 后真实长度(E134)。

## E135 — stdio NDJSON framing 逐 chunk toString() 拆坏跨包多字节字符(splitLines bug,Continuo 侧收口) (P1,数据损坏)

- **问题**: `electron/main/services/mcp-stdio-server.service.ts:332` 用外部 `@continuo-terminal/server-node` 的 `splitLines(buf, chunk)`,其实现 `buffer + chunk.toString()` 对每个 socket Buffer chunk **单独解码**。Unix socket 分包若切在 UTF-8 多字节字符中间,合法 JSON-RPC 里的中文/韩文/emoji 参数(如 send_text/tool args)被拆成两半各自解码 → U+FFFD 或 JSON.parse 失败,**数据随机损坏**。
- **修复**: Continuo 侧不改外部包,在调用点收口 —— 新增 `electron/main/lib/ndjson-line-decoder.ts` 的 `createNdjsonLineDecoder`,用 `TextDecoder({stream:true})` 跨 decode 调用缓存未完成多字节序列、正确还原后按 '\n' 分行。mcp-stdio-server 改用之(`buffered` 供 E127 字节上限背压检查);移除 splitNdjsonLines 导入与 NdjsonSplitResult 再导出(无外部消费者)。
- **测试**: 新增 ndjson-line-decoder.spec(README + bdd:index)×4(`{"q":"中"}` 在 '中' 字节中间切两 chunk → 还原 + JSON.parse 正确;emoji 逐字节拆 → 还原;多行 + \r\n 剥离 + 残行 buffered;ASCII 跨 chunk)。中和(还原 chunk.toString())→ 跨 chunk + emoji 2 测失败,恢复后 4278 PASS;既有 socket-safety(真 socket,含 E127 多字节大行)+ framing 测试无回归。
- **沉淀**: **流式协议解析(socket/stream)逐 chunk decode 文本是通病(splitLines/E131/E132 同根)——必用 `TextDecoder({stream:true})` 或累积 Buffer 整体 decode,绝不能逐 chunk toString()**。外部包(file: dep)的 bug 可在本仓调用点用替代实现收口,避免跨仓改动 + 重链(本轮审计 scope=Continuo)。E135 是 byte-vs-char/跨 chunk 解码族在 stdio 协议入口的收尾。

## E136 — assertJsonValue 接受非 plain object(Date/Map/Set/class),JSON.stringify 静默改写 (P1,E103 深化/数据变形)

- **问题**: `electron/shared/assert-json-value.ts:41` 对象分支把**任意** object 都当 JSON object 递归 Object.entries,未拒绝 Date/Map/Set/class instance/带 toJSON 的对象。这类值 assertJsonValue「校验通过」,但 JSON.stringify 静默改写:Date/带 toJSON → 字符串,Map/Set/class instance → `{}`(只剩 enumerable own props,丢失内部状态/方法)。插件 dataStore / MCP result / layout 存这类对象 → 调用方以为存的是原值,重启或客户端收到变形数据。E103/E105/E117/E119 的深化(它们覆盖 non-finite/undefined/function,但漏了「非 plain object」这一类静默改写)。
- **修复**: 对象分支先验 plain object —— `Object.getPrototypeOf(value) === Object.prototype || === null`(即 `{}` / `Object.create(null)`),否则抛 `non-plain object`。数组在前已单独处理。
- **测试**: plugin-data.spec +E136×2(write Date/Map/Set/class instance/嵌套 Date → 抛 non-plain;字面量对象 + Object.create(null) → 正常写入)。中和(移除 plain 校验)→ E136 失败,恢复后 4280 PASS;assertJsonValue 全消费者(data-store/mcp-register/mcp-reply/layout)无回归。
- **沉淀**: **「JSON 安全」校验须拒一切 JSON.stringify 会静默改写的值,不止 non-finite/undefined —— 非 plain object(Date→string、Map/Set/class→{})也是静默改写**。校验「可序列化」时只看 typeof object 不够,要看 prototype 是否 plain。assertJsonValue 历经 E103(non-finite/undefined)→ E105/E117/E119(传播到各序列化出口)→ E136(非 plain object)逐步逼近「严格 JSON 值」完整定义。

## E137 — snapshotFromStores 对 unsafe integer windowSeq 无防御(导出 API 点-of-use 兜底,E8 同族) (P1-latent,safe-integer)

- **问题**: `src/lib/persist/explorer-persist.ts:176` snapshotFromStores 对 windowSeq 无安全整数校验,`windowSeq + 1`(nextWindowSeq)对 unsafe integer(≥ 2^53)因 IEEE-754 精度会 no-op/碰撞 → 污染 nextWindowSeq 与窗口段索引(新窗复用 seq / 段匹配错乱)。
- **亲读分流(reachability)**: **当前生产路径已被 E8 守卫** —— windowSeq 来自 main-app `parseInitialWindowSeq(?windowSeq=)`(initial-workspace.ts:50,E8 已拒 unsafe → 回退 0)。故 snapshotFromStores 在生产**收不到** unsafe windowSeq。codex 报的「renderer 启动参数」路径已闭;此修为**导出 API / 未来调用点的防御性兜底**(point-of-use 单一来源该不变式,而非依赖每个调用方预校验),非当前可达 bug。诚实标记 P1-latent。
- **修复**: snapshotFromStores 入口 `const seq = Number.isSafeInteger(windowSeq) && windowSeq >= 0 ? windowSeq : PRIMARY_WINDOW_SEQ`(fail-closed 回退主窗位);段 windowSeq 与 nextWindowSeq 都用 seq。对正常(始终安全)调用为 no-op。
- **测试**: workspace-store-empty-string.spec +E137×2(unsafe `MAX_SAFE_INTEGER+2` → 段 windowSeq 回退 0、nextWindowSeq 是安全整数 1;合法 5 → 段 5、next 6)。中和(`seq = windowSeq`)→ E137 失败,恢复后 4282 PASS。
- **沉淀**: **`x + 1` / 算术对 unsafe integer 静默失真(精度碰撞),凡用作 id/seq 计数的数值都须 Number.isSafeInteger 守卫**。防御性不变式应在 point-of-use(snapshotFromStores 用 windowSeq+1 处)单一来源,而非散落各调用方(E8 守 query,但导出函数对未来调用仍须自卫)。zod `.int()` 不拒 unsafe integer(本 session 早期 safe-integer 族);此为该族在持久化 seq 计数的补强。亲读确认 reachability、诚实标 latent —— codex误报率非零,豁免/latent 判定须有亲读依据(对照 E127/E131 被推翻的「直觉豁免」,本项是「亲读确认已闭」)。

## E138 — mergeWritableIntoFull 信任 renderer writable.nextWindowSeq(E137 主进程写盘侧对偶,真可达) (P1,safe-integer/跨进程)

- **问题**: `electron/main/persistence.ts:170` `mergeWritableIntoFull()` 用 `Math.max(current?.nextWindowSeq, writable.nextWindowSeq)` 信任 renderer 经 IPC 传来的 writable.nextWindowSeq。ExplorerWritableSnapshotSchema 只校验 nonnegative int —— **zod `.int()` 不拒 unsafe integer**(本 session safe-integer 族通病)。畸形/恶意 writable snapshot 可把磁盘 nextWindowSeq 提升到 unsafe integer 并写盘;allocateWindowSeq 自愈前已写坏盘 + 污染 merge 契约。**与 E137 不同,此项真可达**:writable 是 IPC 边界输入(main 须验,不能信任 renderer;E137 只守 renderer 自己的 snapshotFromStores,不守任意 IPC writable payload)。
- **修复**: merge 时 `safeSeq(n) = Number.isSafeInteger(n) && n >= 0 ? n : 0`,对 current 与 writable 的 nextWindowSeq 都过滤,只在安全值上取 max。非法 writable 值忽略(回退 0,max 保留磁盘 current)。
- **测试**: merge-preserves-restore-all-windows.spec +E138×2(writable.nextWindowSeq = MAX_SAFE_INTEGER+2 → 忽略,保留磁盘 7;writable 安全 9 > current 2 → 取 9 不回退)。中和(还原直接 `?? 0` 取 max)→ unsafe 测试失败,恢复后 4284 PASS。
- **沉淀**: **跨进程「同一不变式」须在权威进程(main)的 IPC 入口独立校验,不能依赖发送进程(renderer)已守**(E137 renderer 守 snapshotFromStores、E138 main 守 mergeWritableIntoFull —— 双侧对偶,缺 main 侧则 renderer 绕过/篡改即破)。zod schema 校验数值须显式 `.refine(Number.isSafeInteger)`,`.int()/.nonnegative()` 都放行 unsafe integer。这是 safe-integer 族(E137/E138)在 explorer 持久化 seq 计数 renderer/main 双侧的收口。

## E139 — select setting 读路径不校验 enum,非法 stored 值喂给消费者(E122 select 侧对偶) (P2,值域)

- **问题**: `src/plugins/settings/values-store.ts` getSettingValue(E6)/useSettingValue(E122)只对 **number** setting 做 clamp,**select** setting 不校验 stored string 是否属于 spec.enum。篡改/旧 localStorage 可把 `terminal.cursorStyle` 读成任意字符串并写进 `term.options.cursorStyle`(喂给 xterm),或让其它 select 进入非法状态(UI 无选中项)。E122 修了 number 读路径净化,select 是漏的值域对偶。
- **修复**: 抽共享 `coerceSettingValue(spec, value)`(SettingItemRegistry,与 clampSettingNumber 同处):number → clamp;select(声明了 enum 时)→ 值须 ∈ enum 否则回退 default;其余原样。getSettingValue 与 useSettingValue 共用之(消除两读路径净化逻辑漂移 —— E122 教训)。无 enum 的 select(极简/测试 spec)→ 原样返回。
- **测试**: values-store.spec +E139×4(getSettingValue 非法 select → default、合法 → 保留、无 enum spec → 原样;useSettingValue hook 经注册 spec 非法 → default、合法 → 保留)。中和 coerceSettingValue 的 select 分支 → 2 测失败,恢复后 4288 PASS;number clamp(E6/E122)+ 跨窗 language + LanguageFromSettings 无回归。
- **沉淀**: **读路径净化要覆盖 spec 的所有「值域」类型,不止 number(min/max),还有 select(enum)** —— 持久化值净化是按 type 分派的完整契约,补一类(number)易漏其它(select)。两读路径(非 hook getter + React hook)的净化必共用单一来源(coerceSettingValue),否则补 select 时又要改两处、易再漂移(E122 dual-path 教训的强化)。

## E140 — assertJsonValue plain object 仍漏 symbol key / 非枚举自有属性(E136 深化) (P1,数据丢失/变形)

- **问题**: `electron/shared/assert-json-value.ts:50` E136 加了 plain-object 校验,但对 plain object 只 `Object.entries()` 遍历(仅枚举字符串键)。仍漏:(1)**symbol key** `{[Symbol()]:x}` —— Object.entries 不遍历、JSON.stringify 也静默丢 → 校验通过但该字段悄悄丢失;(2)**非枚举自有属性**(含非枚举 toJSON)—— entries/stringify 都跳过数据(「校验通过但不持久化」),非枚举 toJSON 还会改写序列化结果。
- **修复**: plain object 分支追加:`Object.getOwnPropertySymbols(value).length === 0`(无 symbol key)+ `Object.getOwnPropertyNames(obj).length === Object.keys(obj).length`(own keys 全枚举,无非枚举自有属性 —— 也涵盖非枚举 toJSON)。枚举的 toJSON 函数仍由下方递归 typeof function 拦截。
- **测试**: plugin-data.spec +E140×2(write 含 symbol key 的对象 → 抛;含非枚举自有属性 / 非枚举 toJSON 的对象 → 抛)。中和(移除两检查)→ 2 测失败,恢复后 4290 PASS;全消费者无回归。
- **沉淀**: 「JSON 安全」校验逼近完整契约历经 E103(non-finite/undefined)→ E136(非 plain object)→ E140(plain object 的 symbol key / 非枚举属性)。**`Object.entries`/`Object.keys` 只见枚举字符串键 —— 校验「stringify 忠实往返」须额外核 symbol key 与非枚举自有属性**(它们携带的数据/行为不被 stringify 忠实处理)。assertJsonValue 现为严格 JSON 值的完整守卫(跨 data-store/mcp-register/mcp-reply/layout)。

## E141 — SettingItemSpec register 不校验 string default 长度 / select default ∈ enum(E139 配套) (P2,注册校验)

- **问题**: `src/plugins/registries/SettingItemRegistry.ts:165` validateSettingItemSpec 对 text/select 的 default 只校验 `typeof === 'string'`,(1)无长度上限 → 畸形插件注册超长默认值冻结设置页;(2)不要求 select.default ∈ enum → **E139 对非法持久化值的「回退 default」仍回到非法 default**,消费者继续拿 enum 外字符串(如 xterm cursorStyle)。E139(读路径回退 default)的注册侧配套:回退目标(default)本身必须合法。
- **修复**: validateSettingItemSpec 追加:string default 长度 ≤ SI_DEFAULT_MAX(8192,abuse backstop);select 若声明 enum 则 default 必须命中 `enum[].value`(否则注册抛、不入 registry)。
- **测试**: setting-item-registry.spec(E36 块)+E141×3(超长 text default → 抛 default exceeds max length;select default 不在 enum → 抛 select default must be one of enum;select default ∈ enum → ok)。中和(移除两检查)→ 2 测失败,恢复后 4293 PASS;核心 plugin 注册(theme/language/cursorStyle default 均 ∈ enum)无回归。
- **沉淀**: **「非法值回退到 default」的净化(E139)隐含前提:default 本身合法 —— 须在注册校验处保证**(否则回退是从一个非法值到另一个非法值)。读路径净化(E139)与写入/注册校验(E141)是配套:净化的 fallback 目标必须在校验处被保证合法。settings 边界族:E6/E122(number 读 clamp)+ E139(select 读 enum)+ E141(注册 default 长度/enum)三处闭环。

## E142 — setValue 写入不按 spec 净化,超大 text 撑爆 settings 记录(E122/E139 写侧对偶) (P2,写入净化/记录损坏)

- **问题**: `src/plugins/settings/values-store.ts:62` setValue 写设置 override 时不按 live SettingItemSpec 校验值域/长度,text 值可写入任意长字符串。用户在插件贡献的 text setting 粘贴超大文本 → 进 zustand + localStorage;整份 settings 记录超 readRecord `DEFAULT_MAX_RAW_LENGTH`(1MiB)后下次启动**被当空表丢弃(所有设置丢失)**,当前会话也可能卡顿。E122/E139/E6 修了读路径净化,setValue(写)是漏的对偶。codex 亲读确认 setValue 经 main-app 暴露给插件侧 API(非仅测试),是真外部/畸形输入边界。
- **修复**: setValue 写入前按 live spec `coerceSettingValue`(number clamp / select enum)+ string 截断到 `MAX_SETTING_TEXT_LEN`(64KiB,远超真实设置文本)。spec 未注册则仅截断(graceful)。
- **测试**: values-store.spec +E142×2(超长 text → 截断 64KiB;注册 spec 经 setValue:number 9999→clamp 40、select 'evil'→default 'block'、'bar'→保留)。中和(还原 raw 写)→ 2 测失败,恢复后 4295 PASS;跨窗 sync 无回归。
- **沉淀**: **持久化值的净化须在写(setValue)与读(getSettingValue/useSettingValue)两端都做** —— 读端净化(E122/E139)只防「已存的坏值不害消费者」,但坏值仍占着 localStorage;写端净化(E142)才防坏值进入存储(尤其超大值会撑爆整份记录 raw cap 致全表丢失)。settings 边界族完整闭环:写(E142)→ 注册校验(E141 default 合法)→ 读(E6/E122/E139)三道。

## E143 — parseReview(fresh GraphQL)不校验 url/avatarUrl scheme(E109 fresh-fetch 对偶) (P2,危险协议/双进 DOM 路径)

- **问题**: `src/marketplace/reviews-parser.ts:76` fresh reviews 解析路径把 `raw.url` / `raw.author.avatarUrl` 原样写入 Review,**未做 isHttpUrl 校验**;而 cache-read 路径(isValidReview,E109)已拒危险协议。畸形 GraphQL/IPC 返回可在**首次拉取**时绕过 E109 的 http/https 白名单,直接渲染成 review 外链(`<a href>`)/ avatar(`<img src>`);同一数据落 cache 后反被判非法 → **读写契约不对称**。E112(handle 双路径)同款教训:同一数据有 fresh-fetch 与 cache-read 两条进 DOM 路径,形态/scheme 校验须两端都加。
- **修复**: parseReview 复用共享 `isHttpUrl` 校验 raw.url + raw.author.avatarUrl,非法 → 返回 null(跳过该 review),与 cache-read isValidReview 一致。
- **测试**: reviews-parser.spec +E143×3(url=javascript: → null;avatarUrl=file: → null;合法 https → 成功)。中和(移除 parseReview url 检查)→ 2 测失败,恢复后 4298 PASS。顺带把 spec 中 10 处 `url:'x'` don't-care 占位改为合法 `https://x`(url 现被校验,占位符须合法)。
- **沉淀**: **同一数据有 fresh-fetch(parseReview)与 cache-read(isValidReview)两条进 DOM 路径时,所有 scheme/形态/值域校验必两端都加**(E109 只加了 cache-read 的 url/avatarUrl scheme,fresh-fetch 是漏的对偶;E112 已同款修过 handle,E143 补 url/avatarUrl)。读写契约对称族 + 双进 DOM 路径族的交汇。改 parseReview 增校验须同步更新「url 当 don't-care 占位」的旧测试为合法值。

## E144 — parseReview fresh 路径 thumbsUp 不校验非负安全整数(E93 fresh-fetch 对偶) (P2-latent,排序污染)

- **问题**: `src/marketplace/reviews-parser.ts:96` parseReview(fresh GraphQL 解析)对 `raw.thumbsUp` 只 `?? 0`,未校验非负安全整数;而 cache-read(isValidReview,E93)与 main toNode(E93)都校验。畸形节点的负数/小数/超安全整数/非数会进 Review → helpful 排序 `b.thumbsUp - a.thumbsUp` 出 NaN/错序,UI 显示畸形点赞数。
- **亲读分流(reachability)**: production fresh 路径 reviews-fetcher → `coApi.marketplace.fetchReviews`(IPC)→ **main toNode(E93)已 canonicalize thumbsUp 为非负安全整数** → parseReview。故 parseReview 在生产收到的 thumbsUp 已被 main 守卫,**非当前可达**;此为 parseReview 自守(导出/可测函数,与 cache-read 对偶)的 defense-in-depth(诚实标 P2-latent,同 E137)。
- **修复**: parseReview 内 `typeof === 'number' && Number.isSafeInteger && >= 0 ? raw.thumbsUp : 0`(与 E93 同款),完成 fresh-vs-cache 对称。
- **测试**: reviews-parser.spec +E144×2(负数/小数/字符串/超安全整数/Infinity → 归 0;合法非负安全整数 / 缺省 → 保留/0)。中和(还原 `?? 0`)→ 测试失败,恢复后 4300 PASS。
- **沉淀**: fresh-vs-cache 校验对称族(E112 handle / E143 url-scheme / E144 thumbsUp)—— parseReview 应对每个字段自守到与 isValidReview 同等契约,即使生产路径上游(main toNode)已守。亲读确认 reachability 后诚实标 latent(对照 E127/E131「直觉豁免被推翻」,本项与 E137 同为「亲读确认上游已守」)。

## E145 — keybinding 捕获/写端不复用 HOTKEY_SHAPE_RE,可持久化永不触发的畸形 hotkey (P2,写入净化)

- **问题**: `src/plugins/keybindings/KeybindingCaptureModal.tsx:55` eventToCombo 直接 `parts.push(e.key.toLowerCase())` 拼 combo,未处理 Space(`e.key === ' '`)与主键为 `+` 等情况 → 产出注册侧 `HOTKEY_SHAPE_RE`(CommandRegistry,`/^[^+\s]+(\+[^+\s]+)*$/`)明确拒绝的畸形 hotkey:`mod+ `(含空白)/ `shift++`(空段)。compileCombo 对 '+'-split 后 trim 成空主键 → 快捷键显示异常且**永远不触发**。且 keybindings-store.setHotkey 写端只校验类型/长度,不校验形态 → 畸形 override 持久化。
- **修复**: 导出 `HOTKEY_SHAPE_RE`(单一来源,注册/捕获/写端共用)。(1)eventToCombo 产出后 `HOTKEY_SHAPE_RE.test(combo) ? combo : null`(无法表示的组合拒绝、不捕获);(2)setHotkey 写端:`'' = unbind` 放行,非空须长度 ≤256 且形态合法,否则 no-op。
- **测试**: keybinding-capture-modal.spec +E145×4(eventToCombo:Space → null、主键 '+' → null、合法 ctrl+x → 'mod+x'、纯修饰键 → null);keybindings-store.spec +E145×2(setHotkey 含空白/空段/超长 → no-op;合法/空串 unbind → 写入)。中和(还原裸 join / 去 setHotkey 校验)→ E145 失败,恢复后 4306 PASS。
- **沉淀**: **同一形态契约(HOTKEY_SHAPE_RE)有「注册(已校验)+ 用户捕获 + 写端」三入口时,捕获/写端必复用同一 regex** —— 注册侧校验不覆盖用户捕获/override 写入路径(它们绕过 register)。这是「形态契约散落多入口须收口共享」(E110/E123 plugin-id 同款)在 keybindings 的体现。捕获侧应只产出下游可解析/可触发的值(eventToCombo 是 UI→存储的转换点,须在此把关)。

## E146 — agentAuth.respond requestId 无长度上限(plugin-fs scope-decision requestId 同型缺口) (P2,IPC 资源放大)

- **问题**: `electron/main/ipc.ts:216` agentAuth.respond 的 requestId 只 `z.string().min(1)`,**无 .max**;同型的 plugin-fs scope-decision requestId 已限 ≤256(E97)。畸形/恶意 renderer 可用超长 requestId 反复触发 IPC 解析 + `pending.get(requestId)`,放大 main 内存/CPU;授权回执通道契约也与其它 requestId 通道不一致。
- **修复**: requestId 加 `.max(256)`(与 plugin-fs 同值)。超限 → safeHandle BAD_INPUT(formatZodErrorCapped E73 钳错误串,不回显原始长串)。schema 单列到 `electron/main/agent-auth-schema.ts`(不引 electron app,可被测试 import —— 直接 import ipc.ts 会触达 index.ts 的 `app.isPackaged` 在测试崩,E83 同款 harness 约束)。
- **测试**: agent-auth-respond-schema.spec(README + bdd:index)×3(合法 requestId(含 256)+ decision → ok;requestId 超 256 → fail;空 requestId / 非法 decision / 未知字段 → fail)。中和(去 .max)→ 超长测试失败,恢复后 4309 PASS。
- **沉淀**: **同型 IPC 通道(requestId 回执:plugin-fs scope-decision / agent-auth respond)的输入上限须一致** —— 一处加了(E97)另一处易漏。`z.string().min(1)` 无 max 是常见缺口,所有跨 IPC 的字符串字段都应 .max。测试可达性约束:含 `app.isPackaged` 等 electron 启动副作用的模块(ipc.ts→index.ts)不能在单测 import → 把纯 schema 抽到无副作用模块(E83「test-visibility reverse-decides implementation」复用)。

## E147 — plugin-data load/save 不校验磁盘 JSON 是 plain object,非对象致 renderer load 抛/假丢失 (P2,契约/数据假丢)

- **问题**: `electron/main/services/plugin-data-store.service.ts` plugin-data:load 对磁盘 data.json 只 `JSON.parse` 后原样返回,未校验是 plain object;plugin-data:save raw IPC 也未校验 data 形态。data.json 契约是 `{value:...}` 包装对象,但外部残留/绕过 renderer 的 raw IPC 可写入合法 JSON 但畸形形态(`null`/`"str"`/`[...]`/`42`)。renderer `IpcPluginDataStore.load` 随后 `Object.prototype.hasOwnProperty.call(data, 'value')`:对 `null` **抛 TypeError**,对非对象返 false(把已存数据当不存在 = **假丢失**),且文件不被隔离。
- **修复**: main load 解析后若非 plain object(null/数组/非对象)→ 隔离 `.corrupt` 后降级 `{}`(同 JSON 损坏路径,renderer 收到 {} 安全);main save 把 `data ?? {}` 后若非 plain object(数组/原语)→ BAD_INPUT 拒写(null/undefined 归一 {} 安全)。
- **测试**: plugin-data-corrupt-degrade.spec +E147×3(磁盘 null/字符串/数组/数字 → load {} + .corrupt 快照;save 数组/字符串/数字/bool → BAD_INPUT 不写盘;save null/undefined → 归一 {})。中和(去 load/save 两守卫)→ 3 测失败,恢复后 4312 PASS。
- **沉淀**: **「合法 JSON ≠ 符合契约形态」—— JSON.parse 成功不代表是期望的 plain object**;读端(load)与写端(save)都须校验顶层形态(非对象 → load 降级 / save 拒)。下游消费者用 `hasOwnProperty.call(x,...)` / `x[key]` 隐含 x 是对象,但 `hasOwnProperty.call(null,...)` 抛 —— 持久化读出的值进对象操作前必先验形态。读/写契约对称(load 降级 + save 拒)双侧收口。

## E148 — MCP terminal not-found 错误回显超长 session_id(外部 schema 无上限,Continuo 侧收口) (P2,错误回显放大)

- **问题**: 外部 `@continuo-terminal/protocol/src/schemas.ts:164` 多个 MCP terminal 输入 schema 的 session_id 只 `.min(1)` 无长度上限(await_stop_hook/send_input/send_text/press_key/read_output/kill/resize 同族)。畸形 MCP client 可传接近请求体上限(≤1MB,stdio E127/HTTP body cap)的超长 session_id;它在所有 not-found 路径被 Continuo 的 `ERR_TERMINAL_SESSION_NOT_FOUND(id)` **原样拼进错误消息** → 放大 JSON-RPC 错误响应 + 日志/内存。
- **修复**: schema 长度上限在外部包(跨仓不在本仓修,同 E135);Continuo 侧收口 not-found 错误回显 —— `ERR_TERMINAL_SESSION_NOT_FOUND` 单一 helper 把 id 截断到 256 + '…' 标记(覆盖所有 not-found 调用点)。超长 id 仍 not-found(不匹配任何 session),只是错误不再回显超长原串。
- **测试**: send-input.spec +E148(超长 session_id(5000)→ TERMINAL_SESSION_NOT_FOUND + 错误消息含 '…'、长度 <400、不含超长原串)。中和(还原原样回显)→ E148 失败,恢复后 4313 PASS。
- **沉淀**: **外部输入即使无法在源头(外部包 schema)限长,本仓也须在「回显/日志/错误消息」出口截断不可信原串** —— 错误消息把未净化的超长外部输入原样拼回是放大向量(同 E73/E75/E77 错误串放大族)。单一 helper(ERR_*)收口所有调用点的回显截断。外部 file: dep 的 schema 缺口在本仓消费侧收口(同 E135 splitLines / E132 readGitBlob)。

## E149 — 终端 overflow 节流 + safeTruncate 用 UTF-16 code unit 当字节(E125 同族) (P2,字节语义/输出膨胀)

- **问题**: `electron/main/services/terminal.service.ts:39` 终端 overflow 节流声称按 bytes(OVERFLOW_THRESHOLD_BYTES 2MiB/s、TRUNCATE_MAX_BYTES 64KiB),但 `bytesPerSecond += chunk.length` 与 `safeTruncate(data, maxBytes)` 的 `data.length`/`cutPoint = data.length - maxBytes` 都按 **UTF-16 code unit** 计数(chunk 是 string)。大量 CJK(3 bytes/字)/emoji 终端输出真实 UTF-8 字节数倍超阈值仍不触发 overflow,且截断保留远超 64KiB 字节 → IPC/renderer 输出膨胀、卡顿/内存峰值。
- **修复**: (1)bytesPerSecond += `utf8ByteLength(chunk)`(真实字节);(2)safeTruncate 改为按真实 UTF-8 字节从尾部累积找保留 ≤ maxBytes 字节的最早**字符边界** cutPoint(处理代理对,不拆坏多字节字符/不产 U+FFFD),再保留既有 ANSI 边界回退(防半截色码)。
- **测试**: terminal-service/helpers.spec +E149×3('中'×200 截到 60 字节 → tail byteLength ≤60、无 U+FFFD、以 '中' 起;emoji×100 截到 40 字节 → ≤40、无 U+FFFD;byteLength ≤max 多字节 → 原样)。中和(还原 char-based)→ 2 测失败,恢复后 4316 PASS。overflow 计数器修复共用 utf8ByteLength(E125/E126 已测)。
- **沉淀**: byte-vs-char 族(E124-E149)延伸到终端实时输出节流/截断。**截断多字节文本须按真实字节且保持字符边界**(byte-slice 会拆坏字符 → U+FFFD;本实现按 code point 累积字节找字符边界 cutPoint,兼顾 ANSI 边界)。凡 `*_BYTES` 阈值与 `.length` 比较/`.slice` 都须真实 UTF-8 字节(终端输出是高频路径,膨胀影响实时性)。

## E150 — stop-hook broker buffered 仅按条数封顶 + parseStopPayload 字段无上限 (P2,内存放大/字节语义)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts:333` 起。stop-hook broker 的 `buffered` 数组只按**条数**淘汰(maxEntries=500),但每条经 ingestFile 钳整文件 1MiB(MAX_HOOK_FILE_BYTES)后仍可持近 1MiB 原始 JSON → 仅按条数封顶最坏 ~500MiB 常驻;且 `parseStopPayload` 各字段(session_id/turn_id/cwd/transcript_path/last_assistant_message)解析后**无长度上限**,单字段可接近 1MiB 进 buffered / 非 raw MCP 响应 / 日志,造成放大。
- **亲读**: ingestFile 把 jsonText 整块塞 buffered;awaitNext/cleanupStale/stop 都只 splice/清空数组不计字节;parseStopPayload 直接透传字符串字段。1MiB 文件钳制是"单条上限"而非"总量上限",二者正交。
- **修复**: (1)`parseStopPayload` 加 `capStr(v, max)` —— 标识/路径字段 ≤`FIELD_MAX`(1024)、`last_assistant_message` ≤`LAST_MSG_MAX`(64KiB);(2)`BufferedEntry.byteSize` 记每条 `Buffer.byteLength(jsonText,'utf8')`;(3)新增 `bufferedBytes` 计数 + `MAX_BUFFERED_BYTES`(16MiB,可注入 `maxBufferedBytes`),与条数上限**同一 while 循环双闸 FIFO 淘汰**(`buffered.length > 1 && (length > maxEntries || bytes > maxBufferedBytes)`);(4)cleanupStale/awaitNext/stop 三处同步 `bufferedBytes -=`/置 0。FIELD_MAX/LAST_MSG_MAX/parseStopPayload/createHookFileBroker 均 export 便于直测。
- **测试**: 新增 hook-broker-field-caps/parse-stop-payload-caps.spec ×3(超 FIELD_MAX/LAST_MSG_MAX → 截断、短字段原样);await-stop-hook.spec +E150 字节淘汰(注入 maxBufferedBytes=3000 + 3 条 ~2KiB entry → 仅 1 条幸存:首 await 兑付 status:'stop',次 await 超时)。中和:去 byte 闸 → 字节淘汰测失败;去 slice → 字段截断测 ×2 失败;恢复后 4320 PASS。
- **沉淀**: 数量上限族(E26/E83/E82/E30)新维度——**"条数上限 ≠ 字节上限"**:单条有钳制不等于总量有界,持变长 payload 的缓冲须**双闸**(条数 + 总字节,同循环同 FIFO,`length>1` 保至少留 1)。字段级也要上限:文件总大小钳制不防"单字段独占近全部预算"。byte-vs-char 族(E124-E149)在缓冲计量上的延伸:计字节用 `Buffer.byteLength('utf8')` 不用 `.length`。

## E151 — await_stop_hook not-found/unknown-runner 错误回显超长 session_id(E148 兄弟入口漏网) (P2,错误回显放大)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts:812/821`。`await_stop_hook` 的 session_id 同 E148 一样只有 minLength(外部 protocol zod 跨仓 .min(1) 无上限),但 not-found(meta===null)与 unknown-runner 两处错误消息都把 `input.session_id` **原样拼进** message。E148 当时只收口了 mcp-tools-terminal 的 not-found 路径,漏了 hook-bridge 这个兄弟入口。
- **亲读**: 确认两处 `new Error(\`...${input.session_id}...\`)` 直接插值;jsonSchema 仅 `minLength:1`。畸形 MCP client 可传接近请求体上限(≤1MB)的超长 session_id → 放大 JSON-RPC error 响应 + 日志/内存。(输出 result.session_id 回显的是已存在 session 的真实 id,受终端 id 格式约束,非放大向量,不动。)
- **修复**: 把 E148 的 `SESSION_ID_ECHO_MAX`(256)+ 截断逻辑**抽到共享 helper** `electron/main/lib/session-id-echo.ts`(`truncateSessionIdForEcho`),单一来源;mcp-tools-terminal 的 `ERR_TERMINAL_SESSION_NOT_FOUND` 改调共享 helper,hook-bridge 两处错误用 `echoId = truncateSessionIdForEcho(input.session_id)` 回显。jsonSchema 维持 E148 既定做法(echo 截断是真防御;zod 跨仓不改,加 maxLength 仅咨询且易与 zod 不一致)。
- **测试**: await-stop-hook.spec +E151(超长 session_id not-found → message 含 '…'、长度 <400、不含原长串)。中和共享 helper(不截断)→ **E151 + E148 两测同时失败**(一 helper 两消费者,最强单一来源证据);恢复后 4321 PASS。
- **沉淀**: 错误回显放大族(E148/E151)——**「修一族必 grep 所有兄弟入口」**再次验证:E148 收口 terminal not-found 时漏了 hook-bridge 的同形态 not-found/unknown-runner。回显截断逻辑应一开始就抽共享 helper,而非每个文件 module-local(否则下一个兄弟入口又复制一份或漏掉)。判定放大向量要区分「错误消息插值外部输入」(真向量,截断)与「输出回显已校验的真实 id」(非向量,保契约不动)。

## E152 — extractProtocolUrl 在长度上限生效前对每个 argv 全量 new URL()/toLowerCase (P2,启动期放大)

- **问题**: `electron/main/protocol-argv.ts:18`。`extractProtocolUrl()` 遍历 argv,对每项先 `new URL(a)`(全量解析),失败分支再 `a.toLowerCase()`(整串拷贝)。深链 8KB 上限(`MAX_PROTOCOL_URL_LEN`)只在下游 `routeProtocolUrl()`(protocol-dispatch.ts:80)生效,在此**之后**。冷启动 `process.argv` 或 second-instance argv 由 OS/恶意调用方控制,畸形超长参数会在上限生效前先触发大字符串 URL 解析 + toLowerCase 拷贝 → 放大启动 CPU/内存。
- **亲读**: 确认循环内无任何长度前置守卫;`new URL` 对多 MB 串解析 + 失败 fallback 整串 toLowerCase 都是 O(n) 大拷贝。callers:index.ts:526(second-instance argv)/932(冷启动 process.argv),两处都是启动关键路径。
- **修复**: 循环内在 `new URL(a)`/`a.toLowerCase()` 之前加 `if (a.length > MAX_PROTOCOL_URL_LEN) continue;`,复用 protocol-dispatch 已导出的同一常量(单一来源,protocol-dispatch 是零 import 纯模块,安全引入)。超长串即便是合法深链也会被下游 routeProtocolUrl 拒,故跳过无功能损失。
- **测试**: protocol-argv.test +E152×2(超 MAX_PROTOCOL_URL_LEN 深链 → null 且同批合规深链仍命中;恰好 == MAX_PROTOCOL_URL_LEN 边界含等号仍命中)。中和(去 length 守卫)→ 超长测失败(合法超长 URL 被解析返回而非跳过),恢复后 4323 PASS。
- **沉淀**: 数量/长度上限族(E26/E83/E137...)新维度——**「上限要在第一个 O(n) 操作之前生效,而非下游」**:下游有 8KB cap 不代表上游解析/拷贝安全,启动期(argv 由外部控制)尤甚。凡循环内对外部输入做 `new URL`/`toLowerCase`/`JSON.parse` 等全量操作,长度门控须前置到操作之前。边界测试含等号(`> max` 跳过 ⇒ `== max` 必须保留)。

## E153 — CommandRegistry.register 只按 .length 校验,假设字段都是 string,不校验运行时类型 (P2,畸形插件输入)

- **问题**: `src/plugins/registries/CommandRegistry.ts:56`。`validateCommandSpec`(E35)只对各字段做 `.length` 上限 + hotkey 形态,假设 id/title/titleKey/category/hotkey 都是 string、fn 是 function。但 CommandSpec 来自第三方**未类型化 JS plugin**,TS 类型不构成运行时保证。畸形 spec(`id:{}`/`title:123`/`hotkey:42`/`fn:'x'`)绕过校验:`(123).length === undefined`,`undefined > max` 为 false;`hotkey:42` 经 `HOTKEY_SHAPE_RE.test(42)` 的 String 强转还能通过。后续 CommandPalette 渲染、hotkey 分发、`execute()` 调 `cmd.fn()` 按 string/function 使用 → 崩溃(`'x'()` TypeError)或注册出不可触发命令(对象当 Map key)。
- **亲读**: 确认 validateCommandSpec 全程无 typeof。对照**兄弟 registry PanelRegistry(E37)**:它已对 type/title 做 `typeof !== 'string'` + factory 做 `typeof !== 'function'` 校验 —— E37 当时给 PanelRegistry 上了完整运行时校验,E35 给 CommandRegistry 只上了长度校验,是同族漏网。另发现 PanelRegistry 的**可选 titleKey** 同样只有 length 无 typeof(`titleKey:123` 同样绕过)—— 顺手一并修。
- **修复**: CommandRegistry —— 注册边界显式校验 id/title 为非空 string、fn 为 function、可选字段(titleKey/category/categoryKey/hotkey)若存在必须是 string,length 检查前先 typeof(lenChecks 元组改 `unknown` 容纳运行时非 string),hotkey 形态校验在 typeof 之后。PanelRegistry —— 可选 titleKey 补 typeof 守卫。两处对齐为同一运行时校验强度。
- **测试**: registries.spec +E153×7(CommandRegistry:id 非串/空、title 非串/空、fn 非函数/缺失、可选字段非串、合法回归;PanelRegistry:titleKey 非串)。中和(去 typeof 守卫)→ 7 测全失败,恢复后 4330 PASS。
- **沉淀**: 「修一族必 grep 所有兄弟入口」再次命中——E37 给 PanelRegistry 上运行时类型校验时,**未同步给同族 CommandRegistry**(只上了长度)。未类型化外部输入(JS plugin 贡献项)的注册边界,**TS 类型 ≠ 运行时保证**,必须 `typeof` + 必填非空 + 函数字段 `typeof === 'function'`;`.length` 校验对非 string 是静默放行(`undefined > max` 为 false),String 强转会让数字混过 regex —— 长度/形态校验前必须先 typeof。可选字段同样需 typeof(不只必填)。

## E154 — SettingItemRegistry.register 同 E153 族:.length 校验假设字段是 string,缺 typeof (P2,畸形插件输入)

- **问题**: `src/plugins/registries/SettingItemRegistry.ts:119`。`validateSettingItemSpec`(E36/E141)对 id/category/group/groupKey/title/titleKey/description/descriptionKey/unit 只做 `.length` 上限,假设都是 string。SettingItemSpec 来自未类型化 JS plugin,畸形 spec(`id:{}`/`category:123`/`title:true`/`titleKey:{}`)绕过(`({}).length === undefined`,`undefined > max` 为 false)进 registry → 设置项排序/UI/values 写入链路出脏项、React 渲染异常,或非 string id 进 settings override 路径。enum option `labelKey` 同样只有 length 无 typeof(value/label 已有 E141 typeof)。
- **亲读**: lenChecks 循环全无 typeof;E141 已给 enum value/label、default、number 参数上了 typeof/finite,但字符串字段 lenChecks 和 labelKey 漏。与 E153(CommandRegistry)、E37(PanelRegistry)完全同族——同一轮 codex 连续报出三个 registry 的同型漏洞,印证「同族跨入口系统性漂移」。
- **修复**: 必填 id/category/title 校验非空 string;lenChecks 元组改 `unknown`,循环内先 typeof(非 string 抛 `must be a string`)再 length;enum option labelKey 补 typeof 守卫。与 E153 对齐为同一运行时校验强度。
- **测试**: setting-item-registry.spec +E154×4(必填非串/空、可选字段非串、enum labelKey 非串)。中和(去 typeof)→ 4 测全失败,恢复后 4334 PASS。
- **沉淀**: E152→E153→E154 同一 codex 审计连续三轮命中「register 边界 .length 校验缺 typeof」族(protocol-argv 不同族,registry 三个同族)。**未类型化外部输入(JS plugin 贡献项)的所有 registry register 入口都须 typeof + 必填非空**;`.length` 对非 string 静默放行是该族通用缺陷。一次修一个 registry 时应顺手 grep 全部 registry —— 本轮 codex 逐个报(CommandRegistry→SettingItemRegistry),我每次都顺手扫兄弟(E153 连带修 PanelRegistry titleKey,E154 连带修 enum labelKey)收窄复发面。codex 已亲读确认 PanelRegistry/PluginMcpRegistry/RibbonRegistry/EditorActionRegistry/SettingTabRegistry/StatusBarRegistry/ExplorerDecoratorRegistry「大多已有边界校验」。

## E155 — ExplorerContextMenuRegistry.register 可选 group 缺 typeof + 主动收口全 registry 同族 (P2,畸形插件输入/菜单崩溃)

- **问题**: `src/plugins/registries/ExplorerContextMenuRegistry.ts:76`。E48 已对必填 id/label、when/fn 上了 typeof,但**可选 group** 只做 `.length` 上限缺 typeof。`group:{}`/`group:123` 绕过(`({}).length === undefined > max` 为 false)进 registry → 打开右键菜单时 `groupPluginItems()` 把 group 当 Map key 并在排序里 `a.localeCompare(b)`,非字符串使整个菜单渲染崩溃。
- **亲读**: 确认 line 76 无 typeof。E152→E155 同一 codex 审计已连续命中 4 个 registry 的 register-typeof 漏洞(CommandRegistry/SettingItemRegistry/ExplorerContextMenu,外加我连带修的 PanelRegistry/enum labelKey)。
- **修复 + 主动收口**: ExplorerContextMenu group 加 typeof。随后**主动 grep 全部 registry**(`!== undefined && X.length >`)找同族残余,命中最后一处 `SettingTabRegistry.ts:40` 可选 titleKey 缺 typeof,一并修。审计全 9 个 registry 的 validate:CommandRegistry/PanelRegistry/SettingItemRegistry/ExplorerContextMenu/SettingTab 已全部 typeof+必填非空;EditorAction/Ribbon/StatusBar/PluginMcp 无未类型化 string 字段(icon=ReactNode,side=enum,无可选 string 漏网)。**字符串 typeof 族至此全 registry 收敛**。
- **测试**: explorer-context-menu.spec +E155×2(group 非串抛/合法回归);setting-tab-registry.spec +E155×1(titleKey 非串抛)。中和两处 typeof → 各自测失败,恢复后 4337 PASS。
- **沉淀**: 「修一族必 grep 所有兄弟入口」的**主动收口**实践——codex 逐个报(E153→E154→E155 三个 registry),我在修第三个时主动 grep 全 registry 一次性扫清同族残余(SettingTabRegistry),而非等 codex 第四次报。**可选字段是该族最易漏的位置**:必填字段往往在早期审计(E37/E40/E48)就加了 typeof,但可选 string 字段(titleKey/group/labelKey)只加了 length 上限 —— 凡 `optional !== undefined && X.length > max` 都须前置 typeof。

## E156 — SettingItemRegistry select 类型未强制 enum,可注册无控件死设置项 (P2,语义/畸形插件输入)

- **问题**: `src/plugins/registries/SettingItemRegistry.ts:147`。`type:'select'` 语义上必须带 enum(SettingItemRow 仅在 `type==='select' && spec.enum` 时渲染控件),但 validate 的 enum 校验只在 `spec.enum !== undefined` 时跑。畸形 plugin 注册 `{type:'select', default:'x'}` 无 enum → defaultOk(select→typeof string)通过 → 进 registry → 设置页显示标题但无可操作控件,且 default/值无法按枚举域校验(coerceSettingValue 的 select 分支因 enum 缺失原样放行非法值)。另:`enum` 若是非数组(如 `enum:123`)→ `(123).length` undefined 跳过 count 检查 → `for (const opt of 123)` TypeError 崩在 validate 内。
- **亲读**: 确认无「select 必带 enum」检查;enum 校验块缺 Array.isArray 守卫。E141 的「select.default ∈ enum」检查也只在 enum 存在且非空时跑,无法兜住 enum 缺失。
- **修复**: type 校验后加 `select 必须非空 enum 数组`(`!Array.isArray(spec.enum) || length===0` → 抛);enum 校验块开头加 `Array.isArray` 守卫(非数组抛 diagnostic 而非 TypeError)。
- **测试**: setting-item-registry.spec +E156×4(select 无 enum/空 enum/enum 非数组 抛、select 带 enum 回归)。**修正 2 个既有 fixture**(getByCategory + settings-search-lazy-subscribe 注册 select 无 enum,补上 enum)——旧测试钉死了「select 可无 enum」的错误契约。中和 → 3 测失败,恢复后全量 4341 PASS。
- **沉淀**: 边界审计从「字段类型/长度」深入到「**类型间语义约束**」(discriminated union:type 决定哪些字段必填)。`select` 是 tagged union 的一支,其判别式(type)与必带字段(enum)的耦合此前只在「字段存在时」校验,漏了「字段缺失」。**凡 `if (field !== undefined) { 校验 }` 的可选校验,若该 field 在某 type 下其实必填,需补一条 type→field 必填的前置断言**。修正既有 fixture 时确认是「旧测试钉死了错误的宽松契约」而非真回归(亲读 SettingItemRow 渲染确认 select 无 enum 确实无控件)。

## E157 — IPC handler 抛错 message/code 原样回传未限幅(BAD_INPUT 已限幅,不对称) (P2,错误回显放大)

- **问题**: `electron/main/safe-handle.ts:90/164`。`processIpcCall` 与 `processIpcCallWithCtx` 的 catch 块把 handler 抛出的 `Error.code`/`Error.message` 原样塞进 IpcResult 回传 renderer。BAD_INPUT(zod)路径经 `formatZodErrorCapped` 限幅,但 handler 抛错路径无限幅。任一 handler 把外部错误/超长路径/子进程 stderr 拼进 message(很常见),都会经 IPC structured-clone 把巨量字符串送回 renderer → 主/renderer 内存与 UI 放大,与 BAD_INPUT 边界不对称。
- **亲读**: 两个 process* 函数 catch 块逐字相同(`code = typeof e.code==='string' ? e.code : HANDLER_ERROR;message = typeof e.message==='string' ? e.message : String(err)`),均无 cap。
- **修复**: 抽共享 `toCappedErrorResult(err): IpcResult<never>`,对 code(`ERR_CODE_MAX=256`)/message(`ERR_MESSAGE_MAX=8192`)用 `capErrText`(超限截断 + 附 `… (+N)` 剩余长度);保留 HANDLER_ERROR 的 console.error。两个 process* catch 块都改调它(单一来源,消两份逐字重复)。
- **测试**: safe-handle.spec +E157×3(超长 message 截断到 ERR_MESSAGE_MAX+标记、超长 code 截断、正常短串原样回归)。中和 capErrText(不截断)→ 2 测失败,恢复后 4344 PASS(1 个 stop-hook-crosstalk 已知 flake 隔离重跑通过,与本改无关)。
- **沉淀**: 错误回显放大族(E73/E148/E151/E157)延伸到**通用 IPC 错误出口**——所有 handler 异常的共享回传点。限幅要覆盖**所有**回传分支(BAD_INPUT 限了,HANDLER_ERROR 漏了,是「同一出口多分支限幅不对称」)。两个逐字相同的 catch 块是隐藏的漂移源,抽共享 helper 收口。凡经 IPC structured-clone 回 renderer 的字符串(error message 尤其,常含外部输入/stderr)都须限幅。

## E158 — readFileCapped TOCTOU:stat 判大小与 readFile 读取分两次按路径解析,可绕过大小上限 (P1,内存/崩溃)

- **问题**: `electron/main/services/plugins.service.ts:141`。`readFileCapped`(E24)先 `fs.stat(path)` 判 size,再 `fs.readFile(path)` 整文件读入。两次都按**路径**独立解析:检查与读取之间文件可被替换(路径指向新 inode)或原地增长 → 绕过 manifest(1MiB)/main(8MiB)/styles(4MiB)大小上限,主进程仍整超大文件读入并经 IPC 传输 → 内存峰值/卡顿/崩溃。畸形/恶意本地插件可触发(应用启动扫描 + 插件列表刷新 + watcher + 安装路径多处调用)。
- **亲读**: 确认 stat→readFile 两步独立。多调用点(loadPluginDir/install clone/watcher 扫描)全经此 helper,单点修即全覆盖。
- **修复**: 改为单 fd:`fs.open(path,'r')` 后 `fh.stat()`(对**已打开 fd** 的 fstat,与后续 read 同一 inode,无路径二次解析)取 size 快速拒绝超限;读取经同一 fd 且 buffer 上限 `min(size,maxBytes)+1`,读后 `total > maxBytes` 兜底(防 fstat 后原地增长);finally 关 fd。读取量恒有界,消除 TOCTOU 窗口。用 fstat-size 定 buffer 而非恒 `maxBytes+1`,避免小文件也分配满额 buffer。
- **测试**: 导出 readFileCapped,plugins-service.spec +E158×6(≤max/==max/>max/稀疏超大/缺失/多字节 UTF-8)。既有 E24 listPluginDirs 超大测试继续覆盖各调用点。中和双闸(去 fstat 检查 + 去 total 兜底)→ 5 测失败,恢复后 4350 PASS。
- **沉淀**: stat-before-read 族(E18/E26/E66/E67/E68)的 TOCTOU 升级——**「先 stat(path) 判大小再 read(path)」是两次独立路径解析,本身就是 TOCTOU**:size 检查对「读取的那个 inode」不构成保证。修法是单 fd(open→fstat(fd)→read(fd) 同一 inode)+ 读取量硬有界(buffer cap + 读后复查),双闸防原地增长。凡「按属性决定是否读取」的模式,属性检查与读取必须落在同一 fd 上,且读取量独立设上限不依赖检查值。

## E159 — readMetadataCapped 同 E158 TOCTOU(E158 漏掉的兄弟入口)+ 抽共享 readFhCapped 收口 (P1,内存/崩溃)

- **问题**: `electron/main/services/plugins.service.ts:228`。`readMetadataCapped`(E68)与 E158 的 readFileCapped 是同一文件内的兄弟,**同样** `fs.stat(path)` 预检 + `fs.readFile(path)` 两次独立路径解析的 TOCTOU。_permissions.json/_path_scopes.json/_enabled.json 在检查与读取之间可被替换/增长绕过 1MiB 上限 → 整块读入 + JSON.parse;path-scopes 损坏路径还把超大 raw 写 .corrupt 放大 I/O。我修 E158 时**只改了 readFileCapped,漏了这个兄弟**。
- **亲读**: readMetadataCapped 的错误语义与 readFileCapped 不同 —— 它**透传错误**(ENOENT→调用方「缺文件=空表」;非 ENOENT/too-large→抛 → 调用方「当前态未知,绝不降级空表触发 RMW 抹其它 plugin」)。修复须保留这一契约。
- **修复**: 改单 fd(`fs.open`→`fh.stat()`→bounded read),**open 的 ENOENT/EACCES 直接透传**(不 catch),too-large 抛无 code 普通 Error(调用方走非 ENOENT→throw)。同时**抽共享 `readFhCapped(fh, sizeHint, maxBytes)`**(从已打开 fd 有界读 min(size,maxBytes)+1,返 {text,tooLarge}),readFileCapped(返 null)与 readMetadataCapped(抛错)都复用 —— 单一来源防两兄弟 TOCTOU 修法再次漂移。
- **测试**: plugins-service.spec 更新 readEnabledIds/readPermissions 的 EACCES 测试(mock `fsp.open` 替 `fsp.readFile`)+ too-large 测试(真实稀疏 truncate 替 stat mock,覆盖单 fd fstat 路径);plugins-enabled-mutate.test EACCES 改 mock open。中和 readMetadataCapped 双闸 → 2 测失败,全量 4350 PASS。
- **沉淀**: **codex 当场抓住我 E158 的兄弟入口漏网**——这正是「修一族必 grep 所有兄弟入口」反复强调却仍易漏的:我修 readFileCapped 时未 grep 同文件内 `fs.stat(...path...)` + `fs.readFile(...path...)` 的所有 stat-before-read 副本(readMetadataCapped 就在 80 行外)。**换审计者捞自引入回归/连带缺口=最高价值**(topic-54/58 同结论)。修法上抽共享 readFhCapped 收口,使「同一 TOCTOU 修复」对两个错误语义不同的消费者只有一份实现,杜绝下次再漂移。修共享 helper 改动了消费者的底层 IO API(readFile→open),须 grep 所有 mock 了 readFile/stat 的测试同步改 mock 点(open)。

## E160 — readExplorerCapped TOCTOU(stat-before-read 第三个兄弟)+ 抽共享 lib readFileCappedFd (P1,内存/崩溃)

- **问题**: `electron/main/persistence.ts:231`。`readExplorerCapped`(E67)与 E158/E159 同族:`fs.stat(path).size` 预检 + `fs.readFile(path)` 整文件,两次独立路径解析的 TOCTOU。explorer.json 在检查与读取之间可被替换/增长绕过 16MiB 上限 → 启动/窗口恢复时整块读入 + JSON.parse,损坏路径还把超大 raw 写 .corrupt 放大 I/O。
- **亲读**: 错误契约:ENOENT→null(首次启动);非 ENOENT(EACCES)→throw(当前态未知,绝不返 null 触发 `?? default` 覆盖丢 recentRoots/pinned/窗口段);too-large→throw 且不进 preserveCorrupt。
- **修复 + 跨文件收口**: 把单 fd TOCTOU-safe 读**提升为共享 lib** `electron/main/lib/read-fh-capped.ts` 的 `readFileCappedFd(filePath,maxBytes)`(open→fstat 同 inode→有界读 min(size,maxBytes)+1;open 错误透传,越限返 `{tooLarge,size}`)。**plugins.service(E158/E159 的 readFileCapped+readMetadataCapped)与 persistence(readExplorerCapped)都改用它**——之前 E159 抽的 readFhCapped 只在 plugins.service 内部,现提到 lib 让跨文件兄弟共享。各调用方按自身契约映射 tooLarge→throw/跳过、open 错误→透传/null。
- **测试**: explorer-corrupt-preserve.spec 更新 EACCES(mock `fs.open`)+ too-large(真实稀疏 truncate)测试。中和 readExplorerCapped tooLarge → 1 测失败;中和共享 readFileCappedFd 双闸 → **8 测跨 plugins+explorer 失败**(多消费者共用,最强单一来源证据)。全量 4350 PASS。
- **沉淀**: stat-before-read TOCTOU 是**跨文件的系统性族**(E158 plugins readFileCapped → E159 plugins readMetadataCapped → E160 persistence readExplorerCapped,codex 逐个揪)。剩余同族站点(尚未触及):settings.service `loadSettings`、plugin-data-store `load`、ipc/fs/read-file(带 lstat/isDirectory)、mcp-tools-hook-bridge(ingestFile + config 读,带 .corrupt/discriminated-union)——各有 corrupt-rename/cache/类型检测的 bespoke 语义,按 codex surface 逐个用共享 readFileCappedFd 收口(基础设施已就位,每站点只需映射自身错误契约)。**「先 stat(path) 再 read(path)」是该族通用反模式**:属性检查与读取须落在同一 fd(fstat+read 同 inode),读取量独立设上限。跨文件抽 lib 比每文件本地 helper 更能防同族漂移。

## E161 — plugin-data:load TOCTOU(stat-before-read 族第四站,E160 已预告)→ 用共享 readFileCappedFd 收口 (P1)

- **问题**: `electron/main/services/plugin-data-store.service.ts:64`。`plugin-data:load` 同族:`fs.stat` 判大小 + `fs.readFile` 整文件两次独立路径解析,stat 与 read 之间 data.json 可被替换/增长绕过 MAX_PLUGIN_DATA_BYTES(16MiB)→ 整块读入 + JSON.parse,损坏/非法形态路径还把超大内容写 .corrupt。E160 文档已列为待收口同族站点。
- **修复**: 改用共享 `readFileCappedFd`(E160 抽到 lib)。契约保持:open ENOENT→`{}`;非 ENOENT(EACCES)→throw(绝不静默降级 `{}` 覆盖/丢插件已存数据);too-large→`rename .corrupt` + 降级 `{}`(不整块读入、不 parse);后续 JSON.parse / 非 plain object → 写 .corrupt + `{}` 不变。
- **测试**: plugin-data-store.test 既有「load 超 16MiB → 隔离 .corrupt + {}」(真实稀疏 truncate)已覆盖 tooLarge 新路径;+E161×1(EACCES 经 mock `fsp.open` → 抛出,不降级 {})。中和 EACCES 透传(改 return {})→ 4 测失败,恢复后 4351 PASS。
- **沉淀**: stat-before-read TOCTOU 族第四站收口(E158→E159→E160→E161)。**E160 抽到 lib 的红利兑现**:本次修复只是「调用 readFileCappedFd + 映射 tooLarge→rename.corrupt / open-error→ENOENT?{}:throw」,无需重写读取逻辑。剩余同族站点:settings.service `loadSettings`(too-large→rename.corrupt+cache)、ipc/fs/read-file(lstat/isDirectory)、mcp-tools-hook-bridge(discriminated-union)。**改 readFile→open 的 IO API 变更须 grep 所有 mock readFile/stat 的测试同步改 mock open / 改真实稀疏文件**(E159/E160/E161 每次都触发测试 mock 点迁移)。

## E162 — hook-bridge ingestFile + readConfigCapped TOCTOU(stat-before-read 族第五站)→ 共享 readFileCappedFd (P1)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts:279`(ingestFile)+ `:595`(readConfigCapped)。两处同族:`stat(path).size` 预检 + `readFile(path)` 整文件,检查与读取之间 hook JSON / 配置可增长/替换绕过 MAX_HOOK_FILE_BYTES / MAX_CONFIG_FILE_BYTES → 整块读入,突破原本钳制 raw/last_assistant_message 的 1MiB 防线。
- **修复**: 两处改用共享 `readFileCappedFd`。**ingestFile**:保留 `stat` 取 `mtimeMs`(age 检查)+ 一个早期快速丢弃,但实际读取用 readFileCappedFd(同 fd fstat 权威 size 校验);tooLarge→processed+unlink 隔离(既有语义),读失败→return 重试,race 守卫(stopped/gen)在读后复查。**readConfigCapped**:整体替换,保留 discriminated union(open ENOENT→missing / 其它→read-error / tooLarge→too-large / ok)。移除现已无用的 `readFile` import。
- **测试**: await-stop-hook.spec(真实 hook 文件)+ install-stop-hook config-too-large(真实超大文件)继续覆盖 tooLarge 新路径;**EACCES 测试 mock 点从 `vi.mock('node:fs/promises').readFile` 迁到 `spyOn(node:fs.promises,'open')`** —— read-fh-capped 经 `node:fs` 的 promises(非 `node:fs/promises`),vitest 下两者是不同 namespace,module-mock 'node:fs/promises' 不命中;改 spyOn node:fs promises 与 plugins-service/explorer 的 TOCTOU 测试一致。中和共享 readFileCappedFd 双闸 → **11 测跨 5 文件失败**(install-stop-hook/plugin-data/plugins/explorer),恢复后 4351 PASS。
- **沉淀**: stat-before-read TOCTOU 族第五站收口(E158→E159→E160→E161→E162)。**ESM mock namespace 陷阱**:共享 helper 用 `import { promises as fs } from 'node:fs'`,而被测调用方原先 `import ... from 'node:fs/promises'` —— vitest 里 `vi.mock('node:fs/promises')` 不影响 `node:fs` 的 promises 对象;`spyOn(node:fs.promises, 'open')`(直接改对象)才跨 specifier 命中(因 node 里二者共享同一函数对象,但 module-namespace mock 不共享)。**抽共享 helper 时统一其 fs import specifier,并让所有相关测试 spy 同一对象**。剩余同族站点:settings.service `loadSettings`(corrupt-rename+cache)、ipc/fs/read-file(lstat/isDirectory/symlink no-follow)——待 codex surface 逐个收口。

## E163 — fs:read-file 用 lstat(no-follow)做 size cap,但 readFile 跟随 symlink → 小链接指向超大目标绕过 cap (P1)

- **问题**: `electron/main/ipc/fs/read-file.ts:14`。用 `lstat(filePath).size`(**不跟随 symlink**)做 64MiB 上限检查,但随后 `fspReadFile(filePath)` **跟随 symlink** 读目标内容。一个很小的 symlink(lstat.size ≈ 链接路径长度,远 < 64MiB)指向超大目标 → size 检查通过 → readFile 跟随读超大目标 → 主进程整块读入 + IPC 发送 OOM/卡死。stat-before-read 族的 **symlink 语义错配变体**(检查与读取走不同的 follow 语义)。
- **亲读**: lstat 用于 isDirectory 检查(no-follow,直接目录→FS_NOT_FILE)+ size。size 用 lstat 是 bug(应查跟随后的真实目标);isDirectory 用 lstat 是对的(no-follow)。
- **修复**: isDirectory 检查仍用 lstat(no-follow,保留 FS_NOT_FILE 语义)。size+读取改用共享 `readFileCappedFd`(open **跟随 symlink** → fstat 报**目标**真实大小 → 有界读 maxBytes+1),size 上限对读取的真实目标权威生效。tooLarge→FS_FILE_TOO_LARGE,open 错误→mapNodeErrnoCode。移除现已无用的 fspReadFile import。
- **测试**: fs-adapter.spec readFile +E163×2(symlink→超大目标(稀疏 truncate)→ FS_FILE_TOO_LARGE;symlink→小文件 → 正常读回);既有 E18(直接超大)+ FS_NOT_FILE(直接目录)继续覆盖。中和共享 readFileCappedFd 双闸 → E163 + E18 + 11 跨消费者共 13 测失败,恢复后 4353 PASS。
- **沉淀**: stat-before-read 族 symlink 变体——**「检查用 no-follow(lstat),读取用 follow(readFile)」是 size cap 绕过**:两个 syscall 的 symlink 解析语义必须一致。单 fd(open 跟随 + fstat 目标 + 有界读)天然统一语义且消除 TOCTOU。isDirectory 仍要 no-follow lstat(否则 symlink→dir 被当文件)——**同一函数里不同检查可有不同 follow 语义,但 size-check 必须与 read 的 follow 语义对齐**。剩余同族站点:settings.service `loadSettings`(corrupt-rename+cache),待 codex surface。

## E164 — settings.service loadSettings TOCTOU(stat-before-read 族末站,全族收敛)→ 共享 readFileCappedFd (P2)

- **问题**: `electron/main/services/settings.service.ts:65`。`loadSettings` 同族:`fs.stat` 判 64KiB 上限 + `fs.readFile` 整文件两次独立路径解析,检查与读取之间可增长/替换绕过上限 → 整块读入 + JSON.parse,违背「超大不整块读入」。
- **修复**: 改用共享 `readFileCappedFd`。语义保持:ENOENT→默认 + 写 cache(首次启动);EACCES/EIO→默认但**不写 cache**(否则默认成「当前状态」,saveSettings 覆盖用户 locale)+ 下次重试;tooLarge→rename `.corrupt.{ts}` + 默认 + 写 cache;ok→JSON.parse + schema 校验,失败→rename .corrupt + 默认。`fs.rename` 仍用 node:fs/promises(stat/readFile 已移除)。
- **测试**: settings-service.spec EACCES 测试 spy 从 `fs.readFile`(node:fs/promises)迁到 `nodeFsPromises.open`(node:fs promises,readFileCappedFd 实际所用);E69 too-large 从「mock stat 谎报超大」改真实 >64KiB 合法 JSON 文件(覆盖单 fd fstat)。中和共享 readFileCappedFd 双闸 → 13 测跨全部 6 个消费文件失败,恢复后 4353 PASS。
- **沉淀**: **stat-before-read TOCTOU 全族收敛**(E158 plugins.readFileCapped → E159 plugins.readMetadataCapped → E160 persistence.readExplorerCapped → E161 plugin-data.load → E162 hook-bridge.ingestFile+readConfigCapped → E163 read-file(symlink 变体)→ E164 settings.loadSettings),7 个站点跨 6 文件全部收口到单一来源 `electron/main/lib/read-fh-capped.ts` 的 `readFileCappedFd`。codex 用 8 轮逐个揪出同一反模式的所有副本——印证「同一反模式会散落全仓多文件,换审计者系统性逐个 surface」;**抽到 lib 的单一来源让后 4 站每站只需『调用 + 映射自身错误契约(ENOENT/EACCES/tooLarge → null/throw/rename.corrupt/default)』**,且中和 lib 一处即令 13 测跨 6 文件失败=最强收敛证据。配套教训:改 readFile→open 的 IO API,所有 mock readFile/stat 的测试须迁移到 spy `node:fs` promises 的 open / 改真实文件(ESM namespace:`node:fs/promises` ≠ `node:fs`.promises 在 vitest module-mock 下)。

## E165 — GraphQL 响应 errors 字段假设是数组,非数组(对象/字符串)致 .map TypeError (P2,外部形态校验)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:152`。`if (json.errors && json.errors.length > 0)` 后直接 `json.errors.map(...)`。json.errors 来自外部 GitHub GraphQL 响应,TS 类型不构成运行时保证。畸形响应给 `{errors:{length:1}}` 或 `{errors:"x"}`(truthy 且 length>0,但非数组)→ `.map` 在 `{length:1}` / 字符串上抛 TypeError → 整次 reviews 拉取失败、Marketplace 评分退 stale/error,而非安全规范化。
- **亲读**: 同函数内 node(E106)、pageInfo(E106)、thumbsUp(E93)都已有外部形态守卫,唯独 errors 数组性未校验。
- **修复**: `json.errors && json.errors.length > 0` → `Array.isArray(json.errors) && json.errors.length > 0`。非数组 errors 视为无结构化错误跳过;若同时无有效 data,下方 `!d || !Array.isArray(d.nodes)` 兜底 break → 空 nodes 优雅降级。`.map` 内 `e?.message` 的可选链已容忍非对象元素。
- **测试**: security-marketplace-token-main.spec +E165×2(`{errors:{length:1}}` / `{errors:'boom'}` → 不抛 TypeError,resolves 空 nodes)。中和(去 Array.isArray)→ 2 测失败(抛 TypeError),恢复后 4355 PASS。
- **沉淀**: 外部数据形态校验族(E106/E93/E165)——**「truthy + .length > 0」不等于「是数组」**:`{length:N}` / 字符串都满足该判断却不可 `.map`。凡对「期望是数组」的外部字段做 `.map/.filter/.forEach`,前置必须 `Array.isArray`(不能只判 truthy + length)。同一函数已对兄弟字段(node/pageInfo)加了形态守卫却漏了 errors=同函数内形态校验不完整,审计须扫该函数所有外部字段访问点。

## E166 — GraphQL 响应顶层 JSON.parse 结果未校验形态,null/字符串/数组致属性访问 TypeError (P2,外部形态校验)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:151`。`JSON.parse(text) as GraphqlResp` 后直接访问 `json.errors` / `json.data`。合法 JSON 顶层可为 `null` / 字符串 / 数组 / 数字 —— `null.errors` 在属性访问处抛 TypeError;拉取走异常降级 stale 而非可控 code。E165 的直接兄弟(E165 修 errors 字段形态,E166 修顶层 json 形态)。
- **亲读**: E165 刚给 `json.errors` 加了 Array.isArray,但顶层 `json` 自身仍可能是 null → `json.errors` 先于 Array.isArray 求值就抛。
- **修复**: JSON.parse 结果先存 `unknown`,校验 `=== null || typeof !== 'object' || Array.isArray` → 抛稳定 `MARKETPLACE_RESPONSE_INVALID`(与 MARKETPLACE_RESPONSE_TOO_LARGE 同款 code-as-message 风格),再 `as GraphqlResp`。
- **测试**: security-marketplace-token-main.spec +E166×4(it.each:顶层 null/字符串/数组/数字 → 抛 MARKETPLACE_RESPONSE_INVALID,且消息不含 "of null"/"not a function"/"undefined" 等属性访问 TypeError 特征)。中和(去顶层守卫)→ 4 测失败,恢复后 4359 PASS。
- **沉淀**: 外部形态校验族(E106/E93/E165/E166)——**JSON.parse 结果的顶层形态本身要校验,而非只校验其字段**:`JSON.parse` 可返回 null/原语/数组,`X.field` 在 null/undefined 上抛。修了字段形态(E165)还要修容器形态(E166)——**形态校验要从最外层容器开始,逐层向内**(顶层 object → 字段是数组 → 元素是对象)。`x as Type` 断言对运行时零保证,外部数据 parse 后第一步就该是顶层形态守卫。连续两轮(E165→E166)codex 揪同函数的字段级与顶层级形态缺口=形态校验的「层级完整性」易漏。

## E167 — isTerminalSessionShape 只校验类型,缺字符串长度 + 数字有限性(E23 在同守卫的延续) (P2,纵深防御)

- **问题**: `src/stores/terminal.store.ts:52`。`isTerminalSessionShape`(M16 IPC ingress 守卫)校验各字段类型,E23 已给其中的 `attachTarget.panelId`(≤256)/windowId(安全整数)加了长度/范围校验,但 session **自身**的 title/cwd/agentLabel/workspaceRoot 无长度上限、createdAt/exitCode/ownerWindowId 无有限性/安全整数校验。畸形 sessions_changed/listSessions payload(超长 title/cwd 或 NaN/Infinity 时间、小数 exitCode)进 renderer store → UI 卡顿/异常展示/状态污染。
- **亲读 + 可达性**: 主进程写入口已全部 cap —— create(TerminalCreateInputSchema:title/agentLabel≤LABEL_MAX=512,cwd/workspaceRoot≤PATH_MAX=8192)+ updateCwd(E33:cwd≤PATH_MAX);createdAt=Date.now()、exitCode=PTY 退出码、ownerWindowId=BrowserWindow.id 均 main-内部恒有限。故畸形值**经正常路径不可达**——本修是 **renderer ingress 纵深防御**,与 E23 在同一守卫给 attachTarget 加 cap 的决策一致(补齐 session 自身字段的同等校验,消除「panelId 校验长度但 title/cwd 不校验」的守卫内不一致)。诚实标注:非可达 exploit,是防御一致性补齐。
- **修复**: isTerminalSessionShape 字符串字段镜像 create 上限(SESSION_ID_MAX=256/LABEL_MAX/PATH_MAX,从 terminal-create 导入),createdAt `Number.isFinite`、exitCode `null|安全整数`、ownerWindowId `安全整数 && >=0`。主进程 session store 的 add/updateCwd/setExited 不补(IPC schema 已 cap 所有写入口,再加是冗余)。
- **测试**: filter-pure-fn.spec(经 filterByOwnerWindow→isTerminalSessionShape)+T13/T14/T15(超长 title/cwd/agentLabel/workspaceRoot → shape-invalid;NaN createdAt/小数 exitCode/负 ownerWindowId → shape-invalid;恰 512/有限/安全整数边界 → 通过)。中和 length/finite 检查 → 2 测失败,4362 PASS。
- **沉淀**: 纵深防御一致性——**同一 ingress 守卫内,对一部分字段加了长度/范围校验(E23 attachTarget),其余同类字段就该补齐**(否则守卫给人「已防御」的错觉却有缺口)。判可达性:写入口(create/updateCwd IPC schema)已 cap ⇒ 畸形值不可达 ⇒ 标 P2 纵深防御而非 exploit(同 E137/E144 latent 诚实标注),但因守卫内不一致 + 低成本仍值得补。不向 main session store 扩散冗余断言(写入口已是权威 cap 点)。

## E168 — notify:push IPC payload 无 runtime 形态/长度校验(bridge ingress 纵深防御) (P2)

- **问题**: `src/notifications/NotifyIpcBridge.tsx:23`。`coApi.notify.onPush` 回调只按 TS 类型信任 payload,直接读 `payload.windowId/message/code/level`,无 runtime 形态/长度校验。畸形 payload(null/非对象/非法 level/超长 message·code/畸形 params/非安全 windowId)可让 bridge 回调抛错(如 `null.windowId`)或把 invalid/超大 toast 写入通知队列。
- **亲读 + 可达性**: `pushNotification`(notify.ipc.ts:38)是唯一发送方,但**全仓无生产调用方**(channel 当前未被触发);发送方是 main 内部(payload 非外部/插件直接控制)。preload onPush 也不校验,直接透传。故畸形 payload **当前不可达**——本修是 **bridge ingress 纵深防御**,与 bridge 既有防御姿态(windowId ingress filter + empty-payload drop,topic-09/15 "防御性模式")一致。诚实标注:无 reachable exploit、channel 未启用,补的是防御一致性。
- **修复**: 新增**共享** `isNotifyPushPayload(v)` type guard(electron/shared/notify-channels.ts):非 null 非数组对象、level ∈ NOTIFY_LEVELS、message≤4096、code≤256、params 是 plain object(≤64 键,值仅 string≤2048|有限 number)、windowId 安全整数≥0。bridge 回调首行 `if (!isNotifyPushPayload(payload)) { warn + drop }`。
- **测试**: notify-ipc-bridge.spec +E168×2(11 种畸形 payload 全 drop + warn、notify 不调用;合规 params string/number 正常转发)。中和 bridge 守卫 → 1 测失败(null payload 致回调抛错/notify 误调),恢复后 4364 PASS。
- **沉淀**: 纵深防御诚实分级——**channel 未启用 + 发送方 main 内部 ⇒ 非可达 exploit**,但与 bridge 既有防御姿态一致 + 低成本 + 防未来 caller 误用,故补(同 E167 判断框架:写入口/发送方是否权威 cap、守卫内是否已有同类防御决定补还是 DEFER)。IPC ingress(即便 main→renderer 被视为受信)若已有部分防御(windowId filter),补全形态/长度校验是合理一致性;type guard 放 shared 便于 main/preload/renderer 任一侧复用 + 单测。

## E169 — plugin-fs:scope-request payload 无 runtime 校验(E168 同族,安全敏感授权弹窗) (P2)

- **问题**: `src/plugins/permissions/usePluginFsScopeRequests.ts:36`。`onScopeRequest` 回调直接 `payload.scopes.map((scope) => ... scope.path ...)`,无 runtime 校验。畸形 payload(null/scopes 非数组/scope 非对象/缺或非法 mode/超长 path/超长 requestId/非法 pluginId)→ 回调抛错(`payload.scopes` on null / `scopes.map` on 非数组 / `expandScopePathForDisplay(undefined)` 的 `.startsWith`)或把脏授权请求写入 prompt store → **fs scope 授权弹窗(安全敏感)卡死/显示异常**。
- **亲读 + 可达性**: 该 channel **是活跃的**(插件请求 fs 访问即触发,不同于 E168 未启用的 notify),payload 由 main 从插件请求构造,path/pluginId/scopes 受插件影响。比 E168 更接近可达(安全授权流的 DoS:畸形请求崩溃 bridge 阻塞合法弹窗)。
- **修复**: 加 `isScopeRequestPayload` 守卫:非 null 对象、requestId 非空 ≤256、pluginId 经 `isValidPluginId`(复用 E123)、scopes 是数组 ≤256 项,每项 path 非空 ≤FS_PATH_MAX、mode ∈ {'r','rw'}。非法 drop + warn,不进 prompt store。
- **测试**: scope-decision-feedback.spec +E169×2(8 种畸形 payload 全 drop + requestFsScope 不调用 + warn;合规多 scope/mode rw 正常进 store)。**修正 3 个既有 fixture**(a11y/race 测试的 scope 缺 mode,PathScope 实际必含 mode `'r'|'rw'`,补上)。中和守卫 → 1 测失败,4366 PASS。
- **沉淀**: IPC ingress 纵深防御族(E167/E168/E169)——**活跃 + 安全敏感 channel 的 ingress 守卫优先级高于未启用 channel**(E169 > E168):授权流的 bridge 崩溃 = 权限弹窗 DoS。既有不完整 fixture(scope 缺 mode)在加严守卫时暴露——**守卫严格化会暴露测试 fixture 与真实类型(PathScope.mode 必填)的偏差,须按真实类型补全 fixture**(非削弱守卫迁就旧 fixture)。复用既有校验器(isValidPluginId E123)而非重写格式校验。

## E170 — i18n:changed 广播 payload 无 runtime 校验,非法 locale 致 translate() 全 UI 崩溃 (P1)

- **问题**: `src/stores/settings.store.ts:43`。`coApi.i18n.onChange` 回调直接用 `payload.locale`/`payload.gen` 更新全局 i18n。非法 locale(catalog 不存在,如 'fr')→ `setI18nModuleLocale('fr')` → translate() 的 `DICTS['fr']` undefined → **全 UI 渲染崩溃(跨窗广播 → 所有窗口)**;NaN/Infinity gen → `payload.gen < currentGen` 对 NaN 恒 false → 污染乱序保护(后续广播全被旧 gen 挡或反之永久错乱)。
- **亲读 + 可达性**: 广播由 main setCurrentLocale 后发出;main 的 i18n.setLocale IPC(i18n.ipc.ts:48)已用单源 `LocaleSchema`(z.enum(['en','zh','ko']))校验,settings.json 也经 SettingsSchema 校验 locale。故非法 locale **生产不可达**——本修是广播 ingress 纵深防御。但**后果严重(全 UI translate 崩溃,跨所有窗口)+ 复用单源 LocaleSchema 成本极低 + E168/E169 同族**,故标 P1-latent 仍补。
- **修复**: `isValidI18nChangedPayload` 守卫(非 null 对象、locale 经 `LocaleSchema.safeParse`、gen 安全整数 ≥0),onChange 首行非法 drop + warn,不更新 store/module locale。
- **测试**: locale-store.spec +E170×2(9 种畸形:null/非对象/非法 locale 'fr'/NaN·Infinity·非整数·负 gen/locale 非串/缺 locale → drop,state 不变;合规 locale∈catalog + 安全整数 gen → 正常更新)。中和守卫 → 1 测失败,4368 PASS。
- **沉淀**: IPC ingress 纵深防御族(E167/E168/E169/E170)——**按后果严重度分级**:E170 后果(全 UI translate 崩溃)+ 跨窗广播 → 即便生产不可达也标 P1 优先补(对比 E168 未启用 channel 标 P2)。**复用单源 schema(LocaleSchema)做 ingress 校验** = 与写入口同一真理源,零漂移。NaN 在 `<` 比较中恒 false 是乱序保护的隐藏破绽——凡用 `gen < current` 做单调序保护的,gen 必须先校验 `Number.isSafeInteger`(NaN/Infinity 会永久毒化比较)。

## E171 — agent-auth:request payload 无 runtime 校验,null 解构抛 rejection / 超长进授权弹窗 (P2)

- **问题**: `src/shell/AgentAuthPrompt.tsx:39`。`onRequest(async ({ requestId, method, agentLabel }) => ...)` 直接解构 payload。畸形 push(null → 解构 null 抛未处理 rejection;缺 requestId → respond(undefined) → main pending 等 5min 超时;超长 method → `t('permissions.agent.generic', { method })` catalog 插值放大 + 进弹窗状态)。授权弹窗(安全敏感)。
- **亲读 + 可达性**: agent-auth:request 由 main 在 agent/MCP 工具请求授权时 push,method/agentLabel 受 agent 影响;channel 活跃(agent terminal 授权流)。E146 已给 respond 侧 requestId cap≤256,但 request 侧 payload 无校验。
- **修复**: 加**共享** `isAgentAuthRequestPayload`(electron/shared/agent-auth-channels.ts):非 null 对象、requestId 非空≤256(对齐 E146 respond 上限)、method 非空≤256、agentLabel 可选≤512。回调首行非法 drop + warn,不解构/不调 ensure/respond。
- **测试**: agent-auth-prompt.spec +E171×2(9 种畸形 payload 全 drop:不弹 Modal + respond 不调用 + warn;合规含 agentLabel 正常弹 Modal)。中和守卫 → 1 测失败,4370 PASS。
- **沉淀**: IPC ingress 纵深防御族(E167-E171,**5 个 renderer 事件/广播入口**:terminal session shape / notify push / fs scope-request / i18n changed / agent-auth request)codex 系统性逐个揪。**「直接解构回调参数」是 null 解构抛未处理 rejection 的隐藏破绽**(`async ({ x }) => ` 对 null payload 抛,且在 async 里 → unhandledRejection)——所有 `onX((payload) => ...)` IPC ingress 回调都应先 runtime 形态守卫再解构/使用。type guard 放 shared(与 channel/payload 类型同文件)便于 main/preload/renderer 复用 + 单测。请求侧与应答侧 cap 须一致(requestId 两侧都 ≤256)。

## E172 — plugin-mcp INVOKE bridge 不用 InvokePayloadSchema,畸形反向调用抛错/main pending 超时 (P2)

- **问题**: `src/plugins/plugin-mcp-invoke-bridge.ts:36`。`onInvoke((payload) => registry.invokeLocal(payload.name, payload.input) ... payload.requestId)` 直接读字段,**不用已有的 `InvokePayloadSchema`**。畸形 main→renderer INVOKE(null → `payload.name` 抛 / 缺 name → invokeLocal(undefined) / 缺 input / 缺 requestId → replyInvoke 无法关联 → main pending 等 timeout / 超长 name·requestId)。
- **亲读**: `InvokePayloadSchema`(electron/shared/plugin-mcp-schemas.ts:62,strict + requestId/name 限长 + input 必填 refine)已存在但 bridge 未用。
- **修复**: bridge 首行 `InvokePayloadSchema.safeParse(payload)`。**分级处理**(codex 建议):非法但含可用 requestId(string 非空 ≤REQUEST_ID_MAX)→ `replyInvoke ok:false INVALID_PARAMS`(让 main pending 立即收口,不等 timeout);无合法 requestId(无法关联)→ drop + warn。两路都不调 invokeLocal。then/catch 改用校验后的 `valid.requestId`(非原始 payload)。export REQUEST_ID_MAX 供 bridge 复用。
- **测试**: invoke-bridge.spec +E172×2(含可用 requestId 的缺 name/缺 input → INVALID_PARAMS + invokeLocal 不调;null/缺/空/超长 requestId → drop+warn + 不回写 + 不抛)。中和 schema 守卫 → 2 测失败,4372 PASS。
- **沉淀**: IPC ingress 纵深防御族 E172(**第 6 个入口**:terminal-shape/notify/fs-scope/i18n/agent-auth/plugin-mcp-invoke)。**「已有 schema 却没在 ingress 用」是常见疏漏**——InvokePayloadSchema 早就定义(给别处用),但反向调用 bridge 漏接;审计须查「定义了校验 schema 的 channel,其所有 ingress 点是否都接上」。**有 requestId 的请求-应答型 ingress,非法时应『带 requestId 回错误』而非纯 drop**——纯 drop 会让对端 pending 等超时,带 requestId 回 INVALID_PARAMS 让对端立即收口(比 notify/i18n 单向广播多一层「可关联即应答」处理)。

## E173 — preload fs:dir-changed push payload 无 runtime 校验,null.path 抛 / 脏 path 进 watcher (P2)

- **问题**: `electron/preload/index.ts:175`。`onDirChanged` listener `(_, payload: {path}) => cb(payload.path)` 直接读 `payload.path`。畸形 push(null → `null.path` 在 preload listener 抛 / 非对象 / path 非字符串/超长)→ listener 抛错,或把非法 key 送进 Explorer watcher / external-file-sync(目录刷新异常、debounce Map 污染、外部同步失效)。
- **亲读**: fs:dir-changed 由 main fs watcher 广播(path 来自 resolveWatchChangedPath / fs.watch filename,可含异常文件名)。preload listener 是 renderer 侧第一道,无校验。
- **修复**: 新增**共享** `isFsDirChangedPayload(v, maxPathLen)`(electron/shared/fs-channels.ts):非 null 对象 + path 是 string ≤ maxPathLen(空字符串合法 → 只限上限不限非空)。preload listener 用它(传 FS_PATH_MAX),非法 console.warn drop,不抛/不下传脏 path。
- **测试**: 新建 fs-dir-changed-payload-guard/guard.spec ×4(合规含空/恰上限 path → true;null/非对象/数组/path 非字符串/缺 path/超长 → false)。preload 本身 import electron 顶层不可直测 → 守卫抽 shared 单测(同 E168/E171 模式)。中和 → 3 测失败,4376 PASS。
- **沉淀**: IPC ingress 纵深防御族 **E173(第 7 个入口**:terminal-shape/notify/fs-scope/i18n/agent-auth/plugin-mcp-invoke/fs-dir-changed)。**preload listener 也是 ingress 点**(不只 renderer hook/store)——main→renderer 的 `ipcRenderer.on` 回调同样要形态守卫(null payload 在 preload 抛也会断订阅)。preload 顶层 import electron 不可直测 → **守卫抽 shared module 单测 + preload 仅做 wiring**(贯穿 E168/E171/E173)。空字符串路径是合法值(根/相对)→ 守卫只限长度不强制非空(对比 requestId/id 类必非空)。

## E174 — sessions_changed 实时广播未校验是数组(初始 listSessions 已有,广播路径缺=双路径不对称) (P2)

- **问题**: `src/shell/dock/TerminalSessionsSync.tsx:84`。`onSessionsChanged((snapshot) => filterByOwnerWindow(snapshot, ...))` 直接传 snapshot。初始 listSessions 路径(line 68)已有 `Array.isArray(r.data?.sessions)` 守卫,但实时广播路径缺同等 guard。畸形 sessions_changed payload(null/对象/字符串)→ filterByOwnerWindow 的 `for (const s of sessions)` 抛 → 中断会话同步、tab/列表停旧态。
- **亲读 + 自引入加固**: 双路径不对称(初始有/广播无)。另发现原代码 `sawPush = true` 在处理**之前**置位 —— 畸形首个广播会置 sawPush=true 致初始 listSessions 结果被丢弃(line 67 `if (sawPush) return`),即畸形广播抑制有效初始 hydration。
- **修复**: 广播回调首行 `if (!Array.isArray(snapshot)) { warn + notify(同初始路径 sessions_restore_failed) + return }`;**sawPush=true 移到守卫之后**(畸形广播不置 sawPush,不抑制初始 hydration)。
- **测试**: terminal-sessions-sync/sync.spec +E174×2(null/对象/字符串/数字广播 → notify + store 不变 + 不抛;畸形后合规广播仍更新)。中和 Array.isArray → 2 测失败,4378 PASS。
- **沉淀**: IPC ingress 纵深防御族 **E174(第 8 个入口**)+ **双路径对称族**(E112/E143/E144 fresh/cache 对偶的延续):同一数据两条到达路径(请求-响应初始 vs 广播实时),一条加了形态守卫另一条易漏——**审计须对「同一数据的所有到达路径」核对守卫对称性**。顺带修正 `sawPush` 时序破绽:状态机的「已见信号」标志必须在**有效**信号处理后置位,不能在校验前置位(否则畸形信号污染状态机 / 抑制有效路径)。

## E175 — plugin-shell-stream:event preload handler 信任 TS 类型,畸形事件抛/喂错 chunk 给插件流 (P2)

- **问题**: `electron/preload/plugin-shell-stream.preload.ts:69`。handler 直接读 `payload.streamId/kind/payload`。畸形事件(null → `null.streamId` 在 preload 抛 / 非对象 / 非法 kind → 当 chunk 处理 / stdout·stderr payload 非二进制 → `new Uint8Array(非array-like)` 空/错 chunk / exit payload 非 {exitCode,signal} → 垃圾 exitInfo)→ 喂给插件 stream → done/chunks 状态异常甚至永久挂起。
- **亲读**: EVENT 通道广播给**所有**活跃 stream 的 handler,故畸形事件分两类:无主(无法归属任何 stream)vs 本 stream-坏。一个无主畸形事件若让每个 handler 都合成 exit,会误杀所有 stream。
- **修复**: 抽**纯函数** `parseShellStreamEvent(payload, expectedStreamId)`(electron/shared/plugin-shell-stream-channels.ts)分类:`unattributable`(null/非对象/streamId 非串 → 不归属)/ `not-ours`(streamId≠ → 静默)/ `invalid`(本 stream 但 kind·payload 形态非法)/ `exit`(校验 exitCode number\|null + signal string\|null)/ `chunk`(payload 必 instanceof Uint8Array,拷贝)。handler 据此:not-ours 忽略 / unattributable warn+drop(**不动本 stream**)/ invalid warn + synthesizeExit 收敛 / 合法照常。
- **测试**: 新建 shell-stream-event-parse/parse.spec ×5(各分类 + 拷贝语义);既有 backpressure/start-reject/early-break 等通过(合法事件行为不变)。中和 exit/chunk 校验 → 2 测失败,4383 PASS。
- **沉淀**: IPC ingress 纵深防御族 **E175(第 9 个入口**:+plugin-shell-stream event)。**广播到多订阅者的 ingress,畸形事件须区分「无主」与「本订阅坏」**:无主事件只能 drop(不可代任一订阅者收敛,否则一个坏事件误杀全部);能归属(streamId 匹配)才可对该订阅做收敛(合成 exit)。preload 顶层 import electron 不可直测 → 解析逻辑抽纯函数 shared 单测(贯穿 E173/E175)。二进制 IPC payload:main Buffer 经 structured-clone 到 renderer 为 Uint8Array(Buffer 是其子类),校验用 `instanceof Uint8Array`。

## E176 — hadDirectory 检测 Array.from(dt.items).slice 在上限前全量物化 DataTransferItemList (P2)

- **问题**: `src/shell/App.tsx:105`。窗口级 drop handler 的 hadDirectory 探测 `Array.from(dt.items ?? []).slice(0, MAX_DROP_FILES).some(...)` —— `Array.from` 在 `.slice` 前**全量物化**整个 DataTransferItemList。拖入海量文件/畸形超大拖放时,同步 drop 事件回调遍历/分配全部 items,绕过注释里的 E114 上限,UI 卡顿。同文件 `captureBoundedFiles`(E118)已对 dt.files 有界,但 items 分支漏(双路径不对称)。
- **亲读**: `.slice(0,max)` 之前 `Array.from` 已物化全部;`.some` 短路只在 slice 后的子集生效,救不了前面的全量物化。
- **修复**: 抽 `hasDirectoryInFirstItems(items, max)`(src/lib/window-drop.ts,captureBoundedFiles 兄弟):按索引 `for (i<items.length && i<max)` 有界循环,不用 Array.from;命中目录即短路 return。App.tsx 调用它。webkitGetAsEntry 缺失/返 null → 非目录(不抛)。
- **测试**: window-drop.spec +E176×5(null/含目录/全文件/webkitGetAsEntry 缺失/命中即短路只读 1 个 index/超大 5000 无目录只读 ≤max 个 index)——用 Proxy 计 index 读次数验有界(同 E118 captureBoundedFiles 测法)。中和 `i<max` 上限 → 超大测失败,4388 PASS。
- **沉淀**: 有界遍历族(E114/E118/E176)+ **双路径对称**(E174 同理):同一 drop 事件两个分支(files 经 captureBoundedFiles 有界 / items 经 Array.from 全量),一个有界另一个漏——**`Array.from(X).slice(0,n)` 是「先全量物化再截断」的反模式**,有界化必须在物化时就用索引循环 `for (i<len && i<max)`,不能 Array.from 后再 slice。Proxy 计读次数是验「真有界、未全量遍历」的标准测法。

## E177 — plugin-data assertPluginId 无长度上限 + 错误回显原始超长 id (P2)

- **问题**: `electron/main/services/plugin-data-store.service.ts:30`。`assertPluginId` 校验字符集 + ./.. + 非空,但无长度上限(plugins.service/plugin-mcp-schemas/plugins.ipc 均有 PLUGIN_ID_MAX=256)。绕过 wrapper 直调 pluginDataRaw.load/save/clear 时,超长合法字符 id 进正则扫描/path join/lockfile 路径/错误链路 → 主进程 CPU/内存/日志放大或 ENAMETOOLONG;且错误 `invalid plugin id: ${id}` 回显原始超长 id(E148 echo 放大族)。
- **亲读**: charset/./.. 防路径穿越已有,长度上限是同族其它持久化入口都有、唯独 plugin-data 漏(不对称)。
- **修复**: 加 `PLUGIN_ID_MAX=256` 长度上限;错误改为不回显原始 id 的固定 `'invalid plugin id'` + 附 `code: BAD_INPUT`(稳定 code)。保留 "invalid plugin id" 前缀(既有测试 regex 匹配)。
- **测试**: plugin-data-store.test +E177×2(超长 id load/clear/save 拒绝 + code BAD_INPUT + 错误不回显原始超长串;恰好 256 接受边界含等号)。既有 T2.f/T2.g(路径穿越/分隔符)仍匹配 "invalid plugin id"。中和长度检查 → 1 测失败,4390 PASS。
- **沉淀**: 长度上限对称族 + echo 放大族(E148)合流——**同一约束(PLUGIN_ID_MAX=256)在多个持久化入口重复定义为 local const,新入口(plugin-data)易漏其一**;审计须 grep 所有 `assertPluginId`/pluginId 校验点核对长度上限一致性。错误消息**拒绝即不回显原始非法输入**(尤其超长),只给稳定 prefix + code(by-code 本地化 + 防放大,贯穿 E148/E151/E157)。

## E178 — plugin-fs check() chokepoint 缺 target 路径 type/长度闸,超长进 realpath 放大 (P2)

- **问题**: `electron/main/services/path-scope-registry.service.ts:85`。`check()` 是所有 plugin-fs 操作(read/lstat/remove/rename/write/mkdir → readFile/lstat/realpath/readGitBlob)的授权 chokepoint,但直接把 raw `target` 传给 `resolveForRead/resolveForWrite/...`(内部 fs.realpath),无 type/长度前置闸。已授权插件传超长路径 → 经 renderer/preload structured-clone 进主进程 realpath → ENAMETOOLONG / CPU·内存放大;非 string → TypeError 而非稳定 SCOPE_ERROR。plugin-fs scope-request 路径限 8192,但实际 read/stat 操作 target 无同等闸(不对称)。
- **亲读**: check() 是单一 chokepoint(所有 opType 分支都先调 resolveForX realpath);在其顶部加一道闸即覆盖全部入口(codex 优选「统一在 check() 做,不逐入口」)。
- **修复**: check() 顶部(identity resolve / realpath 之前)加 `typeof target === 'string' && 0 < length <= FS_PATH_MAX`(对齐主 fs.ipc fsPath() 上限),非法抛 `ScopeError('invalid target path', {reason:'target-invalid'})` —— 不回显原始(可能超长)target。
- **测试**: path-scope-registry.spec +E178×2(超长 target → ScopeError reason target-invalid + 不回显超长串;非串/空 target → ScopeError 非 TypeError)。中和 check() 闸 → 2 测失败,4392 PASS。
- **沉淀**: **在 chokepoint 加闸 > 逐入口加闸**——所有 plugin-fs 操作共用 check() 这一授权关口,把 type/长度校验放这里一处覆盖 read/lstat/remove/rename/write/mkdir 全部,胜过每个 IPC handler 各加(E158-E162 stat-before-read 抽 lib 同理:找共享关口收口)。长度上限须在第一个 O(n)/syscall(realpath)之前(E152 同律)。错误不回显原始非法 target(E148/E177 echo 族)。注:renderer scoped-app 各 fs path 方法的前置预检是 IPC structured-clone 放大的额外优化(codex 提及「也补」),主 check() 闸已闭合 realpath 放大这一核心向量。

## E179 — Markdown resolveLink href 无长度上限,超长链接 normalize/openExternal 放大 (P2)

- **问题**: `src/panels/Editor/link-resolve.ts:80`。`resolveLink(href, ...)` 的 href 来自(可能恶意/损坏的)**文件内容**,不经 IPC schema。无长度上限:file 分支跑 `normalize`(indexOf/slice/`rest.split(/[\\/]/)` O(n) + 数组分配);external 分支把超长 URL 经 openExternal IPC structured-clone 后才被主进程 schema 拒。单个恶意 Markdown 构造超长链接,用户 Cmd/Ctrl+点击 → renderer 大字符串处理/数组分配/IPC 放大,编辑器卡顿。
- **亲读**: href 是文件内容派生的非 IPC 字符串入口(区别于前序 IPC ingress 族)。external/file 两分支各有放大路径。
- **修复**: resolveLink 顶部硬上限 `href.length > MAX_FILE_LINK_LEN(8192,对齐 FS_PATH_MAX)` → null(两分支较大者,挡 normalize);external 分支再判 `> MAX_EXTERNAL_LINK_LEN(2048,对齐 shell.openExternal)` → null(不进 IPC)。超限直接 null,不进 normalize/IPC。
- **测试**: markdown-link-resolve.spec +E179×4(超长外链 >2048 → null / 外链 ≤2048 回归 external / 超长文件链接 >8192 → null / 文件链接 ≤8192 回归 file)。中和两道上限 → 2 测失败,4396 PASS。
- **沉淀**: 边界审计从 IPC ingress(E167-E178)回到**文件内容派生字符串**入口——Markdown href/正文等来自磁盘文件的字符串同样是外部不可信输入(恶意/损坏文件),凡对其做 normalize/split/O(n) 解析或下传 IPC 前都须长度上限。**上限分级对齐下游真实闸**(external 对齐 openExternal 2048、file 对齐 FS_PATH_MAX 8192),既挡本地放大也避免「IPC structured-clone 后才被下游拒」的前置放大(E44/E152 同律:上限前置到第一个 O(n)/IPC 之前)。

## E180 — app.fs.* 路径方法发 IPC 前无长度预检(E178 renderer 对偶) (P2)

- **问题**: `src/plugins/scoped-app.ts`。`app.fs.readFile/listDir/stat/lstat/realpath/mkdir/rename/rm/cp/readGitBlob/atomicReplaceWithinScope` 直接把路径传给 `coApi.pluginFsRaw.*` IPC,无长度预检(仅 writeFile 有 E44 path 检查)。主进程 PathScopeRegistry.check()(E178)虽拒超长 target,但正常插件 API 仍先把超长路径 structured-clone 进 preload/main → renderer/preload IPC 序列化放大;非 string 还会变 TypeError。E178 主进程守卫的 renderer 对偶缺口。
- **亲读**: writeFile 已有 inline `path.length > FS_PATH_MAX` 检查(E44),其余 11 个路径方法漏(不对称)。
- **修复**: 抽 `assertPluginFsPath(path, label)`(复用 FS_PATH_MAX:`typeof !== 'string' || > FS_PATH_MAX` → throw;空字符串放行交主进程 check())。所有 app.fs 路径方法发 IPC 前调用(双路径方法 rename/cp/atomicReplace 校验两个参数,readGitBlob 校验 repoDir);writeFile 的 inline 检查收口到 helper。
- **测试**: scoped-app.spec +E180×2(11 方法超长路径全抛 /too long/ + 都不发 IPC;上限内正常透传);E44 path 测试 regex `/path too long/`→`/too long/`(helper 消息措辞变)。adding code 行移位 → 更新 web-compat-allowlist scoped-app globalThis 行 237→259(E125/E129 同款联动)。中和 helper → 2 测失败,4398 PASS。
- **沉淀**: IPC 放大防御的**主/renderer 双侧对偶**(E178 主 check() chokepoint + E180 renderer scoped-app 预检)——主进程守卫闭合安全/realpath 放大,renderer 预检闭合 IPC structured-clone 前置放大,两侧都要(E44 writeFile 早确立此模式,其余方法补齐)。**一个文件内同类方法只有一个加了预检(writeFile),其余 11 个漏 = 审计须 grep 同 API 族所有方法**。抽 helper 收口避免 12 处 inline 漂移。renderer 加行须连带更新 web-compat-allowlist 行号(固有联动)。

## E181 — app.clipboard.writeText 无类型/大小校验(fs/shell/notifications 兄弟入口漏网) (P2)

- **问题**: `src/plugins/scoped-app.ts:388`。`clipboard.writeText(text)` 只做权限检查,直接把 text 传给 cached `navigator.clipboard.writeText`,无类型/大小校验。畸形/恶意插件传非 string 或超大字符串 → renderer/系统 clipboard API 卡顿/内存峰值/异常路径。同文件 fs(E44 path/content)、shell(E46 input/args)、notifications 都有「发底层前输入上限」,clipboard 是漏掉的兄弟入口。
- **亲读**: scoped-app 的输入上限族(writeFile content MAX_WRITE_BYTES + path FS_PATH_MAX、shell input SHELL_STDIN_MAX、fs path E180)已覆盖 fs/shell,clipboard.writeText 独漏。
- **修复**: writeText 授权后、发原生 clipboard 前:`typeof text !== 'string'` → BAD_INPUT;`utf8BytesExceed(text, CLIPBOARD_TEXT_MAX_BYTES=16MiB)` → BAD_INPUT(clipboard 文本通常 KB 级,16MiB 远超真实复制只挡滥用)。复用 utf8BytesExceed(真实 UTF-8 字节,E125)。
- **测试**: scoped-app.spec +E181×1(已授 clipboard 但非 string / 超大 → BAD_INPUT)。中和守卫 → 1 测失败,全量 4399 PASS。clipboard 代码在 globalThis 命中行(259)之下,web-compat 行号不受影响。
- **沉淀**: 输入上限族(E44/E46/E180/E181)——**同一 scoped API 对象的所有「转发到底层」方法都该有发底层前的输入上限,逐个补齐易漏单个**(fs/shell 有,clipboard 漏)。审计须枚举 scoped-app 每个 forwarding 方法核对输入校验对称性。文本类输入上限用真实 UTF-8 字节(utf8BytesExceed)非 .length(E125 同律)。BAD_INPUT code 沿用文件内既有字面量风格(line 56)。

## E182 — app.editor.openFile path 发 checkPath IPC 前无长度预检(E180 直接兄弟) (P2)

- **问题**: `src/plugins/scoped-app.ts:436`。`editor.openFile(path)` 权限通过后直接 `coApi.pluginFsRaw.checkPath(token, path)`,未在 renderer wrapper 侧校验 path 类型/长度。畸形/超长 path 先 structured-clone 进主进程才被 checkPath 拒,与同文件 app.fs.*(E180 assertPluginFsPath)防线不一致。E180 的兄弟入口 —— openFile 在 editor namespace(makeEditor),不在 E180 sweep 的 makeFs 内。
- **亲读**: openFile 契约返回 `EditorOpenResult`(结果对象,非 throw),`EditorOpenFailureCode` 含 `'INVALID_PATH'`(无 BAD_INPUT)。故不能复用会 throw 的 assertPluginFsPath,改返回 `{ok:false, code:'INVALID_PATH'}`。opts.line out-of-range 已是下游 `ok:true reason:'line-out-of-range'` 的优雅处理,非崩溃路径,故本次只补 path。
- **修复**: ensurePerm 后、checkPath 前:`typeof path !== 'string' || length===0 || length > FS_PATH_MAX` → `{ok:false, code:'INVALID_PATH', message}`,不调 checkPath / rawEditor.openFile。
- **测试**: openFile-scoped-permission.spec +E182×2(超长/非串/空 path → INVALID_PATH + checkPath/rawEditor 不调;合规 path 正常走 checkPath+转发)。中和 path 闸 → 1 测失败,web-compat 行号不受影响(makeEditor 在 globalThis 命中行之下),4401 PASS。
- **沉淀**: E180 的兄弟入口漏网——**「同族 sweep 受限于当时的代码区域」**:E180 sweep 了 makeFs 的 fs 方法,但 openFile 在 makeEditor(editor namespace),同样 path→checkPath IPC 却在另一函数。审计同族缺口须按「行为」(所有把 path 发进 fs/checkPath IPC 的方法)而非「位置」(单个对象)grep。错误返回形态须匹配该 API 的契约(openFile 返结果对象用 INVALID_PATH,非抛 BAD_INPUT)——同一防御在不同 API 按其错误契约落地。

## E183 — assertJsonValue 数组用 forEach(跳过 sparse 空洞)+ 无 length 上限,稀疏巨数组绕过 (P1)

- **问题**: `electron/shared/assert-json-value.ts:37`。数组分支 `value.forEach((v,i)=>...)`:(1)forEach **跳过 sparse array 空洞** → `new Array(1e9)`(稀疏,length 1e9 但 0 个实际元素)forEach 0 次迭代秒过校验;(2)无 length 上限。随后 JSON.stringify 生成 1e9 个 null 的超大 JSON(renderer/main OOM)——绕过「stringify 后按 16MiB cap」的保护(stringify 本身就是 OOM 点,cap 在它之后)。空洞还被 stringify 成 null = 校验通过但落盘变形。
- **亲读**: assertJsonValue 是 E103/E136/E140 的 JSON-safe 校验单一来源(plugin-data save/layout 等多处用)。forEach 的 hole-skip 是隐蔽语义。
- **修复**: 数组分支先 `value.length > MAX_JSON_ARRAY_LEN(1M)` → 抛(挡稀疏巨数组在 stringify 前);再**索引循环** `for (i<length)` 逐位:`!(i in value)` = sparse hole → 抛;否则递归元素。索引循环 + hole 显式拒绝替代 forEach。
- **测试**: 新建 assert-json-value-sparse/sparse-array.spec ×6(new Array(1e9) too large / `[1,,3]` 及 delete 空洞 / 稠密 ok / 元素递归校验 / 空数组 / 嵌套稀疏)。中和(回 forEach 无 cap)→ 3 测失败,4407 PASS。
- **沉淀**: **Array.forEach/map/filter 跳过 sparse holes 是隐蔽漏检**——校验/遍历数组完整性必须用索引循环 `for (i<length)` 且显式 `i in arr` 判空洞,不能用 forEach(空洞被静默跳过 → 校验通过但 JSON.stringify 把空洞变 null)。「校验后再 cap 大小」对「校验本身/序列化本身就是放大点」无效(E152/E179 同律:上限须在第一个 O(n)/分配点之前)——assertJsonValue 的 length cap 必须在 forEach/stringify 之前。稀疏数组(length 与实际元素数解耦)是「校验快速通过但物化巨大」的经典绕过。

## E184 — assertJsonValue object 分支无 key 数上限 + 多次全量物化 key 数组 (P2)

- **问题**: `electron/shared/assert-json-value.ts:77`(E183 对象对偶)。object 分支:(1)无自有属性数量上限;(2)`getOwnPropertySymbols` + `getOwnPropertyNames` + `Object.keys` + `Object.entries` **多次全量物化** key 数组。百万 key 的 plain object(plugin data / MCP schema / MCP result)→ stringify 字节上限生效前就在 renderer/main 多次大数组分配/卡顿。E183 的数组 length cap 不覆盖对象宽度。
- **修复**: 一次 `Reflect.ownKeys(obj)`(覆盖 string + symbol)→ 立即 `length > MAX_JSON_OBJECT_KEYS(10万)` cap → **单次循环**逐 key:`typeof k === 'symbol'` 拒(E140 symbol)、`getOwnPropertyDescriptor` 判 `!enumerable` 拒(E140 非枚举)、递归值。替代 4 次全量物化为 1 次 ownKeys + 每 key descriptor。object key 上限取 10 万(比数组 1M 更紧:key 带字符串键+值开销;16MiB 字节 cap 兜底)。
- **测试**: assert-json-value-sparse.spec +E184×5(>10万 key too many keys / symbol key / 非枚举 / 正常+Object.create(null) / 值递归)。既有 E140/E183 行为经新循环保持(symbol/非枚举/嵌套通过)。中和 key cap → 1 测失败,4412 PASS。
- **沉淀**: E183(数组)→E184(对象)成对——**容器校验的「宽度上限」要数组(length)和对象(key 数)都覆盖**,补了一个易漏另一个。校验大容器**先 cap 再遍历**且**单次枚举**(Reflect.ownKeys 一次取全 key,替代 getOwnPropertySymbols+getOwnPropertyNames+keys+entries 的 4 次全量物化)——多次 `Object.keys/entries/getOwnPropertyNames` 对宽对象是隐藏的 N 倍数组分配。cap 须在第一次物化(Reflect.ownKeys)之后**立即**、遍历/递归之前(同 E152/E183 上限前置律)。

## E185 — terminal create env 用 z.record+refine,条目上限在全量遍历后才生效 (P2)

- **问题**: `electron/shared/terminal-create.ts:32`。env 校验 `z.record(z.string().max(KEY), z.string().max(VAL)).refine(r => Object.keys(r).length <= ENV_MAX_ENTRIES)`。z.record 先 **O(N) 全量遍历**校验所有条目,refine 又 `Object.keys` **再全量物化**一次,条目数上限在全量成本之后才拒绝 → 畸形巨 env(百万条目)在主进程 schema 校验阶段就 O(N) 遍历/分配/卡顿,绕过「env≤1024 防放大」意图。
- **修复**: 替换为 `z.custom<Record<string,string>>().superRefine(validateEnvBounded)`。validateEnvBounded:先确认 plain object(非 null/非数组),`for-in` + hasOwnProperty **早停计数到 ENV_MAX_ENTRIES+1 即拒**(不遍历完整巨对象),同轮校验 key/value 为 string 且 ≤ 上限。O(min(N, 1025)) 而非 O(N)。
- **测试**: terminal-ipc.spec 既有 E11(1025 条目/value 超长 → fail)+ create-session env 测试经新校验保持;+E185×4(key 超长 / 非对象(数组/字符串/数字) / value 非串 / 合规 env 含空对象)。中和 count 早停 → 1 测失败,4416 PASS。
- **沉淀**: **「校验后再 cap」对 zod schema 同样适用上限前置律(E152/E183/E184)**——`z.record(...).refine(count<=N)` 是「先全量校验所有条目、再数 count」的反模式,数量上限必须在遍历中早停(superRefine 手动 for-in + break),不能靠 refine 在 z.record 全量遍历之后兜。集合型外部输入(env/record)的数量上限要在第一遍遍历内早停计数,且避免 Object.keys 的额外全量物化。

## E186 — shell.exec env 同 E185 z.record+refine(E185 兄弟入口)→ 抽共享 bounded env validator (P2)

- **问题**: `electron/main/ipc/shell.ipc.ts:27`。ExecInput 的 env 与 terminal.create(E185)同型:`z.record(...).refine(r => Object.keys(r).length <= ENV_MAX_ENTRIES)` —— 条目上限在 z.record 全量遍历 + Object.keys 全量物化之后才生效。绕过 renderer facade 或未来 LM 直调 coApi.shell.exec 时,畸形巨 env 在 main schema 校验阶段 O(N) 卡顿/内存峰值。E185 只修了 terminal.create,shell.exec 是漏掉的兄弟入口。
- **修复**: 抽**共享** `makeEnvBoundedValidator(limits)` 工厂(electron/shared/validate-env-bounded.ts):产出 superRefine 校验器(plain object + for-in 早停计数到 maxEntries+1 即拒 + 同轮校验 key/value)。terminal-create(E185)与 shell.ipc(E186)都改用它(各传自己的 limit 常量),单一来源防漂移。E185 的本地 validateEnvBounded 收口到工厂。
- **测试**: exec-input-limits.spec +E186×4(key超长/非对象/value非串/合规)+ terminal-ipc 既有 E185×4 + E11;两侧 env 测试都过。中和共享 helper count cap → **2 测跨 shell + terminal 失败**(单一来源证据),4420 PASS。
- **沉淀**: 「修一族必 grep 兄弟入口」——E185 修 terminal.create env 时未 grep 其它 `z.record(...).refine(Object.keys...)` env 入口(shell.exec 同型)。**同一校验反模式(z.record+refine 数量上限)散落多 IPC schema,修一处须 grep 全部 `.refine.*Object.keys.*length` / `z.record` 入口**。抽共享 superRefine 工厂(参数化 limits)收口,两入口零漂移 + 中和一处令两侧测试失败=最强单一来源证据(同 read-fh-capped E158-E162 模式)。

## E187 — WritePermissions data 同 z.record+refine(E185/E186 第三入口)→ 共享 makeBoundedRecordValidator (P2)

- **问题**: `electron/main/ipc/plugins.ipc.ts:71`。WritePermissionsInput.data(权限表 `Record<pluginId, PermissionRecord>`)同 E185/E186:`z.record(...).refine(r => Object.keys(r).length <= PLUGINS_MAX)` —— 上限在 zod 全量遍历所有 plugin 记录 + Object.keys 全量物化之后才生效。畸形/旧 renderer 整表权限写入时,巨 data 在 main schema 阶段 O(N) 卡顿/分配(权限表是持久化数据)。
- **修复**: 把 E185/E186 的 `makeEnvBoundedValidator` 泛化为 `makeBoundedRecordValidator({keyMax, maxEntries, valueOk, label})`(value 校验改回调:env=string≤上限,权限表=`PermissionRecordSchema.safeParse(v).success`),makeEnvBoundedValidator 变薄封装。WritePermissionsInput.data 改 `z.custom<...>().superRefine(makeBoundedRecordValidator({...valueOk: PermissionRecordSchema.safeParse}))`。三入口(terminal env / shell env / 权限表)单一来源。
- **测试**: plugins-ipc-input-limits.spec 既有「条目超 10000 → fail」+ 合规保持;+E187×4(pluginId key超长 / 非对象 / 非法 PermissionRecord value / 合规含两种 record 形态 + 空)。env(E185/E186)测试经泛化重构后仍过(消息措辞变但断言只看 .success)。中和共享 count cap → **3 测跨 plugins+terminal+shell 失败**(三消费者单一来源证据),4424 PASS。
- **沉淀**: 「z.record(...).refine(数量上限)」反模式第三次命中(env×2 + 权限表)—— **同一反模式在多 IPC schema 反复出现,应一次抽够通用**(makeBoundedRecordValidator 泛化 value 校验为回调,覆盖 string-value 与 object-value record)。codex 连三轮(E185→E186→E187)逐个揪同型,印证抽共享时要按「最通用形态」(任意 value 校验)而非只解决当前 value 类型,否则下个 value 类型的兄弟入口又得重抽。中和一处令三消费者测试失败=单一来源已闭环。

## E188 — RegisterPayloadSchema.jsonSchema z.record(z.unknown())+refine,assertJsonValue 上限来得太晚 (P2)

- **问题**: `electron/shared/plugin-mcp-schemas.ts:33`(z.record+refine 族第四/末例)。jsonSchema `z.record(z.unknown()).refine(s => assertJsonValue(s) + byte cap)` —— z.record 先 O(N) 全量遍历整个 schema 对象(Object.keys + 每 key z.unknown 校验),assertJsonValue 的对象 key/字节上限(E184)在 refine 中才跑、来得太晚。绕过 renderer PluginMcpRegistry 预检的畸形 IPC payload 用巨 jsonSchema 在 main schema 阶段 O(N) 卡顿/分配。
- **亲读 + 我已预判**: E187 后我主动 grep 确认这是仅剩的 z.record,判其较缓(z.unknown 值不深校验 + assertJsonValue 已 E183/E184 限幅)未主动修;codex 如期报出。
- **修复**: `z.custom<Record<string,unknown>>().superRefine`:先 plain object/非数组守卫(替代 z.record 的对象判定 + 拒 null/数组/原语),再 `assertJsonValue(s)`(E183/E184 数组 length + 对象 key 数早停上限)+ UTF-8 字节上限。去掉 z.record 的前置全量遍历;assertJsonValue 的 E184 对象宽度上限现在是第一道遍历(早停)。
- **测试**: ipc-protocol.spec 既有(数组/string/Infinity/undefined/byte-cap jsonSchema → fail)经新 superRefine 保持;+E188×3(null / 数字 / 含 sparse 数组值经 assertJsonValue 拒)。sparse 数组用 `delete x[1]` 构造避 no-sparse-arrays lint。中和 plain-object 守卫 → 4 测失败,4427 PASS(1 已知 flake 隔离通过)。
- **沉淀**: z.record+refine 反模式**全族收敛**(E185 terminal env → E186 shell env → E187 权限表 → E188 jsonSchema,4 入口)。**用 z.record 仅为「确认是对象」却付出全量遍历代价时,改 z.custom + superRefine 手动 plain-object 守卫**,把真正的限幅(assertJsonValue/字节/条目早停)前置为第一道遍历。E183/E184 给 assertJsonValue 加的容器宽度上限,在此成为 jsonSchema 的有效早停闸(底层 helper 加固后,上层去掉冗余 z.record 即自动受益)。

## E189 — hasFiles 用 Array.from(dataTransfer.types).includes 在高频拖放事件全量物化 (P2)

- **问题**: `src/panels/Terminal/useTerminalDragDrop.ts:24`(E176 同族有界遍历)。`hasFiles` = `Array.from(dataTransfer.types).includes('Files')`,在 dragenter/dragover/drop **高频同步事件**每次全量物化 types 列表。畸形/超大 DataTransfer.types(恶意拖放源可塞大量 format)→ 每次事件全量分配数组 → renderer 卡顿(终端文件列表本身已有 bounded capture,types 检查漏)。同仓其它拖放路径已避免全量物化(E176)。
- **修复**: hasFiles 改按索引遍历 `for (i<types.length)` + 命中 'Files' 即短路 return,零额外数组分配(不 Array.from)。**不对 'Files' 搜索设 count 上限**(否则 'Files' 在靠后位置会假阴性 → 漏处理 drop);无 Files 时 O(N) 索引遍历但无分配。DEV debug 日志的 `Array.from(dataTransfer.types)` 改 boundedTypes(只读前 32 项,不全量)。
- **测试**: drag-drop.spec(导出 hasFiles)+E189×3(Files 任意位置/不含/null/空 → 正确;Proxy 计 index 读:命中 Files 即停 reads===1;超大无 Files reads===5000 但无 Array.from 整组拷贝)。中和回 Array.from → 短路+读计数测失败,4430 PASS。
- **沉淀**: 有界遍历族(E114/E118/E176/E189)——**高频事件回调里的 `Array.from(domList).includes/some` 是每事件全量分配热点**,改索引循环 + 短路(零分配)。`.includes/some(x)` 这类「找一个就够」的检查永远不该先 `Array.from` 物化整个 list。短路搜索**不能为「有界」而设 count 上限**(目标可能在任意位置,截断 = 假阴性破坏正确性);有界化体现在「不分配」而非「不遍历」。DEV-only 日志的全量物化也截断(防开发环境复现)。

## E190 — windowOpenHandler window.open url 无长度上限,先 new URL + openExternal (P2)

- **问题**: `electron/main/index.ts:211`。`windowOpenHandler({url})` 直接 `new URL(url)` 解析,deny 分支白名单通过后 `shell.openExternal(url)`,url 无类型/长度上限。renderer/插件或不受信链接(target=_blank / marketplace authorUrl / 评论 url)可触发超长 http(s) URL → 主进程先做大字符串 URL 解析,并可能把巨大 URL 交系统协议处理器。绕过 shell.openExternal IPC 的 2048 schema(那是 renderer→main invoke 路径,window.open 走的是 setWindowOpenHandler 另一条)与 Markdown 外链上限(E179)。
- **亲读**: window.open(HandlerDetails.url)是独立于 IPC openExternal 的入口,无前置长度闸。
- **修复**: 抽**共享** `MAX_EXTERNAL_URL_LEN=2048`(electron/shared/url-limits.ts)。windowOpenHandler 首行 `typeof url !== 'string' || length===0 || length > MAX_EXTERNAL_URL_LEN` → `{action:'deny'}`,先于 new URL / openExternal。**收口**:shell.ipc OpenExternalInput 的 `.max(2048)` 字面量 + link-resolve(E179)的 local 2048 都改用共享 MAX_EXTERNAL_URL_LEN(三处单一来源)。
- **测试**: external-url-scheme-whitelist.spec +E190×2(静态守卫:index.ts windowOpenHandler 有 `url.length > MAX_EXTERNAL_URL_LEN` 且在 `new URL(url)` 之前;共享常量 = 2048)。index.ts 顶层 app 副作用不可 import(E146)→ 静态源守卫(沿用该 spec 既有模式)。link-resolve/shell-ipc 既有 2048 测试经共享常量保持。中和 windowOpenHandler 守卫 → 2 测失败,4432 PASS。
- **沉淀**: 外链长度上限族(E152 extractProtocolUrl / E179 Markdown link / E190 window.open)——**同一资源(外部 URL)有多个入口(IPC openExternal / window.open setWindowOpenHandler / Markdown link / argv protocol),每个都要前置长度闸**(E182 「按行为而非位置 grep 兄弟」同律)。多处 2048 字面量收口到共享 MAX_EXTERNAL_URL_LEN(单一来源)。长度闸须在第一个 O(n)(new URL 解析)之前(E152/E179 上限前置律)。

## E191 — spike-gate spikeAllowed 对导航 url 无长度上限 + 日志写完整 url (P2)

- **问题**: `electron/main/spike-gate.ts:21`。`spikeAllowed()` 对 url 直接 `/[?&]spike=/.test(url)`,在**每次导航**(will-navigate/will-frame-navigate)运行;guardNav/guardOpen 阻止时 `console.warn(..., {url})` 写完整 url。无类型/长度上限 → 畸形超长导航 URL 每次导航守卫 O(N) 正则扫描 + 完整字符串进日志(绕过 windowOpenHandler E190 的外链长度闸,因导航是另一入口)。
- **亲读**: 正则 `/[?&]spike=/` 是线性(非回溯,非 ReDoS),但 O(N) 扫描每导航重复;日志 echo 是放大(E148 族)。
- **修复**: 定义 `MAX_NAV_URL_LEN=8192`(导航 URL = renderer file URL + workspace≤2048/windowSeq/spike query,留足余量)。hasSpikeQuery 前置 `typeof url === 'string' && url.length <= MAX_NAV_URL_LEN`(超长不跑正则,视为无 spike → packaged 下仍由 env-missing 拦)。`capUrlForLog`(截断 256 + …)用于两处 console.warn,日志只记摘要。
- **测试**: spike-gate.spec +E191×3(超长含 spike= → env-missing 不扫描 / 上限内含 spike= → packaged-blocked 回归 / guardNav 超长 url 日志只记截断摘要不写完整)。中和长度闸 + 日志截断 → 2 测失败,4435 PASS。
- **沉淀**: 外部 URL 入口族再扩(E152 argv / E179 Markdown / E190 window.open / E191 导航守卫)——**导航守卫(will-navigate)是又一个每事件跑、url 来自外部的高频入口**,正则/扫描前须长度闸(即便正则线性,O(N)×每导航 仍是放大;且日志 echo 须截断)。E148 echo 放大族延伸到导航日志:阻止/拒绝类日志不回显完整外部 url,只记截断摘要。同一资源(URL)的每个新入口都要补这套(长度闸 + 日志截断)。

## E192 — pickArgvFolders argv.slice(start) 在循环截断前全量复制尾部 (P2)

- **问题**: `electron/main/services/cli-args.service.ts:35`。`for (const p of argv.slice(start))` 先把 `argv` 从 start 起的整个尾部复制成新数组,然后才在循环体内 `if (dirs.length >= MAX_STARTUP_DIRS) break` 截断。畸形超长 `process.argv`(冷启动拖大量路径)会在进入主逻辑前物化整个尾部数组 → 不必要内存峰值,削弱"目录数到顶"的边界保护(数量闸只在 slice 之后才生效)。
- **亲读**: slice 复制是 O(N) 一次性分配;数量闸 MAX_STARTUP_DIRS=32 已挡同步 stat,但 slice 发生在闸之前。P2-latent(冷启动 argv 通常很短),属有界迭代族(E176/E189)。
- **修复**: 改索引遍历原数组 `for (let i = start; i < argv.length; i++) { if (dirs.length >= MAX_STARTUP_DIRS) break; const p = argv[i]; ... }`。凑满即 break,绝不复制尾部。
- **测试**: cli-args-folder.spec +E192×2(Proxy 包 argv,访问 `.slice` 即抛 → 证实现不 slice / 索引遍历仍尊重 start 偏移 skipFirstArg)。中和回 slice 版 → Proxy 测失败,4437 PASS。
- **沉淀**: 有界迭代族再扩(E176 Array.from→index loop / E189 / E192 argv.slice→index loop)——**"先截断后遍历"的循环,截断闸必须在每次迭代体内,且遍历不得先全量复制集合**(slice/Array.from/Object.entries 都在闸之前分配)。凡"凑满 N 即 break"的收集,用原集合 + 索引/迭代器推进,不预先物化子集。Proxy throw-on-method 是验"不调用某 O(N) 方法"的干净中和手段。

## E193 — initial-workspace paramsOf 无长度上限 + 启动时重复解析三次 (P2)

- **问题**: `src/lib/initial-workspace.ts:15`。`paramsOf(search)` 在 `new URLSearchParams(normalized)` 前无长度上限;且 main-app 启动早期 `parseInitialWorkspace` / `parseInitialWindowSeq` / `parseInitialFresh` 各调 `paramsOf` 一次 → 同一畸形超长 `location.search` 被 URLSearchParams 解析三次,早于任何 workspace/windowSeq 字段级校验就产生 CPU/内存峰值。
- **亲读**: paramsOf 是三个 parse 函数的单一入口(单一来源)。URLSearchParams 解析是 O(N)。P2-latent(location.search 通常由 main 构造,但 renderer 启动入口属外部可控面)。
- **修复**: 加 `MAX_STARTUP_QUERY_LEN=65536`(workspace 路径 ≤ FS_PATH_MAX 8192,URL-encode 最坏 ~3×,加其它小参数,64KiB 留足余量)。paramsOf 在 `new URLSearchParams` 之前 `if (search.length > MAX_STARTUP_QUERY_LEN) return null` —— 超长直接当无 query,三个调用者各返默认(null/0/false),绝不重复解析。
- **测试**: initial-workspace.spec +E193×4(超长 query → 三个 parse 各返默认 / 上限内正常长 query 三处照常解析回归)。中和去长度闸 → 3 测失败,4441 PASS。
- **沉淀**: 外部输入长度上限族再扩(E152 argv / E179 Markdown / E190 window.open / E191 导航守卫 / E193 启动 query)——**被多个入口共用的解析 helper(单一来源),长度闸加在 helper 内即一次覆盖所有调用者**;尤其"同一外部串被 N 个字段解析器各调一次"时,闸前置在共享 helper 比每个调用点各加更省且不漏。URLSearchParams/new URL 等 O(N) 解析前都须长度闸。

## E194 — main.tsx thin-entry spike 判定绕过启动 query 长度上限 (P2,E193 兄弟入口)

- **问题**: `src/main.tsx:6`。thin-entry 在导入 main-app 前直接 `new URLSearchParams(location.search).get('spike')` 判定 spike,没复用 E193 给 `initial-workspace` 加的启动 query 长度上限。畸形超长 `location.search` 仍会在 renderer **最早**入口被完整解析一次,绕过后续 parseInitial* 的保护。
- **亲读**: 这是 E193 的兄弟入口(同一外部 `location.search` 的另一个解析点)。thin-entry(topic-45)刻意零静态 import 以分离 spike/main-app chunk —— 但 AST 契约只约束 `main-app.ts`,不约束 `main.tsx`;且 `initial-workspace.ts` 是零依赖纯模块,静态 import 不会拉入 main-app/spike chunk(thin-entry.spec 的"spike 路由不拉 main-app"仍绿)。
- **修复**: 把 E193 的 paramsOf 提为导出 helper `safeStartupParams(search)`(单一来源,内含长度闸),`parseInitialWorkspace/WindowSeq/Fresh` 三处改用它;main.tsx 改 `safeStartupParams(location.search)?.get('spike') === 'plugin-isolation'`。超长 query → 返 null → 当非 spike → 加载 main-app,绝不在最早入口解析超长串。
- **测试**: thin-entry.spec +E194×1(含 spike= 但整体超长的 location.search → 不命中 spike,路由 main-app)。中和 main.tsx 回裸 URLSearchParams → 该测失败,4442 PASS。
- **沉淀**: 外部输入长度上限族 + "修一族必 grep 兄弟入口"合流 —— **同一外部串(location.search)的每个独立解析点都要走同一个带闸的 helper**。E193 在共享 helper 内加闸后,仍有 main.tsx 这个**更早、独立**的解析点没接入(thin-entry 为分 chunk 故意不 import main-app,导致它绕过了 helper)。修 helper 后必 grep 该外部串的所有 `new URLSearchParams(...)/new URL(...)` 直接构造点,逐一改用带闸 helper(零依赖纯 helper 可安全注入 thin-entry,不破 chunk 契约)。

## E195 — popout-mode isPopoutWindow/popoutUrlFor 绕过启动 query 长度上限 (P2,E193/E194 兄弟入口)

- **问题**: `src/lib/popout-mode.ts:7`。`isPopoutWindow()` 直接 `new URLSearchParams(window.location.search)`,未复用 E193/E194 的 `safeStartupParams` 长度闸。该函数在**每次 App 渲染**时调用(App.tsx:187 `isPopoutWindow() ? <PopoutHost/> : <MainApp/>`)→ 畸形超长 `location.search` 每次渲染被完整解析一次,绕过同一外部输入族(E193 parseInitial* / E194 main.tsx spike)的保护。`popoutUrlFor(window.location.href)`(HeaderActions:107 用户点击 popout 时)同样会把超长 query 带进 popout 子窗 URL → 子窗每次渲染又解析一次。
- **亲读**: isPopoutWindow 是 render-path 无条件解析(每渲染),popoutUrlFor 是用户点击触发(一次)。两者都读同一外部串 `window.location.search`/`.href`。popout-mode.ts 原零依赖,导入零依赖纯模块 initial-workspace 安全。
- **修复**: isPopoutWindow 改 `safeStartupParams(window.location.search)?.get(POPOUT_FLAG) === '1'`(超长 → null → 非 popout → 默认主窗)。popoutUrlFor 加 `if (url.search.length > MAX_STARTUP_QUERY_LEN) url.search = ''`(畸形超长 query 必非法,清空后再附 popout 标记 → 不携带进子窗,挡住子窗的重复解析)。
- **测试**: popout-mode.spec +E195×5(isPopoutWindow 超长→false / 上限内 popout=1→true / 无 window→false / popoutUrlFor 超长 query→清空仍附 popout=1 / 上限内 query→保留回归)。中和两处闸 → 2 测失败,4447 PASS(known flake stop-hook-unknown-window 隔离重跑全过,无关)。
- **沉淀**: 外部输入长度上限族 + "修一族必 grep 兄弟入口"再合流(E193 helper 内加闸 → E194 main.tsx 漏 → E195 popout-mode 漏)——**同一外部串(location.search/href)的每个解析点都是独立入口,逐轮被 codex 揪出**。修共享 helper 后须对该外部串全仓 grep `new URLSearchParams(...)/new URL(...)` 逐个改接 helper;尤其 render-path 无条件解析(每渲染调)比一次性解析更值得优先。**清空而非拒绝**是另一种降级:超长 query 必畸形,从 popout 子窗 URL 中剥离(保留功能标记)优于拒绝整个操作。

## E196 — 主进程 isPopoutUrl + safe-handle frame.url 信任判定无 URL 长度上限 (P2,E195 主进程对偶)

- **问题**: `electron/main/popout-url.ts:9` `isPopoutUrl(rawUrl)` 直接 `new URL(rawUrl)` 无类型/长度上限,在窗口创建(index.ts:493)/ agent-auth 选主窗(agent-auth.service.ts:35,60)/ MCP fallback 选窗口(mcp-stdio-server.service.ts:263)等热路径对 `webContents.getURL()` 反复调用 → 畸形超长窗口 URL 反复完整解析,与 renderer 侧 isPopoutWindow(E195)长度闸不对称。**兄弟**:`safe-handle.ts` 的 `isTrustedRendererFileUrl`(line 68)+ `defaultIsTrustedFrame`(line 150)在**每次 IPC** 调用对 `frame.url` 做两处 `new URL`,同样无闸。
- **亲读**: grep 全部 `getURL()` 调用点,均经 isPopoutUrl(单一 helper);grep 全部主进程 `new URL`,protocol-argv(E152)/ windowOpenHandler(E190)已护,index.ts:356 是 dev env 内部值。safe-handle 两处是真兄弟(热路径无闸 new URL on 受控 frame.url)。
- **修复**: 新增共享 `MAX_WINDOW_URL_LEN=65536`(electron/shared/url-limits.ts;窗口 URL = file:// + 启动 query,query 部分 renderer 侧 cap 64KiB,故全长取同量级)。isPopoutUrl 在 new URL 前 `typeof + length` 闸,超长返 false。safe-handle 两函数 fail-closed:超长 frame.url 视为**不受信**(返 false)——安全默认(超长 URL 不该被信任),defaultIsTrustedFrame 顶部统一加闸覆盖下游 dev origin 比较分支。
- **测试**: popout-url-detection.spec +E196×3(超长→false / 非字符串→false / 上限内回归);security-file-url-trust.spec +同族×3(未注册超长→false 不再宽松 / 注册后超长→false fail-closed / 上限内回归)。中和各闸 → 共 3 测失败,4453 PASS。
- **沉淀**: 外部输入长度上限族跨进程对偶(renderer src E193-E195 ↔ main electron E196)——**同一概念(popout/窗口 URL 判定)在两进程各有实现,renderer 加闸后主进程对偶也要加**。主进程信任判定函数加长度闸必 **fail-closed**(超长=不受信),与 renderer 侧"超长=非 popout/默认主窗"的安全方向一致。"修一族必 grep 兄弟入口"在主进程体现为:grep 全部 `getURL()` 调用点确认收口单一 helper + grep 全部 `new URL` 确认其余已护或内部值;每个独立信任/解析入口都要加同一闸。

## E197 — isValidAggregateRecord Object.keys/entries 在 key 数上限前全量物化两次 (P2)

- **问题**: `src/marketplace/reviews-types.ts:148`。`isValidAggregateRecord()` 先 `Object.keys(d).length > MAX_AGGREGATE_KEYS`(全量物化所有 key 成数组)再判上限,然后 `Object.entries(d).every(...)`(再物化一次 key+value 对)。篡改 sessionStorage 缓存可在 16MiB raw cap 内塞海量短 key → Marketplace 打开时(reviewsCache.validate=isValidAggregateRecord)两次全量物化 → renderer 内存/CPU 峰值,削弱 key 数上限(上限在物化之后才生效)。
- **亲读**: 有界迭代族(E176 Array.from / E189 / E192 argv.slice)。reviews-types.ts 与 plugin-id.ts 下游校验器(isValidAggregate/isValidReview/isValidPluginId)均不用 Object.keys/entries → spy 断言干净。
- **修复**: 改单次 `for...in` + `Object.prototype.hasOwnProperty.call` 惰性遍历:边计数边校验,`count > MAX_AGGREGATE_KEYS` 立即 false(不继续遍历/物化),每个 value 当场 isValidAggregate + key===pluginId 校验。行为等价(同阈值、同 short-circuit),仅去掉两次全量物化。
- **测试**: reviews-parser.spec +E197×6(spy 断言不调 Object.keys/entries=单次遍历 / 2001 全合法→false 计数超限 / 恰好 2000→true 边界回归 / key≠pluginId→false E113 回归 / value 非法→false / 空{}→true 非对象数组→false)。中和回 Object.keys/entries 版 → spy 测失败(行为测因同阈值不区分,spy 测捕获实现差异),4459 PASS。
- **沉淀**: 有界迭代族再扩(E176/E189/E192/E197)——**"有上限的集合校验"先 Object.keys/entries/values 物化再判 length 上限 = 上限失效**(物化已发生)。改 for...in 惰性遍历 + 计数超限立即返回 + 边遍历边校验。**性能型修复行为等价、纯行为测不可中和区分(同阈值同短路),须用 spy(断言不调 Object.keys/entries)或 Proxy 捕获实现差异**(同 E192 Proxy throw-on-slice)。校验器单一来源:确认下游校验器不用 Object.* 才能让 spy 断言干净。

## E198 — readRecord constrained 路径 Object.entries 在 maxEntries 前全量物化 (P2,E197 兄弟入口)

- **问题**: `src/plugins/storage/local-storage-record.ts:51`。`readRecord()` constrained 路径 `for (const [k,v] of Object.entries(parsed))` 把 localStorage JSON 对象所有键值对全量物化成数组,然后循环里才 `n >= maxEntries break`。被篡改的 localStorage(E70 的 1MiB raw cap 是 backstop,但其内可塞数万短 key)→ Settings/Keybindings 启动 / `storage` 跨窗同步事件时全量物化 → renderer 内存/CPU 峰值,削弱 maxEntries 上限。
- **亲读**: E197 的精确兄弟(同为"Object.entries 物化后才判条目上限")。**我在 E197 grep 兄弟时漏了它**——E197 grep 找的是 `Object.keys(...).length > MAX` 模式,而本处是 `Object.entries` + 循环内 `break`,结构不同未命中。codex 下一轮即揪出。
- **修复**: 改单次 `for...in` + `Object.prototype.hasOwnProperty.call`:边计数边过滤(maxKeyLength/valueGuard skip 不计数),`n >= maxEntries` 立即 break,不全量物化。行为等价(同插入序、skip 不计数、同截断)。
- **测试**: local-storage-record-guard.spec +E198×3(spy 断言不调 Object.entries / maxEntries 截断保留插入序前 N / skip 不计数凑满合法项才 break)。**web-compat-allowlist 行号同步更新**(修复 +6 行使 writeRecord 的 globalThis 67/69→73/75,E180 同类纪律,否则 web-compat.spec T5 审计失败)。中和回 Object.entries 版 → spy 测 + web-compat 行号测共 2 失败,4462 PASS。
- **沉淀**: 有界迭代族再扩(E176/E189/E192/E197/E198)。**关键教训:grep 兄弟入口要按"行为/语义"而非"字面模式"**——E197 我只 grep `Object.keys().length > MAX` 字面,漏了同族但结构不同的 `Object.entries`+循环内 break(E198)。物化-后-判上限有多种写法(`Object.keys().length>MAX` / `Object.entries().every` / `for...of Object.entries() {...break}`),grep 须覆盖 `Object.keys|entries|values|Array.from` **所有** 物化调用 + 人工核对每处是否"物化在上限/早退之前"。修改行数的文件凡含 globalThis/受限 API,必同步 web-compat-allowlist 行号(E180)。

### E198 附:family grep 抓到 scoped-app.ts env 兄弟(同轮一并修)

- 按 E198 教训("grep 须覆盖所有物化调用 + 人工核对物化是否在上限之前")全仓 grep `Object.keys|entries|values|Array.from`,抓到 **`src/plugins/scoped-app.ts:85`**:`const keys = Object.keys(rec); if (keys.length > SHELL_ENV_MAX_ENTRIES) bad(...)` —— 插件 `app.shell.exec` 传入的 env 在条目上限前被 Object.keys 全量物化(再 for-of 又遍历一次)。同族,codex 尚未报告,本轮一并修。
- 修复:改单次 for...in + hasOwnProperty,边计数边校验(count > MAX 立即 bad()),不 Object.keys 物化。行为等价(同上限、同 bad()、超长 key/非字符串 value 仍拒)。
- 测试:scoped-app.spec +E198×2(env 超上限→BAD_INPUT 且 exec 路径 Object.keys 调用计数=0 / 上限内超长 key·非字符串 value 仍拒回归)。**spy 计数须在 await 后、任何 vitest 匹配器(rejects/toMatchObject 自身调 Object.keys)之前立即读取**,否则匹配器机制污染计数(本轮踩坑:`expect(spy).not.toHaveBeenCalled()` 被 rejects 匹配器调用 2 次而误失败 → 改 try/catch 捕获 err + 立即读 mock.calls.length)。
- web-compat-allowlist 二次同步:scoped-app fix +4 行使 globalThis 注释命中 259→263(E180 纪律)。
- 其它物化调用核对(均非本族,排除):registries/EventBus/terminal Array.from(内部有界 Map/Set);DOM querySelectorAll;reviews-fetcher new Map(Object.entries(已 E197 校验过的 ≤MAX record));spike-gate/index.ts Object.entries(内部构造的 query);IpcPermissionStore Object.entries(raw)(**无既有上限**,属"缺上限"而非"物化在上限前",不同族 → 不在本轮 scope,如需加 maxEntries 是单独设计决策)。

## E199 — 主进程 readPermissions/readAllPathScopes Object.entries 在 key 上限前全量物化 (P2,E197/E198 主进程对偶)

- **问题**: `electron/main/services/plugins.service.ts:414`(readPermissions)+ `:558`(readAllPathScopes)。两者各有 key 数上限(MAX_PERMISSION_PLUGIN_KEYS=10000 / MAX_PERSISTED_PLUGIN_KEYS=4096),但循环前 `Object.entries(json)` 把 `_permissions.json` / `_plugin-path-scopes.json` 所有 plugin key 全量物化成数组再 break。被污染的旧数据文件(E68 raw-size cap 是 backstop,但其内可塞大量短 key)→ 启动 / 授权读取时主进程内存/CPU 峰值,削弱 key 数到顶。
- **亲读**: E197/E198 的主进程对偶(同为"Object.entries 物化后才 break")。codex 一并指出 readAllPathScopes 兄弟。两函数同模式。
- **修复**: 都改单次 `for...in` + `Object.prototype.hasOwnProperty.call`,`const value = rec0[pid]` 取值,边校验(isSafePluginId/key 长度/value 形态)边计数,`keyCount >= MAX` 立即 break。行为等价(同上限、同 skip 语义、E86/E87 canonicalize 全保留)。
- **测试**: plugins-service.spec +E199×2(readPermissions / readAllPathScopes 经 readPluginPathScopes 各:不对目标 permissions/scopes 对象调 Object.entries + 行为回归)。中和回 Object.entries 版 → 2 测失败,4466 PASS。
- **沉淀**: 有界迭代族跨进程对偶完整(renderer E197 reviews-types / E198 local-storage+scoped-app ↔ main E199 plugins.service ×2)。**关键:主进程 async fs 函数的"不调 Object.entries"断言不能用全局 `vi.spyOn(Object,'entries')` 计数**——Object 是全局,async await 期间全套并行的其它测试文件会调 Object.entries 污染计数(本轮踩坑:readAllPathScopes 计数被污染误失败,隔离重跑 0)。改 **spy 筛选**:`spy.mock.calls.some(c => 含测试专属 key 'com.a'/'com.b' in c[0])`——只认以目标对象为参的调用,免污染且精确捕获物化(中和版调 `Object.entries(json)` 即命中)。剩余 IpcPermissionStore.parsePermissionState 的 `Object.entries(raw)` 无既有 key 上限(属"缺上限"非"物化在上限前"),不同族,不在本轮 scope。

## E200 — assertJsonValue 经 obj[k] 读 getter 校验,与调用方 JSON.stringify 二次求值不一致 (P1)

- **问题**: `electron/shared/assert-json-value.ts:96`。object 分支取描述符判枚举性后,`assertJsonValue(obj[k], ...)` 用 `obj[k]` 取值——对 **accessor(getter)属性会执行 getter**。校验通过后调用方 `JSON.stringify(value)` 会**再次执行 getter**。恶意/畸形对象 `{ get x() { return 第一次小JSON-safe值;第二次超大/非JSON-safe值 } }` 可让"校验时"看到合法小值、"序列化时"落超大/非 JSON-safe/不同内容 → stringify 内存放大 OR 落盘内容与校验对象不一致(数据完整性 TOCTOU)。P1。
- **亲读**: assertJsonValue 是 renderer 预检 + main 兜底的 JSON-safe 单一 helper(plugin saveData / MCP jsonSchema 共用)。getter-TOCTOU 仅此一处——其它校验器(E197 isValidAggregateRecord 等)读的是 JSON.parse 产物(只含 data property,无 getter)。
- **修复**: 要求 data property —— `if (!('value' in desc)) throw 'accessor...'`(accessor 描述符无 `value` 字段,data 描述符有),拒 getter/setter;递归校验 `desc.value`(getOwnPropertyDescriptor 取的是快照值,**只求值一次**),不再 `obj[k]`。data-property 对象行为不变(desc.value === obj[k]),仅 accessor 被拒(fail-closed,合法 JSON 数据本就只有 data property)。
- **测试**: assert-json-value-sparse.spec +E200×4(enumerable getter→抛 accessor / getter 两次返不同值→校验阶段即拒且 getter 调用计数=0 证不执行 / setter-only→抛 / data 属性回归 ok)。中和回 obj[k] → 3 测失败,4470 PASS。
- **沉淀**: 数据完整性"校验↔使用 二次求值不一致"族(E103 stringify 静默改写 / E136 非 plain object / E140 symbol+非枚举 / E200 getter TOCTOU)。**凡"先校验值再由调用方序列化/落盘"的 helper,取值必须用 `Object.getOwnPropertyDescriptor(obj,k).value`(快照,求值一次)而非 `obj[k]`(对 accessor 重复执行 getter)**——否则 getter 可在校验与使用之间返回不同值。JSON-safe 校验应拒一切 accessor(合法 JSON 数据只有 data property)。getter 调用计数=0 是验"校验从不触碰 getter"的干净断言。

## E201 — makeBoundedRecordValidator 未拒 symbol/non-enumerable key (P2,DEFER — user 定夺)

- **codex 报告**: `electron/shared/validate-env-bounded.ts:30`。makeBoundedRecordValidator() 只 for...in 校验 enumerable string key,未拒 symbol key / non-enumerable own property;这些属性通过校验但被 JSON.stringify/对象展开跳过,调用方可能以为整对象已边界校验。建议用 Reflect.ownKeys/descriptor 拒 symbol+non-enumerable。
- **亲读结论:DEFER(经 user 定夺 2026-06-26,选项「DEFER + 注释 flag」)**。理由三条:
  1. **不可达**:全部 3 个消费者(shell.ipc / terminal-create / plugins.ipc)都是 **IPC ingress 的 zod schema**,在 main 校验经 structured clone 的对象。Electron structured clone **不复制 symbol key、不复制 non-enumerable own property** → 这些属性在校验器运行前已被剥离,校验器永远见不到。
  2. **语义一致无分歧**:for...in(enumerable string own key)与所有真实消费者(JSON.stringify / structured clone / spawn env)枚举语义一致,三者同样跳过 symbol/non-enumerable,无"校验↔使用"分歧(区别于 E200 getter 的真分歧)。
  3. **抵触 E185 刻意设计**:本工厂的全部意义是 early-stop(达 maxEntries+1 即拒、不全量物化)。捕获 non-enumerable string key 必须 getOwnPropertyNames 全量物化,直接回退 E185 防放大 —— codex remedy 与既有刻意注释的设计冲突。
- **与 assert-json-value(E140/E200)的区别**:那里校验同进程待 stringify 的**活对象**(可含 symbol/非枚举,且校验对象==stringify 对象),故须显式拒;这里是 **post-IPC 已净化对象** + early-stop 契约,语义不同。
- **处置**: 代码内加 DEFER flag 注释(说明三条理由 + 与 E140/E200 区别),不改 for...in,不动 E185。无测试改动。typecheck + lint 绿。
- **沉淀**: codex 的"同族泛化"建议须经**可达性 + 与既有刻意设计是否冲突**双重亲读分流 —— 同一表面模式(for...in vs Reflect.ownKeys)在不同上下文判定相反:E140/E200(同进程活对象,校验==使用)该拒,E201(post-IPC 净化对象 + early-stop 契约)该 DEFER。"架构权衡反转刻意设计"→ 停问 user(本轮首次在 edge-case 方向触发 user 决策)。

## E202 — MCP create_session 用协议 schema 校验本工具不消费的 args/env(无上限解析放大面)(P2)

- **问题**: `electron/main/services/mcp-tools-terminal.ts:201`。Continuo 的 create_session MCP 工具 `inputSchema: createSessionInputSchema`(协议包 schema)。该 schema 含 `args: z.array(z.string())` / `env: z.record(z.string(),z.string())` **无数量/长度上限** + shell/cols/rows。但本工具 run() 构造 ptyInput 只消费 cwd/name/agentLabel/autorun/target/install_stop_hook/include_raw,**完全不消费** shell/args/cols/rows/env。外部 MCP client 可在 1MB body 塞海量 args/env → mcp-host `tool.inputSchema.safeParse(args)` 在工具执行前 zod 全量深校验这些数组/record(z.array 遍历每元素、z.record 校验每条目),随即被本工具丢弃 = 纯解析放大面。
- **亲读**: 协议包(node_modules/@continuo-terminal/protocol)是与 server-node 的**共享契约**——server-node 的 create_session **确实**消费 shell/args/env(spawn PTY),故协议 schema 含它们是对的,**不可改协议包**。放大面只在 Continuo 这个不消费的消费者。advertised jsonSchema(本工具 additionalProperties:false)已只列消费字段——inputSchema(zod)与之不一致。
- **修复**: Continuo 侧 `createSessionInputSchema.omit({ shell, args, cols, rows, env })`(协议 schema 是 `.strict()`,.omit 保留 strict)→ 这些未消费字段成 unrecognized key 被 **strict 浅拒**(不深校验数组/record 内容),消除放大;inputSchema 与 advertised jsonSchema 对齐。工具类型 `McpTool<CreateSessionBoundedInput, ...>`(z.infer 收窄,run 只读消费字段,类型安全)。
- **测试**: create-session.spec 改 E202(原"inputSchema 是 createSessionInputSchema"测试 →"拒绝未消费字段 args/env/shell/cols/rows" + 消费字段照常 + 协议原 schema 仍接受 args 作对比)。中和回协议 schema → 该测失败,4470 PASS。
- **沉淀**: "无消费的解析放大面"族 —— **复用上游/共享 schema 校验输入时,若本消费者只用其中子集,未消费字段(尤其无上限的 array/record)仍被 zod 深校验=放大面**。修法:从共享 schema `.omit()`/`.pick()` 出本消费者的 bounded schema(strict 下浅拒未消费字段,不深校验),与 advertised jsonSchema 对齐。**不改共享/上游契约**(其它消费者如 server-node 真消费这些字段)——收窄放在本地消费者。zod `.omit/.pick` 保留 `.strict()` unknownKeys 策略。

## E203 — MCP terminal tools 的 session_id 无长度上限(协议 schema min(1) 无 max)(P2)

- **问题**: `electron/main/services/mcp-tools-terminal.ts`(send_input/send_text/press_key/read_output/kill)+ `mcp-tools-hook-bridge.ts`(await_stop_hook)。各工具 inputSchema 用协议包 schema,session_id 为 `z.string().min(1)` **无 .max**(jsonSchema 也只 minLength:1)。外部 MCP client 可传 1MB session_id,zod 校验通过后进 deps.has/getSessionOwner/write/read/kill 等 Map/lookup,错误回显虽已截断(E148/E151),运行期仍反复处理超长 key。
- **亲读**: E202 同类(协议 schema 共享,server-node 也消费,不可改协议包)+ session_id 长度族。session id 形如 `term-<uuid>`(~40 字符)。仓内已有 `SESSION_ID_MAX=256` 散落两份副本(terminal.ipc.ts / terminal.store.ts)。
- **修复**: 新建共享单一来源 `electron/shared/session-id-limits.ts`(SESSION_ID_MAX=256),收口两处既有副本(import 替换 local const,防漂移)。Continuo 侧对 6 个工具 schema `.extend({ session_id: z.string().min(1).max(SESSION_ID_MAX) })`(同 string 类型 → z.infer 不变 → 无需改工厂类型;await_stop_hook 的 .default() 字段保留)。不改协议包。
- **测试**: 6 工具 spec 各把"inputSchema 是 XxxInputSchema"身份测试改为"E203 session_id 超 256 → 拒 + 正常 id 通过 + 协议原 schema 仍接受"(对比);await_stop_hook 用 driver.tool.inputSchema 同款断言。中和去 .max → 6 测失败,4470 PASS。
- **沉淀**: 接 E202 "无消费/未约束的协议 schema 字段" —— 复用共享协议 schema 时,**即便字段被消费(session_id 进 lookup),协议层的宽松约束(min(1) 无 max)也须在本消费者按本地上限收窄**(.extend 同类型字段不改 z.infer,比 E202 的 .omit 改类型更轻)。收口散落的同义常量到 shared 单一来源(本轮 SESSION_ID_MAX 三处→一处:terminal.ipc/terminal.store/MCP tools 共用,防漂移)。session id 类标识字段:.min(1) 须配 .max。

## E204 — MCP terminal tools advertised jsonSchema 的 session_id 缺 maxLength(与运行时 inputSchema 不一致)(P2,E203 对偶)

- **问题**: `electron/main/services/mcp-tools-terminal.ts`(5 工具)+ `mcp-tools-hook-bridge.ts`(await_stop_hook)。E203 给运行时 zod inputSchema 的 session_id 加了 .max(SESSION_ID_MAX),但**公开 jsonSchema**(MCP client/LLM 经 tools/list 看到的入约)仍只声明 `minLength: 1`,无 maxLength。MCP client 据公开 schema 认为允许超长 session_id,调用时却被运行时私有 schema 拒 → advertised↔运行时不一致的畸形输入正确性问题(LLM 误以为合法的输入被拒)。
- **亲读**: E203 的 advertised 对偶(E202 omit 对齐的反向:那里收窄 zod 对齐已严的 jsonSchema;这里补 jsonSchema 对齐已收窄的 zod)。SESSION_ID_MAX 两文件已导入(E203)。
- **修复**: 6 个工具的 `jsonSchema.properties.session_id` 补 `maxLength: SESSION_ID_MAX`(jsonSchema 是普通对象字面量,直接用导入的 number 常量值)。advertised 与运行时 inputSchema 双向一致。
- **测试**: 6 工具 spec 的 E203 测试各加一行 `expect(JSON.stringify(tool.jsonSchema)).toContain('"maxLength":256')`。中和去 jsonSchema maxLength → 6 断言失败,4470 PASS。
- **沉淀**: MCP 工具的 **inputSchema(运行时 zod)与 jsonSchema(advertised tools/list)是同一约束的两份表示,任一侧改约束必同步另一侧** —— 否则 client 据 advertised 构造的合法输入被运行时拒(E204),或 advertised 过宽诱导放大(E202)。改 MCP 工具入参约束的 checklist:zod inputSchema + jsonSchema 两处都改。用 `JSON.stringify(jsonSchema).toContain(...)` 断言 advertised 侧避免深层类型转换。

## E205 — create_session 的 cwd/name/agentLabel/autorun 三层(jsonSchema↔zod↔run)长度上限漂移 (P2,E203/E204 同族)

- **问题**: `electron/main/services/mcp-tools-terminal.ts` create_session。cwd/name/agentLabel 的长度上限(PATH_MAX/LABEL_MAX)+ autorun(MCP_AUTORUN_MAX 字节)只在 run()(E32 手动 .length / utf8BytesExceed 检查)兜底;createSessionBoundedSchema 只 omit 未消费字段、没给这些字段 .max();advertised jsonSchema 也无 maxLength。→ MCP client/LLM 看到的入约允许超长字符串,调用时才在 run() 失败 = 公开 schema↔zod inputSchema↔运行时三层漂移。
- **亲读**: E203/E204 在 create_session 的延伸(那两个是 session_id;这个是 cwd/name/agentLabel/autorun)。MCP_AUTORUN_MAX 此前定义在 bounded schema **之后** → 移到之前(const TDZ,否则 .extend 引用报 ReferenceError)。
- **修复**: createSessionBoundedSchema `.extend({ cwd: z.string().max(PATH_MAX).optional(), name/agentLabel: .max(LABEL_MAX), autorun: .max(MCP_AUTORUN_MAX) })`(保留 .optional());advertised jsonSchema 补 `maxLength: PATH_MAX/LABEL_MAX/MCP_AUTORUN_MAX`。**run() 的 E32 检查保留**——defense-in-depth + 直调 run() 测试路径 + autorun 的精确 **byte** 检查(utf8BytesExceed)比 zod .max 的 code-unit 粗上限更准,仍由 run() 兜底(三层上限同值 MCP_AUTORUN_MAX,intent 一致)。
- **测试**: create-session.spec +E205×2(zod inputSchema 对 4 字段加上限 / advertised jsonSchema 同步 maxLength)。中和去 .extend + jsonSchema maxLength → 2 测失败,4472 PASS。
- **沉淀**: MCP 工具入参约束是 **三层**(advertised jsonSchema / zod inputSchema / run() 运行时手动检查)—— 任一字段的约束改动须三层对齐,否则 client 据 advertised 构造的"合法"输入在更深层被拒(漂移)。autorun 类需 **byte 精度**的字段:zod .max(code-unit)作粗上限 + run() utf8BytesExceed 作精确兜底,两者同值常量。const 被 schema 顶层引用须在 schema 定义之前声明(TDZ)。

## E206 — readEnabledIds json.every() 在数量上限前全量遍历数组 (P2,有界迭代族-数组变体)

- **问题**: `electron/main/services/plugins.service.ts:289`。`Array.isArray(json) && json.every((x) => typeof x === 'string')` 在 capped for...of 循环(凑满 MAX_ENABLED_IDS 即 break)之前先 `.every()` **全量遍历**数组校验每元素是字符串。畸形 `_enabled.json` 塞大量短字符串 → 启动 / enable·disable 读盘时 .every 完整扫描整个数组,削弱数量上限(MAX_ENABLED_IDS=4096)的防放大意图。E68 raw-size cap(~1MiB)是 backstop,但其内可塞数万短串。
- **亲读**: 有界迭代族(E197/E198/E199 对象 Object.entries;E206 是**数组** .every 变体)。测试契约:`['ok', 1]`(任一非字符串)→ `[]`(必须保留)。
- **修复**: 类型校验并入 capped 循环:`for (const x of json) { if (typeof x !== 'string') return []; ... if (out.length >= MAX_ENABLED_IDS) break; }`。遇非字符串即 `return []`(保持 .every 的"任一非字符串→整文件非法"契约 + 早停不续扫);全字符串则凑满 MAX 即停(不全量预扫)。
- **测试**: plugins-service.spec +E206×1(`[...4096 valid, 12345]` 末尾非字符串在上限之后 → 凑满 4096 即 break、从不扫到末尾 → 返 4096;中和回 .every 全扫到非字符串会返 [],该测失败)。既有 `['ok',1]→[]`(303)/ cap→4096(326)回归保留。4473 PASS。
- **沉淀**: 有界迭代族再扩(E176/E189/E192/E197/E198/E199/E206)——**数组校验的 `.every()/.some()` 在 cap/slice 之前是全量预扫,与 Object.keys/entries 物化同族**。改:类型/有效性校验折叠进 capped 循环,凑满即停;"任一无效→整体拒"的 every 契约用循环内 early-return 保留(早停 + 契约不变,仅"无效项在 cap 之后"的病态边界从拒→返前 N,可接受)。**codex 提示同文件还有 every/filter-before-slice 兄弟(line 427 array-form decisions `value.every(isDecision)`+slice / line 580 pathScopes `.filter(isIpcPathScope).slice()` / line 388/390 isPermissionRecordObject 守卫 .every)—— 均 per-plugin 数组、E68 文件大小 backstop,按一报一修协议待 codex 逐个报告时谨慎处理(.every 全有或全无 + 共享守卫契约,避免 bulk 改动 permission 校验引入回归)。**

## E207 — readPermissions decisions/pathScopes every() 在数量上限前全量扫描 + 上限后坏项丢整条 (P2,E206 兄弟)

- **问题**: `electron/main/services/plugins.service.ts:427`(array-form)+ isPermissionRecordObject(:388/390,object-form)。decisions 用 `value.every(isDecision)`、pathScopes 用 `.every(isIpcPathScope)` 在 slice(0, MAX) **之前**全量校验整个数组。畸形 `_permissions.json` 只要在第 1001 条(MAX_DECISIONS_PER_PLUGIN=1000)之后放一个坏 decision,就让**整条 plugin 授权记录被丢弃**(every false),且超长数组仍被全量扫描——数量上限没有真正早开(既是放大面,也是"上限后一个坏项丢整条有效授权"的数据丢失)。
- **亲读**: E206 的兄弟(codex 在 E206 报告时已预告)。**关键契约**:array/object-form 都有"任一非法 decision → 整条记录丢弃"(测试 421:对象形态 decisions 非法 → pluginId 跳过)—— 不能简单改成 filter/skip(会破契约,且 pathScopes 在 readAllPathScopes 是 filter 语义、在 readPermissions 是 every 语义,两套契约)。
- **修复**: 抽 `cappedAllValid<T>(arr, isValid, max): T[] | null` —— 凑满 max 即 break(有界,不全扫);**上限内任一非法 → 返 null**(保留"任一非法→整组丢弃"契约);非法项落在 max 之后 → 凑满即停、不扫到它(返前 max)。readPermissions 两形态都用它(移除 isPermissionRecordObject 守卫,object-form 改 shape 检查 + cappedAllValid 内容校验)。
- **测试**: plugins-service.spec +E207×3(array-form 非法在上限后→保留前 1000 / array-form 非法在上限内→整条丢弃契约保留 / object-form pathScopes 非法在上限后→保留前 256)。既有 421(object decisions 上限内非法→跳过)/ 386/405 往返 / E87 cap 回归保留。中和回 every+slice 全扫 → 2 测失败,4476 PASS。
- **沉淀**: 有界迭代族(E176/E189/E192/E197/E198/E199/E206/E207)。**`.every(isValid)` 作"全有效门 + slice"是全量预扫 + "任一非法(含上限后)→整组拒"双问题** —— 抽 cappedAllValid:凑满即停(有界)+ 上限内非法→null(保 every 的拒绝契约)+ 上限后非法不影响(资源/数据双修)。同一字段(pathScopes)在不同 reader 有不同契约(every vs filter)须分别对待,勿混用同一 helper。**E206 提示的兄弟(line 427/388)本轮(E207)由 codex 正式报告后修复——一报一修协议下,预告的兄弟等正式报告再动,避免抢跑改错契约。**

## E208 — readAllPathScopes 每 plugin scope 数组 filter() 在 slice 前全量扫描 (P2,E206/E207 兄弟,filter 语义)

- **问题**: `electron/main/services/plugins.service.ts:579`。每个 plugin 的 scope 数组 `value.filter(isIpcPathScope).slice(0, MAX_PERSISTED_SCOPES_PER_PLUGIN)` —— filter 先全量扫描 + 物化所有合法 scope,再 slice 截断。畸形 `_path-scopes.json` 单个 plugin 下塞大量 scope → 冷启动水合 / 授权读盘时被完整遍历,scope 数上限(256)不能早开。
- **亲读**: E206/E207 同族,但 **filter 语义**(skip 非法、keep 合法)≠ E207 的 every(任一非法→drop)。结果与旧 filter+slice **恒相同**(前 256 合法),纯性能修复。
- **修复**: 抽 `collectValidCapped<T>(arr, isValid, max): T[]`(与 cappedAllValid 对偶:非法**跳过**不丢整组,凑满 max 即 break)。替代 filter().slice()。
- **测试**: plugins-service.spec +E208×1(257-len scope 数组 → 用 `Array.prototype.filter` spy 按 257 长度筛选验"不再对超长 scope 数组调 filter" + 结果回归 256)。既有 E86(filter 非法/cap→256)回归保留。中和回 filter+slice → spy 测失败,4477 PASS。
- **沉淀**: 有界迭代族两 helper 对偶 —— **cappedAllValid(every 语义:上限内任一非法→null 丢整组)/ collectValidCapped(filter 语义:跳过非法、收集合法、凑满即停)**,按原 .every / .filter 语义选用,勿混。**纯性能修复(结果恒同)的中和**:用 `Array.prototype.<method>` spy + 按测试专属数组长度(257)筛选 instances(免全套并行污染),验"不再调用该 O(N) 方法"(同 E199 Object.entries spy 按 key 筛选 / E192 Proxy throw)。至此 plugins.service.ts 持久化 reader 的"物化/全扫在 cap 前"族全收口(E199 Object.entries×2 / E206 enabled every / E207 decisions·pathScopes every / E208 pathScopes filter)。

## E209 — command-palette recent.ts readFromStorage filter() 在 slice 前全量扫描 (P2,E208 renderer 对偶)

- **问题**: `src/plugins/command-palette/recent.ts:69`。`parsed.filter(isRecentEntry).slice(0, MAX_RECENT)` —— filter 全量扫描+物化所有合法 entry 再 slice。localStorage 虽有 256KiB raw cap(E72),但其内可塞大量短 entry;启动(模块初始化 line 85)/ storage 跨窗同步 / **每次 record() 读 live 列表**都完整遍历,MAX_RECENT=20 不早开。
- **亲读**: E208(readAllPathScopes filter)的 renderer 对偶。filter 语义。recent.ts 是 renderer 单处用,inline 惰性循环(不抽 helper)。结果与旧 filter+slice 恒同(前 MAX_RECENT 合法)。
- **修复**: inline `for (const item of parsed) { if (out.length >= MAX_RECENT) break; if (isRecentEntry(item)) out.push(item); }`。凑满 MAX_RECENT 即停。
- **测试**: recent.spec +E209×1(999-len 数组 → Array.prototype.filter spy 按 999 长度筛选验"不对超大数组 filter"+ 结果回归 MAX_RECENT)。既有 E39(filter 非法/cap)/ E72(raw cap)回归保留。中和回 filter+slice → spy 测失败,4478 PASS。
- **沉淀**: 有界迭代族跨进程全收口 —— **main(plugins.service E199/E206/E207/E208)+ renderer(reviews-types E197 / local-storage-record E198 / scoped-app env E198 / recent E209)** 所有"持久化/外部数组读回的 filter/every/Object.entries 在 cap/slice 前全量物化"入口均改有界迭代。**编辑陷阱**:替换 `filter().slice()` 为循环时,old_string 勿连带删掉前面的 `const parsed = JSON.parse(raw)`(本轮一度删除致 parsed undefined,typecheck 前自查补回)。

## E210 — isValidAggregateRecord 缺全局累计 reviews 上限(单插件×插件数可绕过)(P2)

- **问题**: `src/marketplace/reviews-types.ts:156`。reviews 缓存校验只限 aggregate key 数(MAX_AGGREGATE_KEYS=2000)+ 单插件 reviews 数(MAX_REVIEWS_PER_PLUGIN=2000),二者相乘最坏 400 万 reviews,**无全局累计上限**。篡改 sessionStorage 可造很多 plugin × 各少量 reviews,总数远超 main 端 MAX_TOTAL_NODES=2000(累计节点上限),打开 Marketplace 时放大校验 / Map 构建 / 渲染成本。
- **亲读**: E197(我已把 isValidAggregateRecord 改 for...in)的延伸——逐项上限有了,缺累计上限。renderer 镜像 main 常量(不可 import electron/main),main marketplace-reviews.service 有 MAX_TOTAL_NODES 累计上限,renderer 缓存校验应对齐。
- **修复**: 加 `MAX_TOTAL_REVIEWS = 2000`(对齐 main MAX_TOTAL_NODES),在 isValidAggregateRecord 的 for...in 中 `totalReviews += agg.reviews.length`(agg 已过 isValidAggregate,reviews 是数组),`totalReviews > MAX_TOTAL_REVIEWS → return false`(早停,超限即 cache miss → 重拉,main 侧再 clamp)。
- **测试**: reviews-parser.spec +E210×2(3 plugin × 700 = 2100 > 2000 各自单插件上限内 → false / 累计恰好 2000 → true 边界)。中和去累计上限 → "2100→false"测失败,4480 PASS。
- **沉淀**: **逐项上限 ≠ 累计上限** —— "key 数上限 + 单项内容上限"二者相乘仍可远超系统真实产出的累计上限。凡 renderer 镜像 main 的多层数据结构(record→list),除逐项 cap 外须有**与 main 累计产出对齐的全局 cap**(此处 reviews 总数 vs main MAX_TOTAL_NODES)。累计 cap 放在已有的 for...in 单遍里(边遍历边累加,超限早停),零额外开销。

## E211 — listDir readdir() 全量物化整目录(MAX_TOTAL_ENTRIES 检查前 OOM)(P2,有界迭代族 syscall 级)

- **问题**: `electron/main/ipc/fs/list-dir.ts:151`。`readdir(dir, {withFileTypes:true})` 一次性把整目录所有 dirent 物化进主进程数组(Node syscall 本身返回完整数组),`dirents.filter(...)` 再物化一份。MAX_TOTAL_ENTRIES=100k 上限只在随后的 per-item 循环生效 → 超宽目录(100k+ 直接子项)在上限检查前就内存峰值/OOM,上限没有真正保护 readdir 阶段。
- **亲读**: 有界迭代族(E206-E210)的 **syscall 级**变体 —— 前几个是 JS .filter/.every/Object.entries 物化;这个是 Node `readdir` 本身的全量物化。测试语义:maxTotalEntries 计**处理阶段**非排除项,`> max` 触发(test 199/212)。
- **修复**: 改 `opendir(dir)` 流式读取(Dir 内部 bufferSize 缓冲,默认 ~32),`for await (const dirent of dirHandle)` 边读边按 LSTAT_CHUNK 成块处理(保留原 chunked 并发 lstat + maxFiles 早停 + totalCount 计数+上限 + 递归 + 末尾 sort)。totalCount 仍在处理阶段计数(语义/上限不变)。for await 在 break/throw(FS_DIR_TOO_LARGE)/完成时自动 close Dir。readdir 阶段内存从 O(目录宽度) 降到 O(bufferSize)。
- **测试**: fs-adapter.spec +E211×1(**静态源码守卫**:list-dir.ts 含 `opendir(` 不含 `readdir(` + 行为回归列目录;node:fs/promises 导出不可 spy[Cannot redefine property],行为结果与 readdir 相同,故用 E146/E190 同款静态守卫)。既有 E38(maxTotalEntries / 边界)回归保留。中和加 readdir( → 静态守卫失败,4481 PASS。
- **沉淀**: 有界迭代族延伸到 **syscall 级** —— `readdir` 返回完整数组是隐藏的全量物化点(不只 JS .filter/.every);超宽目录的内存上限必须用 `opendir` 流式(bufferSize 缓冲)才在读取阶段真正生效。**neutralize 手段分级**:运行时 spy(Object.entries/Array.filter,可 spy 的)> 静态源码守卫(node:fs/promises 等不可 spy 的内建,退而验源码 + 行为回归)。后者较弱但对"行为结果相同的纯实现替换 + 不可 mock 的依赖"是务实选择(同 E146/E190 windowOpenHandler)。

## E212 — readHookDirCapped readdir() 全量物化 hook 目录 (P2,E211 同模式 + 引出 ingest 顺序依赖)

- **问题**: `electron/main/services/mcp-tools-hook-bridge.ts:101`。`readdir(dir)` 一次性物化整个 hook events 目录所有文件名,再 `names.slice(0, max)` 截断。堆积/畸形的 hook 目录(app 自管,但可累积)在每次 start/cleanup 扫描时把全部文件名读入内存,MAX_HOOK_DIR_ENTRIES=4096 只限后续处理数量,不保护枚举阶段。
- **亲读**: E211(list-dir)同模式(syscall 级 readdir 全量)。**但引出隐藏耦合**:readHookDirCapped 的返回顺序 = ingestFile 顺序 = buffered 入队顺序;同 session 多 hook 文件时 awaitStopHook 返回 **buffered 首个匹配**(首入胜出)。opendir 流式枚举顺序与旧 readdir 不同 → 改了"谁先 ingest" → await-stop-hook 主测试中 term-cc 从 cli-1 变成 cli-2 胜出(真实行为变化,非纯性能)。
- **修复**: (1) 改 `opendir(dir)` for await 流式 + 读到 max+1 即截断告警(语义保持)。(2) **关键**:`names.sort()` —— 旧 readdir 顺序本是未定义,排序使枚举/ingest 顺序确定(消除 opendir vs readdir 的平台/实现相关性),`cc_4_claude-cli-1_default` < `cc_4_claude-cli-2_raw` → cli-1 先入 buffered → 解析 cli-1(与原行为一致 + 确定性)。
- **测试**: 复用既有 E83(8>5 截断+告警)+ 2 race(R108 start-stop / R90 ingest-stop:mock 由 readdir 改 **opendir**——R108 opendir deferred 暂停 + 空 async-iterable Dir;R90 opendir 产出名单 + stat deferred 暂停,opendir 异步迭代多微任务 tick 故 await flush 由 3 增到 12)+ await-stop-hook 排序断言。中和 revert readdir → 3 测失败(behavioral neutralize),4481 PASS,typecheck/lint 绿。
- **沉淀**: **readdir→opendir 流式不仅是性能改写,会改变目录枚举顺序** —— 凡下游对"文件处理顺序"有隐藏依赖(此处 ingest 顺序决定 buffered 首入胜出)的,必须 `sort()` 使顺序确定(旧 readdir 顺序本未定义,排序是改善非回归)。改 reader 的 readdir→opendir 时 grep 下游是否按返回顺序做"首个/最后胜出"判定。mock readdir 的 race 测试随之改 mock opendir(async-iterable Dir + 暂停点从 readdir-await 移到 opendir-await 或 stat-await;异步迭代多 tick → 增 await flush 次数)。

## E213 — notify isValidParams Object.keys 在 NOTIFY_PARAMS_MAX_KEYS 前全量物化 (P2,有界迭代族)

- **问题**: `electron/shared/notify-channels.ts:44`。`isValidParams()` 用 `const keys = Object.keys(obj); if (keys.length > NOTIFY_PARAMS_MAX_KEYS) ...; for (const k of keys)` —— 先全量物化 notify:push payload 的所有参数 key 再判 64 上限。畸形 payload 在 runtime guard(NotifyIpcBridge ingress)阶段先物化所有 key,上限没早开,与其它 IPC record 守卫(E185-E188 makeBoundedRecordValidator)的早停迭代不一致。
- **亲读**: 有界迭代族(E197/E199 Object.keys 物化模式)。**E198 教训复现**:此处是 `const keys = Object.keys(obj)` + 下一行 `keys.length > MAX`(跨两行经变量),E206/E198 的单行 `Object.keys(...).length > MAX` grep 漏了它,codex 按行为抓到。
- **修复**: 改单次 `for...in` + `hasOwnProperty`,边计数边校验,`count > NOTIFY_PARAMS_MAX_KEYS` 立即 false。行为等价(同上限、同 string/number 值校验)。
- **测试**: notify-ipc-bridge.spec +E213×2(直接测导出的 isNotifyPushPayload:MAX+1 keys → false 且 Object.keys spy 按 'k0' 筛选不命中 params 对象 / 恰好 MAX 合法 → true 回归)。既有 E168(畸形 params drop)回归保留。中和回 Object.keys → 2 测失败,4483 PASS。
- **沉淀**: 有界迭代族再扩(E197/E199/E206/E207/E208/E209/E211/E212/E213)。**grep 兄弟必按行为**:`Object.keys(obj)` 赋值给变量再 `.length > MAX`(跨行)逃过单行 pattern grep(E198 已记此教训,E213 再次印证)—— 应 grep 所有 `Object.keys|entries|values` 调用 + 人工核对每处是否"物化在上限/早退之前"(含跨行变量)。spy 按测试专属 key 筛选(免并行污染)是这类共享模块纯计数修复的标准中和。

## E214 — stdio NDJSON 单 chunk 行数无上限(海量极短/空行放大)(P2)

- **问题**: `electron/main/services/mcp-stdio-server.service.ts:352`。stdio NDJSON 只限**单行字节**(MAX_STDIO_LINE_BYTES=1MB,E1/E127),不限一次 data chunk 解出的**行数**。`for (const line of lines)` 为每行挂 promise 链 + 持有 line 字符串。恶意/畸形客户端发 1MB 的 `\n\n\n...` 或海量极短 JSON 行(每行都不超字节上限)→ 主进程分配海量 line 字符串 + 海量 promise → CPU/内存放大。
- **亲读**: handleLine 对空白行已 `if (!line.trim()) return`(no-op 无输出),但仍为每空行挂 promise + 调 handleLine = 放大。codex 抓的是"行数"维度(此前只有"单行字节"维度)。
- **修复**: (1) 空白行 `line.trim() === ''` **入链前同步跳过**(NDJSON 约定忽略,与 handleLine 早返一致,但避免 promise 开销)。(2) 加 `MAX_STDIO_LINES_PER_CHUNK=1024` 非空行预算,`chained > 预算` → parse error + `sock.destroy()`(与 E1 单行超限同款断开)。1024 远超正常批量(MCP client 通常一行一请求)。
- **测试**: socket-safety.spec +E214×2(2000 极短 `{}` 行 > 预算 → parse error + 断开 + tool 不执行 / 5000 空行 → 同步跳过、不断开、tool 不执行)。既有 E1(超长无换行)/ E127(CJK 字节)/ 多行同 chunk 回归保留。中和去行数闸 → too-many-lines 测失败,4485 PASS。
- **沉淀**: 流式输入的资源上限有**两个正交维度** —— 单条字节(E1/E127:单行 ≤1MB)+ **批次条数**(E214:单 chunk 非空行 ≤1024)。只限单条字节挡不住"海量小条"放大。凡 split-then-loop 处理外部流(NDJSON/批量)的,除单条上限外须有"一次解出的条数"上限 + 空白/no-op 条目入循环前同步跳过(不为它们挂 promise/分配)。codex 此轮从"超长单行"转向"过多短行"——同一资源(stdin 输入)的另一放大维度。

## E215 — layout:read 读端 passthrough,未复用写端 JSON-safe + 字节上限 (P2,E89 写端对偶)

- **问题**: `electron/main/ipc.ts:78`。`layout:read` 直接 `return entry?.layout ?? null`(磁盘 passthrough),未复用写端(layout:write,E89/E119)的 `MAX_LAYOUT_BYTES`(2MiB)+ assertJsonValue 校验。旧版本/手工污染的 explorer.json 可含 >2MiB 但 <16MiB(loadExplorer 文件上限,不被拒)的 dock layout → 启动恢复时 renderer 仍 fromJSON() 处理超大 layout → 恢复卡顿/内存放大。
- **亲读**: E89(写端字节上限)的读端对偶。disk layout 经 loadExplorer 的 JSON.parse 必 JSON-safe(JSON.parse 不产生 Infinity/NaN/undefined),故读端**核心防护是字节上限**(超大但合法 JSON),assertJsonValue 仅极端损坏兜底。MAX_LAYOUT_BYTES 此前在 ipc.ts 内定义(写端用)。
- **修复**: 抽 `electron/main/lib/layout-read-guard.ts`(MAX_LAYOUT_BYTES 单一来源 + `sanitizeReadLayout(layout)`:null/undefined→null,先 stringify 量 UTF-8 字节超 MAX→null 早拒,再 assertJsonValue 兜底→null,否则原样返回)。layout:read 改 `sanitizeReadLayout(entry?.layout ?? null)`;layout:write 复用同常量(读写单一来源)。ipc.ts 顶层 app 副作用,守卫逻辑抽到可导入模块(E146 模式),但本 spec 经 registerIpc + electron mock 可直接测行为(无需静态守卫)。
- **测试**: layout-ipc.spec +E215×1(persist >2MiB 合法 JSON layout → layout:read 返 `data:null` 走默认布局)。既有 T9(正常 layout 读回)/ E89(写端上限)回归保留。中和读端去 sanitizeReadLayout → 该测失败(返超大 huge),4486 PASS。
- **沉淀**: **写端有上限校验,读端也须对偶**(E215 layout / 此前 E193/E199 等持久化读端 canonicalize 同理)—— 持久化数据的"写端门控"挡不住旧版本残留/手工污染/降级写入的历史数据,读端必须独立复用同上限(单一来源常量 + helper)。disk(JSON.parse 产物)读端的核心防护是**字节/数量上限**(JSON-safe 已由 JSON.parse 保证,仅兜底)。

## E216 — hydrateEditorTabs 无界并发 fan-out 恢复全部 tab (P2,并发放大)

- **问题**: `src/lib/persist/explorer-persist.ts:270`。`Promise.allSettled(paths.map((p) => fs.readFile(p)))` 一次性并发恢复全部 openFilePaths。explorer.json schema 允许至多 100k openFilePaths,畸形/旧快照启动时同时发起海量 IPC/文件读 promise → renderer/main 卡顿/资源耗尽。**单文件大小 cap(E68 等)不防并发 fan-out**(数量维度)。
- **亲读**: 与有界迭代族(物化)不同,这是**并发 fan-out 放大**(N 个 promise 同时在飞)。真实用户 tab 数远低于 100k。allSettled 语义(reject 逐项跳过、不抛)+ root-changed race 守卫(R13)须保留。
- **修复**: (1) 截断到 `MAX_RESTORED_TABS=256`(超量 = 畸形/旧快照;canonical snapshot 下次持久化按恢复集写回,逐步收敛掉超量路径)。(2) 分块并发读(`RESTORE_READ_CONCURRENCY=32`,峰值并发钳到 32,仿 list-dir LSTAT_CHUNK),非一次性 map 全部。allSettled/root 守卫/activePath 逻辑不变。
- **测试**: editor-session-restore.spec +E216×1(300 openFilePaths → readFile 只调 256 次、tabs 256)。既有恢复/reject-skip/root-guard 回归保留。中和去截断 → readFile 调 300 次,该测失败,4487 PASS。
- **沉淀**: 资源上限的**第三维度** —— 单条字节(E1/E68)+ 批次条数(E214)+ **并发 fan-out**(E216:同时在飞的 promise 数)。`items.map(asyncFn)` + Promise.all/allSettled 对外部来源/持久化数组是无界并发,即便每条有大小 cap、即便总条数有 schema cap(100k 仍太大),启动期同时 fan-out 仍资源耗尽。须:业务恢复数硬上限(远低于 schema cap)+ 分块并发池(峰值并发钳定)。schema 的 array max(防文件撑爆)≠ 运行期并发恢复上限(防 fan-out)。

## E217 — sanitizePersistedDockLayout Object.keys 全量物化 + 缺 panel 数量上限 (P2,有界迭代族 + E215 同族)

- **问题**: `src/shell/dock/DockShell.tsx:61`。`for (const panelId of Object.keys(j.panels))` 全量物化所有 panel key 再扫描(找 terminal panel → 返 null)。layout:read 有 2MiB 字节上限(E215),但畸形 layout 仍可在其内塞大量短 panel key,启动恢复时分配完整 key 数组,且**缺 panel 数量上限** → 启动卡顿/内存峰值。
- **亲读**: 有界迭代族(Object.keys 物化)+ E215 dock layout 同族。函数契约:含 terminal panel → 返 null(终端不从持久化 layout 恢复)。sanitizePersistedDockLayout 已导出可直接测。
- **修复**: 改单次 `for...in` + `hasOwnProperty` 边数边扫(不 Object.keys 物化);加 `MAX_LAYOUT_PANELS=256`(正常 layout panel 数 = 编辑器 tab + 终端 + 资源管理器,远低于此),`count > MAX` → 返 null(丢弃 layout 走默认布局);terminal panel 仍立即 null(契约保留)。
- **测试**: zoom-toggle.spec(T7b)+E217×2(300 panels > 256 → null / 200 panels < 256 非终端 → 不变)。既有 T7b(含 terminal→null / 不含→原样)回归保留。中和去 panel cap → 300-panel 测失败,4489 PASS。
- **沉淀**: 有界迭代族 + 持久化字节上限族的交汇 —— **字节上限(E215 layout 2MiB)挡不住"数量"维度**(2MiB 内可有海量短 key)。同一持久化结构既要字节上限(防撑爆文件)又要元素数量上限(防枚举/恢复放大),二者正交(参 E210 逐项 vs 累计、E216 schema-max vs 并发)。Object.keys-then-scan 一律改 for...in 边数边扫 + 数量 cap 早退。

## E218 — ndjson-line-decoder split('\n') 全量物化,逃过 E214 后置行数 cap (P2,E214 下推)

- **问题**: `electron/main/lib/ndjson-line-decoder.ts:22`。`createNdjsonLineDecoder.push()` 内 `residual.split('\n')` 全量物化所有行。E214 在 data handler 加的 MAX_STDIO_LINES_PER_CHUNK 在 push **返回后**才生效 —— 畸形 MCP stdio 客户端发海量短行/空行,split 在调用方 cap 前就分配巨大 parts 数组(E214 只挡后续入链 promise,不挡 decoder 的 split 放大)。
- **亲读**: E214(post-decode 行数 cap)的下推 —— 同 E211/E212(readdir→opendir):materialization 在更底层(decoder split),后置 cap 逃不过。decoder 仅 1 个生产消费者(mcp-stdio)+ spec 直接测。
- **修复**: push 加可选 `maxLines` 参数,改**索引扫描**(indexOf('\n')逐行 slice)产出至多 maxLines 行,达到即 `overflow=true` + break + 清残行(不 split 全量物化)。返回类型 `string[]` → `{ lines, overflow }`(NdjsonPushResult)。caller 传 MAX_STDIO_LINES_PER_CHUNK,overflow → parse error + 断开(同 E214 too-many)。maxLines 省略 → 退化产出全部行(向后兼容,行为同旧 split)。
- **测试**: ndjson-line-decoder.spec +E218×3(maxLines 超→overflow+产出≤max+清残行 / 未超→overflow false+残行保留 / 省略→全部产出向后兼容);ct-b3-socket-safety +E218×1(2000 空行洪流→decoder overflow+断开);**E214b 调整**(原 5000 空行"不断开"→ 现超 cap 会 overflow,改为 500 空行 < cap 测"上限内空行跳过不断开" + 新增超上限空行洪流测)。中和回 split → 2 测失败,4493 PASS。
- **沉淀**: 放大维度的修复要**下推到 materialization 真正发生的层**(E211/E212 readdir→opendir;E218 split→index-scan)。在上层加"后置 cap"(E214 handler 行数)挡不住下层一次性物化(decoder split);凡"先全量产出再上层 cap"的两层结构,cap 必须下推到产出层(产出时即 bounded)。改 API 返回形态(string[]→{lines,overflow})时:grep 全部 caller + spec 调用点逐一改(本轮 1 caller + 6 spec push 调用)。空白行计入 decoder 总行 cap(split 单位),故"空行洪流"也应 overflow 断开(E214b 的"空行永不断开"在下推后修正为"超 cap 断开")。

## E219 — terminal:write data 用 .max() (UTF-16 code unit) 非真实 UTF-8 字节 (P2,字节 vs code-unit 族)

- **问题**: `electron/main/ipc/terminal.ipc.ts:70`。`data: z.string().max(MAX_WRITE_CHARS)`(2M)是 UTF-16 code unit 限制,非真实 UTF-8 字节。CJK(3 字节/字)/emoji(4 字节/2 code unit)输入在 `data.length ≤ 2M` 时实际写入 6-8MB 到 PTY/IPC,与下游(PTY/IPC 按字节)边界语义不一致,可能终端写入卡顿。
- **亲读**: 字节 vs code-unit 族(E125 通则 / E127 stdio line / E129 shell stdin / E133 autorun)。terminal:write 是 renderer→main IPC,renderer 大 paste/畸形可发 2M CJK chars = 6MB。MCP send_input/send_text 经 stdio line 字节 cap(E1/E127)已 transitively 字节限,故只 terminal:write 这个 IPC 入口有缺口。
- **修复**: `MAX_WRITE_CHARS` → `MAX_WRITE_BYTES=2_000_000`,`data` 改 `.refine((s) => !utf8BytesExceed(s, MAX_WRITE_BYTES), ...)`(同 E129 shell stdin / scoped-app 写法)。ASCII 行为不变(char==byte),多字节按真实字节限。
- **测试**: terminal-ipc.spec +E219×2(700k CJK chars = 2.1MB 字节 > 2M → fail / 2M ASCII = 2M 字节 → ok 边界回归)。既有"2M+1 ASCII → fail"回归保留(字节语义下仍成立)。中和回 .max(code unit) → CJK 测失败,4495 PASS。
- **沉淀**: 字节 vs code-unit 族(E125/E127/E129/E133/E219)—— **凡"字符串大小上限 + 下游按字节消费(PTY/IPC/文件/spawn stdin)"的入口,zod `.max()` 是 UTF-16 code unit(CJK/emoji 真实字节数倍),必须 `utf8BytesExceed` refine 按真实字节**。检查所有 `z.string().max(N)`:若 N 是"字节预算"且下游按字节,改字节 refine。同一数据(PTY write)的不同入口(IPC writeInputSchema / MCP send_input)边界单位须一致(都字节)。

## E220 — MCP send_input/send_text 的 data/text 用 .max() (code unit) 非真实字节 (P2,E219 MCP 工具兄弟)

- **问题**: `electron/main/services/mcp-tools-terminal.ts:84`。Continuo 的 send_input/send_text bounded schema(E203)只给 session_id 加上限,data/text 仍沿用协议原 `z.string().max(SEND_INPUT_MAX_CHARS=2_000_000)`(UTF-16 code unit)。stdio line 字节 cap(E1/E127 1MB)transitively 限了 stdio transport,但与 terminal:write(E219)字节语义不一致;未来调 transport 上限/内部直调工具时 CJK/emoji 多字节仍绕过"字节"语义。
- **亲读**: E219(terminal:write IPC)的 MCP 工具兄弟。字节 vs code-unit 族。data/text 下游同样写 PTY(按字节)。utf8BytesExceed 已导入(E202/E203)。
- **修复**: 加 `SEND_DATA_MAX_BYTES=2_000_000` + `sendDataBounded`(utf8BytesExceed refine),sendInputBoundedSchema extend `data: sendDataBounded`、sendTextBoundedSchema extend `text: sendDataBounded`(同 E219 字节语义,与 terminal:write 统一)。不改协议包。
- **测试**: send-input.spec / send-text.spec +E220×2(700k CJK = 2.1MB 字节 → 拒 / 上限内 ASCII → 通过 / 协议原 schema code-unit 仍接受 CJK 作对比)。中和去 data/text refine → 2 测失败,4497 PASS。
- **沉淀**: 字节 vs code-unit 族跨入口统一(E219 terminal:write IPC ↔ E220 MCP send_input/send_text)——**同一数据(PTY write)的所有入口边界单位必须一致(都真实字节)**。复用共享协议 schema 的 string 字段(send data),其 .max() 是 code-unit,Continuo 侧 extend 时除 session_id 还要把按字节消费的 data/text 一并字节化(E203 当时只收窄了 session_id,漏了 data/text 的单位 → E220 补)。

## E221 — assertJsonValue Reflect.ownKeys 全量物化再判 MAX_JSON_OBJECT_KEYS (P2,DEFER — user 定夺)

- **codex 报告**: `electron/shared/assert-json-value.ts:82`。object 分支 `Reflect.ownKeys(obj)` 全量物化所有 key 后才 `> MAX_JSON_OBJECT_KEYS` 检查;畸形超宽对象在上限生效前先分配完整 key 数组。建议改 for...in + hasOwnProperty 边计数边递归、仍校验 symbol/非枚举。
- **亲读结论:DEFER(经 user 定夺 2026-06-26,选项「DEFER + 注释 flag」)**。三条理由:
  1. **codex remedy 不可行**:本分支靠 Reflect.ownKeys **看到** symbol key(`typeof k === 'symbol'` 拒)+ 非枚举自有属性(`!desc.enumerable` 拒)满足 E140/E200 契约;for...in **只枚举 enumerable string key**,看不到 symbol/非枚举 —— JS 无 lazy 枚举它们的方式(getOwnPropertyNames/Symbols/ownKeys 都全量物化)。改 for...in 会让 symbol/非枚举静默通过 → 破 E140/E200。
  2. **可达契约(区别于 E201)**:assertJsonValue 校验同进程活对象(插件 saveData / MCP jsonSchema / layout:write 可传 symbol/非枚举),symbol/非枚举**可达** —— 不同于 E201 的 post-IPC 已剥离不可达。故 E140/E200 检查在此有意义,不能丢。
  3. **E184 已最小化**:此前 getOwnPropertySymbols+getOwnPropertyNames+keys+entries 多次物化,E184 收口为**单次** Reflect.ownKeys;超 MAX 时 key 数组立即抛弃(转瞬即逝)。混合(for...in 预数 + Reflect.ownKeys)只挡常见超宽 enumerable 情形,exotic 百万非枚举/symbol 仍物化,且对每个合法对象双遍历(收益小、代价常驻)。
- **处置**: 代码内加 DEFER flag 注释(三条理由 + 与 E201 可达性区别),不改逻辑。typecheck + lint 绿,无测试改动。
- **沉淀**: codex 的"有界迭代/Object.keys→for...in"族泛化第二次撞上**需要全键枚举(含 symbol/非枚举)的校验器**(E201 makeBoundedRecordValidator / E221 assertJsonValue)。判定钥匙=**可达性 + 是否需检测 symbol/非枚举**:E201(post-IPC 不可达 symbol/非枚举)→ DEFER;E221(同进程可达 + E140/E200 必须拒 symbol/非枚举)→ 也 DEFER 但理由是"检测 symbol/非枚举与零物化在 JS 不可兼得"。**检测 symbol/非枚举 ⊥ lazy 枚举**:凡校验器须拒 symbol/非枚举键,必用 Reflect.ownKeys/getOwnPropertyNames 全量物化,for...in 不可替代。

## E222 — marketplace-reviews capJoinedMessages 前 json.errors.map 全量物化 (P2,有界迭代族)

- **问题**: `electron/main/services/marketplace-reviews.service.ts:172`。`capJoinedMessages(json.errors.map((e) => String(e?.message ?? '')))` —— 调 cap 前先 `.map(...)` 把外部 GraphQL `json.errors` 全量物化成 string 数组,capJoinedMessages 再 slice 到 MAX_JOINED_ITEMS(20)。畸形 GraphQL 响应(8MiB 内可塞大量短 errors)→ 错误路径先分配完整 message 数组 + 逐项 String 化,cap 只限拼接结果不限 .map 放大。
- **亲读**: 有界迭代族(.map 物化在 cap 前)。capJoinedMessages 收已物化 string[],映射在调用点。formatZodErrorCapped 的 `error.issues.map` 是 schema 界定(.strict 大对象产单条 unrecognized_keys,非 N 条),非外部放大,不动。
- **修复**: 加 mapper 变体 `capJoinedMessagesFrom<T>(items, mapper, moreLabel?)`(shared 单一来源)—— 只对**前 MAX_JOINED_ITEMS(20)个**元素调 mapper(`for i<limit`),不 `items.map` 全量;`items.length`(数组 O(1))算 extra 精确。语义与 capJoinedMessages 一致。marketplace 调用点改 `capJoinedMessagesFrom(json.errors, (e) => String(e?.message ?? ''))`;format-zod-error re-export 同步。
- **测试**: 新建 cap-joined-messages.spec(+README+bdd:index)×5(capJoinedMessages 拼接/超 20 截断 + capJoinedMessagesFrom:1000 元素只调 mapper 20 次[vi.fn spy]+(+980 more)精确 / 少量全 map / 空数组)。中和回 items.map → mapper 调 1000 次,spy 测失败,4502 PASS。
- **沉淀**: 有界迭代族再扩 —— **`arr.map(fn)` 喂给"取前 N"的 cap = 全量物化 + 全量 fn 调用在 cap 前**(同 filter-before-slice E208/E209)。修法:cap helper 提供 mapper 变体,内部只对前 N 个调 mapper(`for i<min(len,N)`),源数组是 array 时 length O(1) 保精确 extra 计数。外部可控数量的源(GraphQL errors / 持久化数组)喂给 join/cap 前,把 map 下推进 cap helper。

## E223 — formatZodErrorCapped + manifest + PluginMcpRegistry 的 issues.map 全量物化 (P2,E222 兄弟)

- **问题**: `electron/main/lib/format-zod-error.ts:16`(+ `src/plugins/manifest.ts:85` E77 / `src/plugins/registries/PluginMcpRegistry.ts:176` E76)。均 `capJoinedMessages(error.issues.map((i) => ...))` —— 先 `.map` 全量物化所有 zod issue 的 message,再 cap。**array schema(如 z.array(z.string()))校验大量无效元素 → 每元素产一 issue → error.issues 可海量**(我 E222 时误判 issues 受 schema 界定,但 .strict 大对象产单 issue,**array 多无效元素产 N issue**)。畸形 IPC/MCP 入参 / manifest → 错误路径先分配完整 message 数组。
- **亲读**: E222(GraphQL errors)的剩余 zod-issues 同族。三处都是 `capJoinedMessages(issues.map())`,迁移到 E222 的 `capJoinedMessagesFrom`。window.ipc.ts:116 是 `console.warn(issues)`(util.inspect 默认 cap 数组显示 + NotifyRootInput 小 schema)非 cap-join 路径,留。
- **修复**: 三处改 `capJoinedMessagesFrom(error.issues, (i) => ..., 'more issues')`(只对前 20 个 issue 调 mapper)。format-zod-error re-export capJoinedMessagesFrom 已就绪(E222)。
- **测试**: cap-joined-messages.spec +E223×1(formatZodErrorCapped 对 z.array 1000 无效元素 → 1000 issues → 限条 +"more issues"+ 总长 cap)。既有 plugin-manifest/safe-handle/registry 回归保留(行为保持,输出 ≤20 issue 时相同)。bounded 属性由 E222 capJoinedMessagesFrom 测试(mapper 20×)中和。4503 PASS。
- **沉淀**: 错误串放大族(E73/E75/E76/E77/E222/E223)全收口到 capJoinedMessagesFrom —— **zod `error.issues` 不总是 schema-界定**:`.strict` 大对象 → 单 unrecognized_keys issue,但 `z.array(...)` 多无效元素 → 每元素一 issue(N 个)。凡 `capJoinedMessages(X.map())`(X 外部可控数量:GraphQL errors / zod array-issues)一律 capJoinedMessagesFrom(map 下推、只 map 前 N)。E222 时漏判 issues 维度 → E223 codex 补(同 E198"按行为非字面 grep 兄弟"教训:E222 grep 了 .errors.map 但漏判 issues.map 的 array 情形)。

## E224 — App.tsx 全局 dragover/drop 裸 types.includes('Files'),未用共享 hasFiles (P2,E189 漏掉的兄弟)

- **问题**: `src/shell/App.tsx:93/98`。全局 dragover/drop(高频事件)用 `e.dataTransfer?.types.includes('Files')`,未复用 Terminal 侧 E189 已建的早停 hasFiles helper。E189 把 Terminal 的 `Array.from(types).includes` 收口为 hasFiles(索引早停 + 类型守卫),但 **App.tsx 这个 dragover/drop 入口是收口时漏掉的兄弟**。
- **亲读**: `.includes('Files')` 本身也早停(命中即停),无物化(非 Array.from),故 App.tsx 原非真性能 bug;但属"修一族必 grep 兄弟入口"——hasFiles 应用于**所有** dragover/drop 检测点(单一来源 + 类型守卫 + null 检查),App.tsx 是漏网的。
- **修复**: hasFiles 从 useTerminalDragDrop 移到共享 `@/lib/window-drop`(与 captureBoundedFiles / hasDirectoryInFirstItems 同处,drop helpers 的家);useTerminalDragDrop `import + re-export` 保既有路径(Terminal 代码 + drag-drop.spec 不变);App.tsx import hasFiles 替换两处 `.types.includes('Files')`(顺带类型守卫窄化 dataTransfer 非 null)。
- **测试**: window-drop.spec +E224×2(hasFiles 含 Files→true / 不含→false / null→false / 命中即短路:index 1 getter 抛 → 命中 [0] 不访问 [1+])。既有 drag-drop.spec(Terminal hasFiles 经 re-export)+ cold-start-drag(App drop)回归保留。中和 hasFiles 去早停(scan-all)→ 2 测失败,4505 PASS。
- **沉淀**: "修一族必 grep 兄弟入口"——E189 建 hasFiles 时只改了 Terminal,App.tsx 全局 drop 是漏掉的同类入口(codex 后续 grep 全部 dragover/drop 检测点抓到)。**通用 helper(hasFiles 是 DataTransfer 通用工具,非 Terminal 专属)应放共享 lib(window-drop)而非某 feature 模块**,再由各 feature import,避免 App→panel 的层级反向耦合 + 防止新入口又裸写。`.includes` 与 helper 行为同(都早停)时,consolidation 的价值是单一来源 + 类型守卫 + 防新入口漂移,非性能。

## E225 — Explorer dragover/drop 多处裸 types.includes('Files'),未用共享 hasFiles (P2,E224 续/hasFiles 收口剩余)

- **问题**: `src/panels/Explorer/`:FolderTree.tsx(4 处)/ FileRow.tsx(1)/ tree-config.ts(2)共 7 处 dragover/drop 仍 `dataTransfer.types.includes('Files')`,未复用 E224 收口到 `@/lib/window-drop` 的共享早停 hasFiles。Explorer 外部拖放是又一批漏掉的同类入口。
- **亲读**: E224(App.tsx)的续 —— codex grep 全 `.types.includes('Files')` 抓到 Explorer 剩余 7 处。consolidation(单一来源 + 防新入口漂移),`.includes` 本也早停故非真性能 bug。
- **修复**: 3 文件 import 共享 `hasFiles` 替换 7 处。**hasFiles 改为普通 boolean(非 `is DataTransfer` 类型守卫)**:React.DragEvent.dataTransfer 类型为**非空** DataTransfer,对其用 `is DataTransfer` 守卫会让否定分支 narrow 成 `never`(FolderTree handleDragOver 的内部 drag 分支仍访问 e.dataTransfer.dropEffect → TS2339 never)。App.tsx(原生 DragEvent.dataTransfer 可空)改显式 `if (dt === null) return` 收窄(替代守卫窄化)。
- **测试**: tree-config.spec +E225×1(canDropForeignDragObject 用早停 hasFiles:types[0]=Files、[1] getter 抛 → 命中即返不访问 [1])。既有 canDrop(含/不含 Files)回归保留。中和 canDrop 回 scan-all filter → 早停测失败,4506 PASS。
- **沉淀**: 共享 helper 收口要 grep **全部**同类入口(E189 Terminal → E224 App → E225 Explorer 3 文件 7 处,逐轮被 codex 揪出剩余)—— 一次性 `grep -rn "types.includes('Files')"` 全仓扫净比逐轮补更彻底(本轮一次清 7 处)。**类型守卫 vs 普通 boolean 的坑**:`x is T` 守卫用于"输入类型 ⊋ T"才有意义;对"输入已是 T"(React 非空 DataTransfer)的输入,守卫否定分支 narrow 成 never,破坏 else 分支 —— 跨可空(原生)/非空(React)两种 DragEvent 复用的 helper 应返普通 boolean,可空侧调用方自行 null 收窄。

## E226 — collectAllTags 全局 distinct tag 无累计上限 (P2,E210 逐项≠累计上限族)

- **问题**: `src/marketplace/filter.ts:47`。`collectAllTags()` 逐 entry 把所有 tags 收进 Set,再 `Array.from(set).sort()`。单 entry tags 有上限、index entries 有上限(4096),但**二者相乘最坏数十万 distinct tags** —— 畸形远程 marketplace index 无全局 tag 数上限,收集/排序 + UI 渲染全部 tag 按钮处卡 renderer。
- **亲读**: E210(reviews 全局累计)同族 —— 逐项上限 ≠ 累计上限。collectAllTags 导出可直接测。
- **修复**: 加 `MAX_MARKETPLACE_TAGS=256`,嵌套收集循环 `set.size >= MAX → break outer`(凑满全局 distinct tag 即停,只渲染限度内集合)。合法 index(<256 distinct tag)行为不变。
- **测试**: filter.spec +E226×1(单 entry 1000 distinct tags → collectAllTags 截断到 256)。既有 去重/排序/空 回归保留。中和去 cap → 收集 1000,该测失败,4507 PASS。
- **沉淀**: 逐项≠累计上限族(E210 reviews / E226 tags)—— **"单项数量上限 × 项数上限"相乘仍可远超 UI 可渲染/可处理的全局量**;凡"逐 N 项各收集 M 个 → 汇总渲染"的聚合(tags / reviews / nodes),除逐项/项数 cap 外须有**全局汇总 cap**(distinct tag 总数),收集时凑满即停(set.size 闸 + break outer)。远程/持久化数据驱动 UI 列表(按钮/卡片)的收集函数都要全局 cap,防 UI 渲染海量元素卡顿。

## E227 — ScopeRequestCorrelator 未决 scope 请求无数量上限(插件 spam 放大)(P2)

- **问题**: `electron/main/services/scope-request-correlator.ts:53`。`createRequest()` 对 pending scope 请求无全局/per-webContents 数量上限。单次 request-scope 的 scopes 已限,但插件可连续 spam 大量未决请求 —— 每个在 pending Map 驻留至 resolve / 5min TTL,renderer 弹窗队列 + TTL 定时器随之线性增长 → 内存/弹窗放大(DoS 面)。
- **亲读**: "pending map/queue 无界"族(非迭代物化)。调用方(plugin-fs.service request-scope handler)createRequest → send 弹窗 → await。最干净:加 `canAccept()`,handler 在 createRequest + 弹窗**前**检查,超限终态 deny(不入 pending、不发弹窗)→ renderer 弹窗队列经此 transitively 受限(main 不发 = renderer 收不到)。
- **修复**: correlator 加 `MAX_PENDING_SCOPE_REQUESTS=256`(全局)+ `MAX_PENDING_PER_WEBCONTENTS=64` + `canAccept(webContentsId)`(全局 size 闸 + per-wc 计数闸,pending 封顶后遍历 O(≤256))。plugin-fs.service 在 createRequest 前 `if (!correlator.canAccept(event.sender.id)) return 'deny'`(终态 deny 收口)。
- **测试**: scope-correlator spec +E227×3(per-wc 64 满 → 该窗口 canAccept false、别窗 true / 全局 256 满 → 任意窗口 false / 未达 → true)。中和 canAccept 恒 true → 2 测失败,4510 PASS。
- **沉淀**: 资源上限维度第四 —— 单条字节(E1)+ 批次条数(E214)+ 并发 fan-out(E216)+ **未决/在途请求数**(E227 pending requests)。凡"创建一个驻留至 resolve/TTL 的 pending 条目(带定时器/弹窗)"的入口(scope 请求 / 授权弹窗 / await_stop_hook),须有 pending 数量上限(全局 + per-来源),超限 fail-closed(deny/拒)。authoritative 侧(main)加 cap 即可 transitively 限下游(renderer 队列)——cap 在创建+派发前检查,不创建即不派发。

## E228 — plugin-mcp 反向 invoke pending Map 无在途数量上限(MCP client spam 放大)(P2,E227 同族)

- **问题**: `electron/main/services/plugin-mcp-bridge.service.ts:115`。`createInvokeRemote()` 的 pending Map 对在途(in-flight)invoke 无全局/per-webContents 数量上限。每次 invoke 登记一条 pending + 起 30s timer + 向 renderer 发 IPC;此前只对单次 input/result 大小设限(E125 等)。外部 MCP client 可并发 spam 海量 tools/call 到同一 plugin tool —— 累计 pending + timer + IPC 事件放大 main 内存/事件循环压力(DoS 面)。E227(scope 请求 pending)的同族,在 plugin-mcp 反向调用路径。
- **亲读**: "pending map/queue 无界"族,资源上限维度第四(未决/在途请求数)。invoke 内 `new Promise` + pending.set,无 size 闸。注册侧已有 E79 数量上限(MAX_TOOLS_PER_WC/GLOBAL),但 invoke 在途无 cap。终态删除散在 6 处(timer/send-catch/send-false/reply/abortByWc/abortByTool)—— 加 per-wc 计数须收口删除,否则计数漂移会永久误判上限卡死后续 invoke。
- **修复**: 加 `MAX_INFLIGHT_INVOKES_GLOBAL=512` + `MAX_INFLIGHT_INVOKES_PER_WC=128`(对齐 E227 ScopeRequestCorrelator 双闸)。invoke 入口先查全局 pending.size + per-wc 计数,超限立即 reject `TOO_MANY_REQUESTS`(新错误码),不入 pending、不起 timer、不发 IPC。新增 `inflightPerWc` Map(O(1) 维护)+ `incWc/decWc`(decWc 归零删 key,Map 排空回收)+ **`removePending(requestId)` 单一删除收口**(删 pending + decWc),把原 6 处 `pending.delete` 全改走 removePending,防计数漂移。per-wc 上限同时透传约束单 tool spam(一个 tool 归属唯一 wc,无需再加 per-tool 维度)。
- **测试**: stub-tool.spec +E228×5(per-wc 满 → reject TOO_MANY_REQUESTS 且不入 pending/不发 IPC / reply 释放槽位后可再 invoke〔计数对偶无漂移〕/ owner1 满 owner2 不受影响〔per-wc 隔离〕/ abortByWc 释放全部槽位后可重新满额〔无残留〕/ 全局 512 满后全新 wc 也被全局闸拒)。中和:禁 per-wc 分支(`if (false)`)→ 4 测失败〔全局测仍过,各闸独立验证〕,4513 PASS。
- **沉淀**: 资源上限维度第四(未决/在途请求数)在 plugin-mcp 路径复现 —— 凡"每请求登记一条带 timer/IPC 的 pending,驻留至 reply/timeout"的反向调用入口都须全局 + per-来源在途上限,超限 fail-closed reject。**计数与多出口删除的对偶必须收口到单一 remove helper**:在途计数(incWc/decWc)若散在 N 个终态删除点维护,极易漏一处致 decWc 不对称 → 计数只增不减 → 永久误判满 → 后续合法 invoke 全被拒(比无 cap 更糟的"伪 DoS")。先收口删除(removePending 统一 delete+decWc)再加计数,是这类"带配额的多出口 Map"的安全改法。per-wc 闸天然透传约束更细粒度(per-tool)——tool 归属唯一 wc,无需叠加维度(极简)。

## E229 — agent-auth 反向授权 pending Map 无数量上限(MCP/agent spam 放大 + 假死)(P2,E227/E228 同族)

- **问题**: `electron/main/services/agent-auth.service.ts:72`(pending Map line 28)。`requestAgentAuth()` 对未决授权 pending 无全局/per-window 数量上限。每次登记一条 pending + 起 5min timer + 向 renderer 发 IPC;renderer 同一时间只弹一个授权框,其余全堆在 main 等满 5min 超时 —— 外部 MCP/agent 可并发 spam 大量需授权的 tool 调用,pending Map + timer + IPC 线性放大 main 内存/事件循环,且发起的外部 agent 进程干等假死(DoS 面)。E227(scope pending)/E228(plugin-mcp invoke pending)的同族,在 agent-auth 反向授权路径。
- **亲读**: 资源上限维度第四(未决/在途请求数),pending map 无界族。requestAgentAuth 先 pickWindow → new Promise(pending.set + timer + send),无 size 闸。注意文件头注释 + line 6 明确 renderer `store.ensure` **处理并发 pending** —— 故 codex 建议的"该窗口已有未决即拒"(per-window=1)会破坏既有合法并发设计,**不照搬**;改用宽松 backstop(global + per-window 计数),保并发又挡 spam。
- **修复**: 加 `MAX_PENDING_AUTH_GLOBAL=256` + `MAX_PENDING_AUTH_PER_WINDOW=64`(对齐 E227 ScopeRequestCorrelator 双闸值)+ `pendingCountForWindow(windowId)`(O(≤256))。requestAgentAuth 在 pickWindow 后、createPending 前查全局 pending.size + per-window 计数,超限直接终态 return `'denied'`(不入 pending、不起 timer、不发 IPC)。
- **测试**: agent-auth-service.spec +E229×4(per-window 满 → 终态 denied 且不发 IPC / resolve 释放槽位后可再请求〔计数无漂移〕/ win1 满 win2 不受影响〔per-window 隔离〕/ 全局 256 满后全新窗口也被全局闸拒)。中和:双闸条件改 `false` → 4 测失败,4517 PASS。
- **沉淀**: 资源上限维度第四(未决/在途请求数)在 agent-auth 路径复现 —— 至此 pending 数量上限族覆盖三条反向调用链:scope 请求(E227)/ plugin-mcp invoke(E228)/ agent-auth 授权(E229),解法同构(全局 + per-来源双闸,超限 fail-closed 不创建/不派发)。**codex 的具体修复值(per-window=1「已有未决即拒」)与既有设计冲突时不照搬**:文件头注释已声明 renderer 处理并发 pending,per-window=1 会回归并发能力 —— 取其方向(加 pending 上限)弃其过激值,用远高于正常并发的 backstop(64)。凡"每请求登记带 5min timer + IPC 的 pending、且消费端串行处理"的反向授权入口,都须 pending 数量 backstop,否则慢消费 + 快产生 = 队列无界 + 上游假死。

## E230 — plugin-shell-stream active 子进程表无并发数量上限(已授 shell 插件 spam 耗尽资源)(P2,E227/E228/E229 同族)

- **问题**: `electron/main/services/plugin-shell-stream.service.ts:29`(active Map)。START 只 `active.has(streamId)` 去重,对 active 流式子进程总数无全局/per-sender 上限。已授 shell 权限的插件可经 `app.shell.execStream()` 并发启动大量长跑 stream,每个占一个**真实子进程** + timeoutTimer + IPC listener + active 条目,直到 timeout(5-30min)/abort/window cleanup 才释放 —— 极端输入耗尽主进程/系统资源(fd / PID / 内存)。E227(scope pending)/E228(plugin-mcp invoke pending)/E229(agent-auth pending)的同族,但对象是**真实 OS 子进程**,杀伤力更重。
- **亲读**: 资源上限维度第四(并发 active 资源数)。START handler 已有 frame-trust(R8)+ 单 streamId 去重 + cmd/args/cwd 大小校验(E45)+ timeoutMs clamp(E10),唯独缺总量上限。active Map 在 finalize/forceKillStream/killStreamsForSender 处删除 → 计数随 Map 增删自然维护,无需独立计数器,只需 spawn 前查 size。
- **修复**: 加 `MAX_ACTIVE_STREAMS_GLOBAL=128` + `MAX_ACTIVE_STREAMS_PER_SENDER=32` + `activeCountForSender(senderId)`(O(≤128))。START 在 dedup 之后、spawn 之前查全局 active.size + per-sender 计数,超限 fail-fast 抛新错误码 `TOO_MANY_STREAMS`(不 spawn、不入 active、不起 timer)。计数靠 active Map 现有增删点自然释放(finalize/ABORT/sender cleanup)。新增 ERROR_CODES.TOO_MANY_STREAMS + en/zh/ko catalog 3 条(by-code 本地化链)。
- **测试**: 新建 electron/main/__tests__/plugin-shell-stream-active-cap.test.ts ×4,**mock node:child_process.spawn 返回永不结束的 fake child**(廉价确定,无需真起几十个 node 进程):per-sender 满 → 抛 TOO_MANY_STREAMS 且不 spawn / ABORT 释放槽位后可再 START〔计数自然维护〕/ sender1 满 sender2 不受影响〔per-sender 隔离〕/ 全局 128 满后新 sender 也被全局闸拒。中和:双闸条件改 `false` → 4 测失败。enum-count 38→39 + catalog 114→117 测试同步更新,4524 PASS。
- **沉淀**: 资源上限维度第四在 active 子进程表复现 —— 至此数量上限族覆盖四条:scope pending(E227)/ plugin-mcp invoke pending(E228)/ agent-auth pending(E229)/ shell-stream active 子进程(E230)。**对象是真实 OS 资源(子进程/fd/PID)时优先级实质高于纯 Map 条目**(后者只耗内存,前者可拖垮整机),但同解(全局 + per-来源双闸,spawn/创建前 fail-fast)。**计数维护优先复用资源 Map 自身的增删点**(active Map 已在 4 处删除)而非引入独立计数器 —— 少一个需对偶维护的状态 = 少一个漂移源(对比 E228 因多出口删除须引入 removePending 收口;此处 active 删除已收口在 forceKillStream/finalize,直接 size/scan 即可)。新业务错误码须同步 enum-count 测试 + i18n catalog ×3(en/zh/ko)+ catalog 全覆盖测试数(每码 ×3 locale)。

## E231 — shell-stream preload async iterator pending next() 等待者无数量上限(E230 preload 侧兄弟)(P2)

- **问题**: `electron/preload/plugin-shell-stream.preload.ts:154`。chunks AsyncIterator 的 `next()` 在无缓冲 chunk 且未退出时 `chunkResolvers.push(resolve)`,对 pending 等待者数量无上限。E61 的 `MAX_STREAM_QUEUE_BYTES` 只限**已收到字节**,不限**空读等待者**。恶意/异常插件可对同一 iterator 并发调用海量 `next()` 而不 await → chunkResolvers 无界增长;且 exit/return/synthesize 时 `resolveAllChunksDone` 同步遍历唤醒全部等待者 → 内存 + 主线程尖峰。E230(main 侧 active 子进程上限)的 preload/renderer 侧兄弟(同 spawn 路径的另一端),waiter 计数维度。
- **亲读**: R93 注释明确 chunkResolvers 是 **FIFO 等待者队列,故意支持并发 next()**(预取/并发读 stream 的封装库)—— 故 codex 建议的"单 iterator 只允许一个 pending next()"会回归 R93 修的并发能力,**不照搬**;取其方向(加 waiter 上限)用宽松 backstop。
- **修复**: 加 `MAX_PENDING_NEXT_RESOLVERS=1024`(远超任何合法并发预取)。next() 在 push resolver 前查 `chunkResolvers.length >= MAX`,超限视为滥用 → 与 E61 字节背压**同构**:removeListener + ABORT 子进程 + `synthesizeExit({exitCode:-1})` 收敛**所有**等待者(含本次返 done),停止接收。不只 reject 当次(避免 stream 半死、其余等待者仍挂)。
- **测试**: shell-stream-concurrent-next.spec +E231×1(凑满 1024 pending next() 不触发 → 第 1025 个超限 → ABORT invoke + 本次 done + 之前全部 pending 收敛 done + done Promise 合成 -1 exit)。既有 R93 并发 FIFO×2 回归保留(证不破坏并发)。中和:cap 条件改 `false` → E231 测失败、R93 仍过,4525 PASS。
- **沉淀**: 数量上限族第五,且揭示**同一功能的两端都要查**:E230 修 main 侧 active 子进程上限后,codex 立刻查同模块 preload 侧 → 发现 next() 等待者无界(E231)。**资源上限审计要沿数据流两端走(main spawn 端 + preload 消费端)**,一端加限不代表另一端安全(main 限了并发 stream 数,但单个 stream 的 preload 消费端仍可被海量 next() 打爆)。**"已收字节上限"≠"空读等待者上限"**:背压(E61)限的是入站数据量,本条限的是出站消费请求堆积 —— 同一 buffer 两个独立无界维度。over-cap 响应与既有同类防御(E61 背压)保持同构(ABORT + 合成 exit),不引入新收敛语义。

## E232 — MCP HTTP host sseClients SSE 长连接无数量上限(持 token 客户端反复建连耗尽资源)(P2,E227-E231 同族)

- **问题**: `electron/main/services/mcp-host.service.ts:479`(sseClients Map)。每个 `GET /mcp` 成功(token 校验过)后保留一个 ServerResponse + `setInterval` keepalive + sseClients Map 条目,只在 close/revoke 才清,无全局/per-token 数量上限。持有合法 bearer token 的本地客户端可反复打开大量 SSE 长连接不关闭 → main 累积 socket / ServerResponse / Map 条目 / keepalive timer;且 `broadcast()` 对全部连接线性写入 → 资源耗尽 + UI/agent 通知卡顿。E227-E231 数量上限族的第六处(SSE 长连接维度)。
- **亲读**: handleSse 是 createMcpHost 内闭包(非纯函数);本文件测试约定 HTTP/SSE 真行为留 E2E、单测只覆盖纯契约(generateToken/verifyBearer/parseRpcMessage…)。token 校验(verifyAndResolveCtx)已挡未授权,但**已授权连接数无闸**。sseClients 删除已收口在 closeSseClient + req close + revoke 各路径。
- **修复**: 加 `MAX_SSE_CLIENTS_GLOBAL=64` + `MAX_SSE_CLIENTS_PER_TOKEN=16` + **纯函数 `sseAdmissionAllowed(globalCount, perTokenCount)`**(便于单测,沿用本文件 pure-contract 测试模式)。handleSse 在写 200/建 keepalive **前**算 per-token 计数(扫 sseClients,O(≤64))+ 查准入,超限 `res.statusCode=429; res.end()` 拒(不建连、不起 keepalive、不入 Map)。token 复用准入算出的值传入 sseClients.set(去重复计算)。
- **测试**: agent-terminal-mcp-host/host.spec +E232×4(均未达→准入 / 全局 64 达上限→拒〔即便 per-token 少〕/ per-token 16 达上限→拒〔即便全局有空间〕/ 边界 63→ok/64→拒、15→ok/16→拒)。中和:helper 改 `return true` → 3 测失败(均-under 那条仍过),4529 PASS。
- **沉淀**: 数量上限族至此六处覆盖**外部可反复建立的常驻资源**全谱:pending 请求(scope E227 / agent-auth E229)/ in-flight 调用(plugin-mcp E228)/ spawn 子进程(shell-stream E230)/ 消费等待者(next() E231)/ **长连接(SSE E232)**。**内闭包逻辑的可测性**:handleSse 不可直接单测(HTTP)时,把判定抽成纯函数(sseAdmissionAllowed)export 单测,闭包只做 IO 编排 + 调纯函数 —— 与本文件既有 verifyBearer/parseRpcMessage 的"IO 壳 + 纯核"分层一致,既测到 cap 逻辑又不需起 HTTP server。token 校验通过 ≠ 资源无限:**鉴权挡的是"谁能连",数量闸挡的是"能连多少"**,两者正交,有 token 门控仍需连接数 backstop(合法 token 也可被滥用/泄漏后批量建连)。

## E233 — stdio MCP socket server 连接无数量上限(本用户进程反复连接耗尽 fd/内存)(P2,E232 同族)

- **问题**: `electron/main/services/mcp-stdio-server.service.ts:314`(connection 回调)。stdio MCP socket server 对 `clients`/`lineChains`/`aborters`/`socketCtx`/`socketSubject` 无连接数量上限。socket 受 chmod 0600(unix)/ NT pipe ACL(Win)限本用户,但**本用户任意进程**可反复连接 `<userData>/mcp.sock` 保持空闲 —— 每条连接保留 Socket + AbortController + 行解码器闭包 + 多个 Map/Set 条目;`broadcast()` 对全部 client 线性写入 → main fd/内存耗尽 + 通知广播拖慢。E232(HTTP SSE 连接)的同族,在 stdio socket 传输侧。
- **亲读**: connection 回调无条件 `clients.add(sock)` + 建 AbortController/lineChain,无 size 闸。单行字节(E1)+ 行数(E214/E218)上限已有,但**连接数**无限。删除已收口在 sock close(clients/socketCtx/socketSubject/lineChains delete + aborter.abort)。**连接建立时 subject/window 尚未解析**(per-message hello 才定 socketSubject)→ 只能在连接入口加全局闸(per-subject 在连接时不可知,与 E232 SSE 的"建连即知 token"不同)。
- **修复**: 加 `MAX_STDIO_CLIENTS_GLOBAL=64`(对齐 E232)。connection 回调最前查 `clients.size >= MAX` → 写 PARSE_ERROR 'too many connections' + `sock.destroy()` + return(不进任何 clients/aborters/lineChains 表)。计数随 sock close 现有清理自然释放。
- **测试**: ct-b3-socket-safety.spec +E233×1(真 unix socket:建满 64 连接保持 → 第 65 收 'too many connections' + 断开 → 关一个已建连接后 revived 又可建立〔计数随 close 释放〕)。中和:cap 条件改 `false` → 该测失败,4530 PASS。
- **沉淀**: 数量上限族第七处,**E232/E233 是 MCP 两种传输(HTTP SSE / stdio socket)的连接上限对偶** —— 同一逻辑服务的两个传输端都要查。**身份解析时机决定可用闸维度**:SSE 建连即带 bearer token(可 global + per-token 双闸 E232),stdio socket 连接时 subject 未知(per-message hello 才定)→ 只能 global 闸 E233。审计连接类资源时先确认"建连时已知什么身份信息",据此选可施加的闸维度,不能照搬上一处的 per-X 维度。文件级权限(chmod 0600 / pipe ACL)挡的是"哪个用户能连",数量闸挡的是"该用户能连多少",正交 —— OS 权限不替代连接数 backstop。

## E234 — update-store manifest 拉取 Promise.allSettled 无并发上限(畸形安装集触发数百-上千 fetch 尖峰)(P2,E216 并发 fan-out 同族)

- **问题**: `src/marketplace/update-store.ts:98`。refresh() 对 `relevant`(已安装命中的 marketplace entries)直接 `Promise.allSettled(relevant.map((e) => fetchPluginManifest(e)))`,无并发上限。源码注释假设 "N < 100",但 marketplace index 上限 4096、本地插件目录上限可达 1024 —— 畸形/极端安装集或缓存可触发数百到上千个 manifest fetch **同时**发起:renderer 网络/Promise/解析压力尖峰,GitHub raw 被本地 burst 打满,市场/设置页卡顿或 update check 长时间拖慢。资源上限维度第三(并发 fan-out,E216 Promise.all 同族),区别于数量上限族(E227-E233 是"驻留资源条数",本条是"瞬时同时在途数")。
- **亲读**: relevant.map → allSettled 是真无界并发。下游 `for (i) results[i].status` 依赖结果按输入顺序对位 + 单失败不影响其它(allSettled 语义),修复须保此两点。仓内无现成可复用并发池 helper(P3 lstat 分块在另一分支)。
- **修复**: 新建 `src/lib/map-with-concurrency.ts` 的 `allSettledWithConcurrency(items, limit, fn)` —— 固定大小 worker 池(workerCount=min(limit, items.length)),结果 new Array 按 index 对位,每任务 try/catch 成 {status:fulfilled|rejected}(保 allSettled 语义)。update-store 改用它 + `MAX_MANIFEST_FETCH_CONCURRENCY=12`(8-16 区间掩盖网络延迟又不打爆)。下游 results[i] 处理不变(返回同形 PromiseSettledResult[])。
- **测试**: update-store.spec +E234×1(N=50 远超上限,fetchManifest mock 跟踪 inFlight/maxInFlight + 逐个放行;断言峰值在途 === 12 且全部 50 个最终拉取过)。中和:还原 `Promise.allSettled(relevant.map(...))` → maxInFlight=50≠12 测失败,4531 PASS。
- **沉淀**: 资源上限族两条正交轴 —— **驻留条数**(E227-E233:pending/连接/子进程,"同时存在多少")用 size 闸 fail-closed;**瞬时并发**(E234,E216:fan-out,"同时在途多少")用 worker 池钳定。`xs.map(asyncFn)` + `Promise.all/allSettled` 当 xs 由外部/畸形数据驱动(index/目录/响应数组)时都是潜在 fan-out 尖峰点 —— 凡"对外部规模数组逐项发 IO"都要有界并发池,而非裸 map+all。**注释里的规模假设("N<100")是审计信号**:与实际上限常量(index 4096 / 目录 1024)对照,假设过期即漏洞。并发池 helper 须保 allSettled 双语义(顺序对位 + 单失败隔离),用 worker-pool(共享游标)而非 chunk 分批(后者批内最慢拖累整批,吞吐更差)。

## E235 — 终端会话(真实 PTY)无数量上限(create_session/Cmd+T 循环耗尽系统资源)(P1,E230 数量上限族)

- **问题**: `electron/main/services/terminal-sessions.service.ts:87`(sessions Map,truth source;及 terminal.service.ts instances)。`add()` 对会话数量无全局/每窗口上限。`terminal:create` / MCP `create_session` 可持续创建新 PTY —— 极端输入或已授权 agent 循环调用可堆出大量**真实子进程**,每会话占 PTY + 4MiB ring buffer + throttle interval + metadata 快照广播 + Dock panel,同步拖垮 main/renderer/系统。数量上限族里**最重的资源**(真实 PTY + 4MiB/会话),故 P1。
- **亲读**: `add()` 是所有创建路径(IPC user create + MCP create_session)的 reservation 单一漏斗,且在 `service.createTerminal` 的 **PTY spawn 之前**调用(terminal.ipc.ts:201 先 add 再 219 createTerminal,见 R31 注释)。故在 add() 加 cap 即覆盖所有路径,且超限抛错时 IPC handler 不会进到 createTerminal → **不漏 PTY 子进程**。sessions Map 含 live + exited-retained,remove/removeByOwner 释放 → 计数自然含两态(对齐 codex"计数含 live 与 exited-retained")。
- **修复**: 加 `MAX_TERMINAL_SESSIONS_GLOBAL=256` + `MAX_TERMINAL_SESSIONS_PER_WINDOW=64` + `sessionCountForWindow()`(O(≤256))。add() 在 duplicate 检查后、构造 session 前查全局 sessions.size + per-window 计数,超限抛 `TOO_MANY_TERMINALS`(新错误码,不入 sessions、不 notify、不触发 PTY spawn)。新增 ERROR_CODES.TOO_MANY_TERMINALS + en/zh/ko catalog 3 条 + enum-count 39→40。
- **测试**: terminal-sessions-service.spec +E235×4(per-window 64 满 → 抛 TOO_MANY_TERMINALS 不入 sessions / setExited 不释放〔exited-retained 仍计数〕、remove 才释放后可再 add / per-window 隔离 win1 满 win2 可 add / 全局 256 满后新窗口也被全局闸拒)。中和:双闸条件改 `false` → 4 测失败,4538 PASS。
- **沉淀**: 数量上限族第八处,**首个 P1**(对象是真实 PTY 子进程 + 大 buffer,资源权重远高于纯 Map 条目/连接,故 codex 提级 P1)。**在 reservation 单一漏斗加 cap 优于在 N 个调用点各加**:add() 是所有 create 路径的必经点且在 spawn 前,一处 cap 即全覆盖 + 天然不漏底层资源(若在 spawn 后才 cap,抛错时已 spawn 的 PTY 成孤儿)。**资源释放语义要分清"逻辑结束"与"条目移除"**:setExited(PTY 已死但 entry 保留显 badge)不释放计数,只有 remove(entry 真删)才释放 —— cap 计 Map.size 自动正确含 exited-retained,与"PTY 是否存活"解耦(已死但保留的 entry 仍占 UI/metadata 资源,该计数)。

## E236 — 插件贡献注册表无条目数量上限(畸形插件循环注册撑爆 UI)(P2,E79/E54 注册表数量上限族)

- **问题**: `src/plugins/registries/CommandRegistry.ts:95`(及 7 个兄弟 registry)。各 registry 只校验**单条** spec 字段长度/形态(E35/E37/E153),无**数量**上限。畸形/恶意插件可循环注册大量合法小条目 → items Map 无界增长 → getAll() 全量 Array.from + 命令面板搜索排序 + 全局 hotkey 扫描线性放大 → renderer 卡顿/内存上涨。E79(plugin-mcp tool 数量上限)/E54(ExplorerDecorator)的同族,覆盖剩余 Map 型 registry。
- **亲读**: grep 全 9 个 registry —— ExplorerDecoratorRegistry 已有 MAX_DECORATORS(E54,数组型),其余 8 个(Command/EditorAction/ExplorerContextMenu/Panel/Ribbon/SettingItem/SettingTab/StatusBar)结构同构(`items = new Map` + `register(spec): Disposable` + `items.has(id) → warn 覆盖` + `items.set`),全缺数量上限。codex 只报 CommandRegistry,但「修一族必 grep 兄弟入口」→ 8 个一次修齐。
- **修复**: 新建共享 helper `src/plugins/registries/registry-capacity.ts`:`MAX_REGISTRY_ITEMS=1024` + `assertRegistryCapacity(name, size, isExistingId)`(覆盖既有 id 不增长 → 放行;新 id 且满 → 抛)。全 8 个 register() 在 validate 之后、items.set 之前调用(Panel 以 spec.type 为 key,其余 spec.id)。收口共享 helper 而非 8 处各写常量,消漂移。
- **测试**: 新建 registry-capacity.spec ×12(helper 三态:未达放行 / 满+新 id 抛 / 满+既有 id 放行;CommandRegistry 集成:注册到 1024、+1 新 id 拒、覆盖既有 id 放行、dispose 释放名额后可再注册;**家族接线守卫:readFileSync 全 8 个 registry 源码断言含 assertRegistryCapacity 调用**——防某兄弟漏接/回归)。pnpm bdd:index 重建索引。中和:helper 改 `if(false)` → 2 测失败,4550 PASS。
- **沉淀**: 数量上限族第九处(注册表条目)。**一次修齐同构兄弟 + 共享 helper 收口**:codex 报一个(CommandRegistry),但同构兄弟(8 个 Map 型 registry)全缺时,逐个等 codex 报需 8 轮 —— grep 全族一次修齐 + helper 单一来源,避免漂移(8 处各写易出现常量不一/漏判覆盖语义)。**家族接线守卫测试(grep 源码断言全兄弟都调 helper)**是防"加了 helper 但某兄弟漏接"或未来回归的最轻量保险(对比 i18n 的"全量守卫",同模式:用源码级断言钉死家族完整性,不逐个构造每 registry 的 valid spec)。覆盖既有 id 不计入增长是关键语义(register 同 id = 覆盖非新增,满表时仍须允许 reload/override)。

## E237 — plugin-data:save 校验 payload 却落盘原始 data(raw IPC null/undefined 致数据丢失)(P1,数据安全)

- **问题**: `electron/main/services/plugin-data-store.service.ts:169`。save 把 `data ?? {}` 归一成 `payload`(line 115),assertJsonValue / JSON.stringify / 字节上限全跑 payload;但 `atomicWriteJson(file, data)` 落盘写的是**原始 data**。绕过 renderer 直调 raw IPC 传 `null`/`undefined` 时,payload={} 过校验,却把 `null`/`undefined`(序列化为 "null")写进 data.json → 破坏 data.json 的 plain object 契约 → 下次 load 见非对象 → 当损坏隔离(.corrupt)+ 降级返 {} = 插件数据静默丢失/重置。校验对象与落盘对象不一致(检查 X 写 Y)。
- **亲读**: line 115 payload = data ?? {},line 169 写 data。确认 atomicWriteJson(file, null) 会写 "null",load(line 92-99)对非 plain object → 写 .corrupt + return {}。既有 E147 null 测试(line 97)只断言 `LOAD resolves {}` —— 但旧 bug 下 load 也返 {}(损坏降级也返 {}),故漏检(测对了返回值,没测落盘内容/契约)。
- **修复**: line 169 `atomicWriteJson(file, payload)`(写归一后的 payload,与校验对象一致)。一行修复。
- **测试**: plugin-data-corrupt-degrade.spec +E237×1(raw IPC save(id, null/undefined)→ **读落盘内容断言 JSON.parse === {}** 且后续 load 不产生 .corrupt)。中和:还原写 `data` → E237 失败(既有 E147 null 测试仍过,证旧测漏检),4551 PASS。
- **沉淀**: 数据安全"检查 X 落盘 Y"族 —— **归一/校验后产出的对象(payload)与最终持久化的对象必须是同一个**;凡"先 normalize→validate(payload),再 write(原始 input)"的写入路径,validate 与 write 的对象不一致 = 校验形同虚设(畸形 input 过 payload 校验仍落盘)。**测试要断言落盘产物而非仅返回值**:E147 只测 load 返回值,损坏降级恰好也返 {} → 把"写坏了再降级掩盖"误判为"写对了"。验数据安全写入须读磁盘内容断言契约(JSON.parse 落盘 === 期望),并断言不触发损坏隔离(.corrupt 不存在),才能区分"真写对"与"写错被降级吞掉"。

## E238 — renameSession 自定义终端标题无长度上限(绕过主进程 LABEL_MAX)(P2)

- **问题**: `src/stores/terminal.store.ts:266`。`renameSession(id, title)` 只 `title.trim()` 后写入 `customTitles`,无长度上限。主进程 create/title 入口有 LABEL_MAX(512,terminal-create schema z.string().max),但 renameSession 是 **renderer-only store 入口,不经主进程 schema** —— 极长自定义标题进 customTitles 被 DockReconciler/Dock tab title 反复渲染,绕过主进程 512 边界 → UI 卡顿/内存膨胀。
- **亲读**: LABEL_MAX=512 已在本文件 line 12 导入(isSnapshot 守卫 line 62/74 已用它校验快照 title)。renameSession 漏用同一上限。"主进程已 cap 但 renderer-only 旁路入口绕过"族(同 E147 plugin-data raw IPC 旁路 renderer 校验,方向相反:这里是 renderer 旁路 main)。
- **修复**: `title.trim().slice(0, LABEL_MAX)` 截断(复用既有 LABEL_MAX,非新常量)。截断而非拒绝:保留用户重命名意图只钳长度;空串仍走 delete 分支恢复默认标题。LABEL_MAX 是 code-unit 上限(z.string().max() 同语义),slice 匹配。
- **测试**: terminal-store.spec +E238×2(5000 字符 → 截断到 512 / 前后空白+超长 → 先 trim 再截断 512)。既有 rename/空串删除/trim 视同空 回归保留。中和:去 slice → 2 测失败,4553 PASS。
- **沉淀**: "主进程 schema 有 cap 但 renderer-only 状态入口旁路"族 —— 同一显示串(terminal title)有两个写入路径:主进程 create(经 terminal-create schema cap)+ renderer store renameSession(纯前端,不经 schema)。**凡同一字段有"经校验主路径"与"纯 renderer 旁路"两个写入口,旁路必须复用主路径的同一上限常量**(import LABEL_MAX 而非各写),否则主路径的 cap 被旁路架空。审计 cap 完整性要列全某字段的**所有**写入口(main IPC + renderer store action + 持久化 hydrate),逐个核对都施加同一约束。

## E239 — scoped-app requestScope 无 pre-IPC 预检(超大 scopes 数组先序列化进 IPC)(P2,E44/E180 pre-IPC 预检族)

- **问题**: `src/plugins/scoped-app.ts:139`。`app.fs.requestScope(scopes)` renderer wrapper 直接把插件传入的 scopes 发 `coApi.pluginFsRaw.requestScope`,无数量/字段预检。主进程 plugin-fs.service request-scope 入口有 MAX_SCOPE_REQUEST_COUNT=64 + path 长度 + mode 校验,但畸形插件传超大数组/超长路径时,renderer→preload→main 的 **structured clone 已先序列化大对象**(IPC 放大),主进程 schema 才拒绝。同 wrapper 的 readFile(E180)/writeFile(E44)已有 pre-IPC 预检,requestScope 是漏掉的兄弟。
- **亲读**: scoped-app readFile/writeFile 已用 FS_PATH_MAX/MAX_WRITE_BYTES 在发 IPC 前 reject,requestScope 漏。主进程校验(数量/path/mode)在 plugin-fs.service:584-605。
- **修复**: scope 限制收口到 shared `electron/shared/fs-limits.ts`:`MAX_SCOPE_REQUEST_COUNT=64` + `validateScopesShape(scopes)`(数组 + 数量 + 每项 {path 非空≤FS_PATH_MAX, mode∈{r,rw}},合法返 null 否则返错误消息)。path 长度复用既有 FS_PATH_MAX(8192,本就对齐)。**main 与 renderer 共用**:plugin-fs.service 改调 helper(替 22 行 inline 校验)+ re-export MAX_SCOPE_REQUEST_COUNT 维持既有测试 import;scoped-app requestScope 发 IPC 前调 helper,超量抛 Error+code BAD_INPUT(主进程仍作权威兜底)。
- **测试**: scoped-app.spec +E239×3(合法转发 / 数量>64 抛 BAD_INPUT 不调 IPC / path 超 FS_PATH_MAX 或 mode 非法抛不调 IPC)。既有 read-file-size-cap 的 main tooMany 测试经 re-export 保留。中和:去 renderer guard → 2 测失败,4556 PASS。**web-compat-allowlist 行号联动**:scoped-app 加 12 行使既有 globalThis 注释 hit 行号 263→275,同步更新 allowlist(E180 纪律)。
- **沉淀**: pre-IPC 预检族(E44 write/E180 read/E239 requestScope)—— **renderer wrapper 凡把插件传入的"规模可变 payload"(大字符串/大数组/长路径)转发 IPC 前,都须用与主进程同一来源的限制先 reject**,否则 structured clone 先序列化大对象 = 主进程的 cap 挡得住"处理"却挡不住"IPC 传输放大"。校验逻辑收口 shared(validateScopesShape main+renderer 共用),不在两端各写(消漂移)。**改 src/plugins 行数必联动 web-compat-allowlist 行号**(E180):加注释/代码使既有 globalThis hit 下移,allowlist 按行号锚定会 stale → 全量测试才暴露,记得同步。

## E240 — keybindings-store 读端不校验 hotkey 形态(篡改/旧版本畸形值经 compileCombo 误触发)(P1,读≡写对偶族)

- **问题**: `src/plugins/keybindings/keybindings-store.ts:28`。readStored 的 valueGuard 只校验"是字符串且 ≤256",没有复用写入端(setHotkey line 57)的 HOTKEY_SHAPE_RE 形态校验。篡改/旧版本残留的畸形 localStorage override(如 `mod++s` 空段、`mod+ s` 含空白)会被读端放行 → getEffectiveHotkey → compileCombo 当成 `mod+s` 参与全局快捷键匹配 → **意外触发命令**。写入端与注册端(CommandRegistry)都拒绝该形态,唯独读回端漏。读端/写端校验不对称(同 E238 renderer 旁路 / E239 pre-IPC)。
- **亲读**: HOTKEY_SHAPE_RE 已在 line 13 导入(setHotkey 用它)。读端 valueGuard 漏用。localStorage 是用户/旧版本可写的外部源(篡改 + 跨版本残留),读回必须独立校验(写侧 cap 不护读侧/历史数据,同 E215 写侧/读侧对偶)。
- **修复**: valueGuard 改为 `typeof v === 'string' && v.length <= 256 && (v === '' || HOTKEY_SHAPE_RE.test(v))` —— 与写端语义一致('' = unbind 放行,否则须形态合法 + ≤256)。畸形项被 readRecord 丢弃(降级默认快捷键)。
- **测试**: keybindings-store.spec +E240×1(localStorage 注入 合法+空段畸形+空unbind+含空白畸形 4 项,经 storage 事件重读 → 合法/unbind 保留,2 个畸形丢弃)。中和:读端去形态校验 → 测失败,4557 PASS。
- **沉淀**: "读≡写校验对偶"族(E215 写/读 + E238 main/renderer + E239 主/旁路 + E240 写端/读回端)—— **同一字段的写入校验与读回校验必须等价**,否则:旧版本写入的(当时合法、现已收紧规则的)数据、或绕过写入端直接篡改持久层的数据,会从读端进入运行时。localStorage/磁盘等用户可写持久层尤甚(写端 cap 只护"本版本经 UI 写入"的路径,护不了历史残留 + 外部篡改)。修法:读端复用写端同一校验常量/正则(HOTKEY_SHAPE_RE 单一来源),非法降级丢弃。审计某字段约束完整性须列全:写 action + 读回 guard + 跨进程/跨窗同步重读路径,逐个核对施加同一约束。

## E241 — coerceSettingValue 读路径不截断 text(篡改/旧版 localStorage 超长 text 原样返回)(P2,E240 读≡写族)

- **问题**: `src/plugins/registries/SettingItemRegistry.ts:70`(coerceSettingValue)+ `src/plugins/settings/values-store.ts`。setValue(写)经 coerceSettingValue + 显式 slice 到 MAX_SETTING_TEXT_LEN(64KiB);但读端 getSettingValue/useSettingValue 只经 coerceSettingValue,而 coerceSettingValue 对 text 类型 `return value` 不截断。篡改/旧版 localStorage 可放入接近 readRecord 1MiB raw cap 的超长 text override(过 valueGuard:任意 string),读端原样返回 → 设置页/消费者渲染超长字符串卡顿。E240(keybindings 读端)的同族(读≡写校验对偶),都是"写端 cap 了、读端/coerce 没 cap"。
- **亲读**: values-store valueGuard(line 36)接受任意 string 不限长;setValue slice 在 store 层(写端);读端两入口(getSettingValue line 117 / useSettingValue line 131)共用 coerceSettingValue,但它无 text-len 截断。MAX_SETTING_TEXT_LEN 此前定义在 values-store(写端),coerce 看不到。
- **修复**: text 上限常量 `SI_TEXT_VALUE_MAX=64KiB` 收口到 SettingItemRegistry(coerceSettingValue 家),coerceSettingValue 加 text 分支截断(`spec.type==='text' && string && len>MAX → slice`)。coerceSettingValue 是读(getSettingValue/useSettingValue)写(setValue)共用的 coercion 点,在此截断使读≡写。values-store 的 MAX_SETTING_TEXT_LEN 改 import SI_TEXT_VALUE_MAX(单一来源,setValue 的 no-spec graceful 路径仍用它 slice)。
- **测试**: values-store.spec +E241×3(getSettingValue 超长 text 截断到 64KiB / useSettingValue hook 同样截断〔需 register spec + (id,default) 签名〕/ 合法长度不受影响)。中和:去 coerce text 分支 → 2 测失败(合法长度测仍过),4560 PASS。
- **沉淀**: 读≡写族再现(E240 keybindings / E241 settings)—— **当读写共用一个 coerce/normalize 函数时,把约束放进该共用函数**(coerceSettingValue)比在写端单独 slice 更稳:共用函数是读写唯一汇聚点,在此施加 = 读写自动等价,不会出现"写端 slice 了、读端经 coerce 漏 slice"。约束常量随之收口到共用函数的家(SI_TEXT_VALUE_MAX 在 SettingItemRegistry,values-store import),消跨文件漂移。审计 coerce/normalize 函数要核对:它是否覆盖该类型所有需约束的维度(number 有 clamp、select 有 enum、text 此前漏 len)。

## E242 — plugins:changed / protocol-url push 事件无 payload runtime 守卫(畸形 payload 抛/污染)(P2,E168-E175 IPC push ingress 守卫族)

- **问题**: `electron/preload/index.ts:300`(onChanged)+ 306(onProtocolUrl)。两个 main→renderer push 事件 listener 直接 `payload.id` / `payload.url` 解包,信任 main 形态。畸形 payload 为 null → listener 中抛(未捕获);超长/非字符串 id → 进 plugin-reload-gate pending Set 或触发 reload(污染启动期缓冲/错误路径);超长 url → 进 protocol-dispatch。IPC push ingress 纵深防御族(同 E173 fs:dir-changed / agent-auth push),preload 侧两个孪生入口漏守卫。
- **亲读**: onChanged + onProtocolUrl 是同块孪生结构(都 `(_, payload) => cb(payload.X)`)。codex 只报 plugins:changed,但 onProtocolUrl 是字面同款 untrusted-push 兄弟 → 按「修一族必 grep 兄弟入口」两个一起守。plugins-channels.ts 无 zod 依赖(preload 可 import),守卫写纯函数。
- **修复**: plugins-channels.ts 加 `PLUGIN_ID_MAX_LEN=256`(对齐 plugin-mcp PLUGIN_ID_MAX)+ `PROTOCOL_URL_MAX_LEN=8192` + 纯函数守卫 `isPluginsChangedPayload`(非空 string id ≤256)/ `isProtocolUrlPayload`(非空 string url ≤8192)。preload onChanged/onProtocolUrl listener 改 `payload: unknown` → 守卫不过则 `console.warn + return`(drop 不调 cb),与 fs:dir-changed 守卫同款。
- **测试**: 新建 plugins-push-payload-guard/guard.spec ×6(两守卫各:合规/边界上限 true,null/非对象/非字符串/空/超长 false;+ **preload 接线守卫**:readFileSync preload/index.ts 断言含 `isPluginsChangedPayload(payload)` + `isProtocolUrlPayload(payload)` 调用,防漏接)。pnpm bdd:index 重建。中和:守卫 return true → 2 测失败,4566 PASS。
- **沉淀**: IPC push ingress 守卫族(E173 fs:dir-changed / E175 shell-stream / E242 plugins:changed+protocol-url)—— **main→renderer 的每个 push 事件 preload listener 都须 runtime 守卫 payload**(main 形态正确不代表运行时不会有畸形:崩溃中途/旧版本/未来格式/测试桩),畸形 warn+drop 不调 cb,不让脏数据进下游(reload-gate/dispatch/watcher)。守卫纯函数放 zod-free 的 channels 文件供 preload import。孪生入口(同 preload 块的多个 onX push 订阅)一次性全守 + **接线守卫测试**(grep preload 源码断言每个 listener 都调守卫)防漏接/回归 —— 同 E236 家族接线守卫模式。

## E243 — reviews-fetcher 信任 IPC nodes 形态/长度(renderer 读端不闭合)(P2,E215 读端独立校验族)

- **问题**: `src/marketplace/reviews-fetcher.ts:79`。fetchAllReviews 直接 `for (const node of res.data.nodes)`,信任 main 经 IPC 返回的 nodes 一定是数组且已限长(MAX_TOTAL_NODES=2000,仅 main 侧约束)。畸形 IPC payload(非 iterable)→ for...of 抛;超大数组(畸形/未来 main 回归)→ 绕过 renderer 上限放大 parse/aggregate/渲染。边界契约只靠 main 不闭合。
- **亲读**: main marketplace-reviews.service 有 MAX_TOTAL_NODES=2000(E57)。renderer 这端直接消费,无独立守卫。E215(写侧/读侧对偶)/ E240/E241(读端独立校验)同族 —— 跨进程边界两端都要施加约束,不能假设对端永远合规。
- **修复**: reviews-fetcher 加 `MAX_REVIEW_NODES=2000`(对齐 main MAX_TOTAL_NODES)+ 读端守卫:`Array.isArray(res.data.nodes)` 不过 → 当无 reviews(回退 stale 或空 Map,稳定不抛);数组按 MAX_REVIEW_NODES slice 截断再 parse。
- **测试**: reviews-fetcher.spec +E243×2(非数组 nodes → 空 Map 不抛 / 2005 同 pid nodes → aggregate count 截断到 2000)。中和:去守卫还原裸 for...of → 2 测失败,4568 PASS。
- **沉淀**: 读端独立校验族再现(E215/E240/E241/E243)—— **跨进程/跨信任边界消费数据,接收端必须独立施加形态 + 数量约束,不能因"发送端(main)已约束"就裸消费**:发送端的 cap 护不了 IPC 畸形(序列化损坏/版本错配/未来回归/测试桩),且非数组直接 for...of 会抛使整个刷新失败。修法:接收端 Array.isArray 形态守卫(非法→稳定空/降级不抛)+ 数量上限截断(常量对齐发送端,注释标注来源)。审计跨边界数据流要两端都核对约束,不止源头。

## E244 — safeTruncate 前置 reset 未计入预算(返回值超 maxBytes 契约 4 字节)(P2)

- **问题**: `electron/main/services/terminal.service.ts:330`。safeTruncate(data, maxBytes) 先从尾部累积 ≤ maxBytes 字节,再**无条件前置** `\x1b[0m`(4 ASCII 字节)→ 返回值真实 UTF-8 字节 = maxBytes + 4,违反"≤ maxBytes"契约。overflow 路径标称单 chunk 上限 TRUNCATE_MAX_BYTES=64KiB,实际发 64KiB+4;作为通用字节截断 helper 复用时小上限场景明显违约。
- **亲读**: 截断循环用 maxBytes 作预算(line 311),slice 后 line 330 拼 reset 前缀。早返 `utf8ByteLength(data) <= maxBytes` 不加前缀(只截断时加),故只需在截断分支扣除前缀字节。reset 全 ASCII = 固定 4 字节。
- **修复**: 加 `RESET_PREFIX='\x1b[0m'` + `RESET_PREFIX_BYTES=4`,截断预算 `budget = max(0, maxBytes - RESET_PREFIX_BYTES)`,累积循环用 budget。返回 `RESET_PREFIX + slice` 总字节 ≤ maxBytes(maxBytes≥4 时)。maxBytes<4 退化场景预算 0 → 仅返回 reset(前缀本身 4 字节,无法更小,注释标注)。
- **测试**: terminal-service/helpers.spec +E244×3(ASCII/CJK/emoji:`Buffer.byteLength(r) <= maxBytes` 总字节断言,非 +4)。既有 E149 tail≤max 测试仍过(更严)。中和:budget 还原 maxBytes → 3 测失败,4571 PASS。
- **沉淀**: "固定前缀/包装未计入大小预算"族 —— 凡"截断到 N 字节后再拼固定前缀/后缀(reset/换行/包裹标记)"的 helper,返回值会超 N 个前后缀字节;契约若是"返回值 ≤ N"则预算必须先扣前后缀字节(budget = N - fixedAffixBytes)。审计大小契约的 helper 要核对:声明的上限是针对"截断的数据部分"还是"最终返回值"——若是返回值,所有附加字节(reset/分隔符/省略号)都要计入。

## E245 — IpcPermissionStore.parsePermissionState 读端无界解析(畸形权限 payload 巨表/脏值缓存)(P2,E215/E243 读端有界解析族)

- **问题**: `src/plugins/permissions/IpcPermissionStore.ts:84`。parsePermissionState 对 READ_PERMISSIONS 返回值直接 `Object.entries(raw)` 全量物化;parseDecisionList/parsePathScopes 无数量上限;parseDecision 的 decidedAt 仅 `typeof number`(放行 Infinity/NaN/负),permission/path 无长度上限。畸形/未来回归的 IPC payload 在 renderer 首次授权检查时扫描/分配巨表,把超长 permission/path 或非有限时间戳缓进 cache,后续 grant/deny 把脏记录随单 plugin 写回。读端契约只靠 main 不闭合。
- **亲读**: main 侧 plugins.ipc 写端有完整 cap(PLUGINS_MAX=10_000 / DECISIONS_MAX=1000 / PATHSCOPES_MAX=10_000 / PERMISSION_MAX=256 / PATH_MAX=8192 / decidedAt .finite().nonnegative()),plugins.service 读端也有(E92/E185)。唯独 renderer IpcPermissionStore 读端裸解析。E215(写/读对偶)/E243(读端独立校验)同族。
- **修复**: renderer 读端加对齐 main 的常量(MAX_PERMISSION_PLUGIN_KEYS=10_000 / MAX_DECISIONS_PER_PLUGIN=1000 / MAX_PATH_SCOPES_PER_PLUGIN=10_000 / PERMISSION_NAME_MAX=256 / SCOPE_PATH_MAX=8192)。parseDecision 加 permission 长度 + `Number.isFinite(decidedAt) && >=0`;parsePathScope 加 path 长度;parseDecisionList/parsePathScopes 数量上限早停;parsePermissionState 改 for...in + keyCount 早停(不 Object.entries 全量物化巨表)。
- **测试**: ipc-permission-store.spec +E245×5(plugin keys 10050→截 10000 / decisions 1100→截 1000 / decidedAt Infinity/NaN/负→丢弃 / 超长 permission+path→丢弃 / 合法回归)。中和:去 finite + 数量上限 → 2 测失败,4576 PASS。
- **沉淀**: 读端有界解析族(E215/E240/E241/E243/E245)—— **跨进程读回的持久化/IPC 数据,renderer 解析必须独立施加与写端等价的全部约束:数量上限(早停,不全量物化)+ 字段长度 + 数值有限性**。写端 cap(main zod)护不了畸形/旧版本/篡改的持久层数据,且 renderer 是授权决策的实际消费者(脏值缓进 cache 后随 grant/deny 写回污染)。常量值同步 main(注释标注对齐来源),for...in 早停优于 Object.entries 全量物化(巨表在物化阶段就 O(N) 卡)。

## E246 — pathScopes 写端上限(10_000)≠ 读盘层(256)写读契约错位(写成功后静默丢)(P2)

- **问题**: `electron/main/ipc/plugins.ipc.ts:34`。WRITE_PLUGIN_PERMISSIONS 的 PATHSCOPES_MAX=10_000,但主进程读盘层 plugins.service readPermissions 的 MAX_PERSISTED_SCOPES_PER_PLUGIN=256(对齐 PathScopeRegistry MAX_SCOPES_PER_PLUGIN,E81)。写端接受并写入单 plugin 257..10000 条 pathScopes 返回成功,但下次 readPermissions() 只保留前 256 → 重启/下轮 RMW 静默丢 scope。写读上限不对称 = 写假成功后静默截断(数据安全:用户以为授权的 scope 实际丢失)。**E245 我把 renderer 读端 pathScopes 上限对齐到写端 10_000 也是错的** —— 真正绑定的是读盘 256。
- **亲读**: 三处 cap:写 IPC(10_000)/ renderer parse(E245 误设 10_000)/ 读盘(256,绑定)。256 是 PathScopeRegistry 契约。codex 建议统一到 256(写端拒 >256,把"会被读端丢"的写入在入口显式失败)。
- **修复**: plugins.ipc PATHSCOPES_MAX 10_000 → 256(写端 zod 拒 >256,BAD_INPUT);IpcPermissionStore(E245)MAX_PATH_SCOPES_PER_PLUGIN 10_000 → 256(对齐绑定 cap,改注释)。三处统一到 256。
- **测试**: plugins-ipc-input-limits.spec 改 E246(257→fail / 256→pass,替原"超 10000"误导测试)。ipc-permission-store E245 套件不受影响(decisions 测试独立)。中和:PATHSCOPES_MAX 还原 10_000 → 257-fail 测失败,4577 PASS。
- **沉淀**: **写端 cap 与读端/落盘 cap 必须相等,不能写松读紧** —— 否则写成功后读截断 = 静默数据丢失(比直接拒更隐蔽:用户看到"已授权"但重启后 scope 没了)。多层 cap(写 IPC schema / renderer parse / 读盘)须全部对齐到**最严(绑定)的那个**(此处 PathScopeRegistry 256),取最小值收口。**对齐 cap 时要找"真正生效的绑定层"而非任一层**:E245 我对齐到写端 10_000,但写端本身就比读盘松,对齐错了目标 → codex 揪出连环。审计 cap 一致性要列全某资源的所有 cap 层(写校验/序列化/反序列化/落盘/registry 运行时),确认数值全等且等于最严层。

## E247 — writePluginPermissions 服务层写端无 cap 早停(绕过 schema 写超量,读回截断)(P2,E246 写读 cap 对称族)

- **问题**: `electron/main/services/plugins.service.ts:523`。writePluginPermissions(exported service)对 decisionsRaw/scopesRaw 裸 `.filter(isDecision)` / `.filter(isIpcPathScope)`,无数量上限。IPC schema(plugins.ipc)虽限 DECISIONS_MAX/PATHSCOPES_MAX,但**该 service 入口可被测试/未来内部调用直接调用绕过 schema** → 写超量记录落盘成功,而 readPermissions 用 cappedAllValid 按 MAX 截断 → 写成功但读回丢数据 + 写链全量物化卡顿。E246(写读 cap 不对称)的服务层兄弟。
- **亲读**: read 端(readPermissions)用 cappedAllValid(every 语义,上限内任一非法→整条丢),write 端裸 .filter(filter 语义,跳过非法)。两者数量上限不对称(读有 write 无)。仓内已有 collectValidCapped(E208,capped 的 filter:跳过非法 + 凑满 MAX 即停),正是 write 端需要的——保留 .filter 跳过非法语义 + 加 count cap。
- **修复**: writePluginPermissions 的 `.filter(isDecision)` → `collectValidCapped(decisionsRaw ?? [], isDecision, MAX_DECISIONS_PER_PLUGIN)`;`.filter(isIpcPathScope)` → `collectValidCapped(scopesRaw, isIpcPathScope, MAX_PERSISTED_SCOPES_PER_PLUGIN)`(scopesRaw undefined 保持 undefined)。写端落盘即截断到 MAX,与读端对称。
- **测试**: write-plugin-permissions.test +E247×2(写 1100 decisions/300 pathScopes → **读磁盘原始 _permissions.json** 断言已截 1000/256)。**关键:断言磁盘原始内容而非 readPermissions 返回值** —— readPermissions 自己 re-cap,写 1100 落盘读回 1000 仍丢数据,只看 readPermissions 会掩盖写端无界(中和首次未失败即此坑,改读 raw file 后中和正确失败)。4579 PASS。
- **沉淀**: 写读 cap 对称族(E246 IPC schema / E247 service 层)—— **每一层写入口都须独立施加与读端等价的 cap,不能依赖上游(IPC schema)限流**:exported service 函数是契约边界,测试/未来内部调用可绕过 IPC。**验证写端 cap 的测试必须读最终落盘产物(raw file),不能读"也会 re-cap 的读函数"** —— 后者把"写坏了读端兜底截断"误判为"写对了"(同 E237 教训:测数据安全写入须读磁盘断言契约,readPermissions 这类带净化的读函数会吞掉写端缺陷)。复用既有有界收集 helper(collectValidCapped)保持语义(filter 跳过非法)+ 补 count cap。

## E248 — clampExecTimeoutMs/clampExecMaxBytes 只 Math.min 不处理非有限/≤0(service 直调绕 schema)(P2,E10/E122 clamp 族)

- **问题**: `electron/main/services/shell.service.ts:26`。clampExecTimeoutMs/clampExecMaxBytes 仅 `Math.min(input ?? DEFAULT, MAX)`,只裁上限,不处理 NaN/Infinity/0/负。input=NaN → Math.min(NaN,MAX)=NaN(setTimeout(NaN)立即触发 / 截断逻辑不可预期);input≤0/负 → 原样返回(负 timeout 立即超时)。IPC zod 挡一部分,但 execShell + 这两个 helper 是**导出 service 入口**(单测/SDK 集成/未来内部调用直接用,绕过 schema),违背"clamp 到范围内"契约。
- **亲读**: E10(plugin-shell-stream timeoutMs NaN)/E122(setting number clamp)同族 —— clamp helper 须自身完整归一化,不假设输入已被前门校验。helper 标称"纯函数便于测试"= 契约边界,测试直接喂畸形值。
- **修复**: 两 helper 加 `if (input === undefined || !Number.isFinite(input) || input <= 0) return DEFAULT;` 再 `Math.min(Math.trunc(input), MAX)`。非有限/≤0/缺省→默认值,有限正数→截整 + 上限裁剪(整数 ms/字节)。
- **测试**: shell-exec-timeout-clamp.spec +E248×3(NaN/Infinity/0/负→DEFAULT〔timeout + maxBytes〕/ 正小数→trunc)。既有上限/正常/缺省回归保留。中和:还原 Math.min → E248 测失败,4582 PASS。
- **沉淀**: clamp/归一 helper 非有限值族(E10/E122/E248)—— **凡声明"纯函数 clamp 到范围"的 helper,必须自身处理 NaN/Infinity/±0/负,不能只 Math.min/Math.max 裁上下限**(Math.min(NaN,x)=NaN 透传,负数 Math.min 不挡)。helper 是导出契约边界(测试/SDK/未来内部调用直接用,绕过 IPC zod 前门),防御不能外包给调用方。归一化模板:`!Number.isFinite(x) || x<=0 → default; 否则 Math.min(Math.trunc(x), MAX)`。

## E249 — writePluginPathScopes 服务层写端无 cap(E247 漏传播的兄弟入口)(P2,E246/E247 写读 cap 对称族)

- **问题**: `electron/main/services/plugins.service.ts:668`。writePluginPathScopes(写 _plugin-path-scopes.json 的独立 writer)对入参 scopes 裸 `.filter(isIpcPathScope).map(...)`,无数量上限 —— 与 E247 writePluginPermissions **完全同款 bug**。绕过 IPC schema(PATHSCOPES_MAX=256)+ 读盘 cap:进程内/未来调用写超量 scope 落盘成功,readAllPathScopes 只读回前 256 → 写成功重启读回丢数据 + 全量物化卡顿。
- **亲读**: **E247 报告里 codex 已明确点名此兄弟入口**("writePluginPathScopes() 的 .filter().map() 同族也应改为有界收集"),我 E247 只修了 writePluginPermissions,漏传播到 writePluginPathScopes → codex 第 22 轮重报为 E249。这是我自己的"修一族未 grep 全兄弟"缺口(审计者捞自引入/未完成修复,最高价值)。
- **修复**: `.filter(isIpcPathScope).map(...)` → `collectValidCapped(scopes, isIpcPathScope, MAX_PERSISTED_SCOPES_PER_PLUGIN).map(...)`,与 writePluginPermissions(E247)同款有界收集。
- **测试**: plugins-path-scopes.test +E249×1(写 300 scopes → 读磁盘原始 _plugin-path-scopes.json 断言截 256,非 readPluginPathScopes 它也 re-cap)。中和:还原 .filter → 测失败,4583 PASS。
- **沉淀**: **"修一族必 grep 全兄弟"自己也会漏 —— 尤其当报告已点名兄弟却只修主项**。E247 codex 报告正文就写了"writePluginPathScopes 同族也应改",我修主项时未一并处理 → 同一 bug 再报一轮(浪费一轮)。教训:报告/修复里提到"X 同族也有"时,当轮就一并修 + 测,不留到下一轮。两个独立持久化 writer(_permissions.json / _plugin-path-scopes.json)是同构兄弟,改一个的 cap 策略必同步另一个。**写端 cap 测试一律读磁盘原始产物**(readAll* 会 re-cap 掩盖,E247/E249 同坑)。

## E250 — parseReview 直取 raw.body 对非对象元素抛 TypeError(E243 续:数组守卫不含元素守卫)(P2)

- **问题**: `src/marketplace/reviews-parser.ts:42`。parseReview 入参类型 RawDiscussion(假设已是对象),line 43 直接 `raw.body`/`raw.title`。fetchAllReviews(E243)只校验 `nodes 是数组`,数组元素仍可为 null/数字/字符串 —— `nodes:[null]` → parseReview(null) → `null.body` 抛 TypeError → **单个畸形节点让整个 Marketplace reviews 加载失败**(绕过 E243"非数组回退/空 Map"+ 后续字段级校验)。fresh IPC 路径与 cache-read(isValidReview 深校验)不对称。
- **亲读**: E243 我加了 Array.isArray(nodes) + 数量截断,但未守**每个元素**的形态 → parseReview 仍假设元素是对象。codex 续报此元素级缺口。
- **修复**: parseReview 入参 RawDiscussion → unknown,开头 `if (typeof rawInput !== 'object' || rawInput === null) return null;` 再 cast(body 其余 raw.X 不变)。顺补 `typeof raw.createdAt !== 'string' → null`(fresh 路径与 cache-read isValidReview 对齐)。坏节点返 null 跳过,不抛。
- **测试**: reviews-parser.spec +E250(it.each null/undefined/42/string/true/[] → 不抛 + 返 null;createdAt 非字符串 → null)。中和:去对象守卫 → null/undefined 抛 → 2 测失败,4590 PASS。
- **沉淀**: **"容器守卫"≠"元素守卫"**:E243 加了 `Array.isArray(nodes)`(容器是数组)但 parseReview 仍信任元素是对象 → 数组里的 null 元素照样击穿。凡"校验是数组后逐元素 parse"的路径,parse 函数自身入参必须收 unknown + 元素级对象/类型守卫(数组守卫只挡"整体非数组",挡不住"数组含畸形元素")。**逐元素 parse 函数(map/for 调用的)入参一律 unknown + 顶部 typeof object 守卫,坏元素返 null 跳过而非抛**(单元素抛会让整批失败)。fresh-fetch 解析路径要逐字段对齐 cache-read 的深校验(两路径校验对称,E109/E112/E143/E250 同族)。

## E251 — allSettledWithConcurrency limit=NaN → 0 worker 静默丢全部任务(E234 helper 缺口)(P2,E248 clamp 非有限族)

- **问题**: `src/lib/map-with-concurrency.ts:32`(E234 我建的 helper)。`const workerCount = Math.max(1, Math.min(limit, items.length));` 对 limit=NaN:Math.min(NaN, len)=NaN,Math.max(1, NaN)=**NaN**(Math.max 含 NaN 返 NaN,Math.max(1,...) 的"保底 ≥1"对 NaN 失效)→ `Array.from({length: NaN})` 生成 **0 个 worker** → 函数返回等长但全空洞的 results、**一个任务都不执行**(静默"成功"丢全部结果,违反 allSettled 语义)。导出通用 helper,未来调用方传 NaN/计算结果 NaN limit 即触发。
- **亲读**: E248(clamp 非有限值)同族 —— Math.max/Math.min 不挡 NaN。我 E234 用 Math.max(1,...) 想保底 ≥1 但对 NaN 无效。
- **修复**: 先归一化 `const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1;` 再 `Math.min(safeLimit, items.length)`。非有限/≤0→1,小数 trunc。空输入 → min(safeLimit,0)=0 worker = [](正确)。
- **测试**: 新建 map-with-concurrency.spec ×9(顺序对位 + allSettled 单失败隔离 / 峰值在途 ≤ limit / **limit NaN/0/-3/±Infinity 全执行不静默丢** / 小数 trunc / 空输入 [])。pnpm bdd:index。中和:还原 Math.max(1,Math.min) → NaN 测失败(0/-3/Infinity 旧式 Math.max(1,..) 恰好仍对,唯 NaN 破),4599 PASS。
- **沉淀**: clamp 非有限值族再现(E10/E122/E248/E251)—— **`Math.max(1, x)` / `Math.min(MAX, x)` 都不挡 NaN(任一含 NaN 返 NaN)**,想"保底正整数"必须显式 `Number.isFinite(x) && x>0 ? Math.trunc(x) : default`。导出通用并发/迭代 helper 尤须自守 limit/count 参数(NaN length → Array.from 0 长度 → 静默空跑)。**自己建的 helper 也要按 clamp 族自查**:E234 建 helper 时漏了 limit 非有限归一化,codex 续捞(同 E246/E249 自引入缺口,审计者捞自建 helper 的边界漏)。

## E252 — resolveStdioHelloWindowId windowId 仅 isInteger 不 isSafeInteger/非负(与 AttachTargetSchema 不一致)(P2)

- **问题**: `electron/main/services/mcp-stdio-server.service.ts:52`。resolveStdioHelloWindowId 对外部 stdio hello payload 的 windowId 只 `Number.isInteger` —— 挡 NaN/Infinity/小数,但放行 -1 / 9007199254740993(2^53+1,不安全整数)。与 AttachTargetSchema.windowId 的 `nonnegative().max(Number.MAX_SAFE_INTEGER)` 契约不一致。畸形 stdio hello(不可信外部输入)可把负/不安全 windowId 传入 resolveWindowId !== / windowExists 判定;测试/未来实现若用数组索引或 Electron fromId 会精度碰撞或误探窗口。
- **亲读**: 同字段(windowId)两入口校验不对称(attach schema 严,stdio hello 松)。同 E238/E246 同字段多入口 cap 不一致族。
- **修复**: `typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId < 0 → null`(对齐 AttachTargetSchema)。
- **测试**: framing.spec +E252×1(-1 / 1.5 / NaN / ±Infinity / MAX_SAFE_INTEGER+1 即便 token 匹配也拒)。中和:还原 isInteger → 测失败,4600 PASS。
- **沉淀**: **同一语义字段(windowId)在不同入口须用同一最严校验** —— attach schema 已 nonnegative + safe-integer,stdio hello 入口漏 → 不一致。`Number.isInteger` 放行不安全整数(2^53+1)与负数;安全非负整数须 `Number.isSafeInteger(x) && x>=0`。审计数值字段校验一致性:列全某字段所有入口(zod schema / 手写 guard / 多协议),对齐到最严的那个(同 E246 cap 取最严层)。外部协议入口(stdio hello payload)不可信,数值须安全整数 + 范围。

## E253 — parseReview author.createdAt/版本字段仅 nullish 合并不校验类型长度(E250 续:子字段)(P2,fresh/cache 校验对偶)

- **问题**: `src/marketplace/reviews-parser.ts`。parseReview 的 `author.createdAt: raw.author.createdAt ?? '1970...'` 只挡 nullish,不校验类型/长度;continuoVersion/pluginVersion 直接 sections.get()?.trim() 无长度上限。cache-read isValidReview 要求 author.createdAt 是 ≤512 字符串、版本 ≤128。畸形 fresh IPC review 可把 object/超长字符串写进 Review.author.createdAt → 新账号风险判断 `new Date(...)` 变 Invalid Date/NaN 漏标;fresh 路径与 cache 路径契约不一致。E250(我加了顶层 createdAt typeof 守卫)的子字段续缺口。
- **亲读**: isValidReview(reviews-types):createdAt + author.createdAt `isStrMax(x, REVIEW_FIELD_MAX=512)`,版本 REVIEW_VERSION_MAX=128。parseReview(fresh)漏对齐这些子字段。
- **修复**: parseReview 加 REVIEW_FIELD_MAX=512 / REVIEW_VERSION_MAX=128(对齐 reviews-types)。顶层 createdAt 加长度 ≤512(E250 只 typeof);author.createdAt 仅 string && ≤512 才采用否则 epoch;版本经 capVersion(trim 后 ≤128 否则 undefined)。
- **测试**: reviews-parser.spec +E253×3(author.createdAt 非 string → epoch 且 new Date 非 NaN / 顶层 createdAt >512 → null / 版本 >128 → undefined)。中和:author.createdAt 还原 `?? epoch` → 测失败,4603 PASS。
- **沉淀**: fresh/cache 校验对偶(E109/E112/E143/E250/E253)—— **解析函数对齐 validator 要逐字段对齐到子字段/可选字段,不止顶层必填字段**。E250 我加了顶层 createdAt 守卫但漏 author.createdAt(嵌套子字段)+ 版本(可选字段)→ codex 续捞。`x ?? default` 只挡 null/undefined,挡不住 object/数字/超长(类型错/超界);需要类型守卫的字段不能用 `??` 兜底(`typeof x === 'string' && x.length <= MAX ? x : default`)。审计 fresh-parse 对齐 cache-validator 时逐字段列清单(必填/可选/嵌套),每个都对齐类型+长度。

## E254 — assertJsonValue 限 key 数量但不限单个 key 长度(超长 key 推迟到 stringify 制造巨大分配)(P2)

- **问题**: `electron/shared/assert-json-value.ts:116`。assertJsonValue 限对象 key 数量(MAX_JSON_OBJECT_KEYS=100k)但不限**单个 key 长度**。`{["x".repeat(1e8)]: 1}` 过校验,推迟到下游 JSON.stringify 才按字节上限拒 → 先在 renderer/main 制造巨大 stringify 分配;且值非法时错误路径 `${path}.${k}` 拼超长 key 放大错误字符串本身。插件 data / MCP schema / MCP result 经此 helper。
- **亲读**: 循环对 string key 无长度上限。错误 path 拼接 k(无界)。注意 E200/E221 的 Reflect.ownKeys symbol 检测 DEFER 与此正交(key 长度 ≠ key 枚举方法),不动。
- **修复**: 加 `MAX_JSON_KEY_LEN=8192` + 循环内 symbol 检查后 `if (k.length > MAX_JSON_KEY_LEN) throw`(错误消息只含 `k.length` 数字,不拼 key 本身防放大;throw 在递归前故 `${path}.${k}` 的 k 必 ≤ 8192,path 拼接有界)。
- **测试**: assert-json-value-sparse.spec +E254×2(超长 key→抛 key too long + 错误消息 <200 字符且不含 key / 恰好 8192 key→ok)。中和:去 key 长度检查 → 测失败,4605 PASS。
- **沉淀**: **数量上限 ≠ 单元素尺寸上限**(同 E210 逐项≠累计 / E243 容器≠元素):限了对象 key 数量(宽度)不代表限了单个 key 长度(单元素尺寸);"超大 N 个小元素"与"超大单个元素"是两个独立放大维度,JSON 校验须同时限 key 数 + key 长 + 数组长 + 值递归。**校验阶段的早拒优于推迟到序列化**:超长 key 过校验后到 JSON.stringify 才拒 = 先付巨大分配(校验本应在分配前挡住)。**错误消息本身也是放大面**:错误 path 拼接不可信的超长 key/值 → 错误串本身 OOM;错误消息含外部数据须截断/只含长度摘要。

## E255 — mcp-host tools/call 外部 arguments 直接 safeParse,.strict() schema 枚举海量未知 key 放大(P2,读端独立校验 / schema-阶段放大)

- **问题**: `electron/main/services/mcp-host.service.ts:320`。tools/call 把外部 MCP arguments 直接交给 `tool.inputSchema.safeParse(args)`。多数 tool schema 是 `.strict()` object,畸形本地 MCP client 可在 1MB body 内塞海量未知短 key —— Zod 会先**枚举全部 key** 并为每个 unrecognized key 构造 issue/message 数组,错误串 cap(formatZodErrorCapped)在这之后才生效 → 单请求即可让 main 进程在 schema 阶段 CPU/内存放大,阻塞 MCP host 与 Electron 主进程。
- **亲读**: handleMessage tools/call 分支已有 plain-object 守卫(line 306-318:args 须非 null 非数组对象)但**无 key 数 / key 长度预检**,直接 line 320 safeParse。E73 的 formatZodErrorCapped 只 cap 错误串长度,挡不住 Zod 枚举 + 构造 issue 的前置开销。
- **修复**: 加 `MAX_TOOL_ARG_KEYS=1024` / `MAX_TOOL_ARG_KEY_LEN=8192` + 纯函数 `checkToolArgsBounded(args)`(返 `{ok:true}|{ok:false,message}`);在 plain-object 守卫后、safeParse 前调用,超限返回固定 INVALID_PARAMS 不进入 Zod。值远超任何真实 tool 入参形态。导出供单测。
- **测试**: host.spec +E255×5(正常对象 ok / 恰好上限 ok / key 数超限拒 too many / 单 key 超长拒 key too long / 恰好 KEY_LEN ok)。中和:`if (false && ...)` 短路 key 数检查 → 测失败,4610 PASS。
- **沉淀**: **不可信外部数据进 schema 校验器前须先做廉价 bounded 预检**(同 E254 校验阶段早拒优于推迟下游)—— Zod `.strict()` 对 unrecognized_keys 是 O(keys) 枚举 + 每 key 构造 issue,错误串 cap 在 parse **之后**才生效,挡不住 parse 内部放大;预检(key 数 + key 长)是 O(keys) 但常数极小且短路。**校验器本身也是放大面**:把"限制输入规模"前置到比 schema 更便宜的纯 guard,schema 只负责语义。审计所有 `safeParse(外部输入)` 入口:外部可控规模(key 数 / 数组长 / 字符串长)须在进 schema 前 bounded。

## E256 — safe-handle 通用 IPC 包装 safeParse 前缺 bounded 预检(E255 同族,影响面更广)(P1,schema-阶段放大)

- **问题**: `electron/main/safe-handle.ts:108/187`。通用 IPC 包装 `processIpcCall` / `processIpcCallWithCtx` 直接对 rawInput 执行 `schema.safeParse()`。大量 IPC schema 是 `.strict()` object,畸形 renderer/preload 调用可在 1MiB 级 structured-clone 后塞海量未知短 key → Zod 先枚举全部 key 并为 unrecognized_keys 构造 issue/message,E73 错误串 cap 在 parse 之后才生效。影响面比 MCP(E255)更广:**fs/window/plugins/terminal/shell 所有 safeHandle IPC** 都可被同一类巨表 payload 放大 main 线程 CPU/内存。
- **亲读**: 两个 process 函数 safeParse 前只有 isTrustedFrame 门控,无 key 数/key 长预检。既有 E73 测试用 2000 未知 key 验长度截断 → 此预检(1024 cap)会提前拦下,须调到 500 key(< cap)保留长度截断路径覆盖。
- **修复**: 加 `MAX_IPC_INPUT_KEYS=1024` / `MAX_IPC_INPUT_KEY_LEN=8192`(与 E255 对齐)+ 纯函数 `ipcInputBounded(rawInput)`(仅对 plain object 检 key 数/key 长;非 plain object 即 string/number/array/null 放行交给 schema)。两个 process 函数(孪生入口)在 isTrustedFrame 后、safeParse 前一并调用,超限返回 BAD_INPUT 不进入 Zod。导出供单测。
- **测试**: safe-handle.spec +E256×9(非对象放行 / 正常对象 ok / 恰好上限 ok / key 数超限拒 / key 超长拒 / 恰好 KEY_LEN ok / processIpcCall 海量 key→预检文案非 zod 标记 / processIpcCallWithCtx 孪生同样预检 / 正常 payload 回归);E73 测试 2000→500 key 保留长度截断覆盖。中和:`if (false && ...)` 短路 key 数检查 → 3 测失败(且暴露原放大路径 `Unrecognized key(s)...`),4619 PASS。
- **沉淀**: **修一族必 grep 所有兄弟入口** —— E255 修了 MCP tools/call 这个具体入口,codex 续捞到通用 IPC 包装(同根因、更广 blast radius)。**通用包装层(processIpcCall*)是单一收口点**:在此加 bounded 预检 = 所有 IPC schema 一次性受保护,优于逐 handler 加。**预检须只拦 plain object**(IPC schema 入参形态多样:string/number/array/原始值都合法),否则误伤正常调用。**调整既有边界测试阈值时须保留其原覆盖意图**:E73 测的是"单条超大 message 长度截断",新预检会在 1024 key 提前拦,故把 E73 降到 500 key 仍触发单条超大 message(500 长 key 一条 unrecognized_keys issue),两条防线(预检拦超量 + 长度 cap 兜底 <1024 但长 message)互补不重叠。

## E257 — plugin-mcp invoke-reply raw ipcMain.on 绕过 safeHandle 预检直接 safeParse(E255/E256 同族第三入口 + 共享 helper 收口)(P2,schema-阶段放大)

- **问题**: `electron/main/ipc/plugin-mcp.ipc.ts:135`。`plugin-mcp:invoke-reply` 是 raw `ipcMain.on`,绕过了 E256 给 safeHandle 加的 bounded 预检,trusted-frame 校验后直接 `InvokeReplySchema.safeParse(raw)`。该 schema 是 strict discriminated union,畸形 reply 带海量未知短 key 时仍会先触发 Zod 枚举 + 构造 unknown-keys issue → 已加载插件/renderer 侧异常 payload 可在主进程 schema 阶段放大 CPU/内存(发生在 handleReply 的轻量防御之前)。
- **亲读**: handleReply(plugin-mcp-bridge.service.ts:209)是 O(1)——只读 `r['requestId']`/`r['ok']` 等顶层字段,不枚举全部 key。故超限 payload 跳过 safeParse 后仍可安全交 handleReply(它按 requestId 立即 reject INVALID_REPLY,保持第十二 session「畸形 reply 不挂 30s」契约)。E255 修 MCP tools/call、E256 修通用 safeHandle,此为同族**第三个**(也是最后一个绕过 wrapper 的)入口。
- **修复(含 codex 建议的共享 helper 收口)**: 新建 `electron/shared/bounded-input.ts` 的 `boundedObjectAdmissible(unknown)`(返结构化 `reason`)作三入口**单一逻辑来源**;E255 `checkToolArgsBounded` / E256 `ipcInputBounded` 重构为薄封装委托它(各自映射领域文案,常量 alias `MAX_BOUNDED_OBJECT_KEYS/KEY_LEN`,保持既有契约不破测试)。plugin-mcp reply 在 safeParse 前调 `boundedObjectAdmissible(raw)`,超限不进 Zod 但仍交 handleReply。
- **测试**: 新 topic `bounded-input-preflight`(shared-helper.spec ×6 + plugin-mcp-reply-preflight.spec ×2,后者走真实 ipcMain.on handler + **spy InvokeReplySchema.safeParse 断言超限 payload 从不进 Zod**——因 outcome(reject)与去预检后 fallback 相同,须靠 safeParse 调用次数区分)。中和:`if (false && ...)` 短路预检 → spy 测失败(safeParse 被调 1 次),4627 PASS。E255/E256 旧测试全绿(重构未破契约)。
- **沉淀**: **同族跨三入口收口共享 helper 消漂移**(codex 主动建议):E255→E256→E257 是同根因在不同层(MCP host / 通用 IPC wrapper / 绕 wrapper 的 raw ipcMain.on)的三个实例;与其留三份近似 helper,抽 shared `boundedObjectAdmissible` 作单一逻辑来源 + 各入口薄封装映射文案,既消漂移又保各入口契约(常量名/message 经 alias/映射不变 → 既有测试零改)。**raw ipcMain.on 是 safeHandle 保护的盲区**:凡绕过通用 wrapper 的手写 IPC 入口(为拿 event.sender.id 等)都丢失 wrapper 的所有横切防护(预检/错误限幅/trust),审计须单独 grep `ipcMain.on(` / 手写 `processIpcCall` 调用点逐一补齐。**neutralize 敏感性**:当修复与缺陷的 outcome 相同(都 reject)时,行为断言无法区分,须断言**内部路径未触发**(spy 证 safeParse 未被调)才能让测试真正捕获回归。

## E258 — window.ipc NOTIFY_ROOT raw ipcMain.handle 绕过预检直接 safeParse + 日志打印完整 issues(E255/E256/E257 同族第四入口,族收口)(P2,schema-阶段放大 + 日志放大)

- **问题**: `electron/main/ipc/window.ipc.ts:111`。`WINDOW_CHANNELS.NOTIFY_ROOT` 是手写 `ipcMain.handle`(为拿 `event.sender`→BrowserWindow),绕过 safeHandle 的 bounded 预检,直接 `NotifyRootInput.safeParse(raw)`(`.strict()` object)→ 畸形 payload 海量未知短 key 在 Zod 阶段枚举/构造 issue 放大;**第二缺口**:catch 分支 `console.warn(..., parsed.error.issues)` 打印完整 issues 数组(`.strict()` 大量未知 key 时 issues 数组本身就是放大面 → 日志二次放大)。notify-root 是高频 workspace 同步入口。
- **亲读**: handler 自带 trusted-frame 校验(R7)+ root .max(2048)(E34),但 safeParse 前无 key 数预检,且 BAD_INPUT 日志直接传 `parsed.error.issues`。codex 此轮在沿 raw ipcMain.handle/on 清单逐个排除(正是 E257 沉淀预言的盲区扫描)。
- **修复**: safeParse 前复用 shared `boundedObjectAdmissible(raw)`,超限 BAD_INPUT 不进 Zod + 日志只记 `(oversized)`(不传 issues);parse 失败日志改用 `formatZodErrorCapped(parsed.error)`(capped string,不传 issues 数组,同 E73/E157 错误串限幅纪律)。
- **测试**: notify-root-validation.spec +E258×2(海量 key→BAD_INPUT 且 warn 含 '(oversized)' 标记 + 不写 map;BAD_INPUT 日志参数均非数组)。中和:`if (false && ...)` 短路预检 → '(oversized)' 测失败;还原 `parsed.error.issues` 日志 → 非数组测失败。两项均正确失败,4629 PASS。
- **族收口 sweep(本轮主动 grep 全 raw ipcMain 入口确认无剩余同族)**: `grep ipcMain.\(handle\|on\)(` 全 main → 仅 window.ipc NOTIFY_ROOT(本项)与 plugin-mcp INVOKE_REPLY(E257)是"raw + 直接 .strict() object safeParse"。其余:terminal.ipc 全部路由 `processIpcCall`(已被 E256 预检覆盖)/ plugins.ipc 走 safeHandle(line 84 的 PermissionRecordSchema.safeParse 是 collectValidCapped 内逐元素校验,外层已 E256 预检 + 集合 cap 有界,非 ingress 放大)/ plugin-fs、plugin-data-store、plugin-shell-stream 手写 string 参数校验无 object safeParse / index.ts layout:flush-ack & window:id 只判 primitive(typeof number)。**schema-阶段放大族(E255 MCP / E256 通用 wrapper / E257 raw on / E258 raw handle)四入口至此全闭合**。
- **沉淀**: **family sweep 应在修第一/第二个时就 grep 全入口确认边界**(本轮主动 sweep 确认族已闭合,无须等 codex 逐个再报)—— 与"修一族必 grep 兄弟"一致,但更进一步:不仅修兄弟,还**证明没有更多兄弟**(列全 raw ipcMain.handle/on,逐个分流 covered/non-applicable/sibling),给收敛一个可验证的边界。**一个 handler 可有多个同源放大面**:E258 既是 safeParse 放大(入参)又是日志放大(出错路径打印未限幅 issues),修一个入口要查它的所有放大维度(入参校验 + 错误日志 + 错误回传),同 E254 错误消息本身也是放大面。

## E259 — renderer 反向 invoke 跑 plugin 自定义 .strict() schema,顶层预检挡不住嵌套海量 key(E255-E258 深化:嵌套维度)(P2,schema-阶段放大)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:168`。MCP client tools/call → main host(E255 仅预检 arguments **顶层** key)→ 经 bridge 转发 → renderer `invokeLocal` → `spec.inputSchema.safeParse(input)`,这里跑的是 **plugin 自定义** schema(main 注释明确"plugin zod 校验放 renderer 端")。plugin schema 可为**嵌套** `.strict()` object → `{outer:{<<10万 key>>}}` 顶层只 1 key 绕过 main 顶层闸,递归到内层仍触发 Zod 枚举/构造 unrecognized_keys issue 放大(renderer CPU/内存/UI 卡顿 + 拖到 main pending 超时)。E255-E258 的顶层预检(`boundedObjectAdmissible`)只查顶层,留**嵌套维度**缺口。
- **亲读**: invoke 闭包(line 167)safeParse 前无任何 key 数预检;E76 已对**错误串**限幅(capJoinedMessages)但那是 parse **之后**,挡不住 parse 内部枚举放大。既有 `assertJsonValue`(electron/shared)虽递归但 key 上限 10 万(太松,1MB body 内可塞 ~10 万 key 仍过)。renderer 可 import electron/shared(已 import assertJsonValue 等)。
- **修复**: shared `bounded-input.ts` 加**递归**变体 `boundedValueDeepAdmissible(value, depth)`:每对象 key 数 ≤1024 / 单 key 长 ≤8192 / 数组长 ≤65536 / 嵌套深度 ≤64,递归带 depth 计数并**超深先于继续递归返回**(故本函数自身递归深度有界,不会因病态深嵌套先爆栈),fail-fast 返结构化 reason。PluginMcpRegistry invoke 在 safeParse 前调用,超限 INVALID_PARAMS(message 含 reason)不进 plugin schema。
- **测试**: bounded-input-preflight/shared-helper.spec +deep×7(原始值 ok / 嵌套海量 key→too-many-keys / 嵌套超长 key / 数组超长 / 超深→too-deep / 恰好深度 ok / 数组元素递归)+ 顶层 helper 漏嵌套×1;registry.spec +E259×4(嵌套海量 key→INVALID_PARAMS 且 **spy 断言 plugin safeParse 未被调** + message 含 'exceeds bounds' / 超深→too-deep / 超长数组→array-too-long / 正常嵌套回归)。E76 测试 2000→500 key 保留 capJoinedMessages 截断覆盖(同 E73/E258 阈值调整纪律)。中和:`if (false && ...)` 短路预检 → 3 测失败(嵌套 flood 暴露 `Unrecognized key(s)` 直达 plugin schema),4641 PASS。
- **scope 说明**: E259 只给 plugin-**自定义** schema 入口(renderer invoke)加递归预检 —— 该路径 schema 由插件定义、不可控、可深嵌套。E255-E258 的 main IPC 入口保持**顶层**预检:其 schema 由本仓控制(浅、字段少)+ 1MB body 字节闸兜底总规模,顶层闸已够;不为它们引入每调用递归遍历成本(极简)。
- **沉淀**: **顶层 bounded ≠ 递归 bounded**(同 E254 数量≠尺寸 / E243 容器≠元素):预检放大面要匹配**校验器的遍历深度** —— 顶层闸只在 schema 浅时够;当 safeParse 的 schema 会**递归枚举**(嵌套 `.strict()`),预检也必须递归到同深度,否则"顶层 1 key 包裹嵌套 flood"绕过。**预检递归须自身有界**:深度计数 fail-fast 在递归前,防预检自己爆栈(把"限制深度"做成"安全地限制深度")。**按 schema 可控性分层防御**:可控 schema(本仓)+ 字节闸 → 顶层预检够;不可控 schema(plugin/外部定义)→ 需递归预检(没有"schema 一定浅"的保证)。

## E260 — settings/keybindings 写端只截断单项不限整表,读端整表 1MiB cap → 累积超限下次启动静默丢全表(P2,写读 cap 对称)

- **问题**: `src/plugins/settings/values-store.ts:78`(+ keybindings-store.ts 同型)。setValue 写入前只把**单个** text/string 截断到 64KiB(E142/E241),但不限制**整份** overrides JSON 总大小;读端 `readRecord()`(local-storage-record.ts)对同一 localStorage key 有 `DEFAULT_MAX_RAW_LENGTH=1MiB` 原始串上限,超限直接返 `{}`。多个合法大 text setting 累积后整份 >1MiB → 本会话写入"看似成功"(writeRecord 旧实现 void 无上限),下次启动 readRecord 整表丢弃 → **所有 settings overrides 静默丢失**(keybindings 同型)。E242/E246/E247/E249/E252 写读 cap 对称族在 localStorage 持久层的又一实例。
- **亲读**: writeRecord 旧实现无大小校验、返 void;读端 1MiB cap 在 E70 已加。values-store/keybindings-store 都 `writeStored(next); set(...)`(写后无条件提交内存态)。注意须区分**超限**(必丢)与 **quota/无 localStorage**(旧"静默忽略、内存态仍在"语义须保留)。web-compat-allowlist 引用 local-storage-record.ts 的 globalThis 行号(E180 纪律)。
- **修复(收口 writeRecord 单一来源,覆盖 settings + keybindings 两 store)**: writeRecord 改返 `WriteRecordResult = 'ok'|'too-large'|'unavailable'`:序列化后总串长与读端**同一** `DEFAULT_MAX_RAW_LENGTH` 对齐,超限返 `'too-large'` **拒写**;quota/无 localStorage 返 `'unavailable'`(保留旧静默语义)。两 store 的 setValue/setHotkey:`if (writeStored(next) === 'too-large') { warn; return; }` —— **不提交内存态**(保留上次有效持久化,避免内存 vs 磁盘发散 + 下次整表丢失)。reset/resetAll 收缩记录必 ≤cap,不受影响。更新 allowlist 行号 73/75→96/107。
- **测试**: local-storage-record-guard.spec +E260×4(正常→ok 读回 / 超 maxRawLength→too-large 且保留上次值 / 超默认 1MiB→too-large 未写入 / **写读对称:writeRecord 接受的记录 readRecord 必读回**);values-store.spec +E260×1(整份超 1MiB→setValue 拒写不提交内存态 + localStorage 未被覆盖)。中和:`if (false && ...)` 短路 too-large 检查 → 3 测失败(返 'ok'、内存态被提交),4646 PASS。
- **沉淀**: **写读 cap 对称在 localStorage 持久层**(同 E242/E246/E247/E249/E252):写端 cap 必=读端 raw cap,否则"写松读紧"=本会话成功、下次整表丢失。**单项 cap ≠ 整表 cap**(同 E254 数量≠尺寸 / E210 逐项≠累计):限了单个 text 64KiB 不代表限了整份 overrides 总大小,累积仍可越整表读 cap。**收口到共享 writeRecord** 让 settings + keybindings 两 store 一次受保护(消漂移)。**区分"超限必丢"与"quota 仅没落盘"**:前者拒写+不提交内存态(防发散+丢全表),后者保留旧静默+内存态(本会话可用),用三态返回值表达而非 boolean(boolean 会把 quota 误判成必丢而吞掉本会话内存态)。

## E261 — explorer:read 返回完整 payload 含 windows[].layout,绕过 layout:read 的 2MiB 读端 cap(P2,读端 cap 绕过 / 同资源多读出口)

- **问题**: `electron/main/ipc.ts:146`。`explorer:read` 直接返回 `loadExplorer()` 的完整 payload(含每个 `windows[].layout`)。而 layout 的 2MiB 读端 cap(`sanitizeReadLayout`,E215)**只用于** `layout:read` 这一出口。污染/旧版 explorer.json 可携带接近 16MiB 文件上限的超大 layout(经 `LayoutSchema.passthrough()` 不被 schema 拒),通过 explorer:read 绕过 layout 读 cap → renderer 启动 hydrate 无谓 structured-clone/传输巨大 layout,卡顿/内存峰值。同一资源(layout)有两个读出口(layout:read / explorer:read),只在其中一个加了 cap。
- **亲读**: layout:read(line 83)用 sanitizeReadLayout 守卫;explorer:read(line 146)直接 `() => loadExplorer(explorerFile)` 无守卫。layout 字段在 schema 是 `LayoutSchema.optional()`(passthrough,无大小上限)。sanitizeReadLayout 已是单一来源守卫(electron/main/lib/layout-read-guard.ts),返回 layout 原值或 null。
- **修复**: explorer:read 返回前对每个 `window.layout` 复用 `sanitizeReadLayout`:超限/非 JSON-safe → **剥离该 layout**(`delete rest.layout`,renderer 走默认布局),合法则原样保留。类型安全(layout 为 optional,剥离即省略),不引入 `unknown` 赋值。改 handler 为 async。
- **测试**: layout-ipc.spec +E261×2(超大 layout 被剥离 + 同 payload 内合法 layout 保留 + 窗口其它字段保留 / 无 layout 窗口回归原样)。中和:`if (true || ...)` 短路守卫直接 passthrough → 超大测失败,4648 PASS。
- **沉淀**: **同一资源的多个读出口须施加同一读端 cap**(读端独立校验族 E215/E237/E240/E241/E243/E245/E250/E253 的"出口对偶"变体):layout 有 layout:read(已 cap)与 explorer:read(漏 cap)两个读出口,只给其一加守卫 = 另一出口完全绕过。审计读端 cap 时须列全**同一持久化字段的所有读出口/IPC channel**(grep 返回该字段的所有 handler),逐个施加同一守卫(同 E258 family sweep 思路:不仅修一个出口,还要证明没有别的出口漏)。**容器返回放大**:返回大 payload 的 handler(explorer:read 返回整份 explorer.json)须对其内的"可无界子字段"(passthrough layout)逐项 cap,否则子字段成为绕过点。

## E262 — plugin MCP tool result 在 renderer bridge 直接 replyInvoke,10MB/JSON-safe cap 只在 main 侧 IPC 之后(P1,校验太晚 / before-IPC 读端预检)

- **问题**: `src/plugins/plugin-mcp-invoke-bridge.ts:72`。plugin tool 的 `run()` 结果直接 `api.replyInvoke({ ok:true, result })`,经 preload→main structured-clone IPC 后,才在 main 侧 `InvokeReplySchema` 校验 result 的 10MB(`RESULT_BYTES_MAX`)+ JSON-safe(`assertJsonValue`)。上限发生在 **IPC 之后** —— 恶意/畸形插件返回超大字符串/对象时,巨大 payload 已先跨 preload→main IPC 放大内存/卡顿;返回不可 clone 值还触发 IPC 异常兜底(已在错误路径)。"helper/schema 正确但校验发生在放大之后"。
- **亲读**: bridge 的 `.then((result) => api.replyInvoke({ok:true, result}))` 无前置校验;main 侧 InvokeReplySchema 的 result refine 是唯一关卡(IPC 之后)。RESULT_BYTES_MAX 此前未导出。
- **修复(收口共享 predicate)**: 把 InvokeReplySchema result refine 的逻辑抽成导出 `isInvokeResultAdmissible(r)`(assertJsonValue 递归 JSON-safe + utf8 字节 ≤ RESULT_BYTES_MAX,top-level undefined 放行),**single source** 供 main schema refine 与 renderer bridge 共用。bridge 在 `replyInvoke(ok:true)` **前**调用预检:不合格 → 不发原 result,改回 `ok:false` + 新增稳定码 `PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE`(对应 main pending invoke 立即收口,不传超大 payload)。
- **测试**: invoke-bridge.spec +E262×3(>10MB result→不发原 result 改 RESULT_TOO_LARGE 且无 ok:true / 非 JSON-safe Infinity→RESULT_TOO_LARGE / 正常小 result 回归 ok:true)。中和:`if (false && ...)` 短路预检 → 2 测失败(超大 result 被发出),4651 PASS。
- **沉淀**: **"校验太晚"——读端 cap 须在放大点之前**(同 E254/E255 校验阶段早拒优于推迟下游):跨进程数据的大小/形态校验若在 IPC structured-clone **之后**才做,则 IPC 本身已是放大面;须把同一校验前置到**发送端发 IPC 之前**(renderer bridge),main 侧校验降级为纵深第二道。**收口共享 predicate 让发送端预检与接收端 schema 用同一逻辑**(消漂移,避免两端 cap/JSON-safe 规则分叉)。**新协议错误码须稳定且使 pending 收口**:超限不能 drop(对应 invoke 会挂 30s),要回 ok:false 稳定码让对端立即 reject。

## E263 — plugin-mcp-invoke-bridge catch 分支仍原样回传 err.code/message,长度 cap 只在 main IPC 之后(E262 兄弟分支残留)(P1,校验太晚)

- **问题**: `src/plugins/plugin-mcp-invoke-bridge.ts:98`(catch 分支)。E262 只修了 `.then` 的 ok:true result 分支,但 `.catch` 分支仍把插件抛出的 `err.code`/`err.message` **原样** `replyInvoke`。InvokeReplySchema 的 code≤256(CODE_MAX)/message≤8192(MESSAGE_MAX)校验在 main 侧、preload→main IPC **之后** → 插件 run() 抛超长 Error.message/code 时仍先跨 IPC 放大内存/卡顿,属于 E262 同一"校验太晚"在**同文件兄弟分支**的残留(我修 E262 时漏 grep 同一 `.then/.catch` 对的另一分支 → codex 捞自引入缺口)。
- **亲读**: catch 分支构造 `{ok:false, code: e.code ?? 'UNKNOWN', message: e.message ?? 'unknown error'}` 无长度裁剪。两个 ok:false 兄弟(invalid-payload 行 56 / E262 RESULT_TOO_LARGE)用固定短字面量,非无界,不受影响。
- **修复(收口共享 helper,caps 同源)**: schemas.ts 加导出 `makeInvokeErrorReply(requestId, code, message)`,用 InvokeReplySchema 同源的 CODE_MAX/MESSAGE_MAX 裁剪 code/message(requestId 已由上游 InvokePayloadSchema 限长)。channels.ts 无 zod(preload sandbox)且手写 InvokeReply 类型,schemas type-import 之(无运行时环)。bridge catch 分支改用 makeInvokeErrorReply 发 IPC 前裁剪。
- **测试**: invoke-bridge.spec +E263×1(catch 超长 message(8192+5000)/code(256+500)→ 裁剪到 8192/256,内容前缀正确,requestId 保留)。既有"透传 code/message"测试(短串)仍绿(slice 仅超限才裁)。中和:catch 还原原样回传 → 测失败(长度未裁),4652 PASS。
- **沉淀**: **修"校验太晚"一处必 grep 同函数所有发送分支**(同 E249/E257 同族 grep 兄弟入口):E262 修了 `.then` 成功分支,`.catch` 错误分支是同一 `.then/.catch` 对的孪生发送点,同样在 IPC 前无 cap —— 修一个发送分支必查同函数所有 `replyInvoke`/发 IPC 调用点的入参是否都已 bounded。**区分无界 vs 字面量发送点**:同函数多个 ok:false 发送点,只有携带**外部不可控值**(err.code/message 来自插件)的需要裁剪,固定字面量分支天然 bounded(但经共享 helper 路由可防未来回归)。codex 捞我自引入的兄弟缺口=换审计者最高价值(我修 E262 时的盲区对自己不可见)。

## E264 — plugin app.network.fetch 无输入边界闸(其它能力都有),URL/headers 直接交浏览器网络栈(P2,pre-call 预检漏网入口)

- **问题**: `src/plugins/scoped-app.ts:273`。`makeNetwork.fetch` 只做 `ensurePerm('network')` 后直接 `getCachedFetch()(url, init)`,无运行时 URL 类型/长度、headers 数量/长度校验。其它插件能力发原生/IPC 前都有边界闸(fs=`assertPluginFsPath` E180 / shell=`validateShellInput` E46 / fs scope=`validateScopesShape` E239),network 是唯一漏网入口。获 network 权限的畸形插件可把超长 URL、海量/超长 headers 交给(与插件共享的)renderer 浏览器网络栈同步解析 → 卡顿/内存峰值。
- **亲读**: makeNetwork.fetch 无任何 validateXInput;PluginNetworkApi.fetch 签名 `(url: string, init?: RequestInit)`,但运行时插件可传任意类型/超量。
- **修复(scope:URL+headers,body 显式留作策略议题)**: 新建 `electron/shared/network-limits.ts`(NETWORK_URL_MAX=8192 / NETWORK_HEADERS_MAX=256 / NETWORK_HEADER_KEY_MAX=1024 / NETWORK_HEADER_VALUE_MAX=16384,均宽松,合法用例不触);scoped-app 加 `validateNetworkInput(url, init)`:URL 须非空 string ≤ cap;headers 归一化(Headers 实例/二维数组/普通对象)边收集边 cap 条数 + key/value 长度;超限抛 BAD_INPUT、不调 fetch。makeNetwork.fetch 在 ensurePerm 后调用。
- **body 不 cap(有意决策)**: request body 由浏览器**流式**发送(非 renderer 同步物化放大),且插件若传大 body 早已在自己 renderer 物化;给 body 设大小上限会限制合法上传能力 = **策略决策**,按 CLAUDE.md「架构权衡先问 user」留作单独议题,不在本轮单方面施加。URL/headers 是 fetch **同步解析**的清晰放大面,本轮收口。
- **测试**: scoped-app.spec +E264×6(超长 URL→BAD_INPUT 不调 fetch / 非 string·空 URL→BAD_INPUT / headers 超条数→BAD_INPUT 不调 fetch / 单 header value 超长→BAD_INPUT / 合法 URL+headers→通过并调 fetch 回归 / 未授 network→PermissionError 先于输入校验)。mock sandbox-sweep getCachedFetch 使 happy-path 不依赖 jsdom 真 fetch。更新 web-compat-allowlist scoped-app globalThis 行号 275→328(E180 纪律)。中和:`if (false) validateNetworkInput` → 4 拒绝测失败(2 回归仍过),4658 PASS。
- **沉淀**: **同类能力的 pre-call 预检要全员到齐**(family 完整性,同 E258 sweep):fs/shell/scope 都有发原生/IPC 前 validateXInput,network 漏 → 审计插件能力面须列全所有 `app.*` 调原生/IPC 的入口,确认每个都有输入边界闸。**区分同步解析放大 vs 流式传输**:URL/headers 被 fetch 同步解析(放大面,须 cap),body 被流式发送(非同步物化,且 cap 涉上传策略)→ 按"是否同步物化/解析"分流哪些必 cap、哪些是策略议题。**改 src/plugins 行数联动 web-compat-allowlist 行号**(E180/E239 纪律再现)。

## E265 — INVOKE_REPLY 校验失败 fallback 把 raw 整体交 handleReply,传播超大 result/超长 message(E263 main 侧对偶)(P1,读端独立校验)

- **问题**: `electron/main/ipc/plugin-mcp.ipc.ts`(bounded-fail + schema-fail 两个 fallback)+ `plugin-mcp-bridge.service.ts:227`。INVOKE_REPLY 的 bounded/schema 校验失败时,旧实现把 raw reply 整体交 `handleReply(raw)`。handleReply 信任 raw 的 ok 字段:`ok:true`→`resolve(r.result)`(超大 result)、`ok:false`→`reject(new Error(r.message))`(超长 message/code),**均绕过 InvokeReplySchema 的 10MB/8192/256 上限**。畸形 renderer reply 带合法 requestId + ok:false + 超长 message(或 ok:true + >10MB result)→ schema 失败 → fallback → handleReply 读 raw → reject/resolve 超大值 → mcp-host catch 把完整 message/result 编进 JSON-RPC 响应 → main 内存/输出放大。E263 修了 renderer **发送端**(bridge)裁剪,但 main **接收端**须独立防御(恶意/绕过 bridge 的 renderer 可直接发畸形 raw IPC)——读端独立校验。
- **亲读**: handleReply ok:false(line 228-232)读 r.code/r.message 无 cap;ok:true(line 224)resolve r.result 无 cap。两个 fallback 都 `handleReply(raw)`。success 路径 `handleReply(parsed.data)` 是已过 schema 的安全数据。topic-49 设计 fallback 为「畸形 reply 立即 reject 不挂 30s」,但经全 handleReply 泄漏 raw 字段。
- **修复(codex 第二选项,避免 hot 成功路径双校验)**: bridge 加 `rejectPendingInvalid(requestId)`(仅按 requestId 用固定 INVALID_REPLY 拒绝 pending,**不读任何 raw payload**)。ipc.ts 两个 fallback 改用本地 `rejectInvalidReply(raw)`(O(1) 提取 requestId → rejectPendingInvalid;无 requestId 静默丢弃)。success 路径 handleReply(parsed.data) 不变(已 ≤ 上限,不重复校验)。承 topic-49「立即 reject 不挂 30s」语义(observable INVALID_REPLY + pendingCount 0 不变)。
- **测试**: plugin-mcp-reply-preflight.spec +E265×2(ok:false+超长 message(8192+5000)schema 失败→INVALID_REPLY 且固定错误串<200字符不含插件 message / ok:true+>10MB result schema 失败→reject INVALID_REPLY 不 resolve 超大 result)。既有 E257 bounded-fail / topic-49 malformed / no-hang(直接调 handleReply)全绿。中和:schema-fail fallback 还原 handleReply(raw) → 2 测失败(超长 message 传播 + 超大 result resolve),4660 PASS。
- **沉淀**: **发送端裁剪 ≠ 接收端安全(读端独立校验)**(E215/E237/E245/E250/E261 族):E263 修 renderer 发送端 bridge,但 main 接收端必独立施加同等上限——跨进程边界两侧都不可信对方(恶意/绕过 bridge 的 renderer 直接发 IPC)。**校验失败的 fallback 绝不能整体信任 raw**:校验(bounded/schema)失败 = 整个 payload 不可信,fallback 只能用**已知安全字段**(requestId,且仅 O(1) 读)做最小收口(reject pending),绝不读/传播 raw 的 result/message/code。**共享 handleReply 被 success(validated)与 fallback(raw)两类调用方共用时,在调用边界分流**:success 走信任路径,fallback 走零信任路径(rejectPendingInvalid),避免在 handleReply 内对 validated 数据重复昂贵校验(result 的 assertJsonValue+stringify)。

## E266 — mcp-host tools/call catch 把 err.message/code 原样塞进 JSON-RPC error 回外部 client(E262/263/265 链最外层边界)(P2,错误串放大)

- **问题**: `electron/main/services/mcp-host.service.ts:363`。tools/call 的 catch 分支把 `tool.run` 抛出的 `err.message` / `err.code` **原样**塞进 JSON-RPC error(message + data.code),无长度上限,经 HTTP/stdio 回传给外部 MCP client。畸形/恶意 tool(或经 E265 reject 的 plugin invoke 错误)抛超长 message/code → 主进程序列化并回传巨型 error → 内存/输出放大或 MCP client 卡死。这是 E262(renderer 发 result)→E263(renderer 发 error)→E265(main 收 reply)链的**最外层 host→client 输出边界**。
- **亲读**: catch 只 `typeof e.message === 'string' ? e.message : 'internal error'` 取 message、`e.code` 取 code,无 cap。tool.run 的 result 路径(line 353)对内置 tool 是我方控制(暂不在本轮 scope);error 路径对任意 tool(含插件)开放。
- **修复**: 加 `MCP_ERR_MESSAGE_MAX=8192` / `MCP_ERR_CODE_MAX=256`(与 safe-handle ERR_MESSAGE_MAX/ERR_CODE_MAX 同量级)+ 截断 helper;抽纯函数 `formatToolCallError(err)`(message/data.code 截断,附 `… (+N)` 剩余长度;err 为 null/原始值时归一化为 {} 防读 .message 抛 + fallback 'internal error')供 catch 与单测共用。catch 改 `return { error: formatToolCallError(err) }`。
- **测试**: host.spec +E266×5(普通 Error→透传 / 带 code→data.code 透传 / 超长 message→截断 ≤MAX 不含完整原串 / 超长 code→data.code 截断 / 非 string·null message→fallback internal error)。中和:`capMcpErrText` 短路 → 2 截断测失败,4665 PASS。
- **沉淀**: **同一放大向量要追到最外层输出边界**(E262→263→265→266 完整链):plugin invoke result/error 在 renderer 发送端(E262/263)、main 接收端(E265)都裁剪后,**最终经 mcp-host 输出给外部 MCP client 的边界(E266)仍须独立裁剪** —— 任一中间环节裁剪不代表最终输出安全,错误串放大要在「写入对外响应/IPC」的每个边界都 cap(读端独立校验在输出侧的对偶)。**catch(err) 中 err 是 unknown**:throw 可抛任意值(null/原始值/无 .message 对象),catch 处理 err 须先归一化(null/非对象 → {})再读属性,否则 `err.message` 对 null 抛 = 错误处理器自身崩。**抽纯函数利于测错误路径**:catch 内联逻辑难测(需构造抛错的 tool + 完整 host),抽 formatToolCallError 纯函数直接喂各种 err 形态。

## E267 — mcp-host tools/call 成功结果无通用字节上限,内置/未来 tool 超大结果经 host 输出放大(E266 result-path 对偶)(P2,错误串/输出放大)

- **问题**: `electron/main/services/mcp-host.service.ts:353`。tools/call 对 `tool.run()` 成功结果只做 `JSON.stringify(result)` 包成 `content[0].text`,无通用结果字节上限。任一内置/未来注册的 MCP tool 返回超大对象/字符串 → 主进程序列化成巨大 content 经 HTTP/SSE/stdio 回传 → 内存/输出放大。plugin bridge 的 result 上限(E262/E265)只护**插件回包入口**,不护 mcp-host 的**通用输出边界**(内置 tool 不经 bridge)。E266 修了 error-path,此为 result-path 对偶(同一 host→client 输出边界的两条出路)。
- **亲读**: 成功分支序列化无 cap;error 路径已 E266 cap。RESULT_BYTES_MAX(10MB)已在 plugin-mcp-schemas 导出(E262),可复用。
- **修复**: 成功分支序列化后用 `utf8BytesExceed(text, RESULT_BYTES_MAX)` 检字节,超限返 `formatToolCallError({code: PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE, message})`(复用 E266 helper + E262 常量,不回传超大 content)。**用 PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE 枚举常量而非字面量** —— T9b 静态守卫禁止 main 目标文件出现 `code: 'LITERAL'`(初版写字面量触发 T9b,改枚举引用)。
- **测试**: e2e.spec +E267×2(内置 tool 返 >10MB result→tools/call 返 RESULT_TOO_LARGE 且 error 串 <1000 不含巨型 content / 正常小 result→回归正常 content)。中和:`if (false && utf8BytesExceed...)` → 超大测失败,4667 PASS。
- **沉淀**: **同一输出边界的所有出路都要 cap**(E266 error-path / E267 result-path 对偶):host→client 输出有成功(result)与失败(error)两条路,只 cap 一条另一条仍放大;修输出 cap 须列全该边界的所有 return 分支。**上游入口 cap ≠ 通用边界 cap**:plugin bridge cap(E262/265)只护插件结果,但 mcp-host 是所有 tool(含内置/未来)的通用输出边界,须在边界本身独立设 cap(同 E261 多读出口 / E265 读端独立)。**改 main 文件加错误码必用 ERROR_CODES/PLUGIN_MCP_ERROR_CODES 枚举常量**(T9b 静态守卫禁字面量,避免 code 漂移)。

## E268 — performDrop 直接信任外部 File.name 拼 joinPath,未校验 leaf 名(路径穿越 + 超长放大)(P2,untrusted leaf-name / 路径穿越)

- **问题**: `src/panels/Explorer/drop-handlers.ts:153`。performDrop 把 OS 拖放的外部 `File.name` 直接 `joinPath(targetDir, file.name)` 写盘,未校验 leaf 名。含 `/`、`\`、`..` 的 name → "拖到目标目录" 的语义被破坏成写入**子路径/父路径**(路径穿越);超长 name → 构造超长路径跨 IPC 放大 + failed 列表保留原始超长 name(错误串放大)。控制字符(尤其 NUL)可在底层路径处截断/污染。
- **亲读**: 循环读 `file.arrayBuffer()` 后 `joinPath(targetDir, file.name)` 无 leaf 校验。main 侧 rename/create 早有 `assertValidBasename`(无 / \ . ..),但(1)renderer 不可 import(node 依赖)(2)无长度上限/控制字符检查。无现成共享 leaf 校验器。
- **修复(抽共享 validator 消漂移)**: 新建 `electron/shared/leaf-name.ts` 的 `isValidLeafName(name)` + `FS_NAME_MAX=255`(拒非 string/空/`.`/`..`/含 `/`·`\`/含控制字符 0x00-0x1F/超 FS_NAME_MAX)。drop-handlers 读 arrayBuffer/拼 targetPath 前校验,非法 → failed(name 截断到 FS_NAME_MAX 防放大)+ continue,不调 writeBinary。main `assertValidBasename` 重构为委托 isValidLeafName(单一来源 + 增长度/控制字符硬化,FS_BAD_NAME 码不变;错误串只含长度摘要不嵌完整 name 防 E254 放大)。
- **测试**: drop-handlers.spec +E268×5(含 / → FS_BAD_NAME 不写防穿越子路径 / `..` → 不写防穿越父路径 / 含 `\`·控制字符(LF)→ FS_BAD_NAME / 超长 → FS_BAD_NAME 且 failed.name 截断 ≤255 / 合法回归)。fs-adapter rename/create(FS_BAD_NAME)全绿(main 委托不破)。`isValidLeafName` 改返 boolean(非 `name is string` type guard —— 否则 assertValidBasename 的 `string` 参数在 !guard 分支被窄化为 never,`name.length` 报错)。中和:`if (false && ...)` 短路 → 4 穿越/超长测失败,4672 PASS。
- **沉淀**: **外部来源的 leaf/路径段拼进 FS 路径前必校验**(路径穿越族):drag-drop 的 File.name、上传名、协议参数等"外部命名"拼进 joinPath/写盘前须校验单段合法性(无分隔符/`..`/控制字符/超长),否则"放到目录 X"被改写成穿越。**renderer 与 main 共用 leaf 校验须放 electron/shared**(renderer 不可 import main 的 node-依赖 path-utils);main 既有校验是子集时,抽共享 super-set + main 委托(消漂移 + 顺带硬化)。**type guard 用在已 typed 参数上会把 negative 分支窄化为 never**:`(x: string)` + `isX(x): x is string` → `!isX(x)` 分支 x 是 never,访问属性报错;纯校验返 boolean 避免。

## E269 — validateNetworkInput 仅在 header key/value 已是 string 时校验长度,非 string 绕过后被 fetch 隐式 String()(E264 自引入缺口)(P2,条件 typeof gap)

- **问题**: `src/plugins/scoped-app.ts:312`(E264 加的 validateNetworkInput)。per-entry 检查写成 `if (typeof k === 'string' && k.length > MAX)` —— **非 string** 的 header key/value(如 `[['x', {toString(){return huge}}]]` 或 number/object 值)`typeof` 不等 string → 整个条件 false → **跳过长度校验直接通过**,随后交给 fetch/Headers 隐式 `String()` 转换(toString 返超长),在 raw fetch 边界再触发超长转换/异常 → 削弱 E264 的"fetch 前校验"契约。我 E264 自引入的 conditional-typeof 缺口(codex 续捞)。
- **亲读**: Headers 实例分支 forEach 天然给 string;数组分支 `[[k,v]]` 与 record 分支的 value 可为任意类型(record key 必 string,但 value 来自 `headers[k]` 可非 string)。原 `typeof===string &&` 让非 string 全部漏过。
- **修复**: per-entry 改为**要求** key/value 都是 string 再校验长度:`if (typeof k !== 'string' || k.length > MAX) bad(...)`(非 string 直接拒,不留隐式 coercion 入口)。
- **测试**: scoped-app.spec +E269×3(非 string value 含恶意 toString 返超长→BAD_INPUT 不调 fetch / 非 string value number·object→BAD_INPUT / 非 string key 数组分支→BAD_INPUT)。更新 web-compat-allowlist scoped-app globalThis 行号 328→331(E180)。中和:还原 `typeof===string &&` → 3 非 string 测失败,4675 PASS。
- **沉淀**: **`typeof x === 'string' && x.length > MAX` 是反模式:它只在"是 string"时限长,"非 string"全放行**——而非 string 下游常被隐式 String() 转换(fetch/Headers/拼串/模板字面量),把上限契约架空。要限"字符串长度"时,若值理应是 string,用 `typeof x !== 'string' || x.length > MAX`(非 string 即拒);若值可选多类型,先按类型分流再各自限长。**审计 typeof-then-check:`&&` 形式漏非目标类型,`!== type ||` 形式才闭合**(同 E215 容器≠元素 / E243 的"守卫只挡部分形态"族)。**换审计者捞自引入缺口最高价值**:E264 是我刚加的 validateNetworkInput,自带 conditional-typeof gap,codex 下一轮即捞。

## E270 — new-account 风险 badge:author.createdAt 不校验可解析日期,畸形值 NaN 比较绕过 badge(E253 续)(P2,信任信号防绕过 / NaN 比较)

- **问题**: `src/marketplace/MarketplaceTab.tsx:938`。`accountAge = Date.now() - new Date(r.author.createdAt).getTime()`;author.createdAt 经 E253 校验为 string + 长度,但**不保证可解析为日期**。畸形值如 `"not-a-date"` → `getTime()` 为 NaN → `accountAge` 为 NaN → `NaN < NEW_ACCOUNT_MS` 为 **false** → 新账号 ⚠ badge 被静默绕过。**新账号靠损坏自己的 createdAt 即可规避风险提示**(外部 reviews / 篡改缓存可触发)。
- **亲读**: 仅 ReviewItem(line 938-939)用 author.createdAt 算账龄。E253 的 epoch 兜底只对**非 string/超长**生效,string-but-unparseable("not-a-date")通过 E253 → 到 UI → NaN。
- **修复(UI 保守兜底,不在数据层 epoch)**: `isNewAccount = !Number.isFinite(accountAge) || accountAge < NEW_ACCOUNT_MS` —— 不可解析(NaN)= **保守视为新账号**(未知账龄=假定风险,显 badge),闭合绕过。**故意不采纳 codex 的"数据层把畸形 createdAt 兜底成 epoch"子选项**:epoch 解析为 1970(很旧账号)→ accountAge 巨大 → 不显 badge → **反而重新打开本漏洞**(新账号发 garbage→epoch→逃过 badge);故必须在 UI 判定处把 non-finite 兜底为"新"而非在数据层兜底为"旧"。
- **测试**: marketplace-tab.spec +E270×1(author.createdAt='not-a-date' 展开 review → 仍显 ⚠ badge)。中和:还原 `accountAge < NEW_ACCOUNT_MS` → 测失败(NaN 比较 false,badge 消失),4676 PASS。
- **沉淀**: **NaN 比较恒 false 是安全绕过面**(E10/E122/E244 clamp 非有限族在"比较"侧的对偶):`NaN < threshold` / `NaN > threshold` 都为 false —— 用比较结果驱动**安全/风险判定**时,畸形输入产生的 NaN 会静默落到"安全"分支(不触发警告/限制)。涉安全的数值比较须先 `Number.isFinite` 兜底,且**兜底方向要朝保守/告警**(unknown→视为风险),不能朝"放行"。**"标记风险"的兜底 sentinel 不能选会落入"安全"分支的值**:此处不可解析 createdAt 兜底成 epoch(旧账号=安全分支)等于帮攻击者绕过,必须兜底成"新/风险"。审计所有"外部数值/日期 → 比较 → 风险/权限/限制判定"链:畸形→NaN→比较 false→落安全分支 = 漏判。

## E271 — notifications.show 在参数处直接解构,未校验 opts 为对象,插件传 null/非对象抛 TypeError(P2,插件 API 对象形态守卫)

- **问题**: `src/plugins/co-app.ts:160`。`show({ kind, message, code })` 在**参数处直接解构**。opts 是公开插件 API 的直传入参,JS 插件可传 `null`/`undefined`/非对象 → 解构 null/undefined 抛 TypeError → 冒泡到插件激活/命令执行(异常失败),而非按边界策略静默丢弃非法通知。绕过后续 message/code 校验。
- **亲读**: E52 已校验 message/code 内容,但**前提是 opts 已是对象** —— 参数解构发生在任何校验之前。CoNotificationsApi.show 类型声明 opts 为对象,但 JS 插件无视类型。
- **修复**: 改 `show(rawOpts: unknown)`(满足接口:函数参数逆变,`unknown` 是 CoNotificationsShowOpts 的超类型,赋值合法)。先 `rawOpts === null || typeof !== 'object' || Array.isArray` 守卫 → 非法直接 return;再 `as {kind?,message?,code?: unknown}` 读字段(后续 isNotificationLevel/typeof message 校验不变)。
- **测试**: notifications-show-raw.spec +E271(it.each [null,undefined,42,'str',true,[1,2]] → 不抛、不调 notify + 合法对象回归)。中和:`if (false && ...)` 短路守卫 → null/undefined 解构抛 → 2 测失败,4683 PASS。
- **沉淀**: **公开 API 入口在参数处解构 = 把"必是对象"的假设前置到任何校验之前**:`fn({ a, b })` 形式的参数解构对 null/undefined 抛 TypeError(原始值/数组虽不抛但字段全 undefined)。外部/插件可调的 API 不能在参数签名处解构,须 `fn(raw: unknown)` + 对象形态守卫 + 再读字段。**类型声明挡不住 JS 调用方**:TS 声明 opts 为对象只在编译期约束 TS 插件,JS 插件运行时可传任意值 → 公开 API 须运行时守卫(同 E172/E173 IPC ingress / E250 元素守卫)。**参数逆变让 impl 可收 unknown 满足窄类型接口**:`(x: unknown)=>void` 可赋给 `(x: T)=>void`,是公开 API impl 防御性收 unknown 的标准手法。

## E272 — semver prerelease 用裸字符串序比较,非 SemVer §11 点分 identifier(更新检查反向/漏报)(P2,边界语义正确性)

- **问题**: `src/marketplace/semver.ts:24`。两版本数字段全等且都有 prerelease 时,`return pa.prerelease > pb.prerelease` 用**裸字符串序**比较。例 `1.0.0-beta.10` vs `1.0.0-beta.2`:逐字符 'beta.1' vs 'beta.2' 在第 6 位 '1'<'2' → `beta.10 < beta.2` → 判 beta.10 **不**新于 beta.2(反向)。Marketplace 更新检查对合法 prerelease 给出反向/漏报 → 用户收不到应有更新或看到错误提示。
- **亲读**: 这是"有效但边界语义错"(不崩、给错结果)。前序 R6(第八 session)修了无尾锚 `$` 的 parse 丢后缀问题;本项是 parse 正确后的**比较语义**错。文件刻意不引 semver 包(窄场景自家实现),保持该决策。
- **修复**: 新增 `comparePrerelease(a, b)` 按 SemVer §11:`.` 分段逐段比 —— 纯数字段按整数比较(去前导零后「长度多者大,等长字典序」= 任意长度整数精确比较,免 Number 精度)、数字段优先级 < 非数字段、都非数字 ASCII 字典序、所有公共段相等时段数多者更高(`alpha.1` > `alpha`)。line 24 改 `comparePrerelease(...) > 0`。
- **测试**: semver.spec +E272×6(beta.10>beta.2 数字段 / 数字段<非数字段 alpha.beta>alpha.1 / 段数多者高 alpha.1>alpha / SemVer §11 经典序列 alpha<alpha.1<beta<beta.2<beta.11<rc.1 / 非数字字典序 rc>beta / 完全相同→false 回归)。既有 prerelease-precedence + E7 不安全整数 spec 全绿。中和:还原 `pa.prerelease > pb.prerelease` → 数字段序列测失败,4689 PASS。
- **沉淀**: **"有效但语义错"的边界 bug 比崩溃更隐蔽**(不抛、测试若只测"不崩"会漏):字符串序 ≈ 数值序仅在等长无数字段时巧合成立,`beta.2` vs `beta.10` 这类数字段长度不同即背离。**版本/优先级/排序比较涉数字 identifier 必按数字比较,不可裸字符串序**(同类:自然排序文件名 file2 vs file10)。**自家精简实现要覆盖规范的语义分支**:"X.Y.Z 数字段"易实现对,prerelease §11 规则(数字 vs 非数字、段数)易漏 —— 精简实现省的是依赖不是语义正确性。整数精确比较用「去前导零长度→字典序」免大数 Number 精度。

## E273 — registry validate*Spec 读 spec.id/name 前未校验 spec 是对象(E271 registry 族,9 入口)(P2,对象形态守卫)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:82`(validateToolSpec)及同族全部贡献 registry validator。读 `spec.name`/`spec.id` 前未先校验 spec 本身是对象。spec 来自第三方未类型化 JS 插件,TS 类型非运行时保证 —— 传 null/undefined → `spec.name` 抛**非结构化 TypeError**,冒泡到注册/激活路径,错误码与 UI 反馈不稳定(绕过 INVALID_PARAMS / `[xxx-registry] ...` 稳定错误契约)。E271(notifications.show)的 registry-validator 同族。
- **亲读**: 9 个 validate*Spec(Command/EditorAction/ExplorerContextMenu/Panel/Ribbon/SettingItem/SettingTab/StatusBar/PluginMcp)都直接读首字段。primitive/数组 spec 经字段 typeof 检查能兜住(但报"字段非法"而非"spec 非对象"),null/undefined 直接崩。
- **修复(抽 shared 收口 9 入口)**: 新建 `src/plugins/registries/spec-guard.ts` 的 `isSpecObject(spec): boolean`(非 type guard —— 避免对已 typed 的 spec 参数在 false 分支窄化 never,见 E268)。9 个 validator 开头统一 `if (!isSpecObject(spec)) throw/bad('spec must be an object')`(8 个 Error-style 抛 `[xxx-registry] spec must be an object`,MCP 抛 PluginMcpError INVALID_PARAMS),保各 registry 既有错误契约。
- **测试**: 新 topic spec-object-guard(isSpecObject 单测 + CommandRegistry.register(null/undefined/primitive/数组)→ 稳定 "spec must be an object" 非 TypeError + 合法回归 + **家族接线守卫:全 9 个 validator 源码含 `isSpecObject(`**)。中和:isSpecObject 恒 true → null 解构崩 + 单测失败,4706 PASS。
- **沉淀**: **对象形态守卫是公开/插件入口的统一前置**(E271 的 registry 族扩展):凡读外部传入对象字段前必先 `isSpecObject`,否则 null/undefined 解构/取属性抛非结构化 TypeError。**同族多入口(9 registry)抽 shared 谓词 + 家族接线守卫测试**(readFileSync 断言全兄弟都调,同 E236 registry-capacity / E242 preload listener):防某个兄弟漏接或回归,比逐个构造每入口非对象输入更轻量。**类型守卫(`x is T`)用在已 typed 参数上会窄化 false 分支为 never**,纯 boolean 谓词避免(E268 复现教训)。

## E274 — isValidLeafName(E268)弱于 plugin-fs validateLeaf,漏拒 Windows 危险名;收口两者(P2,跨平台 leaf 校验 + 消漂移)

- **问题**: `electron/shared/leaf-name.ts:16`(E268 初版)。isValidLeafName 只拒 空/`.`/`..`/分隔符/控制字符/超长,**漏拒** Windows 危险 leaf:`:`/ADS、CON/NUL 等保留设备名、尾随点/空格、NTFS 8.3 短名(`~[0-9]`)、任意 `~`、非 NFC。而 Explorer create/rename/drop + main assertValidBasename 都复用它 → 畸形名可进写入路径(Windows 上 `foo.txt:ads` 写到不可见 NTFS alternate stream、`CON`/`name.` 平台特殊失败 / UI 路径与真实文件名不一致)。plugin-fs 写路径的 `validateLeaf`(path-resolve.helper.ts)早有最强规则集但**未与 isValidLeafName 收口**(两套漂移)。
- **亲读**: validateLeaf(path-resolve.helper.ts)规则集:NTFS 8.3 / `~` / `..` / 控制字符 / 260·4096 长度 / `:` / WIN_RESERVED(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]) / 尾随点空格 / NFC,**无条件应用**(cross-platform-p0 可移植策略:POSIX 虽合法的名也拒)。validateLeaf 有 path-resolve.test.ts T20 系列测试断言**精确 reason 文案**。
- **修复(收口单一来源)**: 把全规则集 + **逐字 reason 文案** + 长度 tier(260/4096)移入 shared `leafNameRejectReason(name): string|null`;`isValidLeafName = leafNameRejectReason()===null`;validateLeaf 重构为委托(`reason!==null → throw ScopeError('leaf rejected: '+reason)`)→ ScopeError 消息 byte-identical,T20 测试零改通过。FS_NAME_MAX=255 保留作 drop failed.name 显示截断常量(独立于校验 tier)。
- **测试**: 新 topic leaf-name-guard(isValidLeafName 接受合法 + it.each 拒 16 类危险名(:/CON/con/NUL.txt/LPT1/尾随点空格/NFD/~/NTFS83/..) + 控制字符/NUL + 非 string + reason 文案契约 + 收口接线守卫:path-resolve.helper 源码含 leafNameRejectReason()。path-resolve.test T20 + drop-handlers E268 + fs-adapter 全绿。中和:`if (false && ...)` 短路 `:`/WIN_RESERVED → shared 测 + path-resolve T20 同时失败(证收口),4728 PASS。
- **沉淀**: **同一概念的两个校验器(isValidLeafName / validateLeaf)是漂移源,且弱者是安全洞** —— 收口到单一来源时取**最强规则集**(弱者升级到强者),不能取交集。**收口时保留被合并方的精确契约(reason 文案/长度 tier)**让其既有测试零改通过(validateLeaf 的 ScopeError reason 是 T20 测试断言的契约)→ 委托而非重写。**cross-platform-p0 的 leaf 策略是无条件拒 Windows 危险名**(非 runtime 平台门控):工作区可移植性要求 macOS/Linux 上也不创建 `CON`/`a:b`/`file.` 这类换平台即坏的名;与 validateLeaf 既有无条件策略一致。

## E275 — fs:listDir maxFiles schema 只 positive int,无上界/安全整数,畸形大值绕过早停(P2,clamp 上界 + 安全整数)

- **问题**: `electron/main/ipc/fs.ipc.ts:42`。ListDirOptionsSchema 的 `maxFiles: z.number().int().positive()` 无上界、无安全整数约束。`z.int()` 放行 1e308(Number.isInteger(1e308)=true)等不安全整数。畸形 IPC 传极大 maxFiles → list-dir 的 `opts.maxFiles && >0 ? opts.maxFiles : Infinity` 当成有效大数 → 绕过调用方预期的早停 → 单次请求迫使主进程遍历/排序/回传近 MAX_TOTAL_ENTRIES=100000 条(卡顿 + 内存峰值)。
- **亲读**: MAX_TOTAL_ENTRIES(list-dir.ts,硬上限)未导出;maxTotalEntries 不在 IPC schema(仅内部),只 maxFiles 经 IPC 暴露且无界。
- **修复(schema 上界 + helper 自守)**: 导出 MAX_TOTAL_ENTRIES,schema `maxFiles: z.number().int().positive().max(MAX_TOTAL_ENTRIES).optional()`(超 10 万 / 1e308 → BAD_INPUT);list-dir 内 maxFiles 归一化加 `typeof===number && Number.isSafeInteger && >0 ? Math.min(x, MAX_TOTAL_ENTRIES) : Infinity`(防 schema 旁路 / 不安全整数,clamp 到硬上限,非法走默认)。
- **测试**: fs-ipc-bridge.spec +E275(maxFiles 1000/100000 ok,100001/1e308/0 fail);fs-adapter.spec +E275(直调 listDir 传 1e308 → 结果与不传一致不崩)。中和:schema 去 `.max()` → 1e308 测失败,4730 PASS。
- **沉淀**: **`z.number().int().positive()` 不挡不安全整数与无上界**(E7/E4 同族在 schema 侧):`.int()` 仅 Number.isInteger(对 1e308 为 true),不等于安全整数;数量/上限类数值字段须 `.max(硬上限)` + 业务侧 Number.isSafeInteger 自守。**业务硬上限(MAX_TOTAL_ENTRIES)应同时约束 schema 入参**:有早停/容量硬上限时,对应的可调参数 schema 上界对齐到该硬上限(传更大无意义且是放大入口)。**IPC schema + impl helper 双层 clamp**(schema 拒超界 + helper Number.isSafeInteger 归一,防 schema 旁路/未来内部调用),同 E251/E248 clamp helper 自守。

## E276 — pinned.store 运行时无限 pin,超持久化 schema PINNED_MAX → explorer:write 拒整份 → 全 explorer 持久化失败(P2,运行时状态守持久化契约)

- **问题**: `src/stores/pinned.store.ts:18`。toggle 追加 `[...s.paths, path]` **无上限**,但 `ExplorerWritableSnapshotSchema.pinned.paths` 是 `.max(PINNED_MAX=10000)` 且 `pathStr().max(PATH_STR_MAX=8192)`。运行时 pin 超 10000 条(或单条超长)后,snapshotFromStores 原样写出 → explorer:write 被 schema 拒绝**整份** snapshot → workspace/editor/layout/recentRoots 等所有 explorer 持久化**持续失败**(单一超限字段毒死整份持久化)。
- **亲读**: 读路径(loadExplorer→ExplorerSchema)已 schema-cap,故 hydrate 不超;运行时增长唯一入口是 toggle。PINNED_MAX/PATH_STR_MAX 此前未导出。
- **修复(运行时约束到持久化契约)**: 导出 PINNED_MAX/PATH_STR_MAX;toggle 追加分支加 `if (s.paths.length >= PINNED_MAX || path.length > PATH_STR_MAX) return s`(拒加 no-op);已 pin 的仍可移除(降回上限内)。保证运行时状态恒 ≤ 持久化 schema 契约。
- **测试**: pinned.spec +E276(达 PINNED_MAX 后新 pin 拒加 + 已 pin 可移除 / 超长 path 拒加)。中和:`if (false && ...)` → 两测失败,4732 PASS。
- **沉淀**: **运行时状态必须恒满足其持久化 schema 契约**(写读 cap 对称族 E260/E242 的运行时变体):内存 store 无限增长但持久化层有 schema 上限时,超限后**整份**写入被 schema 拒 → 不是丢一条,而是该 store 所属的整份持久化(及同份其它字段)全部失败。store 的 mutation 入口须按持久化 cap 自限(数量 + 单元素长度)。**单一超限字段毒死整份 strict schema 持久化**:`.strict()`/`.max()` 的写 schema 一处违规拒整份 → 运行时任一可增长字段都须前置约束。**同族潜在兄弟**(供后续审计):recentRoots(RECENT_ROOTS_MAX 1000)/expandedPaths(PATH_ARRAY_MAX)/editor openFilePaths 等运行时可增长且有持久化 cap 的 store,均须验证运行时不超 schema。

## E277 — explorer.store expandedPaths 运行时无上限,超持久化 PATH_ARRAY_MAX → explorer:write 拒整份(E276 同族,我已预判)(P2,运行时状态守持久化契约)

- **问题**: `src/stores/explorer.store.ts:43`(setExpandedPaths)+ :35(toggleExpand)。expandedPaths 运行时可经 `setExpandedPaths(new Set(paths))` 无上限写入 / toggleExpand 无限 add,但持久化 `pathArray()` = `.max(PATH_ARRAY_MAX=100000)` + 单条 `.max(PATH_STR_MAX=8192)`。极端树展开超上限后 snapshotFromStores 原样展开成数组 → explorer:write 被 ExplorerWritableSnapshotSchema 拒**整份** → workspace/editor/layout 持久化持续失败。**E276 的 doc 沉淀已预判此兄弟(expandedPaths/PATH_ARRAY_MAX),codex cycle-49 确认。**
- **亲读**: 两个 mutation 入口(toggleExpand 单加 / setExpandedPaths 批量替换)都无界。读路径 hydrate 经 schema 已 cap。
- **修复(运行时约束到持久化契约,同 E276)**: 导出 PATH_ARRAY_MAX;toggleExpand 加 `if (next.size >= PATH_ARRAY_MAX || path.length > PATH_STR_MAX) return s`;setExpandedPaths 改逐项收集 `if (size >= PATH_ARRAY_MAX) break; if (p.length <= PATH_STR_MAX) add`(截断 + 过滤超长)。
- **同族 sweep(本轮验证其余兄弟)**: recentRoots(workspace.store)已 `slice(0, RECENT_LIMIT=5)` ≤ RECENT_ROOTS_MAX 1000 → **安全**;editor openFilePaths 经 pathArray cap(100k),但 tabs 仅按用户逐文件 open 增长(无 bulk-set,100k 不可现实触达,hydrate 经 schema cap)→ **不可现实超限**。故 expandedPaths 是 E276 之外唯一可现实触达的兄弟。
- **测试**: explorer.spec +E277×3(setExpandedPaths 超 PATH_ARRAY_MAX→截断 / 过滤超长 path / toggleExpand 达上限拒加 + 超长拒加)。中和:短路 setExpandedPaths cap → 2 测失败,4735 PASS。
- **沉淀**: **预判的同族兄弟应在首修时主动 sweep 全部运行时-可增长-store**(E276 沉淀预判 → E277 codex 确认,本轮顺带验证 recentRoots/editor 兄弟):列全「运行时可增长 + 有持久化 cap」的 store(pinned/expandedPaths/recentRoots/openFilePaths),逐个验证运行时 mutation 入口是否 ≤ schema cap。已安全的(recentRoots slice 5)记录免重报,可现实触达的(expandedPaths)修。**批量 set 入口(setExpandedPaths/new Set(paths))与单加入口(toggle)都要约束** —— 批量替换是比单加更大的越限入口。

## E278 — editor.store openTab 对 tabs 无运行时上限,超持久化 openFilePaths PATH_ARRAY_MAX(E276/E277 同族,纠正我 E277 误判)(P2,运行时状态守持久化契约)

- **问题**: `src/stores/editor.store.ts:321`(openTab)。tabs 无运行时上限,snapshotFromStores 把所有 file tab(filePath!==null)序列化成 `editor.openFilePaths`(持久化 PATH_ARRAY_MAX=100000 cap + 单条 PATH_STR_MAX)。**插件经 SDK openFile 循环打开海量文件** → tabs 超量 → openFilePaths 超上限 → explorer:write 拒整份 → workspace/editor/layout 持久化持续失败。
- **纠正 E277 误判**: E277 doc 我评估 editor tabs "仅按用户逐文件 open 增长,100k 不可现实触达" → **错**。漏了**程序化 SDK 路径**(插件/co-app editor.openFile 可循环调用),codex cycle-50 指出。可现实触达(恶意/buggy 插件)。
- **修复(同 E276/E277,运行时约束到持久化契约)**: 导出已有 PATH_ARRAY_MAX/PATH_STR_MAX;openTab 加 `if (s.tabs.length >= PATH_ARRAY_MAX || (tab.filePath !== null && tab.filePath.length > PATH_STR_MAX)) return s`(达上限或超长 filePath → no-op,不开 tab)。总 tab 数近似 file-tab 数(untitled 极少),用 O(1) 的 tabs.length。
- **测试**: editor-store.spec +E278×2(超长 filePath 拒开 / tabs 达 PATH_ARRAY_MAX 拒开新 tab)。中和:`if (false && ...)` → 两测失败,4737 PASS。
- **沉淀**: **评估"可现实触达"时必须算上程序化/SDK/插件路径,不只人工操作**(纠正 E277 误判教训):我把 editor tabs 当成"只有人逐个开"判低风险,漏了插件经 SDK 循环开文件的程序化放大路径 —— 凡有 SDK/API 暴露的 mutation(openFile/pin/register),量级上限是"程序循环"而非"人手速度",reachability 必按程序化算。**换审计者捞我的误判**(E277 我判 editor 安全 → codex E278 推翻):自评 reachability 易乐观,外部审计者按"最坏可编程触达"重估是高价值。运行时-守-持久化契约族至此四 store 全闭合:pinned(E276)/expandedPaths(E277)/editor tabs(E278)/recentRoots(已 slice 5 安全)。

## E279 — Quick Open / Command Palette query 不限长,超长 paste 一次性 fuzzyFilter O(results×queryLen) 卡死 renderer(P2,搜索 query 上限)

- **问题**: `src/plugins/quick-open/store.ts:66` + `src/plugins/command-palette/store.ts:30`。两个搜索 store 的 `setQuery: (q) => set({ query: q, ... })` 不限 query 长度。畸形粘贴超长字符串 → 一次性进 fuzzyFilter,对最多数千候选(QuickOpen ≤5000 文件 / Command Palette 全命令)做 toLowerCase + 模糊匹配 = O(results × queryLen) CPU + 大字符串分配 → 单次 paste 卡死 renderer。
- **亲读**: 两个搜索入口同款 setQuery,均无界(命令面板 fuzzy.ts 的 query.toLowerCase 整批一次,但 queryLen 无界仍放大)。codex 早期(cycle-28)曾以"只来自用户输入"低估,但单次 PASTE(非逐字符输入)是一次性放大,非渐进 → reportable。
- **修复(抽 shared 收口两入口)**: 新建 `src/lib/search-query.ts` 的 `MAX_SEARCH_QUERY_LEN=1024` + `clampSearchQuery(q)`;两 store 的 setQuery 改 `set({ query: clampSearchQuery(q), ... })`(超长截断,搜首 1024 字符仍合理)。
- **测试**: 新 topic search-query-limit(clampSearchQuery 单测 + 两 store setQuery 截断 + **家族接线守卫:两 store 源码含 clampSearchQuery(**)。中和:clampSearchQuery 短路 → 3 测失败,4743 PASS。
- **沉淀**: **"只来自用户输入"不等于安全 —— PASTE 是一次性大输入**(区别于逐字符输入的渐进):搜索/过滤函数对候选集做 O(results × inputLen) 时,一次 paste 超长 query 即在单帧内放大;凡用户可粘贴的搜索框 query 须截断长度。**同类搜索入口(QuickOpen/CommandPalette)抽 shared query cap + 家族接线守卫**(同 E236/E242/E273):防新增搜索框漏接。早期"低优先级"的边界项在想清放大模型(paste vs type)后可升级为真 bug。

## E280 — Terminal 搜索框 query 不限长(E279 同族,我 E279 漏 grep 的兄弟)+ 主动收口全部 5 个搜索输入(P2,搜索 query 上限)

- **问题**: `src/panels/Terminal/TerminalSearchBar.tsx:67`。terminal 搜索框 `onChange={(e) => searchApi.setTerm(e.target.value)}` 不限长 → 超长 paste 放大为「超长 pattern × 终端 scrollback」的 xterm SearchAddon 同步搜索成本(regex 模式更甚)→ 卡死 renderer。E279 同族,但我修 E279 时**只 grep 了 quick-open/command-palette,漏了 terminal 搜索**(以及 settings/keybindings 搜索)。codex cycle-52 捞出 terminal 兄弟。
- **修复 + 主动家族收口**: terminal 搜索 onChange 复用 E279 的 clampSearchQuery。**本轮主动 grep 全部搜索/过滤 query 输入**,补齐遗漏的两个:`SettingsPanel.tsx:113`(setQuery→`searchable.filter(haystack.includes(ql))`)、`KeybindingsTabContent.tsx:154`(setQuery→`visible.filter(matches(d, query))`)—— 同 O(items×queryLen) paste 放大。三处 onChange 全加 clampSearchQuery。
- **测试**: terminal-search/search-bar.spec +E280(超长 query 截断后才进 setTerm);search-query-limit 家族接线守卫扩到全 **5 个搜索输入**(quick-open/command-palette/terminal/settings/keybindings 源码都含 clampSearchQuery()。中和:terminal onChange 去 clamp → 测失败,4747 PASS。
- **沉淀**: **"修一族必 grep 所有兄弟"——E279 我只修 2 个搜索 store 漏 3 个(terminal/settings/keybindings),codex 续捞 terminal(E280)**。抽 shared helper(clampSearchQuery)时必须同轮 grep 全部调用场景(所有 `setQuery`/`setTerm`/搜索 onChange + 所有 `.filter`/`fuzzy` 受 query 驱动的列表),一次接全,否则每个漏接的兄弟都会被审计者逐个续报(E279→E280 各一轮)。**家族接线守卫测试列全所有入口**(本轮从 2 扩到 5):readFileSync 断言每个搜索输入源码都调 clampSearchQuery,防新增搜索框漏接 + 锁定本轮收口的完整性。

## E281 — Marketplace 搜索 query 未复用 clampSearchQuery(E279/E280 同族第 6 个搜索输入,我两轮 sweep 仍漏)(P2,搜索 query 上限)

- **问题**: `src/marketplace/MarketplaceTab.tsx:334`。Marketplace 搜索 `onChange={(e) => setQuery(e.target.value)}`(本地 useState)未截断,query 进 `applyFilter(entries, {query})`(filter.ts)→ 对最多 4096 条远端 entry 逐项构造 haystack + toLowerCase/includes,每次渲染跑。超长 paste → 同步 CPU/内存峰值卡住市场面板。E279/E280 搜索 query 上限族的**第 6 个**搜索输入 —— 我 E280 自称"收口全部 5 个搜索输入"仍漏 marketplace(grep 模式未覆盖 marketplace 的 useState query)。
- **亲读**: applyFilter 是导出纯函数(可被非 UI 调用)。CommandPalette/QuickOpenModal 的 onChange 传给**store** setQuery(已 E279 clamp),故无需重复;只有本地 useState 的搜索(settings/keybindings/marketplace)需在 onChange clamp。
- **修复(双层 + 收口确认)**: MarketplaceTab onChange 复用 clampSearchQuery;filter.ts applyFilter 入口防御性 `clampSearchQuery(opts.query)`(纯函数自守,防非 UI 调用方)。**本轮做穷尽 grep**(setQuery/setTerm/setSearch/setFilter 全仓)确认 6 个搜索输入全覆盖:quick-open store(clamp)/command-palette store(clamp)/terminal bar/settings/keybindings/marketplace,无第 7 个。
- **测试**: filter.spec +E281(超长 query 不抛/不放大 + 纯 'foo' 回归匹配);search-query-limit 家族接线守卫扩到含 MarketplaceTab + filter.ts(共 7 文件)。中和:MarketplaceTab onChange 去 clamp → 接线守卫失败,4750 PASS。
- **沉淀**: **穷尽 grep 也会漏(E279 漏 3→E280 漏 1→E281)——审计者多轮逐个续捞同族正是补 grep 盲区的价值**:我的 grep 模式(按 setQuery/setTerm 字面)漏了 marketplace 的 useState query(命名/上下文不同)。教训:family sweep 不能只 grep 一种命名,要按**语义**(所有"用户输入 → 驱动 O(n) 列表过滤"的点)多模式交叉 grep(setQuery + applyFilter + .filter(...includes) + fuzzy 调用点)。**纯导出过滤函数(applyFilter)应自带入参防御**,不只依赖 UI 调用点 clamp(同 E251 helper 自守 / E261 多读出口),则即使某 UI 入口漏接,filter 层仍兜底。

## E282 — Git URL 输入框未截断长度,超长 paste 撑 React state + IPC 放大(main schema 才拒)(P2,before-IPC 输入截断)

- **问题**: `src/marketplace/MarketplaceTab.tsx:516` + `src/plugins/settings/PluginsTabContent.tsx:399`。两个 Git 安装 URL 输入 `onChange={(e) => setUrl(e.target.value)}` 未截断,超长 paste 完整进 React state(同步渲染/内存峰值),提交时巨大 payload 先 structured-clone 到 IPC,main 端 InstallFromGitInput(URL_MAX=4096)才拒 → renderer 侧已放大。**我 E281 时把 git URL 输入判为"skip(单值非搜索)"是误判** —— 它是 before-IPC 输入截断族(同 E264/E268),codex cycle-54 捞出。
- **亲读**: main URL_MAX=4096 在 plugins.ipc.ts 本地 const(未导出/未共享)。两个 renderer 输入完全无截断。
- **修复(收口共享 + 两输入 + 后门)**: URL_MAX 移到 shared `plugins-channels.ts` 的 `GIT_URL_MAX=4096` + `clampGitUrl`;plugins.ipc.ts schema 改用 GIT_URL_MAX;两个 renderer onChange 复用 clampGitUrl;main schema 保留作后门防线。
- **测试**: plugins-ipc-input-limits.spec +E282(clampGitUrl 截断 + main schema 上限=GIT_URL_MAX 同源 + 家族接线守卫:两个 Git URL 输入源码含 clampGitUrl()。中和:clampGitUrl 短路 → clamp 测失败,4754 PASS。(注:并发跑时 stop-hook-crosstalk spec 偶发 timing flaky,与本改无关,单跑通过。)
- **沉淀**: **"单值输入"也要 before-IPC 截断,不只搜索 query**(纠正 E281 我把 git URL 判 skip 的误判):凡用户可粘贴、会进 React state 且会 structured-clone 过 IPC 的输入,都须在 onChange 截断到与后端 schema 一致的上限 —— 即便后端 schema 会拒,renderer 侧的"撑 state + IPC clone"放大已发生(同 E264 fetch headers / E268 drop name)。**main 侧本地 const 上限(URL_MAX)要共享化才能让 renderer 复用同源 cap**(消漂移):后端 schema cap 与前端 onChange clamp 必须是同一常量,否则两端漂移。后端 schema 始终保留作"后门防线"(前端可绕过/旧版本)。

## E283 — jsonSchema 64KiB 字节上限在 assertJsonValue(允许 1M 数组/10万 key)之后,大遍历在 cap 前发生(P2,校验顺序 fail-fast)

- **问题**: `src/plugins/registries/PluginMcpRegistry.ts:112`(renderer)+ `electron/shared/plugin-mcp-schemas.ts` RegisterPayloadSchema jsonSchema superRefine(main)。jsonSchema 校验顺序:assertJsonValue → JSON.stringify → 64KiB 字节上限。但 assertJsonValue 的早停上限是数组 1,000,000 项 / 对象 100,000 key / 深度 256 —— 远超 64KiB schema 契约。`{enum: Array(1e6)}` 在被字节上限拒前先递归遍历 1M 项 + stringify 巨对象;深嵌套(depth 65-256)更绕过(字节小+JSON-safe,assertJsonValue+字节上限都放行,但浪费递归)。同 E254/E255/E259「放大在 cap 之前」族。
- **亲读**: 两处(renderer 预检 + main schema)同序。boundedValueDeepAdmissible(E259)已存在:数组长 65536 / key 数 1024 / 深度 64,且**数组长度处 O(1) fail-fast 不迭代**。其上限远低于 assertJsonValue,适合作 64KiB schema 的廉价前置闸。
- **修复(两处同序插入 bounded 预检)**: 在 assertJsonValue **之前**加 `if (!boundedValueDeepAdmissible(jsonSchema).ok) reject` —— 数组超长/对象超宽/超深在大遍历前 fail-fast。renderer(PluginMcpRegistry)+ main(RegisterPayloadSchema superRefine)各插一道(已 import bounded-input)。
- **测试**: registry.spec + ipc-protocol.spec 各 +E283(深嵌套 depth>64、字节小、JSON-safe 的 jsonSchema → INVALID_PARAMS/fail)。**neutralize 敏感选深嵌套**:它字节小且 JSON-safe → 去 bounded 预检后 assertJsonValue(depth 256)+字节上限都放行 → 注册成功;有预检则拒。中和:renderer 预检 `if(false&&...)` → 深嵌套测失败,4756 PASS。
- **沉淀**: **多道校验的顺序决定放大点 —— 廉价紧界预检必须在昂贵宽界递归之前**(E254/E255/E259 校验顺序族):assertJsonValue 是"JSON 安全性 + 宽松上限(1M/10万/256)"的递归校验,字节上限是事后裁决;二者之间塞一道"紧界 fail-fast 预检"(boundedValueDeepAdmissible:65536/1024/64,数组长 O(1) 拒)挡住大遍历。**深嵌套是字节小但递归大的隐蔽放大**:depth 65 的对象 JSON 仅百字节(过字节上限)但 assertJsonValue 递归 65 层 —— 字节上限挡不住"深而不大",须独立深度闸。**校验顺序 bug 与功能正确性无关(都最终拒),neutralize 须构造"仅前置闸拒、后置闸放行"的输入**(深嵌套:bounded 拒/assertJsonValue+字节 放行)才能区分顺序。

## E285（cycle-56，P2）assertJsonValue 字符串**值**长度无上限 → 超大单字符串在 stringify(OOM 点)前不 fail-fast（E254 字符串值对偶）

- **问题**: `electron/shared/assert-json-value.ts:40`（string 分支 `if (t === 'string' || t === 'boolean') return;`）对字符串**值**无任何长度校验。`{value: 'x'.repeat(100_000_000)}` 过 assertJsonValue（仅检 number 有限/array 长/object key 数/key 长 E254，不检 string 值长），随后调用方 `JSON.stringify(data)` 把这个超大字符串再物化一遍（~2× 内存）。两处受影响：renderer `src/plugins/PluginDataStore.ts:18`（serializeWithinLimit）+ main `electron/main/services/plugin-data-store.service.ts:125`（save handler），均 assertJsonValue → JSON.stringify → utf8 字节上限（MAX_PLUGIN_DATA_BYTES 16MiB）—— stringify 在字节上限**之前**，故超大单字符串在 cap 生效前就制造巨大分配甚至 OOM（stringify 本身就是 OOM 点）。同 E183（数组长）/E184（对象 key 数）/E254（key 长）「在 stringify 前 fail-fast」族，字符串**值**是最后一个未覆盖维度（且数据值通常比 key 更大、更易触发）。
- **亲读**: assertJsonValue 已逐维度限 array 1M / object key 100k / key 长 8192，唯独 string 值无限。boundedValueDeepAdmissible（E259）也不限 string 值（非对象值直接 ok）。MCP schema（SCHEMA_BYTES_MAX 64KiB）/ invoke 结果（RESULT_BYTES_MAX 10MiB）/ plugin data（16MiB）三类调用方字节 cap 中最大 16MiB。
- **修复**: assertJsonValue string 分支加 `MAX_JSON_STRING_LEN = 16 * 1024 * 1024`（= 最大调用方字节 cap）上限，超限抛 `string too long`（错误消息只含长度不拼字符串本身，防错误串放大）。**取 16Mi code unit 不误伤**：任一 UTF-16 code unit ≥ 1 UTF-8 字节，故 len > 16Mi ⇒ 字节 > 16MiB ⇒ 必被任一调用方字节 cap 拒；提前在递归遍历时拒只是挡在 stringify 双倍物化之前（粗粒度 OOM 预闸），精确字节上限仍由各调用方在其后施加。单一来源 assertJsonValue 一处修同时覆盖 renderer + main + MCP schema + invoke 结果全部调用方。
- **测试**: assert-json-value-sparse.spec +E285（顶层/嵌套/数组里超大字符串值 → string too long；恰好 MAX_JSON_STRING_LEN → ok 边界包含;短串回归 ok）。同步把既有 E43 字节-cap 两测（plugin-data.spec / ipc-plugin-data-store.spec）的「单 16MiB+ 字符串触发字节 cap」改为「多段 1MiB 子上限字符串累加超 16MiB」—— 避开 E285 单值上限、仍命中字节 cap(/too large/)，保其原校验意图。neutralize：string 分支 `if(false&&...)` → E285 两测失败，恢复 4760 PASS。
- **沉淀**: **「在 stringify 前 fail-fast」族须覆盖序列化的每个维度**（数组长 E183 / 对象宽 E184 / key 长 E254 / **string 值长 E285** / 深度）—— 任一维度漏检都让对应病态输入在「stringify 后按字节 cap」生效前先 OOM；字符串**值**比 key 更易超大却最后才补。**单一来源 helper（assertJsonValue）一处加维度上限即覆盖所有调用方**（renderer/main/MCP/invoke 同享）。**全局粗粒度上限取值 = 最大调用方字节 cap**：因 UTF-16 len ≤ UTF-8 字节，按最大字节 cap 设 code-unit 上限永不误伤任何字节 cap 会接受的合法输入，精确上限仍由各调用方事后施加。**neutralize/测试既有字节-cap 测时须避开新上限**：用多段子上限元素累加触发字节 cap，否则新维度上限会抢先触发改变错误消息（行为仍正确但测试意图漂移）。

## E286（cycle-57，P2）`assertJsonValue → JSON.stringify → 字节 cap` 族:字节上限在 stringify 之后裁决 → 形态合法但「很多中等元素」的值序列化时 OOM（E283/E285 字节预算维度）

- **问题**: codex 报 `electron/shared/plugin-mcp-schemas.ts:114` `isInvokeResultAdmissible()`：`assertJsonValue(r)` → `JSON.stringify(r)` → `utf8BytesExceed(serialized, RESULT_BYTES_MAX 10MiB)`。assertJsonValue 只限**形态**（数组 1M / 对象 10万 key / key 长 8192 / string 值 16MiB E285 / 深度 256），远超 10MiB 字节 CAP。形态合法但「很多中等元素」（如 1M 元素数组、每个中等字符串）的序列化字节可远超 CAP —— 而字节上限是在 `JSON.stringify` **之后**才裁决，那个 stringify 已先把巨大字符串物化（stringify 本身=OOM 点，字节 cap 来不及）。E285 只堵了"单个超大字符串值"，本轮是"很多中等元素累加"的正交维度。
- **亲读 + grep 兄弟**: 同形 `assertJsonValue(x)` → `JSON.stringify(x)` → `utf8BytesExceed(...CAP)` 共 4 入口同族:result（schemas:114 isInvokeResultAdmissible，10MiB）/ schema（schemas:57 RegisterPayloadSchema jsonSchema，64KiB）/ plugin-data renderer（PluginDataStore.ts serializeWithinLimit，16MiB）/ plugin-data main（plugin-data-store.service.ts save，16MiB）。全部同一 OOM-before-cap 缺口。
- **修复（一 helper 收口 4 入口）**: 新建 `electron/shared/json-byte-budget.ts` `jsonByteLowerBoundExceeds(value, limit)` —— 在 stringify **之前**对序列化字节做**下界**估算并短路（string=2+utf8ByteLength 下界 / number=String(n).length / null|bool 常量 / 结构字符 [ ] { } : , 精确计；转义只增字节故 undercount 安全）。下界 > CAP ⇒ 真实字节必 > CAP（下界永不高估）⇒ 安全提前拒，**不改变 accept/reject 判定**（合法输入下界 ≤ CAP 时照常走其后精确 `utf8BytesExceed(JSON.stringify(...))` 裁决，且此时物化已被下界 ≤ CAP 限住，无 OOM）。4 入口各在 `assertJsonValue` 之后、`JSON.stringify` 之前插一道 `jsonByteLowerBoundExceeds(x, CAP)` fail-fast。
- **测试**: 新 topic `json-byte-budget`（9 测）：下界正确性（无转义 ASCII 与 `utf8ByteLength(JSON.stringify())` 逐一对齐，多上限）+ 下界永不高估（true ⇒ 真实 > limit，含转义/CJK）+ 永不误伤（≤limit → false）+ fail-fast（很多中等元素小上限提前判超限免大分配）+ **isInvokeResultAdmissible spy 测**（11×1MiB 字符串 → 拒，且 `vi.spyOn(JSON,'stringify')` **未被调用** = 证 stringify 前 fail-fast）+ 正常 result 回归 + 家族接线守卫（3 文件 readFileSync 断言引用 helper）。**neutralize 敏感**：`jsonByteLowerBoundExceeds` early `return false` → 下界正确性/fail-fast/spy 三测失败（spy 测捕获"落回下游 stringify 才拒"），恢复 4769 PASS。
- **沉淀**: **「stringify 后按字节 cap」是 OOM-before-cap 反模式 —— 字节上限须在 stringify 之前以下界 fail-fast**（assertJsonValue 形态上限 >> 字节 CAP，二者间塞下界预检）。**下界估算永不高估 ⇒ 用作"提前拒"不改判定**（与精确裁决等价但省 OOM）：string 取 2+原始 UTF-8 字节（转义只增）、结构字符精确、保留精确 stringify 作近边界裁决。**E285（单值长）与 E286（很多中等元素累加）是字节放大的正交两维**，形态族每补一维须回看其余维度。**校验顺序型 fix 的 neutralize**：outcome 相同（都拒），须 spy 下游（JSON.stringify 未被调用）证"提前路径"真触发（同 E283 内部路径断言）。**修一族 grep 全 4 入口一并接同一 helper + 家族接线守卫**，避免逐个续报（E279→E281 教训）。

## E287（cycle-58，P2，E286 family-incomplete 续捞:layout 路径 2 兄弟入口）`assertJsonValue → JSON.stringify → MAX_LAYOUT_BYTES cap` 同 OOM-before-cap 缺口

- **问题**: codex 报 `electron/main/ipc.ts:114` layout:write —— `assertJsonValue(layout)` → `JSON.stringify(layout)` → `utf8ByteLength > MAX_LAYOUT_BYTES (2MiB)`，与 E286 同形「字节上限在 stringify 之后裁决」。assertJsonValue 形态上限（16MiB layout）远超 2MiB，「很多中等元素」dockview layout 序列化时先物化巨串才被 2MiB cap 拒。E286 我 grep `utf8BytesExceed`/`RESULT_BYTES` 等命名只捞到 4 入口，**layout 路径用不同 cap 常量 `MAX_LAYOUT_BYTES` 故漏网**（E279→E281「family sweep 须按语义多模式 grep 不能只一种命名」教训复现）。
- **亲读 + grep 兄弟**: layout 族实为 **2 入口**:写端 `ipc.ts:114`（layout:write）+ 读端 `electron/main/lib/layout-read-guard.ts:23` `sanitizeReadLayout`（disk layout 读回守卫，`JSON.stringify(layout)` → `> MAX_LAYOUT_BYTES → return null`，同 stringify-before-cap）。
- **修复**: 两处各在 `JSON.stringify` 之前插 `jsonByteLowerBoundExceeds(layout, MAX_LAYOUT_BYTES)`（E286 既有 helper 复用）—— 写端超限 throw PAYLOAD_TOO_LARGE，读端超限 return null（走默认布局）。下界永不高估 ⇒ 判定与原字节 cap 等价，只省 stringify 物化。
- **测试**: json-byte-budget.spec +sanitizeReadLayout（很多中等 256KiB 元素累加超 2MiB → null，且 `vi.spyOn(JSON,'stringify')` 未被调用 = stringify 前 fail-fast；上限内 layout 原样返回回归）；家族接线守卫扩到 **5 文件**（+ipc.ts +layout-read-guard.ts）。中和=helper early `return false` → 含 layout spy 在内 4 测失败，恢复 4773 PASS。
- **沉淀**: **抽 shared helper（E286 jsonByteLowerBoundExceeds）后，family sweep 必按语义多模式 grep 全部「stringify-before-cap」入口**——不能只 grep 一种 cap 命名（utf8BytesExceed/RESULT_BYTES），layout 用 MAX_LAYOUT_BYTES + 读端 sanitizeReadLayout 内联 stringify，命名各异；**同一抽象的兄弟入口分散在不同 cap 常量/不同 helper 文件，须按"行为语义(assertJsonValue 后 stringify 再按字节 cap)"而非"符号名"枚举**（同 E279 漏 3→E280→E281 链）。换审计者捞 family-incomplete（我 E286 修 4 入口漏 layout 2 入口）= 最高价值。家族接线守卫扩到全 5 文件锁完整性。

## E288（cycle-59，P2，E286/E287 续捞第 6 入口:MCP host 通用输出边界）`JSON.stringify(result) → utf8BytesExceed(text, RESULT_BYTES_MAX)` OOM-before-cap + helper 任意输入安全化

- **问题**: codex 报 `electron/main/services/mcp-host.service.ts:356` —— tools/call 成功路径 `JSON.stringify(result)` → `utf8BytesExceed(text, RESULT_BYTES_MAX 10MiB)`（E267），同 E286 家族「字节上限在 stringify 之后裁决」。此路径**无前置 assertJsonValue**。plugin tool 结果已被 isInvokeResultAdmissible（E262/E265）限过，但**内置/未来注册的 tool 结果不走 bridge** → host 通用输出边界缺字节预算 fail-fast。「很多中等元素」结果序列化时先物化巨串才被 cap 拒。
- **亲读分流**: 内置 terminal tool 结果均 JSON-safe（条件展开省略 undefined 字段），plugin 结果已 JSON-safe。codex 建议「stringify 前 assertJsonValue + jsonByteLowerBoundExceeds」。**但不采纳 assertJsonValue**：会与 E120（top-level undefined = 空结果 → `''`，刻意设计）冲突（assertJsonValue(undefined) 抛 → 改成 error），且会把现有「嵌套非 JSON-safe 静默强转」改成 error（行为变更）。
- **修复**: 仅在 stringify 前插 `jsonByteLowerBoundExceeds(result, RESULT_BYTES_MAX)` fail-fast（不加 assertJsonValue，E120 + 既有强转行为不变，判定与下方精确字节 cap 等价）。**为此把 helper 改造成对任意输入安全**（host 路径无前置 assertJsonValue，输入可含 undefined/function/symbol/bigint/非有限数/循环引用）：精确复刻 JSON.stringify 省略/强转语义以保「下界永不高估」—— 非有限 number→"null"(4) / 数组里 undefined·function·symbol→"null"(4) / 对象里值为 undefined·function·symbol 的成员整段省略（key+值+逗号都不计，逗号按已输出成员计） / bigint 计 0（stringify 将抛,本 helper 不据此拒,交调用方抛） / 循环引用经深度上限保守判超限。helper **绝不抛错**。对 JSON-safe 输入（既有 5 入口）计数与改前一致（无新分支触发）。
- **测试**: json-byte-budget.spec +「任意输入安全」3 测（undefined/function/symbol/bigint/非有限数 → 返 boolean 不抛 + 复刻省略/强转语义下界对可序列化用例精确 true⇔real>limit + 非 JSON-safe 很多元素仍 fail-fast）；家族接线守卫扩到 **6 文件**（+mcp-host.service.ts）。中和=helper early `return false` → 6 测失败,恢复 4777 PASS。
- **沉淀**: **同一放大向量追到最外层输出边界**（plugin bridge 入口 cap 不护 host 通用边界 —— E262/E265 护 plugin 回包,E288 护 host 所有 tool 输出含内置/未来）。**fail-fast helper 用于无前置校验的边界时必须自身对任意输入安全**（不能假定 JSON-safe 前置条件）—— 复刻 JSON.stringify 省略/强转语义保持「下界永不高估」(undefined 对象成员省略、数组里→null、非有限→null、bigint 计 0 交 stringify 抛)，helper 绝不抛错。**采纳审计建议须分流与既有刻意设计的冲突**（codex 建 assertJsonValue 会反转 E120 空结果 + 改静默强转为 error → 只取字节 fail-fast 部分,弃 assertJsonValue 部分）。家族第 6 入口收口,接线守卫锁 6 文件。

## E289（cycle-60，P2，E286/E288 续捞第 7 入口:renderer 注册 pre-IPC schema 预检)`JSON.stringify(spec.jsonSchema) → utf8BytesExceed(serialized, SCHEMA_BYTES_MAX)` OOM-before-cap

- **问题**: codex 报 `src/plugins/registries/PluginMcpRegistry.ts:125` validateToolSpec —— renderer 注册 MCP tool 发 IPC **前**对 spec.jsonSchema 做 `const serialized = JSON.stringify(...)` → `utf8BytesExceed(serialized, SCHEMA_BYTES_MAX 64KiB)`（E130 pre-IPC 防放大对偶）。已有 boundedValueDeepAdmissible（E283）+ assertJsonValue（E105），但 **boundedValueDeepAdmissible 只限形态（数组≤65536/key≤1024/深度≤64),不限字符串值长/聚合字节** → `[16MiB 串]×65536`（E285 单串≤16MiB,数组≤65536）或 `{enum: 65536 个短串}`（~256KB）过形态闸 + assertJsonValue,在 64KiB 字节 cap 前先 JSON.stringify 物化巨串(OOM)。E286 我加了 main RegisterPayloadSchema(plugin-mcp-schemas.ts:57),但 renderer 这个**独立的 pre-IPC dual**(E130)用两行 `const serialized=JSON.stringify;utf8BytesExceed(serialized,...)` → E286 单行 grep `utf8BytesExceed(JSON.stringify(...))` 漏掉(同 E287 layout 多行 pattern 漏网)。
- **修复**: 在 `JSON.stringify(spec.jsonSchema)` 之前插 `jsonByteLowerBoundExceeds(spec.jsonSchema, SCHEMA_BYTES_MAX)`（E286 helper 复用,与 main RegisterPayloadSchema 同源)。
- **测试**: registry.spec +E289（`{enum: 65536 个短串}` ~256KB 过形态闸但聚合超 64KiB → INVALID_PARAMS + `vi.spyOn(JSON,'stringify')` 未被调用 = stringify 前 fail-fast）；家族接线守卫扩到 **7 文件**（+PluginMcpRegistry.ts）。中和=该行 `if(false&&...)` → registry E289 测的 spy 断言失败（stringify 被触达）,恢复 4779 PASS。
- **沉淀**: **boundedValueDeepAdmissible(形态闸)≠字节预算闸** —— 形态合法的「很多中等元素 / 大字符串值聚合」仍可使序列化字节远超 cap,二者是不同维度,凡 stringify-before-cap 都须**额外**加 jsonByteLowerBoundExceeds(形态闸只挡极端结构 CPU,不挡聚合字节 OOM)。**main schema 与 renderer pre-IPC dual 是同抽象两实装**(E128↔E130),改一处必同步另一处(收口同 helper)。多行 `const x=JSON.stringify;cap(x)` pattern 比单行 `cap(JSON.stringify())` 更易在 family grep 漏网 —— 按行为语义(序列化后按字节 cap)而非单行符号枚举(E287 layout / E289 registry 连续两轮同类漏网)。家族第 7 入口收口,接线守卫锁 7 文件。

## E290（cycle-61，P2，E279-E282 before-IPC 输入截断族）Explorer 新建/重命名 leaf 名输入无长度上限 → 超长 paste 撑 renderer state + 跨 IPC

- **问题**: codex 报 `src/panels/Explorer/CreateInput.tsx:88` —— 新建文件/文件夹的 leaf 名输入 `onChange={(e) => setValue(e.target.value)}` 把原值原样存入受控 React state,无长度上限。超长 paste → 巨值 controlled input 反复 re-render（renderer CPU/内存）+ Enter 后 trim 经 IPC 到 main,才被 leafNameRejectReason（E268/E274）拒。同 E279-E282「可粘贴进 state + 过 IPC 的输入须 onChange 截断」族。
- **亲读 + grep 兄弟**: leaf 名输入 2 处 —— CreateInput（受控 useState,主问题）+ FileRow.tsx 重命名输入（headless-tree `getRenameInputProps()` 管值,不进我方 state,但仍跨 IPC）。`leafNameRejectReason` 长度门是 >260（Win MAX_PATH），但 `FS_NAME_MAX=255` 是真实单组件 FS 上限（>255 名在 ext4/APFS/NTFS 都 ENAMETOOLONG 建不出）→ 截断到 255 不丢任何可创建的名。
- **修复**: CreateInput `onChange` 截断 `e.target.value.slice(0, FS_NAME_MAX)` + `maxLength={FS_NAME_MAX}`（原生键入/paste 双拦,且 Enter 读 `el.value` 也被 maxLength 限）；FileRow 重命名 Input 加 `maxLength={FS_NAME_MAX}`（headless-tree props 之后,原生兜底）。design Input 透传所有原生属性。
- **测试**: create-input.spec +E290 3 测（超长 paste → 受控 value 截断 255 / Enter 后 onSubmit 收 ≤255 / maxLength 属性=255）。中和=onChange 去 slice → 受控 value 截断 + onSubmit ≤255 两测失败,恢复 4782 PASS。
- **沉淀**: **before-IPC 截断族不止搜索 query/URL,也含 FS leaf 名输入**（凡可粘贴进 renderer state + 过 IPC 的输入都须 onChange 截断到后端验证上限）。**受控输入(useState)与库管输入(headless-tree)双拦**:受控用 onChange slice(保证)+maxLength(原生),库管用 maxLength(props 后置覆盖,原生)。**截断上限取真实 FS 单组件限 FS_NAME_MAX=255 而非验证器的宽松 260**:>255 名任何 FS 都建不出,截断不丢可创建的名,且与 drop-handlers failed.name 截断同源。

## E291（cycle-62，P1，E286 字节预算族 / 聚合维度）tools/list 无聚合字节上限 → 多 tool × 大 schema 累加成 MB 级响应 JSON.stringify OOM

- **问题**: codex 报 `electron/main/services/mcp-host.service.ts:270` tools/list —— 把全部已注册 tool 的 name/description/jsonSchema 聚合进单响应。每 tool 的 jsonSchema（SCHEMA_BYTES_MAX 64KiB）/ description（DESC_MAX）各有上限,tool 数也有上限（plugin-mcp-bridge MAX_TOOLS_GLOBAL=2048 / PER_WC=256,E236 族）,但**乘积**（2048 × ~64KiB ≈ 128MB）无聚合上限 → formatRpcResult() 的 JSON.stringify 产生 MB 级字符串经 HTTP/SSE/stdio transport 放大主进程内存。恶意插件批量注册接近上限的 schema 即可触发。P1(高于本 session 其它 P2)。
- **亲读**: tool 数确有上限(MAX_TOOLS_GLOBAL=2048),per-tool schema 确有上限(64KiB),但二者乘积无界。dispatchRpc 自身不 stringify（返 {result}|{error}），JSON.stringify 在下游 formatRpcResult。
- **修复**: tools/list 聚合数组返回前 `jsonByteLowerBoundExceeds(toolList, MAX_TOOLS_LIST_BYTES 16MiB)` fail-fast,超限返 `RPC_ERROR_CODES.RESULT_TOO_LARGE`(-32003,新增,落 JSON-RPC 自定义 -32xxx 区)而非物化巨响应（同 E266/E267「too large → 有界错误」+ E286 字节下界 fail-fast）。16MiB 远高于任何真实 tool 集的 KB 级 tools/list（2048 tool × ~2KB ≈ 4MB < 16MiB < 恶意 128MB),仅挡恶意批量超大 schema。
- **测试**: dispatcher.spec +E291（20×1MiB schema tool ≈ 20MiB → error RESULT_TOO_LARGE / 正常小 schema tool 集 → result 回归）。outcome 神经敏感(去 fail-fast 则返 result 而非 error)。中和=该行 `if(false&&...)` → E291 error 测失败,恢复 4784 PASS。
- **沉淀**: **字节预算族的聚合维度** —— 单元素有上限 + 元素数有上限 ≠ 聚合有上限（乘积可远超单响应可承受字节）；凡「把 N 个各自有界的元素聚合进单响应/单序列化」都须**额外**加聚合字节 fail-fast（tools/list 是 E286 family 的聚合变体,继 E285 单值 / E286 多元素 / E289 形态闸之后的第四个正交维度）。聚合上限取值须远高于真实最大集(2048×2KB≈4MB)、远低于恶意最坏(128MB),16MiB 清晰分隔。dispatchRpc 本身不 stringify(下游 formatRpcResult 才 stringify),故 fail-fast 必在 dispatcher 返 result 前拦。

## E292（cycle-63，P2，E167/E174 同款 IPC-ingress 纵深防御 / 数量维度）renderer 终端会话 ingress 无数量上限

- **问题**: codex 报 `src/shell/dock/TerminalSessionsSync.tsx:73` —— renderer 收 main 推的 listSessions / sessions_changed sessions 数组,经 `filterByOwnerWindow`（terminal.store）过滤。该函数 `for (const s of sessions)` O(n) 全量遍历,有逐元素形态守卫（E167/E174）但**无数组长度上限**。main 已按 `MAX_TERMINAL_SESSIONS_GLOBAL=256` 双闸封顶真实会话(E235),但有 bug / 被篡改的 main 推超大数组时,renderer 无界遍历 + 入 store + 渲染 n 个 tab → 拖垮 renderer。
- **亲读**: filterByOwnerWindow 是两 ingress 路径(初始 listSessions + 实时 sessions_changed)共用函数。`MAX_TERMINAL_SESSIONS_GLOBAL` 是 main terminal-sessions.service.ts 本地 const,renderer 无对应上限。E174 已给同入口加 Array.isArray 守卫(形态),本轮补数量维度。
- **修复**: 常量移到 shared/terminal-session-limits.ts(main 双闸 + renderer ingress 单一来源,同 E203/E20 模式),main 改 import。filterByOwnerWindow 加计数闸:`processed >= MAX_TERMINAL_SESSIONS_GLOBAL` 时发一次 `over-capacity` drop(FilterDropOpts.onDrop 新增此 reason)并 **break**（不遍历病态超大数组余项 —— 全局合法 ≤256 必在前 256 内,break 不丢任何合法会话,只有异常 main 推超额才触发）。warnOnDrop 既有逻辑按 key 去重 console.warn。
- **测试**: filter-pure-fn.spec +E292（超 MAX+50 → 截断到 MAX + over-capacity drop 一次 / 恰好 MAX → 全保留不误触）。中和=计数闸 `if(false&&...)` → 超额测 length≠MAX 失败,恢复 4786 PASS。
- **沉淀**: **IPC-ingress 纵深防御的数量维度** —— renderer 对 main 推的数组不仅要逐元素形态守卫(E167/E174)还要**长度上限**（main 是真相源但「有 bug/被篡改的 main」是既定防御模型,同 E168-E174 族）。**计数闸用 break 而非 continue**：continue 仍 O(n) 遍历病态数组,break 才真正 bound 工作量;break 安全前提是「合法全集 ≤ cap 必在前 cap 个内」(全局会话 ≤256)。main 资源上限常量须 shared 化让 renderer ingress 复用同值作镜像闸(单一来源防漂移)。

## E293（cycle-64，P2，E290 同族 / before-store 输入截断）text 设置值 Input 无 maxLength/onChange 截断

- **问题**: codex 报 `src/plugins/settings/SettingItemRow.tsx:123` —— text 类型设置的 Input `onChange={(e) => setValue(spec.id, e.target.value)}` 无长度上限。值上限 `SI_TEXT_VALUE_MAX=64KiB`。超长 paste 瞬时进 DOM 原生值 + onChange 事件 + setValue 调用链(同 E290 Explorer leaf 名 UI-transient)。
- **亲读**: values-store.setValue 已截断 text 到 MAX_SETTING_TEXT_LEN(=SI_TEXT_VALUE_MAX,E142/E241)→ **持久层安全**。本轮缺口是 UI-transient:Input 无 maxLength、onChange 无 slice → 超大 paste 瞬时物化在 DOM/事件/setValue 入参(到 store 才截断)。
- **修复**: Input 加 `maxLength={SI_TEXT_VALUE_MAX}`(原生拦键入/paste)+ onChange `.slice(0, SI_TEXT_VALUE_MAX)`(兜底),与 CreateInput leaf 名 E290 同款 UI-transient 防御。SI_TEXT_VALUE_MAX 已存在(SettingItemRegistry 导出,values-store 已用)。
- **测试**: setting-item-row.spec +E293（maxLength 属性 = SI_TEXT_VALUE_MAX / 超长 paste 后最终值 ≤ 上限回归）。**neutralize 敏感取 maxLength 断言**(原 Input 无 maxLength → jsdom input.maxLength=-1;store-length 不敏感因 store 也截断)。中和=去 maxLength+slice → maxLength 测失败,恢复 4788 PASS。
- **沉淀**: **持久层已截断 ≠ UI-transient 已防** —— 即便 store/持久层有写入截断(E142/E241),受控输入仍须 maxLength + onChange slice 挡超长 paste 瞬时物化在 DOM/事件/调用链(E290 leaf 名同款)。**neutralize 信号须选「仅本修生效」的断言**:store 也截断时 stored-length 两路同值不敏感,应断言 UI 层独有的 maxLength 属性(原本无 → jsdom -1)。before-IPC/before-store 输入截断族成员:搜索 query(E279-281)/git URL(E282)/FS leaf 名(E290)/text 设置值(E293)。

## E294（cycle-65，P2,E253/E250 fresh↔cache-read 长度对偶）fresh review url/avatarUrl 无长度上限

- **问题**: codex 报 `src/marketplace/reviews-parser.ts:93` —— parseReview(fresh GraphQL/IPC 路径)对 raw.url / raw.author.avatarUrl 只 `isHttpUrl()` scheme 白名单(E143),**无长度上限**。cache-read(isValidReview,reviews-types.ts)用 `isStrMax(url, REVIEW_URL_MAX 2048)` 限长,fresh 不对偶 → 合法 scheme 的超长 URL(`https://`+巨串)首次拉取绕过,进 review cache + 渲染 `<a href>`/`<img src>` + `new URL()` 放大。
- **亲读**: reviews-parser 已建立 fresh↔cache-read 校验对偶(E250 元素守卫 / E253 createdAt/version/thumbsUp 长度+类型),但 url/avatarUrl 长度漏了。cache-read REVIEW_URL_MAX=2048(reviews-types.ts:52 本地 const)。
- **修复**: reviews-types.ts 导出 REVIEW_URL_MAX(parser 已从该模块 import isGitHubLogin,复用同源),parseReview 的 url/avatarUrl 校验加 `.length > REVIEW_URL_MAX` 长度上限(与 cache-read isStrMax 同值同源)。
- **测试**: reviews-parser.spec +E294（超长 https url / avatarUrl → null / 恰好 REVIEW_URL_MAX → 解析成功边界包含）。中和=两处 `.length > REVIEW_URL_MAX` 改 `false &&` → 两超长测失败,恢复 4791 PASS。
- **沉淀**: **fresh-fetch ↔ cache-read 校验对偶须逐字段逐维度齐**(scheme + 长度 + 类型 + 数值有限性)—— 同一字段在 cache-read 限长(isStrMax)而 fresh 只校 scheme = 首拉绕过面;同 E143(scheme 对偶)/E250(元素守卫对偶)/E253(类型长度对偶),URL 长度是本文件该族最后一个漏补的维度。常量在一端 local 时导出给对端复用同源(parser 已 import 该模块,零新依赖)。fresh↔cache-read 长度对偶族延续:E237/E240/E241/E243/E245/E250/E253/E294。

## E295（cycle-66，P2,HTTP request-target 解析）MCP HTTP server req.url 无显式长度上限 + split('?') 物化所有分段

- **问题**: codex 报 `electron/main/services/mcp-host.service.ts:795` —— HTTP MCP server `(req.url ?? '/').split('?')[0]` 取 path。req.url 来自本机 HTTP client(Origin/Host 校验后本机进程仍可任意构造 request-target)。无显式长度上限,且 `split('?')` 物化所有 `?`-分段(只用第一段)。
- **亲读分流**: Node 默认 `maxHeaderSize` ~16KB 已**隐式封顶**整个 header 块(含 request-line),故 req.url 实际 ≤~16KB,非真实 OOM/DoS —— 但显式 414(URI Too Long)上限**不依赖 Node 配置**(他处调高 maxHeaderSize 仍有界)+ `indexOf/slice` 替代 `split('?')`(避免物化分段数组)是 config-independent 纵深防御 + 更省解析。属低价值但有效硬化,采纳。
- **修复**: 抽纯函数 `parseHttpRequestTarget(rawUrl)` 返 `{tooLong, path}` —— 超 `MAX_REQUEST_TARGET_LEN=8192` → tooLong(handler 回 414);否则 indexOf('?')+slice 去 query。HTTP handler 用之(tooLong→414)。纯函数单测覆盖(HTTP wiring 留 E2E,遵本文件「纯函数契约层单测」既定模式)。
- **测试**: host.spec +E295（path 无 query / 带 query 去尾 / undefined→"/" / 多 ? 只第一处截断 / 超 MAX→tooLong / 恰好 MAX→不 tooLong 边界）。中和=length guard `if(false&&...)` → 超长测失败,恢复 4797 PASS。
- **沉淀**: **显式上限优于隐式平台上限**(Node maxHeaderSize 隐式封顶 req.url,但显式 414 不随平台配置漂移)。**`split(sep)[0]` 取前缀反模式**:物化所有分段只用第一段 → 用 `indexOf(sep)+slice(0,i)` 单分配(输入越大差距越大;此处虽 ≤16KB 仍是更优解析)。**不可单测的 HTTP wiring 把可测逻辑抽纯函数**(parseHttpRequestTarget)单测覆盖、wiring 留 E2E(本文件既定分层)。codex 误报率非零但本项是低价值真硬化非误报。

## E296（cycle-67，P2,同步异常绕过异步 .catch 反馈契约）popoutUrlFor new URL 非 total

- **问题**: codex 报 `src/lib/popout-mode.ts:20` —— `popoutUrlFor(baseHref)` 的 `new URL(baseHref)` 无 try/catch。调用点 `HeaderActions.tsx:107` 把 `popoutUrlFor(window.location.href)` **同步**构造进 `addPopoutGroup(...)` 参数,早于 Promise 创建 → 若 popoutUrlFor 同步抛,会**绕过**调用点 `.catch(...)→notify.error`(A50 弹出失败反馈契约),成未处理异常。
- **亲读分流**: 唯一调用方传 `window.location.href`(浏览器保证必合法绝对 URL)→ `new URL` 实际不抛 = 触发**当前不可达**。但 popoutUrlFor 是导出工具,其 throw 行为影响调用点错误处理契约;且「同步异常绕过异步 .catch」是真实-原则性契约缺口(E-A50 刻意加的 .catch 反馈对同步构造步骤无效)。低价值但有效硬化,采纳(令导出工具 total)。
- **修复**: `new URL` 包 try/catch,不可解析 → 原样返回 baseHref(令 popoutUrlFor **total 永不抛**)。畸形 URL 会在 addPopoutGroup 异步失败 → 调用点 .catch 统一反馈(A50 契约恢复覆盖)。query 长度闸(E195)保持。
- **测试**: popout-mode.spec +E296(不可解析 baseHref → 原样返回,不抛)。中和=catch 分支改 rethrow → E296 测失败,恢复 4798 PASS。
- **沉淀**: **同步构造异步调用参数的函数若抛,会绕过该异步调用的 .catch 错误处理**(`api(buildArg()).catch()` 中 buildArg() 同步抛 → api 未调 → catch 不触发)→ 这类参数构造函数应 total(永不抛)或调用点把构造也纳入 try。**导出工具函数的 throw 行为是其契约**(即便当前输入保证合法,total 化防未来/异常调用方 + 让调用点错误处理统一)。reachability 不可达不等于不修:契约缺口 + 低成本 total 化值得(同 E295 低价值真硬化)。

## E297（cycle-68，P2,E252 同一 stdio hello payload 兄弟字段）hello token 无长度上限

- **问题**: codex 报 `electron/main/services/mcp-stdio-server.service.ts:63` —— `resolveStdioHelloWindowId` 的 `_continuo/hello` payload token 校验仅 `typeof string && length>0`,**无上限**。host token 由 generateToken(32 字节 base64url = 43 字符)生成,合法 token 远短。不可信 stdio client 可在 1MB 行(MAX_STDIO_LINE_BYTES)内塞超长 token → 进 `deps.resolveWindowId(token)`(Map.get/比较)放大 CPU/内存。
- **亲读**: 同函数 windowId 已 E252 收口(安全非负整数),token 是同一不可信 hello payload 的兄弟字段,长度上限漏了。HTTP 侧 verifyBearer 靠 `token.length !== expected.length` 早短路天然限长,stdio resolveWindowId 路径无此早闸。
- **修复**: 加 `MAX_HELLO_TOKEN_LEN=256`,token 校验追加 `token.length > MAX_HELLO_TOKEN_LEN → null`(超长不进 resolveWindowId)。
- **测试**: framing.spec +E297（超长 token > 256 → null 且 resolveWindowId 不被调用）。中和=长度上限 `(false && ...)` → 进 resolveWindowId 返 11,E297 测失败,恢复 4799 PASS。
- **沉淀**: **同一不可信 payload 的所有字段都要逐一收口**(E252 修 windowId 时 token 同 payload 兄弟字段漏限长 —— 修一字段须 grep 同 payload 其余字段);**比较/查找前先限 key 长度**(resolveWindowId(token) 的 token 是 Map key/比较输入,超长 key 放大,先 length cap 再查);HTTP 与 stdio 双传输同概念(token)校验须等强(verifyBearer 靠 length-mismatch 早短路隐式限长,stdio 须显式 cap)。stdio hello 不可信 payload 族:E252 windowId / E297 token。

## E298（cycle-69，P2,外部响应回灌出站请求）GraphQL endCursor 无长度上限

- **问题**: codex 报 `electron/main/services/marketplace-reviews.service.ts:198` —— 翻页 `pageInfo.endCursor` 仅 `typeof === 'string'` 校验,**无长度上限**,随后 `after = endCursor` 回传进**下一页请求 body**(`JSON.stringify({ variables: { after } })` 发给 GitHub)。畸形/被篡改/MITM 的 GraphQL 响应可塞超大 endCursor → 撑大出站请求体。
- **亲读**: 同文件 review 字段已用 clampStr(REVIEW_URL_MAX/REVIEW_FIELD_MAX)截断,但 cursor 是**不透明分页 token**(GitHub 实际 ~数十字符)**不能截断**(截断会损坏分页 → 错页/死循环风险)。故须「超限即停止翻页」而非截断。
- **修复**: 加 `MAX_CURSOR_LEN=2048`,`if (typeof endCursor !== 'string' || endCursor.length > MAX_CURSOR_LEN) break`(超大 cursor → 停止翻页,已收到页仍可用,不发出超大 cursor)。
- **测试**: security-marketplace-token-main.spec +E298（page1 hasNextPage=true + endCursor 2049 字符 → fetch 仅 1 次、只返 page1 nodes;既有「分页」测覆盖正常 c1 续拉回归）。中和=长度上限 `(false&&...)` → 用超大 cursor 续拉第二页(fetch 2 次),E298 测失败,恢复 4800 PASS。
- **沉淀**: **外部响应中「会回灌进下一次出站请求」的字段须限长**(endCursor/分页 token/续传游标 —— 响应→请求的闭环放大面);**不透明 token 不能截断只能拒/停**(截断破坏语义,区别于可截断的展示字段 clampStr)—— 按字段是否语义可截断分流:可截断(URL/handle clampStr)vs 不可截断(cursor/token break-or-reject)。外部数据回灌出站是独立于「读端校验」的放大向量(数据安全审计补充维度)。

## E299（cycle-70，P2,启动崩溃防御）dev 渲染 URL new URL 无 try/catch

- **问题**: codex 报 `electron/main/index.ts:356` —— createMainWindow dev 分支 `new URL(process.env['ELECTRON_RENDERER_URL'])` 无 try/catch。env 缺失/畸形(开发误配)→ new URL 同步抛 → createMainWindow 崩溃 → 应用启动无窗口。
- **亲读分流**: ELECTRON_RENDERER_URL 由 electron-vite 注入(dev 必为合法 URL),生产 packaged isDev=false 走 file 分支 → 实际崩溃近不可达。但 env 是外部可误配输入,且「同步抛崩溃启动关键路径」无回退是真实健壮性缺口。低价值但有效硬化,采纳(同 E296/E295 total 化)。
- **修复**: 抽纯函数 `parseDevRendererUrl(rawUrl)` 到 spike-gate.ts(既有可测纯 helper 模块,index.ts 顶层 electron 副作用不可单测导入)—— 缺失/畸形 → null(total 不抛);createMainWindow `devUrl = isDev ? parseDevRendererUrl(env) : null`,devUrl 为 null 回退 `loadFile`(与原 else 分支同)。行为等价,仅畸形 env 从崩溃改为回退。
- **测试**: spike-gate.spec +E299(合法 URL→URL 实例 / 缺失/空/畸形→null 不抛)。中和=catch 改 rethrow → 畸形测失败,恢复 4802 PASS。
- **沉淀**: **启动关键路径(createMainWindow)的 new URL/解析须 total 化 + 回退**,不可同步抛(否则应用启动无窗口=最严用户影响);env 变量是外部可误配输入(虽 dev 工具注入合法,误配/CI 环境差异可触发);**index.ts 等顶层 electron 副作用文件不可单测,可测逻辑抽到 spike-gate.ts 等纯 helper 模块**(同 layout-read-guard E89 从 ipc.ts 抽出)。total 化 new URL 族:E296 popoutUrlFor / E299 dev renderer URL(+ E298 endCursor 是 length-guard 非 try/catch,不同手段同族)。

## E300（cycle-71，P2,E184 同款「校验前勿全量物化 key 数组」)bounded preflight 用 Object.keys 先物化再判数

- **问题**: codex 报 `electron/shared/bounded-input.ts:31` —— `boundedObjectAdmissible` 用 `Object.keys(rawInput)` 在判 key 数 MAX_BOUNDED_OBJECT_KEYS 之前先**全量物化** key 数组。该 helper 是 zod safeParse 前的**廉价 preflight**(E255-E258),但百万-key payload 会先分配百万元素 key 数组才 reject —— preflight 自身放大,违背「比 zod 更便宜」初衷。boundedValueDeepAdmissible 对象分支(line 78)同。
- **亲读 + 与 E221 分流**: E221 曾对 assert-json-value 提议 for...in 被 DEFER(因 assert-json-value 须 Reflect.ownKeys 看 symbol/非枚举满足 E140/E200 数据完整性契约,for...in 看不到)。但 bounded-input 是**纯数量/长度闸**,不需检测 symbol/非枚举(zod .strict() 也只枚举可枚举 string key)→ for...in + hasOwnProperty 与 Object.keys/zod 枚举语义一致,此处安全(关键差异:无 E140/E200 契约)。
- **修复**: 两函数改 `for (const k in obj) { if (!hasOwnProperty.call(obj,k)) continue; count++; if (count>MAX) return too-many-keys; if (k.length>MAX_LEN) return key-too-long; ... }` —— 边数边查 + 早停(超限立即返回,不再遍历;不物化 key 数组)。hasOwnProperty 过滤继承属性,保持 Object.keys 自有-only 语义。
- **测试**: shared-helper.spec +E300（boundedObjectAdmissible / boundedValueDeepAdmissible 各:海量继承可枚举属性 + 1 自有 key → ok,继承不计)。**neutralize 敏感取 hasOwnProperty**:漏 hasOwnProperty 则 for...in 误计海量继承 key → too-many-keys,E300 测(期望 ok)失败。中和=两处 `if(false&&!hasOwnProperty)` → 2 测失败,恢复 4804 PASS。既有 reason(too-many-keys/key-too-long/ok/deep)测全保持(无 combined 用例,reason 优先级不受影响)。
- **沉淀**: **「校验数量/长度前勿先全量物化集合」**(Object.keys/Array.from 在 count 检查前分配全量数组 → preflight 自身放大;改增量迭代 + 早停,同 E183 数组 length-cap-before-iterate / E184 单次 Reflect.ownKeys)。**for...in vs Reflect.ownKeys 按契约分流**:纯数量/长度闸(bounded-input)用 for...in+hasOwnProperty(早停、不物化);须检 symbol/非枚举的数据完整性校验(assert-json-value E140/E200)必 Reflect.ownKeys(E221 DEFER)—— 同一「避免物化」诉求因契约不同结论相反。behavior-preserving 重构 neutralize 取「保持旧语义的关键步骤」(hasOwnProperty=Object.keys 自有-only 语义)而非 outcome。

## E301（cycle-72，P2,E300 自引入对偶)json-byte-budget object 分支用 Object.keys 物化 key

- **问题**: codex 报 `electron/shared/json-byte-budget.ts:88` —— `jsonByteLowerBoundExceeds` 的 object 分支用 `Object.keys(obj)` 物化 key 数组。该 helper 本身是字节预算 fail-fast OOM 守卫(E286/E288,mcp-host tool result 等用),却在 byte budget 超限前先全量物化 key 数组 = 自相矛盾。E300 刚在 bounded-input 修同款,但我 E286/E288 建的这个 helper 是**自引入同模式漏网**。
- **亲读**: 同 E300 —— 此 helper 须匹配 JSON.stringify 枚举(自有可枚举 string key),for...in + hasOwnProperty 与 Object.keys/JSON.stringify 一致,无 symbol/非枚举检测需求,安全。
- **修复**: object 分支改 `for (const k in obj) { if (!hasOwnProperty.call(obj,k)) continue; ... }` + 既有 exceeded 早停 —— 不物化 key 数组、byte budget 超限即停。hasOwnProperty 保持自有-only(JSON.stringify 不序列化继承属性)。
- **测试**: json-byte-budget.spec +E301（继承可枚举属性不计入,下界判定与 JSON.stringify(own-only) 一致）。中和=hasOwnProperty `if(false&&...)` → 继承 key 计入抬高下界 → E301 测失败,恢复 4805 PASS。
- **沉淀**: **抽 helper 时自身也要守同族纪律**(E300 在 bounded-input 修「Object.keys 物化」,我 E286/E288 建的 json-byte-budget 同模式自引入漏网 → codex 续捞)—— 修一族(校验前勿物化集合)须 grep 全仓同模式含**本 session 新建的 helper**;fail-fast/OOM 守卫 helper 内部尤其不能有物化反模式(自相矛盾)。换审计者捞自引入(E300→E301 同模式我新 helper)= 最高价值。for...in+hasOwnProperty vs Reflect.ownKeys 按契约分流同 E300。

## E302（cycle-73,P2,低价值真硬化 / E299 续)parseDevRendererUrl new URL 前无长度上限

- **问题**: codex 报 `electron/main/spike-gate.ts:62` —— E299 的 parseDevRendererUrl 有 try/catch(total)但 new URL(rawUrl) 前无长度上限。
- **亲读分流**: rawUrl 来自 ELECTRON_RENDERER_URL(dev-only、electron-vite 注入、开发误配、OS env 上界、解析一次),非攻击面;new URL 对 OS-bounded 串解析仅微秒级,无 OOM → **极低价值**。但「new URL 前限长」与 cap-before-parse 纵深一致(E295 req.url / E298 endCursor),且明确上界、definitively 闭合本观察,采纳为低价值硬化。
- **修复**: `MAX_RENDERER_URL_LEN=8192`,parseDevRendererUrl 入口 `rawUrl.length > MAX → null`(new URL 前)。任何真实 dev renderer URL ~数十字符远在内。
- **测试**: spike-gate.spec +E302(超 8192 → null)。中和=长度上限 `(false&&...)` → 超长测失败,恢复 4806 PASS。
- **沉淀**: **cap-before-parse 一致性**(new URL/parse 前先限长,即便输入 OS-bounded 非攻击面 —— 明确上界 + 不随输入来源漂移);dev-only/developer-controlled 输入是低价值硬化(非真威胁),但 codex 续捞自建 helper 的细化(E299→E302)以「闭合观察 + 一致性」采纳。区分:此类低价值硬化 vs 真 bug —— 都修但 doc 标注价值层级(同 E295/E296/E299)。

## E303（cycle-74,P2,E302 兄弟入口 / dev URL 解析 family sweep 漏网)defaultIsTrustedFrame expected 无长度上限

- **问题**: codex 报 `electron/main/safe-handle.ts:199` —— defaultIsTrustedFrame(IPC frame 信任门)dev 分支 `new URL(expected)`(expected=ELECTRON_RENDERER_URL)。frame.url 已限长(E196,line 193)且 new URL 已在 try/catch(fail-closed),但 **expected 无长度上限** —— 每次 IPC 调用都 new URL 解析 expected 一次,开发误配/OS 上界超长 env 被反复 O(N) 解析。这是 E302(我刚加 parseDevRendererUrl 限长)的**同 env 兄弟入口**,E299 时未 grep 全 `new URL(ELECTRON_RENDERER_URL)` 站点漏掉。
- **亲读**: new URL(expected) 已 try/catch(total,缺失/畸形→false),仅缺长度上限。expected 是 dev env(developer-controlled/OS-bounded),但 defaultIsTrustedFrame 每 IPC 调用执行 = 反复解析放大面。
- **修复**: `if (!expected || expected.length > MAX_WINDOW_URL_LEN) return false`(对齐同函数 frame.url 的 MAX_WINDOW_URL_LEN=65536 闸,任何真实 dev URL 远在内,fail-closed)。最小对称修,不引 parseDevRendererUrl 跨模块依赖(MAX_WINDOW_URL_LEN 已在 scope)。
- **测试**: safe-handle.spec +E303(expected 超 MAX_WINDOW_URL_LEN → false,即便 origin 本会匹配)。中和=expected 限长 `(false&&...)` → origin 匹配返 true,E303 测失败,恢复 4807 PASS。
- **沉淀**: **同一 env / 同一外部值的所有解析入口须 family-sweep 一并限长/total**(E299 修 index.ts parseDevRendererUrl 时漏 safe-handle.ts:199 同 env 第二入口 —— grep `new URL(ELECTRON_RENDERER_URL)` / `process.env['ELECTRON_RENDERER_URL']` 全站点);**每 IPC 调用执行的函数内的 new URL 反复解析比一次性更值得限长**(frame.url 已限,expected 对称补齐);换审计者捞 family-sweep 漏网(E302→E303 同 env 兄弟)= 最高价值。dev URL 解析族:E299 parseDevRendererUrl total / E302 其长度上限 / E303 safe-handle expected 长度上限。

## E304（cycle-74 后主动 family-sweep,P2,dev URL 解析第三入口)windowOpenHandler new URL(env) 无长度上限

- **问题(主动发现非 codex 报)**: 修 E303 后我 grep 全 `new URL(ELECTRON_RENDERER_URL)` / `process.env['ELECTRON_RENDERER_URL']` 站点,发现 `electron/main/index.ts:236` windowOpenHandler dev 分支 `new URL(process.env['ELECTRON_RENDERER_URL'] ?? '')` —— 同 dev URL 解析族第三入口(前两:E299/E302 parseDevRendererUrl、E303 safe-handle)。在 try/catch 内(不崩),但 env 无长度上限,每次弹窗解析一次无界 OS env。
- **修复**: 复用 parseDevRendererUrl(限长 MAX_RENDERER_URL_LEN + total),`rendererUrl = parseDevRendererUrl(env); allow = rendererUrl !== null && target.origin === rendererUrl.origin`。与 createMainWindow(E299)/safe-handle(E303,用 MAX_WINDOW_URL_LEN)三入口现单一来源/同闸。行为保持(unset/畸形→deny 同旧;valid→同 origin)+ 加 env 长度上限。
- **测试**: windowOpenHandler 是 index.ts 内联 E2E-only handler(不可单测),其 cap+total 契约由 parseDevRendererUrl 自身测(E299/E302)覆盖;typecheck + 全量 test 4807 PASS 无回归验证 wiring。
- **沉淀**: **family-sweep 应主动 grep 穷尽同模式所有入口,不被动等审计者逐个续报**(E299 漏 safe-handle→codex E303 续报;我借 E303 主动 grep 提前找到 index.ts 第三入口 E304,免 codex 下一轮 E304 续报)—— 修一族(同 env/外部值多解析入口)当轮 grep `new URL(X)` / `process.env['X']` 全站点一并收口同 helper。这是「换审计者捞 family-sweep 漏网」教训的主动践行:与其等 codex 逐个报,不如收到一个族成员就 grep 全族。dev URL 解析族闭合:E299 total / E302 cap / E303 safe-handle / E304 windowOpenHandler。

## E305（cycle-75，P2,E283 校验顺序 fail-fast / reorder 非 tighten)isInvokeResultAdmissible assertJsonValue 在字节 fail-fast 之前

- **问题**: codex 报 `electron/shared/plugin-mcp-schemas.ts:124` —— isInvokeResultAdmissible 先 `assertJsonValue(r)`(全量遍历,形态上限 1M/10万/256)再 `jsonByteLowerBoundExceeds`(字节 fail-fast)。超 RESULT_BYTES_MAX(10MiB)但 shape 合法(≤assertJsonValue 上限)的 result 会被 assertJsonValue 完整遍历后才被字节 cap 拒。
- **亲读 + 分流(不采纳 codex 字面建议)**: codex 建 assertJsonValue 前加 `boundedValueDeepAdmissible(r)` —— 但那会**收紧 accept set**(深度 256→64 / 数组 1M→65536),误拒当前合法的深/大 result(plugin tool 可返 7 万元素数组等)。**改用 reorder**:把已有的 jsonByteLowerBoundExceeds 挪到 assertJsonValue **之前**(E288 已使其对任意输入安全,可先于 assertJsonValue 跑)。行为保持(超限两序皆 false;非 JSON-safe ≤上限时仍由其后 assertJsonValue 拒;循环引用 jsonByteLowerBound 深度闸 / assertJsonValue 任一拒)+ 字节 fail-fast 在前(超限不再 assertJsonValue 全量遍历)。
- **测试**: 新 spec invoke-result-order(mock assert-json-value spy assertJsonValue:超限 result→拒且 assertJsonValue **不被调用**;上限内→assertJsonValue 调用一次)。行为保持故 neutralize 取「顺序」(spy assertJsonValue 调用与否),非 outcome。中和=order back(assertJsonValue 先)→超限测的 spy 断言失败,恢复 4809 PASS。
- **沉淀**: **校验顺序 fail-fast 优先 reorder 既有检查而非加收紧的新检查**(codex 建 boundedValueDeepAdmissible 会改 accept set;reorder jsonByteLowerBoundExceeds 既 fail-fast 又保 accept set —— 同诉求两解,选不改契约者)。**behavior-preserving reorder 的 neutralize 取「内部顺序」**(spy 早检查应触达、晚检查不触达),outcome 两序相同不可分;mock 依赖模块 spy 被绕过的昂贵步骤(assertJsonValue)是验「fail-fast 在前」的手段(同 E283/E286 stringify spy)。采纳审计「问题方向」对但「建议手段」会引入回归时,取等效不改契约的修法并 doc 记分流。

## E306（cycle-76，P2,E305 reorder 同族 / plugin-data 两入口)serializeWithinLimit + service save assertJsonValue 在字节 fail-fast 之前

- **问题**: codex 报 `src/plugins/PluginDataStore.ts:19` serializeWithinLimit（+ main `plugin-data-store.service.ts:126`）—— assertJsonValue(data) 全量遍历在 jsonByteLowerBoundExceeds 字节 fail-fast 之前。超 MAX_PLUGIN_DATA_BYTES(16MiB)但 shape 合法(≤assertJsonValue 1M/10万/256 上限)的 data 被 assertJsonValue 完整遍历后才被字节 cap 拒。E305 刚 reorder 了 result 路径,这是 plugin-data 族两入口的同款。
- **修复(reorder,同 E305)**: 两处把 jsonByteLowerBoundExceeds 挪到 assertJsonValue 之前(E288 已使其对任意输入安全)。renderer serializeWithinLimit + main service save。
- **行为分流**: 仅「既非 JSON-safe 又超限」的病态输入,错误从 assertJsonValue 的报错(renderer 通用 Error / main BAD_INPUT)变 too-large(renderer Error / main PAYLOAD_TOO_LARGE)—— 两者皆拒(write 失败),无现实差异,且单-bad 输入(仅超限 或 仅非JSON-safe)行为完全不变。全量 test 验无回归。
- **测试**: 新 spec plugin-data/serialize-order(mock assert-json-value:超限 data→拒且 assertJsonValue 不被调用;上限内→调一次)。中和=order back→超限测 spy 断言失败,恢复 4811 PASS。
- **沉淀**: **校验顺序 fail-fast 的 reorder 是跨入口族**(E305 result→E306 plugin-data renderer+main —— 一处 reorder 后须 grep 全 `assertJsonValue → jsonByteLowerBoundExceeds` 同序兄弟一并 reorder);**reorder 改 both-bad 错误码/消息是可接受的行为分流**(both-bad 病态输入两者皆拒,单-bad 不变,无现实差异 + doc 记)—— 区别于 E305 result 路径返 boolean 无错误码故纯保持;family-sweep reorder 同 E300/E301 物化族(一族修法须扫全兄弟)。

## E307（cycle-76 后主动 family-sweep,P2,reorder 同族第三/末入口)jsonSchema superRefine assertJsonValue 在字节 fail-fast 之前

- **问题(主动发现非 codex 报)**: 修 E306 后我 grep 全 `assertJsonValue → jsonByteLowerBoundExceeds` 同序站点,发现 `electron/shared/plugin-mcp-schemas.ts:55` RegisterPayloadSchema.jsonSchema superRefine —— boundedValueDeepAdmissible(E283 形态闸)后,assertJsonValue(55)仍在 jsonByteLowerBoundExceeds(58)之前。形态合法但「很多中等元素」(≤boundedValueDeepAdmissible 65536/1024/64)且 > 64KiB 的 schema 被 assertJsonValue 完整遍历(≤65536 元素)才被字节 cap 拒。reorder 族末入口(E305 result / E306 plugin-data ×2 / E307 jsonSchema)。
- **修复(reorder,同 E305/E306)**: jsonByteLowerBoundExceeds 挪到 assertJsonValue 之前(boundedValueDeepAdmissible 之后)。jsonByteLowerBoundExceeds 对任意输入安全(E288)可先跑。
- **行为分流**: 仅「既非 JSON-safe 又超字节」病态 schema 的 issue 文案从「非 JSON 安全值」变「序列化超过 N 字节」(皆 reject),单-bad 不变。
- **测试**: 新 spec json-byte-budget/jsonschema-order(mock assert-json-value:超 64KiB shape 合法 schema→reject 且 assertJsonValue 不被调用;上限内→调用)。中和=byte 预检 `if(false&&...)` → 落 utf8BytesExceed(stringify) 仍 reject 但 assertJsonValue 被调用,E307 测失败,恢复 4813 PASS。
- **沉淀**: **family-sweep 主动 grep 穷尽同序兄弟**(E304 dev-URL 族 / E300-E301 物化族 / E305-E307 reorder 族 —— 收到一族成员即 grep 全同模式,主动收口剩余,免 codex 逐个续报)。reorder 族 4 入口闭合:result(E305)/plugin-data renderer+main(E306)/jsonSchema(E307),统一序:形态闸(boundedValueDeepAdmissible,jsonSchema 有)→ 字节下界 fail-fast(jsonByteLowerBoundExceeds)→ assertJsonValue(JSON 安全 + 形态早停)→ 精确字节 cap(utf8BytesExceed∘stringify)。

## E308（cycle-77，P2,reorder 族遗漏 2 入口 / 我 E307 grep 不完整)layout:write + PluginMcpRegistry assertJsonValue 在字节 fail-fast 之前

- **问题**: codex 报 `electron/main/ipc.ts:114` layout:write —— assertJsonValue(layout) 在 jsonByteLowerBoundExceeds(layout, MAX_LAYOUT_BYTES) 之前。**我 E307 的「family-sweep grep」只扫了 5 个文件,漏了 ipc.ts(E287 layout 写)+ PluginMcpRegistry.ts(E289 renderer pre-IPC)** —— codex 捞出 ipc.ts,我借此**真正穷尽 grep**(全仓 assertJsonValue/jsonByteLowerBoundExceeds)发现 PluginMcpRegistry 也同序。
- **修复(reorder ×2,同 E305-E307)**: ipc.ts layout:write + PluginMcpRegistry validateToolSpec 两处 jsonByteLowerBoundExceeds 挪到 assertJsonValue 之前(PluginMcpRegistry 在 boundedValueDeepAdmissible 之后)。both-bad 错误码/文案变(皆拒,单-bad 不变)。
- **测试**: 新 spec plugin-mcp-registry/validate-order(mock assert-json-value:超 64KiB shape 合法 jsonSchema→reject 且 assertJsonValue 不被调用)。ipc.ts layout:write 内联 E2E handler 不可单测(layout-read-guard 读端已正确 + 行为保持 + 全量 test 验)。中和=PluginMcpRegistry byte 预检 `if(false&&...)` → assertJsonValue 被调用,E308 测失败,恢复 4815 PASS。
- **沉淀**: **「主动 family-sweep」的 grep 必须真正全仓,不能只扫记得的几个文件**(E307 我只 grep 5 文件漏 ipc.ts/PluginMcpRegistry,codex E308 捞出 —— 主动 grep 若 scoping 不全=假穷尽,反而漏)。grep 应 `grep -rn 'assertJsonValue(\|jsonByteLowerBoundExceeds('` 全 electron+src,不预设文件列表。reorder 族**真正闭合 6 入口**:result(E305)/plugin-data renderer+main(E306)/jsonSchema main(E307)/layout:write(E308)/PluginMcpRegistry renderer(E308)+ layout-read-guard 读端本就正确。教训:主动 sweep 比被动续报好,但不全的主动 sweep 仍漏 —— grep 命令本身要全仓无 scoping。

## E309（cycle-78，P2,E286 字节预算族 / .length 变体)writeRecord JSON.stringify 在 .length cap 之前

- **问题**: codex 报 `src/plugins/storage/local-storage-record.ts:99` writeRecord —— `JSON.stringify(value)` 后才按 `serialized.length > maxRawLength`(1MiB)拒。settings/keybindings 记录(plugin 可注册多个 ≤64KiB text setting)累积超 1MiB 时先物化整串才按 .length cap 拒。同 E286 stringify-before-cap,但 cap 是 **.length(UTF-16)** 不是 utf8 字节(与读端 readRecord raw.length cap 对称)。
- **亲读 + 单位分流**: jsonByteLowerBoundExceeds 是 **UTF-8 字节**下界(字节 ≥ .length)→ 对 .length cap 会**误拒 CJK 记录**(.length 在上限内但字节超)。故需 **.length 度量**的下界,不能复用字节版。
- **修复**: json-byte-budget.ts 把下界遍历抽成 `lowerBoundExceeds(value, limit, strLen)`(strLen 决定字符串/key 长度度量),jsonByteLowerBoundExceeds=strLen utf8ByteLength(行为不变,薄封装),新增 `jsonStringLengthLowerBoundExceeds`=strLen s.length。writeRecord stringify 前 `if (jsonStringLengthLowerBoundExceeds(value, maxRawLength)) return 'too-large'`。.length 下界 ≤ 真实 serialized.length,故 fail-fast 与 .length cap 判定一致(无误拒)。
- **测试**: local-storage-record-guard.spec +E309(超 maxRawLength→too-large 且 JSON.stringify 不被调用 spy / CJK 记录 .length 在上限内→ok 不按字节误拒)。web-compat-allowlist 行号联动(import +2 行使 globalThis hit 33/35/96/107→35/37/98/117,E180 纪律)。中和=precheck `if(false&&...)` → spy 测失败,恢复 4817 PASS。
- **沉淀**: **字节预算 fail-fast 的度量单位须与 cap 单位一致**(.length cap 用 .length 下界,utf8 字节 cap 用字节下界 —— 跨单位会误拒,如字节下界对 CJK .length cap 过严)。**抽 strLen 参数让一个遍历复用两度量**(避免复制 walk;jsonByteLowerBoundExceeds 薄封装保持行为)。E180:改 src/plugins 行数(加 import)必联动 web-compat-allowlist 行号(json.dump indent=2 保格式,仅改变更的 4 行号,diff 6+6)。stringify-before-cap 族跨度量闭合:UTF-8 字节(E286 result/schema/plugin-data/layout/mcp-host)+ .length(E309 localStorage writeRecord)。

## E310（cycle-79,P2,**DEFER** — codex 建议反转 E124 刻意 fallback + 非生产问题)readResponseTextCapped body===null 回退 r.text()

- **codex 报**: `electron/shared/read-capped.ts:22` —— `readResponseTextCapped` 在 `Response.body === null` 时回退 `await r.text()`,建议 fail-closed(tooLarge/unsupported)而非 uncapped r.text()。
- **亲读分流(DEFER,不改)**:
  1. **非生产问题**:Continuo 全运行时(Electron Chromium renderer + Node/undici main)对有 body 的响应 Response.body 必为 ReadableStream → marketplace 两调用方(fetcher / reviews.service,均 GitHub 200-with-body)生产从不进 body===null 回退分支。
  2. **cap 已强制**:回退分支 line 25 `if (TextEncoder().encode(text).byteLength > maxBytes) throw` —— codex「bypass」不准确,字节上限**已生效**;真实残留只是「read-before-check 内存尖峰」,且仅当 (无 ReadableStream env) ∧ (无/诚实小 Content-Length) ∧ (大 body) 三窄条件同时成立 —— Continuo 无此 env。
  3. **codex 的 fail-closed 会反转刻意设计 + 误处理 null-body 状态**:E124 注释明确「无 ReadableStream(罕见环境/某些 mock):回退 text() + 真实字节校验」是刻意 fallback;fail-closed 移除该支持。且 null-body 状态(204/304/HEAD)合法 body===null + 空体,r.text() 正确返 '',fail-closed 会误抛「too large」。
- **决策**: **DEFER**(承「不单方面反转刻意注释的既有修复 → DEFER 并 flag」)。回退分支已强制字节 cap、生产不可达、fail-closed 引回归(反转 E124 + 破 204)。无现实 bug,不改。若 user 要更激进硬化(如 null-body→'' 的 spec-correct 化,生产等价且无测试依赖回退含 content),可后续单独评估。
- **沉淀**: **codex「问题方向」可指向真实但「建议手段」会引回归 / 反转刻意设计 / 针对非生产路径时,复查后 DEFER 并记 reasoning**(同 E270 不采纳 epoch 兜底 / E305 不采纳 boundedValueDeepAdmissible)。判据:(a) 生产可达性(调用方实际是否触达该分支)、(b) 既有保护是否已覆盖(此处 line 25 字节 cap)、(c) 建议是否反转刻意注释设计 / 破合法语义(204)。三者命中即 DEFER 非盲改。

## E311（cycle-80,P2,本地 notify 路径与 IPC-push/SDK 限长对偶)notifyCore message/code 无长度上限

- **问题**: codex 报 `src/notifications/notify.ts:70` notifyCore —— renderer 本地 notify()/notify.error() 的 message/code 无长度上限,而 main→renderer notify:push(isNotifyPushPayload,NOTIFY_MESSAGE_MAX 4096/NOTIFY_CODE_MAX 256)与 SDK coApp.notifications.show(co-app slice)均限长。各处 notify.error(err.message) 的 err.message 可超长(畸形/插件抛超长串)→ 进 console mirror + Toast DOM 放大。
- **亲读**: 三路径中本地 notifyCore 是唯一未限长者(push 拒、SDK 截);notifyCore 是全部本地 notify 调用的唯一入口(收口点)。
- **修复**: notifyCore 截断 message→NOTIFY_MESSAGE_MAX、code→NOTIFY_CODE_MAX(从 shared/notify-channels 导入,与 push/SDK **同一来源常量**)再 mirrorToConsole + _api.notify。截断(非拒,同 SDK co-app)保留可见反馈。
- **测试**: notify-public-api.spec +E311(超长 message/code → console mirror 的 message 截断到 MAX、prefix=[截断 code]、入队 Toast message 截断 / 上限内原样回归)。中和=notifyCore message 截断 `false&&` → E311 测失败,恢复 4819 PASS。
- **沉淀**: **同一概念多路径(本地调用 / IPC-push ingress / SDK)的校验须对偶齐全**(push 拒 + SDK 截 + 本地未限 = 本地是漏网,err.message 超长直达 DOM/console);收口到唯一入口(notifyCore)+ 同源常量(NOTIFY_MESSAGE_MAX/NOTIFY_CODE_MAX)。截断 vs 拒按路径语义(用户可见反馈用截断保留 toast,ingress 校验用拒)。notify 限长族:push(E242 isNotifyPushPayload)/ SDK(co-app)/ 本地(E311 notifyCore)三路径闭合。

## E312（cycle-81,P2,E269 反模式复现 / pre-IPC content 守卫)scoped-app writeFile `typeof === 'string' &&` 短路漏非 string

- **问题**: codex 报 `src/plugins/scoped-app.ts:174` app.fs.writeFile —— `if (typeof content === 'string' && utf8BytesExceed(content, MAX_WRITE_BYTES))`。content 契约是 string,但 `typeof === 'string' &&` 对**非 string** 短路 → 字节上限被跳过 → 非 string(JS 插件绕 TS 类型传 Uint8Array/对象)直接经 structured-clone 进 IPC(pre-IPC cap 失效)。**E269 同款反模式**(我 E264 在 validateNetworkInput 自引入、E269 修;此处 E44 写时同样埋了)。
- **亲读 + family-sweep**: 全仓 grep `typeof X === 'string' &&` —— 其余命中均为**有效性谓词**(非 string→false→无效→拒,正确)或对可选类型(number/bool/undefined settings/code)的长度检查(非 string 合法、无需限长)。仅 scoped-app:174 是危险形态(content 必 string,非 string 应拒而非放行进 IPC)。单点。
- **修复**: 拆成 `if (typeof content !== 'string') throw 'must be a string'`(非 string 即拒)+ `if (utf8BytesExceed(content, MAX_WRITE_BYTES)) throw 'too large'`(string 再限字节)。非 string 不再进 IPC。
- **测试**: scoped-app.spec +E312(非 string content 对象→抛 must be a string + 不调 pluginFsRaw.writeFile)。web-compat-allowlist 联动(scoped-app +6 行 globalThis 331→337,E180)。中和=改回 `=== 'string' &&` → 非 string 短路不抛 + 转发 raw,E312 测失败,恢复 4820 PASS。
- **沉淀**: **`typeof x === 'string' && (length/bytes check)` 反模式当 x 契约是 string 且结果用作「是否拒绝/限长」时**:非 string 短路绕过检查直达下游(IPC/coercion)。区分:**有效性谓词**(`return typeof===string && ok`,非 string→false→拒,安全)vs **拒绝守卫**(`if (typeof===string && tooLong) reject`,非 string 漏放行,危险)—— 后者须 `typeof !== string || ...` 或拆「非 string 即拒 + string 限长」。同 E269;一处族(E264/E269 network、E312 fs write)反复埋,grep `typeof.*=== 'string' &&` 全仓按「结果是谓词还是拒绝守卫」分流。

## E313（cycle-82,P2,不转发 raw 外部对象 / E46 续)execStream 整 opts 进 IPC

- **问题**: codex 报 `src/plugins/scoped-app.ts:410` app.shell.execStream —— validateShellInput 校验 cmd/args/cwd/env/input,但把**整个插件提供的 opts** 直接传 coApi.pluginShellStreamRaw.execStream → IPC structured-clone。execStream 契约 opts 只 {timeoutMs, cwd}(types.ts:307 / preload PluginShellStreamRaw:29),JS 插件可绕 TS 类型塞额外/超大字段 → 全随 opts 进 IPC 放大。
- **亲读**: 公开 + raw execStream opts 类型均 {timeoutMs?, cwd?}。validateShellInput 校验 cwd/env/input(env/input 是共享 exec 路径字段,execStream 不用)但不剔除未知字段;整 opts 转发使额外字段过 structured-clone。
- **修复**: validateShellInput 之后构造白名单 `safeOpts = opts === undefined ? undefined : { cwd: opts.cwd, timeoutMs: opts.timeoutMs }`,只转发契约声明字段,丢弃额外。opts undefined 保持 undefined(不变为 {})。
- **测试**: scoped-app.spec +E313(opts 含 evil/env 额外字段 → 转发的 opts === {cwd, timeoutMs},额外丢弃)。中和=传整 opts → passedOpts 含 evil/env,E313 测失败,恢复 4821 PASS。
- **沉淀**: **不把插件/外部提供的对象整体转发进 IPC —— 按契约字段白名单重建**(JS 插件绕 TS 类型塞额外/超大字段随对象过 structured-clone 放大;TS 类型挡不住运行时额外字段)。校验(validateShellInput)≠剔除未知字段(校验只查已知字段合法性,未知字段不报错但仍转发)——须显式白名单 `{a: o.a, b: o.b}` 重建。同 E271(对象形态守卫)/E312(content 类型守卫):外部对象进敏感边界(IPC/native)前按契约重建而非透传。

## E314（cycle-83,P2,E63 renderer 对偶 / pre-IPC sha 校验)readGitBlob sha 不预检

- **问题**: codex 报 `src/plugins/scoped-app.ts:253` app.fs.readGitBlob(repoDir, sha) —— 只 assertPluginFsPath(repoDir, E180),不校验 sha。JS 插件传超长/非 hex sha → coApi.pluginFsRaw.readGitBlob → IPC structured-clone 进 main,main 才用 GIT_BLOB_SHA_RE(E63)拒。renderer pre-IPC 缺 sha 预检。
- **修复(单一来源)**: GIT_BLOB_SHA_RE + isValidGitBlobSha 移到 shared/fs-limits(main + renderer 单一来源,同 validateScopesShape 模式)。main plugin-fs.service:504 改用 isValidGitBlobSha(去本地 const)。scoped-app readGitBlob 发 IPC 前 `if (!isValidGitBlobSha(sha)) throw BAD_INPUT`(repoDir 已 E180 预检在前,故 longPath+短 sha 仍先报 path 错,E180 测不破)。
- **测试**: scoped-app.spec +E314(非 hex/超长 sha→BAD_INPUT 不发 IPC / 合法 4-64 hex→透传回归)。web-compat-allowlist 联动(scoped-app +7 行 globalThis 337→346,E180)。中和=sha 预检 `if(false&&...)` → 转发 raw,E314 invalid 测失败,恢复 4823 PASS。
- **沉淀**: **renderer SDK wrapper 的每个发 IPC 参数都要 pre-IPC 预检**(E180 路径 / E44 content / E312 类型 / E313 opts 白名单 / E314 sha 形态 —— readGitBlob 此前只检 repoDir 漏 sha,同 wrapper 多参数须逐参数预检);**main 校验常量(GIT_BLOB_SHA_RE)收口 shared 让 renderer 复用**(单一来源防漂移,renderer 预检与 main 权威校验同规则);有效性谓词 isValidGitBlobSha(typeof&&regex)非 string→false→拒(安全形态,区别 E312 拒绝守卫)。

## E315（cycle-84,P2,E313 同族 / fs opts 白名单)mkdir/rm/cp/atomicReplace 整 opts 进 IPC

- **问题**: codex 报 `src/plugins/scoped-app.ts:223` —— app.fs.mkdir/rm/cp/atomicReplaceWithinScope 把整个插件 opts 直接传 coApi.pluginFsRaw.* → IPC structured-clone。opts 契约是 boolean 标志(mkdir/cp {recursive?}、rm {recursive?,force?}、atomicReplace {overwrite?}),JS 插件绕 TS 类型塞额外/超大字段随 opts 过 IPC。E313(execStream opts)同族,fs 4 方法同样未白名单。
- **修复**: 抽 `pickBoolOpts(opts, keys)` helper(非对象/缺省→undefined;声明字段强制 Boolean 保 truthy 语义;丢弃额外)。4 方法各按契约 keys 白名单重建:mkdir/cp ['recursive']、rm ['recursive','force']、atomicReplace ['overwrite']。
- **测试**: scoped-app.spec +E315(4 方法 opts 含额外字段 → 转发只含契约 boolean 字段)。web-compat-allowlist 联动(scoped-app +pickBoolOpts 16 行,globalThis 346→366,E180)。中和=mkdir 传整 opts → call[2] 含 evil,E315 测失败,恢复 4824 PASS。
- **沉淀**: **同 wrapper 多方法的 opts 透传须统一白名单**(E313 execStream 修一处,fs mkdir/rm/cp/atomicReplace 4 方法同模式漏 → grep 全 wrapper `pluginFsRaw.*(..., opts)` / `Raw.*(..., opts)` 同模式一并白名单);抽 pickBoolOpts(keys) 复用避免 4 份手写;Boolean 强制保 truthy 语义同时丢非 boolean。外部对象进 IPC 白名单族:E313 execStream / E315 fs opts(+ E271/E312/E314 单字段守卫)。**E180 纪律**:每次改 src/plugins 行数(加 helper/守卫)都联动 web-compat-allowlist 行号(本 session E311/E312/E314/E315 连续 4 次 scoped-app/相关行号漂移,json.dump 单行号改 diff 极小)。

## E316（cycle-85,P2,E146 AgentAuthRespondSchema 同型 / pre-IPC schema bound)popout:open panelId schema 无上限 + passthrough

- **问题**: codex 报 `electron/main/ipc.ts:54` —— popout:open 入参 schema `z.object({ panelId: z.string().min(1) }).passthrough()`：panelId 无 `.max()` 上限,且 `.passthrough()` 放行任意额外字段。畸形/恶意 renderer 传超长 panelId 或夹带额外字段 → 经 IPC structured-clone 进 main 才校验放大。建议 `z.object({ panelId: z.string().min(1).max(256) }).strict()`。
- **亲读**: handler(ipc.ts:215)是 M5 占位,立即抛 POPOUT_NOT_IMPLEMENTED,panelId 从不使用;preload(index.ts:128)仅传 `{ panelId }`,panelId 是内部 dock panel id(远短于 256)。schema 注释本身写明「M5 真实现时再扩展 bounds 等字段」——加 bound 正合其意图。`.max(256)` + `.strict()` 对所有真实输入行为保持(panel id 远短于 256,preload 不传额外字段),纯纵深防御 + schema 卫生(挡 passthrough 任意字段)。
- **修复(单列可测试)**: schema 抽到 `electron/main/popout-open-schema.ts`(同 agent-auth-schema E146 模式 —— ipc.ts 顶层 app 副作用不可测试 import),改 `z.object({ panelId: z.string().min(1).max(256) }).strict()`。ipc.ts import 之,去本地 const。与 AgentAuthRespondSchema(requestId ≤256 + .strict)完全同型。
- **测试**: 新 popout-contracts/popout-open-schema.spec(空串拒 / >256 拒 / 额外字段拒 .strict / 合法 ≤256 通过 / 缺失/非串拒,5 case)。中和=退回 `min(1).passthrough()` → >256 与额外字段 2 测失败,恢复 4829 PASS。
- **沉淀**: **每个跨 IPC 的 string schema 都应有 .max() 上限**(无上限 = 超长串经 structured-clone 放大;E146 requestId / 本 panelId 同模式,grep `z.string().min(1)` 无 max 的 IPC schema);**对象 schema 用 .strict() 而非 .passthrough() 除非确需放行未知字段**(passthrough 透传额外字段进 main,占位/已知 shape 用 strict 更紧);占位 handler 也应有 bound(注释承诺「M5 再扩展 bounds」即认其当下缺 bound,提前补不破未来扩展)。module-local schema 不可测试 → 抽单列模块(E146/E316 同模式:agent-auth-schema / popout-open-schema)。

## E317（cycle-86,P2,E276/E277/E278 同族 / 运行时守持久化契约)workspace root/recentRoots 无 PATH_STR_MAX 上限

- **问题**: codex 报 `src/stores/workspace.store.ts:35` normalizeWorkspaceRoot —— 只过滤空/空白/非字符串 → null,不施加 PATH_STR_MAX=8192 上限。而 explorer/editor/pinned store 各自在状态变更入口都有 `path.length > PATH_STR_MAX → no-op 拒`(E276/E277/E278)。workspace 的 root/recentRoots 经 snapshotFromStores 写入 ExplorerWritableSnapshotSchema(root=pathStr().nullable()、recentRoots=array(pathStr()),pathStr=z.string().max(PATH_STR_MAX))—— 运行时若持有超长 root/recentRoot,snapshot 写出后整份 schema 拒 → explorer:write 拒整份 → explorer 持久化全失败(连带 recentRoots/pinned/各窗口/layout/editor 会话一起丢)。
- **亲读**: normalizeWorkspaceRoot 是唯一 chokepoint,被 setRoot(line 46)+ recentRoots 过滤(52)+ snapshotFromStores(explorer-persist 165-168)+ hydrateStores(211-213)+ initial/new-window(487-490)共用。持久化 schema 确认 root=pathStr().nullable() / recentRoots=array(pathStr()).max(RECENT_ROOTS_MAX),pathStr=z.string().max(8192)。与 E276 pinned「运行时超限 → snapshot 写出后 schema 拒整份 → 全失败」完全同型,workspace 是同族唯一未守的 store。
- **修复(单一来源)**: normalizeWorkspaceRoot 加 `if (path.length > PATH_STR_MAX) return null`(import PATH_STR_MAX 自 explorer-persistence-schema,与 editor/pinned/explorer store 同 import)。唯一 chokepoint 加一次即覆盖 setRoot 入口(超长 root 视作未选 null)+ recentRoots 过滤(超长被滤)+ snapshotFromStores 写出前清洗(双层兜底,snapshot 永不含超长 → schema 不拒)。真实路径远短于 8192,行为保持;仅挡拖拽深嵌目录 / 插件经 open-folder 入口传超长串。
- **测试**: window-workspace-roots-map/workspace-store-empty-string.spec +E317 4 case(超长 root→null / 恰好 PATH_STR_MAX 保留含等于边界 / setRoot 超长→root=null / snapshotFromStores 超长 root+recentRoot 清成 ExplorerWritableSnapshotSchema.safeParse 通过的合法快照)。中和=cap `if(false&&...)` → 3 测失败(边界等于测试不依赖 cap),恢复 4833 PASS。
- **沉淀**: **凡进持久化 schema 的运行时 store 字段都须在变更入口施加与 schema 同的 cap**(E276 pinned/E277 explorer expandedPaths/E278 editor openFilePaths/E317 workspace root+recentRoots —— 四 store 同族,workspace 是最后未守者;**修一族必 grep 所有写入同一持久化快照的 store**:snapshotFromStores 聚合 explorer/pinned/editor/layoutUi/workspace 五源,任一源超 cap 即毒整份);单一 chokepoint(normalizeWorkspaceRoot)加一次 cap 同时覆盖运行时入口 + snapshot 写出双层;有效性归一化函数(非法→null)天然适合承载 cap(超长是「非法路径」的一种,与空/空白/非串并列)。

## E318（cycle-87,P2,**DEFER**)ContextMenu selectedPaths 无 MAX_EXPLORER_BATCH_PATHS —— 非真实缺陷,按建议修有害

- **codex 报**: `src/panels/Explorer/ContextMenu.tsx:139` computeActionTargets 多选时 `Array.from(selectedPaths)`(selectedPaths 可达 ~100k)无 MAX_EXPLORER_BATCH_PATHS 上限,经批量操作/IPC 放大。建议 selectedPaths.size 超限前截断。
- **亲读分流(DEFER)**: actionTargets 仅流向 onCut/onCopy(存 renderer-local clipboard-store,**不持久化**到 explorer.json)、onCopyPath(join 写 OS 剪贴板,renderer-local)、onTrash→removeItems(**逐项 IPC** `for (const p of paths)`,非单次大数组 structured-clone)。selectedPaths 来源 = headless-tree selectionFeature(用户 Click/Cmd-Click/Shift-Click 瞬态选择),非外部/恶意/插件输入。
- **为何 DEFER(区别持久化-cap 族 E276/E277/E278/E317)**:(1)用户驱动瞬态 UI 选择,非外部/畸形输入;(2)**不进持久化快照**(剪贴板不在 explorer.json),无 E276 族「超 cap → snapshot 写出被 schema 拒整份 → 持久化全失败」理由;(3)trash 逐项 IPC、cut/copy 本地,无单次大 clone 放大;(4)**建议的 silent cap 会静默丢弃用户主动批量操作的部分目标(选 N 删,只删 cap 个,其余静默保留)= 审计反复警惕的「静默丢数据」反模式,比所谓问题更糟**;高位 cap 改 loud-reject 则拒绝合法大批量(删 5000 构建产物)属功能回退。当前代码对所有现实输入正确安全,极端选择仅「慢」(用户请求固有代价),非缺陷。
- **沉淀**: **持久化-cap 族(E276-E317)的 cap 理由是「防 snapshot 毒化 schema 整份拒」,只适用于进 explorer.json 的运行时 store 字段;瞬态 UI 状态(selection/clipboard 非持久化)不适用**——对其加 cap 是给「用户主动数据操作」做 silent truncation,与「写松读紧静默丢数据」同反模式。DEFER 判据 (c)「建议反转刻意设计/破坏有效语义」此处=破坏用户批量操作完整性。误报来源:codex 把「无 cap」机械等同缺陷,未分流「是否持久化 / 是否外部输入 / cap 是否静默丢用户数据」。
