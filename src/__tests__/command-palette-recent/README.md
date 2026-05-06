# command-palette-recent(命令面板最近执行)

行为契约:**记录用户在 CommandPalette 执行过的 commands**,空 query 时
最近 5 个置顶显示(VSCode 同款 "Recently used" 段)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/recent.ts` | useRecentCommandsStore + localStorage 持久化 |

需 export 的形态:

```ts
export interface RecentEntry {
  readonly id: string;
  readonly ts: number;
}

interface RecentState {
  readonly list: readonly RecentEntry[];
  record(id: string): void;
  clear(): void;
}

export const useRecentCommandsStore: UseBoundStore<...>;
```

## 关键行为

### record(id)

- 把 id 移到列表头部(最近一次执行优先)
- 重复 record 同 id → 更新 ts,仍在头部
- 列表上限 `MAX_RECENT=20`,溢出从尾部丢弃
- localStorage 同步写(key: `continuo:command-palette:recent`)

### list

- 按 ts 降序(最新在前)
- 启动时从 localStorage 读回(JSON.parse 失败 → 空数组)

### clear

- 清空 list + 清 localStorage

### 持久化

- localStorage 不可用(SSR / 隐私模式)→ in-memory 仍可用,record 静默
- JSON 解析失败 → 视为空(不抛)

## 不在本主题验证

- CommandPalette UI 怎么消费 recent(由 command-palette topic 持有)
- 排序合并(空 query 时 recent 前 N + 其余字母序)— 由 command-palette UI 持有
