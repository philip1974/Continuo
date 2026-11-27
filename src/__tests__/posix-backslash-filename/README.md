# posix-backslash-filename(macOS / Linux 上文件名含 `\`)

行为契约:macOS / Linux 上 `\` 是合法文件名字符(`a\b.txt` 是一个文件)。编辑器 tab、窗口标题、状态栏、资源管理器的名字
与父目录计算**只按 `/` 切分**;只有 Windows 运行时(`navigator.platform` 以 Win 开头,renderer 平台工具 `isWindowsRuntime`)
或路径本身是 Windows 形态(盘符 `C:` / UNC `\\`)时 `\` 才算分隔符。

对齐 VSCode:`vs/base/common/path` 按运行平台选 posix / win32 实现,posix 的 basename / dirname 只认 `/`。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/path-cross.ts` | `backslashIsSeparator` / `lastSeparatorIndex` / `splitPathSegments`(单一来源);`basename` / `dirname` / `joinPath` 用它 |
| `src/lib/path-label.ts` `basenameForChrome` | tab / 标题 / 状态栏展示名 |
| `src/panels/Explorer/path-utils.ts` `basenamePreserveTrailing` | 资源管理器确认框 / toast 里的名字 |
| `src/panels/Editor/tab-label-description.ts` | 同名 tab 的父目录后缀 |
| `src/panels/Explorer/tree-config.ts` `isHiddenWithinRoot`、FolderTree 自动定位排除目录 | 相对路径切段 |
| `CodeEditor.languageDescriptionFor`、`link-resolve` 当前文件目录 | 同类切分 |

## 关键行为

- macOS:`/w/a\b.txt` 的名字是 `a\b.txt`,父目录是 `/w`;在 `/w/x\y` 下新建 `f` → `/w/x\y/f`。
- `/w/x\.y`(名字是 `x\.y`,不以 `.` 开头)不算隐藏项。
- Windows 运行时 / Windows 形态路径:`C:\w\a.txt` 的名字仍是 `a.txt`(行为不变)。
