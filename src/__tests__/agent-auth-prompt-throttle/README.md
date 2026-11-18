# agent-auth-prompt-throttle(agent 授权弹窗被拒后有冷却,不能循环弹窗诱导误点)

## 背景

威胁模型:被提示注入的 AI agent 在 Continuo 终端里运行,可经 stdio / HTTP 调 MCP。需授权的工具(terminal.* /
debug.* / plugin.*)在用户未授权时弹出授权弹窗。此前被拒后**没有任何冷却**(只有未决数上限 64/窗、256 全局):
agent 循环调用任一需授权工具、每次被拒立即再调,弹窗关一个来一个(实测顺序 500 次请求全部弹出),而弹窗会抢走
键盘焦点 —— 用户正在终端 / 编辑器打字时,Tab+Enter 落到「仅本次」,Tab Tab Enter 落到「本次启动期间允许」
(整域放行)。跨窗变体:别的窗口里的 agent 直连 socket 不发 hello,以 external 身份在主窗连弹并占住主窗唯一的
授权槽,主窗内合法 agent 的首次授权被自动拒绝。

同族:plugin-fs 的 scope 请求已有同样的节流(`plugin-fs-scope-request-throttle`),机制抽成
`electron/main/lib/prompt-throttle.ts` 两处共用。

## 行为

### 主进程(`agent-auth.service.ts` 的 `requestAgentAuth`)

节流按**调用方**(目标窗口 × 调用方类别:窗口内 agent / external 客户端)计,冷却按**授权域**(terminal / debug /
plugin)计。

- **拒绝冷却**:用户拒绝后,该调用方的这个域进入冷却:30s 起,同一域每次冷却结束后再被拒翻倍,上限 5 分钟;距上次
  拒绝超过 10 分钟后退避级别归零。冷却期内该域的任何 method 都直接失败:不发 IPC、不弹窗。别的域不受影响(但见下一条)。
- **调用方级连续被拒退避**:同一调用方连续 3 次被拒(不论域,挡轮换 terminal → debug → plugin)→ 该调用方的所有域
  进入退避,30s 起每多被拒一次翻倍,上限 5 分钟。用户授予一次只把计数减 1。
- **超时**:弹窗 5 分钟无人应答 —— 用户不理会 ≠ 拒绝,不升退避级别、不计连续被拒;但该域进入一次 30s 冷却
  (否则可以用超时即重弹来持续占屏)。
- **速率上限**:同一调用方 60s 内最多 10 个弹窗(即使每次都被「仅本次」放行)。
- **单飞**:同一调用方同时最多一个未决弹窗。未决期间该调用方的新请求(不论域)直接失败,不排队、不计拒绝。
- **不计为拒绝**:窗口关闭、撤销、应用退出、IPC 发送失败结算的请求。
- 被节流的请求 reject `AGENT_NOT_AUTHORIZED`,消息说明原因与等待时长(工具门控原样返回给 agent),例如
  `the user denied (or did not answer) a recent authorization prompt; Continuo will not ask again for 30s`。
  agent 授权没有用户手动重试入口:用户想放行就让 agent 冷却后再试。
- **「本次启动期间允许」后不节流**:用户对某域选了「本次启动期间允许」后,renderer 对该域直接放行、不弹窗,所以该域
  的并发 / 高频调用是正常使用,主进程原样转发(不单飞、不计速率)。主进程为此记一份授权镜像(真相源仍在
  renderer):撤销、窗口关闭时清除;renderer reload 丢了授权态时自愈 —— 按镜像放行的请求被拒一次即清镜像(这一次
  不计拒绝),之后恢复节流。
- **external 与窗口内互不占用**:两类调用方各自计冷却 / 退避 / 速率、各占一个未决槽;不同窗口之间也互不影响。

### renderer

- **按调用方类别分槽**(`agent-auth.store.ts`):窗口内 agent 与 external 客户端各一个槽。同一时刻仍只显示一个
  弹窗(不堆叠);另一类调用方的请求排在后面,当前弹窗落定后显示。同一类已占槽 → 立即 `denied`。每个请求从到达起
  按 5 分钟各自超时(`cancelled`);main 撤销时显示中与排队中的一并 `cancelled`。
- **授予方向的防误触延迟**(`AgentAuthPrompt.tsx`;实现在 `src/lib/use-prompt-grant-guard.ts`,与插件权限弹窗共用,
  见 `permission-prompt/`):弹窗显示后 500ms 内,「仅本次」「本次启动期间允许」的鼠标 /
  键盘激活无效(弹窗保持);「拒绝」与 Esc 立即可用;初始焦点仍在「拒绝」。排队的下一个请求显示时重新计时
  (对旧弹窗的连点不落到新请求上)。

## 规范

- `main-throttle.spec.ts`:真实 `agent-auth.service` + 真实节流(fake timers):审计复现(500 次只弹 1 次)、
  冷却到期与退避增长、按域记、轮换域退避、授予 / 超时 / 取消不计拒绝、速率上限、单飞、session 授权后不节流、
  撤销与 reload 后恢复节流、external 与窗口内 / 不同窗口互不占用。
- `store-slots.spec.ts`:renderer 分槽与排队。
- `prompt-grant-guard.spec.tsx`:500ms 内「允许」无效、「拒绝」/ Esc 有效、初始焦点、排队切换后重新计时。
- 通用节流机制本身的边界(容量淘汰、授予减 1 等)见 `plugin-fs-scope-request-throttle/`。
