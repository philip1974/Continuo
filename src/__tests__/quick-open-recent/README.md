# Quick Open「最近打开」(VSCode 对齐)

VSCode 的 Quick Open(⌘P)在查询为空时先列编辑器历史(HistoryService,按工作区持久化、跨重启),首项右侧标
「recently opened」;有查询时历史项按匹配度与文件结果一同排序并优先。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/recent-files.ts` | 按工作区根记最近打开的文件(localStorage)、记录点订阅、`orderByRecent` |
| `src/plugins/quick-open/QuickOpenModal.tsx` | 空查询最近项置顶 + 「最近打开」标签 + 分隔线;有查询同分优先 |

## 行为(`quick-open-recent.spec.tsx`)

### 记录
- 记录点 = 用户激活编辑器 tab(打开 / 切换,editorFocusPulse 递增);会话恢复(requestFocus:false)不记
- 只记当前工作区内的文件;最近在前,重复项移到最前
- 每个工作区 ≤ 50 条,≤ 20 个工作区(最久未用的工作区先淘汰)
- localStorage `continuo:quick-open:recent`,形态 `[{ root, paths }]`;读回逐项校验(非字符串 / 超长路径丢弃)、解析前原始串
  上限 1 MiB;读写异常(畸形 JSON / 配额 / 不可用)不抛,当空列表

### 列表
- 空查询:仍在扫描结果里的最近文件按最近顺序排最前,首行标「最近打开」(三语),其余文件按原顺序在后、首行上方分隔线
- 已删除(不在扫描结果里)的最近文件不显示
- 有查询:最近项在前喂给模糊匹配(稳定排序)→ 同分时最近项优先(VSCode 历史加权的简化);不显示标签

## 端到端
- `tests/e2e/quick-open-recent.spec.ts`:打开两个文件后 ⌘P 空查询,最近打开的排最前并带标签
