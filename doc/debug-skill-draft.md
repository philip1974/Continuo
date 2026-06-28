# debug-skill 草案（立项前可独立评审/测试的产物）

> 状态：**DRAFT**。这是"Agent 可控 debug"功能的**第三层（判断力层）**草案，不是已启用的 skill。
> 依赖：debug 插件提供的 `debug_*` MCP 工具（尚未实现）。但本草案可在 Wizard-of-Oz A/B 阶段先写、先测——它本身就是 A/B 要验证的一部分。
> 背景与决策链见知识库 `continuo_agent_debug_dap_feasibility.md`（圆桌 + codex 三轮 + 需求体检）。

---

## 这条 skill 解决什么
debug 插件给的是**能力**（设断点、单步、读变量），但 Agent 在探索性、有状态的调试循环里容易打转、无计划地到处单步。
这条 skill 给的是**判断力**：何时该用断点、何时 console/logpoint 更好、何时根本不该调试、以及调 race 的正确姿势。

## 何时触发
Agent 准备"加 console.log → 重跑 → 看输出"来定位一个运行时行为不符预期的 bug 时，**先读本 skill 决定用哪种手段**。

---

## 决策边界（核心）

### ✅ 优先用断点（debugger）когда：
- 需要**一次读多个变量 / 整个作用域 / 深对象图**，而你还不确定该看哪个值（断点能看全场 + 现场 `evaluate` 任意表达式，console 要先猜打印什么）。
- 不想/不能**改源码**：`node_modules`、编译产物、生成代码、第三方库、或改了要清理的被测代码。
- 想知道**是哪个调用方**触发的（调用栈）/ 只在某条件下停（**条件断点**）。
- 想**省 round-trip**：一次暂停探多个变量、评多个表达式，胜过"改→跑→读"反复多轮。

### ✅ 优先用 console / logpoint когда：
- 要观察**值随时间演变** / 循环跑很多次（用 **logpoint**：只记录不暂停，胜过暂停几千次）。
- 目标**跑不进调试器**（依赖部署/集成环境、启动成本高）——原地 console 可能是唯一可行。
- 一次性、极轻量的确认。

### ⛔ 两者都先别用 когда：
- 看上去是**纯逻辑/类型错**——先**读代码 + 跑失败测试**，多数 TS bug 这样就定位了。
- 还没有**可复现路径**——先把 bug 跑到出错点（断点和 console 都以此为前提）。

---

## 标准工作流（用 debug_* 工具时）
1. `debug_launch`（或 attach）目标 TS 入口 / 失败的测试文件。
2. `debug_set_breakpoint`(file, line)——设在**怀疑状态出错的那一行**，不是随便铺。
3. `debug_wait_for_stop`——阻塞等命中（以它拿到下一停点为"是否停住"的唯一真相，**别信 continue 的返回值**；`reason` 已归一可用，精确位置仍看 `debug_stack`，见下方契约）。
4. 命中后读暂停帧（**必须走 stack→scopes→variables 链**）：
   - `debug_stack`（可省略 `thread_id`，引擎自解析）→ 拿当前 `frame_id`，看调用链；
   - `debug_scopes`(`frame_id`) → 拿各作用域（Local/Closure/Global）的 `variables_reference`；
   - `debug_variables`(`variables_reference`) 读该作用域变量；`debug_evaluate`(`frame_id`, 表达式) 评你的具体假设。
   - ⚠️ **不能**直接拿 `frame_id` 当 `variables_reference` 传给 `debug_variables`（会返回空数组）——必须先 `debug_scopes`。
5. 决定下一步：`debug_continue` / `debug_step_*`——**带着假设走一步看一步**，不是机械单步到底。
6. 定位到后退出会话，去改代码 + 加/跑测试固化。

## 工具调用契约（实战坑，必读）
> 这些是真实使用 debug_* 工具时踩到的行为，写死在 skill 里避免重复踩。

- **`thread_id` 省略即可**：js-debug 把 Node 线程 id 报成 `0`（合法）。`debug_stack`/`debug_step_*`/`debug_continue` 的 `thread_id` 都是可选的，**直接省略**让引擎解析最稳；要传也接受 `0`（不会再被拒）。`wait_for_stop` 返回的 `thread_id` 可能是 0，照样能用。
- **`reason` 已归一可用**（原 js-debug 在 parent/child 配置下命中断点仍发 `reason:entry` 的坑已修）：引擎按 DAP `hitBreakpointIds` 归一，命中断点稳定报 `breakpoint`，step/真 entry 保留原值，`description`（如 "Paused on breakpoint"）也透出。**精确位置仍以 `debug_stack` 的文件/行号为准**。
- **`continue` 的返回值别信**：`debug_continue` 可能返回 `continued:false`（DAP `allThreadsContinued` 的原值），但执行其实已恢复——**以随后的 `debug_wait_for_stop` 拿到下一停点为准**。
- **`frame_id` / `variables_reference` 每次停点失效**：`step`/`continue` 之后，旧的 `frame_id`、`variables_reference` 立即失效（DAP 语义，仅暂停期有效）。每次停下要读变量，都得**重新** `debug_stack` → `debug_scopes` 取新 id，不能复用上一停点的。

## race / 异步 bug 的纪律（codex 复核重点）
- 断点对 race 的正确用法是**"受控调度点"**：在 `await` 间隙、迟到回调、状态快照分叉处停住，**人为放大 interleaving 窗口**来验证根因（例：保存竞态——停在 `await writeFile` 前后读 store 当前内容）。
- ⚠️ **不要无计划地到处单步**——那会改变真实时序、把 heisenbug 藏起来。要么条件断点、要么明确的放大窗口策略。
- race 的**最终修复验证**仍以测试（受控 Promise / 手动 resolve 制造窗口）为准，断点是定位/佐证手段。

## 退出纪律（Agent 易犯）
- 调完**不要留 console.log 在源码里**（污染 diff/commit——这正是断点优于 console 的一大动机，别又自己引入）。
- 不要留**孤儿断点**。
- 把"靠调试发现的根因"落成**一个回归测试**，而不只是改完就走。

---

## 今天就能用的退化版（零引擎依赖）
在 debug 插件落地前，本 skill 的"console/logpoint 高效用法 + 决策边界 + 退出纪律"部分**今天就能独立提升 TS 项目的 console 调试**：先读再决定、打印整对象而非零散字段、用结构化前缀便于过滤、调完即清。

## A/B 验证（本 skill 的考核方式）
在 Wizard-of-Oz A/B 中：给 Agent **本 skill + 人肉模拟的 debug 后端**，在 6 个真实 TS 任务（≥2 async race + 2 业务逻辑 + 1 parser/data-transform + 1 UI/runtime 异常）上，对比"无 debug(console)"与"本 skill + debug"的**定位时间 / 误判率 / 补丁质量**。带 skill 的引导式调试若不能稳定胜出，说明判断力层无效，需重写或放弃。
