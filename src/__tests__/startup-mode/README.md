# startup-mode (Issue #30 修复)

行为契约:**冷启动时决策开窗策略 — dock 拖入(显式 workspace)vs 历史恢复**。
纯函数,无 IO 副作用;由 main 端 `whenReady` 流程调用一次。

> 配套 issue:[#30](https://github.com/philip1974/Continuo/issues/30)
>
> Bug:dock 拖文件夹冷启动时叠加了"主窗 + 历史 windows[] 恢复 + 拖入新窗"
> 三条独立开窗路径,导致打开 3 个 window 且 workspace 各不相同。
>
> 修复:启动时根据是否有 dock 缓冲路径,**二选一**走 dock 模式或 restore 模式,
> 不再叠加。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/startup-mode.service.ts` | 纯函数 `pickStartupMode(pendingPaths, isExistingDir)` |
| `electron/main/index.ts` | `whenReady` 后调用,按返回值分支创建窗口 |

## 模型

```ts
type StartupMode =
  | { readonly mode: 'dock'; readonly dirs: readonly string[] }
  | { readonly mode: 'restore' };

function pickStartupMode(
  pendingOpenPaths: readonly string[],
  isExistingDir: (p: string) => boolean,
): StartupMode;
```

## 关键行为

### 缓冲为空 → `{ mode: 'restore' }`

正常启动(双击 .app / Spotlight 启动)→ 没有 dock 拖入路径 → 走历史恢复流程。

### 缓冲全部非目录 → `{ mode: 'restore' }`

dock 拖了文件(而非文件夹)→ Continuo 当前 phase 不支持文件级打开,过滤后等同于无效缓冲。
仍走 restore 流程,不退化为奇怪状态。

### 缓冲有 ≥1 个目录 → `{ mode: 'dock', dirs }`

`dirs` 顺序保留输入顺序;**只含通过 `isExistingDir` 的目录**(文件 / 不存在的路径被过滤)。
调用方:第一个 dir 作主窗(windowSeq=0)workspace,其余各开新窗,**不**调用历史恢复。

### 去重

`dirs` 中若有重复路径,**保留第一次出现**(macOS dock 同次拖入很少重复,但 defensive)。
重复定义为字符串相等,不做规范化(`/x` 与 `/x/` 不同,符合 Electron 给到的原样路径)。

### 不存在的路径 / 文件 → 不进入 dirs

`isExistingDir(p)` 返回 false 的全部跳过。若全部跳过 → 退化为 `{ mode: 'restore' }`。

## 不在本主题验证

- `whenReady` 中的实际开窗副作用(在 `electron/main/index.ts`,通过 e2e 或手动验收)
- `pendingOpenPaths` 的缓冲机制(`app.on('open-file')` 内,简单 push,无需 BDD)
- 历史恢复细节(在 `window-restore` 主题)
