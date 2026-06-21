# explorer-path-utils(Explorer 跨平台路径 helper)

可维护性 M4(codex 协作):Explorer 的跨平台 `dirname`(同时吃 `/` 与 `\`,不引
path-browserify)曾在 `tree-config.ts` / `FolderTree.tsx` / `drop-handlers.ts` /
`mutate-actions.ts` **四处字面复制**,路径边界规则一改要同步四处易漂移。收敛到
`src/panels/Explorer/path-utils.ts` 单一来源,四个文件 import 使用。行为保持。

## 行为契约 — `dirname(p)`

| 输入 | 输出 | 说明 |
|---|---|---|
| `/a/b` | `/a` | 普通父目录 |
| `/a/b/` | `/a` | 先去尾部分隔符 |
| `/a` | `/` | 根下直接项 |
| `a` | `''` | 裸文件名(无分隔符) |
| `C:\x\y` | `C:\x` | Windows 反斜杠 |
| `/a\b` | `/a` | 混合分隔符取最后一个 |

## `basename(p)` / `basenamePreserveTrailing(p)`(M5)

`basename` 与 `dirname` 同 trim 语义(tree-config root entry name / ExplorerHeader 面包屑用);
`basenamePreserveTrailing` 是**不 trim 尾部分隔符**的变体(FolderTree 批量唯一名 picker 用),
单独命名以显式标明语义差异,避免误用 trim 版改变批量重名行为。

| 输入 | basename | basenamePreserveTrailing |
|---|---|---|
| `/a/b` | `b` | `b` |
| `/a/b/` | `b`(trim) | `''`(不 trim) |
| `C:\x\y` | `y` | `y` |

> M5:basename 三处复制(tree-config / ExplorerHeader trim 版 + FolderTree 不 trim 变体)
> 收敛到 path-utils 两个语义命名的 helper。FolderTree 实际输入恒无尾斜杠,故行为逐字保持。
