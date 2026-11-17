# dock-reconciler-seen-prune

行为契约:**DockReconciler 的「首次出现」记录有界,且不破坏 R25 的 workspace 切回不抢焦**。

`everAddedSessionIds` 记录本 renderer 内出现过的终端 id,用于 originHint==='user' 兜底聚焦只对首次出现生效(R25)。
此前只增不删,随进程生命周期内创建过的终端总数无界增长。

- `TerminalSessionsSync` 每次以权威快照替换 `rawOwned`(owner 过滤后、**workspace 过滤前**)时调
  `pruneReconcilerSeenSessions(rawOwned)`,剪掉已不在快照中的 id
- workspace 隐藏的终端仍在 `rawOwned` 中 → 记录保留 → 切回重现不重新聚焦
- 真正删除的终端从快照消失 → 记录剪除;记录条数 ≤ 当前本窗口 session 数
- 同 id 删除后重建 → 按首次出现处理(user 终端兜底聚焦)
