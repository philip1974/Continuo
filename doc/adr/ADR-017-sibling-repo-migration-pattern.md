# ADR-017 — Sibling-repo Migration Pattern

- **Status**: accepted
- **Date**: 2026-05-26
- **Topic**: `24-migration-shell-env-host-helper`
- **Companion commits**:
  - ContinuoTerminal `777bd13` `feat(server-node): add shell-env subpackage with host-helper shell policy and integration env`
  - Continuo `ef1baf5` `refactor(terminal): consume shell-env helpers from @continuo-terminal/server-node`

## Context

Continuo 持续把 terminal-shell-PTY 子系统抽到 sibling 仓 `ContinuoTerminal` 共享(topic-26 search-addon 评估 / topic-27 key-mapping / topic-27b safeWrite / topic-28 shell-quote / topic-24 shell-env)。这是一类高频迁移场景:**Continuo 是 consumer,sibling 是 npm package 提供方**。本 ADR 把 topic-24 实战中验证的 5 条 pattern 固化为日后同类迁移的模板。

## 决策(5 条 pattern)

### 1. Codex 预评估 + dev-loop red-team-v1 双重审查 sibling 包边界

跨仓迁移触及 sibling 包的"对外通用性边界"。本 topic 用 Codex 在 dev-loop **req 阶段之前**(pre-plan-advisor)就跑了一次只读分析,戳穿了 3 条 P0 误判,在 plan-v1 写出来之前就消化了边界问题:

- "allowlist 别嵌入 SessionManager.create() 默认行为"(若嵌入会破坏 `shell: 'claude' | 'codex'` CLI consumer)
- "byte-identical snippet 比对放 sibling TDD,不是 consumer 端"(consumer 不能合理访问 internal const)
- "bash/fish real_test 没有 GUI 入口"(scope expansion vs. 降级 sibling integration test 的 trade-off)

然后 dev-loop red-team-v1 阶段再独立审查 plan-v1,捕获另一批 5 P1 + 3 P2 + 1 NEED-INFO 的细化问题。**两次独立审查 + 真实 ACCEPT 全部**:无遗漏。

**应用**:任何"Continuo→ContinuoTerminal 共享化"topic 都该走 pre-plan-advisor 预审,把 sibling 包通用性 P0 戳穿在 dev-loop 之外。

### 2. Host-side helper export pattern(allowlist 不进 SessionManager)

`isAllowedShell` / `getDefaultShell` 是 **Continuo host 的 policy**(VSCode 风 `$SHELL` 命中白名单 / Unix path prefix 白名单),不是 PTY server 的 spawn policy。把它放到 `@continuo-terminal/server-node` 的 `shell-env/host-shell-policy.ts`,但:

- **JSDoc 头部明示** "Host helper. Not invoked by SessionManager — host wrapper (e.g. Continuo IPC) calls explicitly."
- **server-node 内部不引** — SessionManager 仍接受任意 `input.shell ?? process.env.SHELL ?? '/bin/zsh'`(`session-manager.ts:165`)
- Continuo 在 IPC handler 里**主动**调 `isAllowedShell(shell)` 做拒绝(`terminal.ipc.ts:154-155`)

**应用**:把"对一类 host 适用,但 sibling 包通用性不该收紧"的 helper export 时,统一走 `host-*` 前缀命名 + JSDoc 边界声明 + sibling 包内部不主动调。

### 3. 中性 namespace 选择(env var rename)

迁移触发的 env var rename 不要带 host 品牌前缀(`_CONTINUO_*` / `_CT_*` 都是品牌缩写)。落到 sibling 包的应该是**类别中性**前缀(`_TERMINAL_USER_*`)。理由:

- sibling 包未来可能服务 codex / claude / 其它 CLI consumer
- shell rcfile 子进程内的 var 应反映"这是哪个类别的 host 注入"而非"这是哪个 host product"
- topic-24 red-team-v1 P1-1 戳穿 `_CT_*` 仍带 ContinuoTerminal 缩写,改为 `_TERMINAL_USER_*` 才真中性

**应用**:rename 决策时,问"五年后这个 var 名在第三方 host 内出现还合理吗"。

### 4. Byte-identical snippet 测试落 sibling TDD,不跨仓 leak internal const

Sibling 包内的字符串模板(如 bash rcfile snippet)是 internal const,**consumer 端 spec 不应反向 import 它做字节比对**(P0-2)。正确分工:

- **sibling 侧 TDD**:`integration.spec.ts` 内嵌 `EXPECTED_BASH_SNIPPET` 完整 String.raw,生成 rcfile 后 `fs.readFile().toBe(EXPECTED)` 做字节比对 + `.not.toContain('_CONTINUO_')` 防回归
- **consumer 侧 BDD**:`host-helper-import.spec.ts` 只验证 import 不抛 + return shape(`{ env, cleanup }`)+ 调用契约,**不**碰 internal const

如果 consumer 想验证字节,要么 export const(污染公共 API)要么写脆弱反射测试 — 两者都不该做。

**应用**:跨仓迁移涉及 internal const(snippet / regex / lookup table)时,字节级 spec 永远在 sibling 包内。

### 5. Actual-PTY skipIf integration test pattern

Sibling PTY 包对真实 shell 行为(OSC 7 / rcfile 加载 / autosuggestion plugin init)只能用 **actual node-pty + skipIf** 测试:

```ts
import { execSync } from 'node:child_process';
import { spawn } from 'node-pty';

function commandExists(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

it.skipIf(!commandExists('fish'))('T26 fish rename + OSC 7', async () => {
  const prepared = await prepareShellIntegrationEnv('fish', baseEnv);
  const pty = spawn('fish', ['-l', '-i'], { env: prepared.env, cols: 80, rows: 24 });
  // sentinel pattern: chained `printf ...; echo "__DONE__"`,wait for marker
  // ...
});
```

**关键 race-bug 提示**(topic-24 Op5b lesson):用 `printf "<%s>" "$VAR"` 后再 `echo "__DONE__"`,predicate 等待 DONE marker。否则 PTY echo back 的 typed input 会被误判为 executed output。

`it.skipIf` 让缺 fish/bash 的 CI 不阻塞,但本机/CI runner 装齐时跑真实验证。

**应用**:sibling PTY 包必须有 actual-shell integration test;依赖 codex/Claude 跑前 grep `commandExists` skipIf 守护。

## 配套机制(支撑 5 条 pattern)

- **codex repo boundary 派发 preamble**:每条 codex 派发任务的指令头都明示 "only edit under <repo>",防 pnpm `file:` link 顺藤跨仓改判(memory feedback `feedback_codex_repo_boundary.md`)
- **pnpm file: link 缓存刷新**:Continuo `pnpm install --offline` 刷新 file: link node_modules,无 lockfile/package.json tracked diff(topic-27 first encountered + topic-24 codex 自检测)
- **byte-identical Op5.5 双重断言**:`git diff --stat package.json` 0 行(主)+ `git diff --stat pnpm-lock.yaml` 0 行(兜底),防 deps 静默 leak
- **codex session 跨阶段复用 + mode-switch preamble**:同一 session 跨 pre-plan-advisor → red-team-v1 → execute 16 ops 复用,每次切换发 "你现在是 X 不是 Y" preamble(议题 C.3)— topic-27/28/24 三次实证

## 后果

- 后续 Continuo→ContinuoTerminal 迁移 topic 直接套这 5 条 pattern,期望端到端时间 ≤ 当前 topic-24 (~3 小时)的 70%
- ContinuoTerminal `server-node` 形成 `shell-env/` + `transports/` + `handlers/` 三类子模块的清晰分层
- sibling 包对第三方 host(codex / claude CLI)的通用性边界**永远不收紧**(Safeguard S1 of topic-24 持续生效)

## 相关

- topic-26 search-addon(评估推后)/ topic-27 key-mapping / topic-27b safeWrite / topic-28 shell-quote — 同类先驱迁移
- ADR-016 i18n architecture — 同类"功能层抽离"模式但目标是本仓内 module 拆分,与 sibling 跨仓不同
- 议题 J(dev-loop-design):sibling 包通用性 vs. host policy 的边界处理来源
