# Agent Diagram MCP — 失败 Post-Mortem

> 实装 → 放弃。2026-05-05 启动,2026-05-06 撤销。
> 分支 `feat/agent-diagram-mcp`(10 commits)已 hard delete。本文档是唯一留底。

## 1. 目标

让 Claude Code / Codex 在 Continuo 内置 terminal 通过 MCP tool 生成、修改、读回、
导出 draw.io 图表,渲染在 dock 内的 `DiagramViewer` 面板。参考项目
[DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io)。

## 2. 实装范围(全删)

| Phase | 范围 | 状态 |
|---|---|---|
| P1 | `diagram.create` tool + `DiagramViewer` panel + iframe `embed.diagrams.net` | ✓ 跑通 |
| P2 | `diagram.update`(乐观锁 expected_version + cell ops add/update/delete cascade)+ `diagram.get`(iframe export round-trip + 3s timeout 回退 store)+ 用户手改 `autosave` 回流 | ✓ 跑通 |
| P3 | `diagram.export`(drawio/png/svg)+ 状态栏 `[◇ N diagram]` chip + `closeAll()` | drawio 写文件 ✓;**png/svg 始终 timeout** |

测试覆盖:1203 vitest tests,4 个 BDD topics(diagram-operations / diagram-mcp-create / diagram-mcp-update / diagram-mcp-get / diagram-mcp-export / diagram-sessions-service)。typecheck / build 干净。

## 3. 真正撞墙的地方(P3 png/svg 导出)

drawio embed iframe **不响应** `{action: 'export', format: 'png'}` postMessage。同一个 iframe 实例 `init` / `load` / `autosave` 出站正常,**唯独 `export` action 沉默**。穷尽尝试:

1. **targetOrigin** 从 `'https://embed.diagrams.net'` 改 `'*'`(参考项目同款)— 无效
2. 加 `scale: 2` 参数(参考项目 png 用)— 无效
3. coordinator 超时从 3s 提到 8s — 无效
4. 验证 iframe contentWindow 存在(发现 ref stale,加 `document.querySelector` 兜底找 active iframe)— 无效
5. 直接在浏览器 console 用 `f.contentWindow.postMessage(...)` 手动测试(完全绕过我们 bridge 代码)— 同样无响应

参考项目 next-ai-draw-io 同样的 postMessage 形态他们能 work,我们不行。**未定位到底层原因**。怀疑方向(未验证):

- Electron renderer + `embed.diagrams.net` 的某种安全策略差异(我们没改 webSecurity,默认值跟普通 Chromium 同)
- drawio 内部 PNG 渲染走 canvas → `toDataURL`,可能命中 cross-origin canvas tainting 但没报错,silently 不响应
- 某个 URL 参数缺失让 drawio 把 export action 静默丢弃

## 4. 沿途撞过又修好的(还是有教训价值)

记录这些是因为它们暴露了 Continuo dev 期的几个真实坑,跟 diagram 无关也会再撞:

### 4.1 CSP 不写 `frame-src` → 跨域 iframe 被 fallback 到 `default-src 'self'` 拦掉

P1 黑屏的根因。`index.html` CSP 加 `frame-src https:` 解决。

### 4.2 自加的 iframe `sandbox="..."` 漏配 → drawio 静默卡 loading

参考项目不用 sandbox,我们防御性加上 `allow-scripts allow-same-origin allow-popups` 反而漏配 drawio 需要的 token。**结论:对受信第三方编辑器,sandbox 弊大于利**(host 已被 CSP `frame-src` 限定)。

### 4.3 IPC subscriber 推全 snapshot 引发 React 多次 re-render → 多次 postLoad 把 drawio 中途打断卡 loading

P2 update 后卡 loading 的第一层。修法:`service.notify` 加 `changed: DiagramSession` 第二参,IPC 精确推变更那个 session(不是末尾、也不是全推)。

### 4.4 drawio 在 `load` 后 echo `autosave`(规范化 xml)→ 触发 load↔autosave 循环

P2 第二层。bridge 加 `lastSeenFromIframeRef` 追踪"iframe 当前显示什么",patch effect 推 iframe 前先比:等于 iframe 已有内容 → 跳过 postLoad。三道 dedup 防线收敛。

### 4.5 Dockview 切 tab 重建 iframe → 新 init 时 pendingRef 已被前次 flush 清空

P2 第三层。bridge 加 `xmlRef` 镜像 prop xml,init handler 从 `pendingRef ?? xmlRef` 取,fresh iframe 总能拉到当前应展示的 xml。

### 4.6 React.StrictMode + Vite HMR 在 dev 期累积 stale `iframeRef` / IPC listener

最深一层。`iframeRef.current` 指向已 detached 的旧 iframe(`contentWindow=null`),但仍是 truthy。同一 push 被多个 listener fire(HMR cleanup 没真清掉)。修法用 `document.querySelector('iframe[title=...]')` 兜底找 active iframe — 但即便如此,P3 png/svg 仍 timeout(意味着 stale ref 不是 png/svg 不通的根因,真正原因见 §3)。

## 5. 决策:为什么放弃

- **P3 png/svg timeout 没法定位**:已穷尽参考项目对照、协议层试错、iframe 源码方向猜测、手动 console 验证。两小时调试无突破。
- **drawio 黑盒**:出站消息没问题,入站消息(`export`)被静默吞,没有 error event,没有 stack trace。继续调下去成本不可控。
- **核心价值有限**:`drawio` 文件导出已工作(直接从 store XML 写盘),**只 PNG/SVG 渲染不可用**。但用户预期 agent 给的图能直接当图用,没 PNG 输出体验降级显著。
- **替代路径成本**:要彻底解决,大概率要换 `<webview>`、自托管 drawio embed、或抄参考项目的轮询架构。这都不是小修。

放弃比硬刚更划算。

## 6. 给"如果重启"的几条建议

1. **优先用 `<webview>` 而非 `<iframe>`**:Electron 原生,更可控。可绕过 cross-origin canvas tainting 之类盲区(未验证)。
2. **抄参考项目轮询架构,不抄 IPC + ref**:参考项目跨进程 polling 看着繁琐,但对 React 生命周期 / HMR 完全免疫。我们直接 IPC + ref 的开发期问题集中在 ref/listener 累积。
3. **打包离线 drawio**(doc/18 计划书原 P4)优先级提到 P1:断网测试更稳,且消除"上游 drawio 行为变化"风险。约 8MB bundle 增量。
4. **`diagram.export` 拆成两阶段** —— `export_xml`(直接走 store,可靠)+ `export_image`(走 iframe,best-effort)。即使 image 不可用,xml 落盘 + 用户在 drawio.com / 桌面版二次导出依然能跑通工作流。
5. **不要用 React.StrictMode 包 iframe-heavy 组件**,或者把 iframe 提到 portal 里作单例 — 避免 dev 期反复 mount。

## 7. 相关 commit(已删,仅记录哈希便于将来 cherry-pick 或挖)

```
75f01de  feat(agent-diagram): P3 — diagram.export 写文件 + 状态栏 chip
dbf17ba  docs: doc/18 §15 P2 实装收尾(已删)
48cd887  fix: tab 切换 fresh iframe 从 xmlRef 回灌
23b9982  fix: bridge 加 lastSeenFromIframe — 修 update 后卡 loading
cd30524  fix: service notify 传 changed + bridge xml 去重
9542c95  feat(agent-diagram): P2 — diagram.update / diagram.get
3b629ba  docs: doc/18 §14 P1 实装收尾(已删)
9e570b7  fix: CSP frame-src + 去掉 iframe sandbox
d4f59f0  feat(agent-diagram): P1 — diagram.create + DiagramViewer
48bbb50  docs: doc/18 计划书(已删)
```

reflog 一段时间内还能找到这些 commit。30 天后随 git gc 清。如果有人想恢复,在 reflog 过期前:

```bash
git checkout 75f01de -b feat/agent-diagram-mcp-resurrect
```
