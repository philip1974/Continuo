# shell-path-label(shell chrome 路径展示名)

可维护性 M11(codex 协作):`TitleBar.tsx` 与 `StatusBar.tsx` 各自复制同一段
`basename(p) = p.match(/[^/\\]+$/) ? m[0] : p`,用于 workspace / active file 在标题栏 /
状态栏的展示名。收敛到 `src/shell/path-label.ts` 的 `basenameForChrome`,两文件 import 使用。

## 行为契约 — `basenameForChrome(p)`

- 取路径最后一段(同时吃 `/` 与 `\`):`/a/b/c` → `c`、`C:\x\y` → `y`
- 无分隔符 → 返回原串:`foo` → `foo`
- **不 trim 尾部分隔符**:`/a/b/` → `/a/b/`(正则末尾匹配不到 → 返原串)

> 注:与 Explorer `path-utils.basename`(先 trim 尾斜杠再取段)**语义不同**,刻意单独命名
> `basenameForChrome`,避免 chrome 展示规则与文件树规则被误合并。
