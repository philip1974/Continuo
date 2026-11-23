# dock-reconciler-seen-prune

行为契约:**DockReconciler 的「首次出现」记录有界,且不破坏 R25 的 workspace 切回不抢焦**。

`everAddedSessionIds` 记录本 renderer 内出现过的终端 id,用于 originHint==='user' 兜底聚焦只对首次出现生效(R25)。
此前只增不删,随进程生命周期内创建过的终端总数无界增长。

- `TerminalSessionsSync` 每次以权威快照替换 `rawOwned`(owner 过滤后、**workspace 过滤前**)时调
  `pruneReconcilerSeenSessions(rawOwned, keepIds)`,剪掉已不在快照中的 id
- workspace 隐藏的终端仍在 `rawOwned` 中 → 记录保留 → 切回重现不重新聚焦
- 真正删除的终端从快照消失 → 记录剪除;记录条数 ≤ 当前本窗口 session 数
- 同 id 删除后重建 → 按首次出现处理(user 终端兜底聚焦)
- 本轮快照有项因 wrong-owner 以外的原因被 ingress 校验丢弃(shape-invalid / missing-owner)且能解析出字符串
  id → **只保留这些 id**(缺失不等于真删除),其余已消失的 id 照常剪;无法解析 id 的丢弃项(not-object / id 非
  字符串 / over-capacity)无从对应任何记录,不阻止剪除 —— 快照持续混入畸形项时记录仍有界;他窗口
  session(wrong-owner)的丢弃不影响剪除
