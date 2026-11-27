# 在文件中查找 / Quick Open 遵从忽略文件(VSCode `search.useIgnoreFiles`)

VSCode 的在文件中查找与 Quick Open(⌘P)默认遵从 `.gitignore` / `.ignore`(`search.useIgnoreFiles` 默认 true;ripgrep 传
`--no-require-git`,非 git 仓库同样读;`search.useParentIgnoreFiles` 默认 false,不读工作区之上的)。搜索视图排除框里的
「使用排除设置与忽略文件」开关(默认开)关掉时,本次搜索既不用排除设置也不用忽略文件。旧实现只有固定的工作区排除表
(`WORKSPACE_SCAN_EXCLUDE`),`.gitignore` 里的产物 / 日志 / 本地配置照样出现在结果与 ⌘P 里。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs/list-dir.ts` | `scanDir({ useIgnoreFiles })`:递归时逐层读 `.gitignore` / `.ignore`(`ignore` 包,gitignore 语法),被忽略的不列出、目录不下钻 |
| `electron/main/search/text-search.ts` | 查询的 `disregardIgnoreFiles` / `disregardExcludeSettings` → 扫描选项 |
| `src/plugins/quick-open/walk-files.ts` · `QuickOpenModal.tsx` | 按设置传 `useIgnoreFiles`,设置变化重扫 |
| `src/panels/Search/search-store.ts` · `SearchPanel.tsx` | 「使用排除设置与忽略文件」开关(持久化随搜索输入)、按设置与开关组装查询 |
| `src/plugins/settings/core-setting-specs.ts` | `search.useIgnoreFiles`(默认开,三语,资源管理器设置页「搜索」组) |

## 行为(`search-ignore-files.spec.ts`)

- 规则语法:通配(`*.log`)、目录(`tmp/`,只匹配目录)、锚定(`/root-only.txt` 只在该忽略文件所在目录)、`**`、否定(`!keep.log`)
- 嵌套:子目录的 `.gitignore` 作用于其下,并可用 `!` 取消上层的忽略;同一目录 `.ignore` 优先于 `.gitignore`
- 被忽略的目录不下钻(其下的 `!` 不能重新包含,git 同);不要求是 git 仓库;不读工作区根之上的忽略文件
- 关闭(`useIgnoreFiles: false` / 设置关 / 视图开关关)→ 与之前一致(忽略文件里的文件照常出现);视图开关关时构建产物目录
  (`dist` / `build` …)也照常搜,`.git` / `node_modules` 等版本控制与依赖目录仍排除
- 已打开编辑器的内容照常在内存里搜(VSCode `getLocalResults` 同,不看忽略文件)
- 忽略文件过大(> 1 MiB)/ 读不了 → 视作没有规则

## 性能

扫描每个目录多两次 open 尝试(`.gitignore` / `.ignore`,多为 ENOENT)。实测见提交说明。
