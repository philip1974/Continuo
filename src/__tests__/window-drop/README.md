# 拖文件夹到窗口(`pickDroppedDirectory`)

行为契约:**用户拖文件夹到 Continuo 窗口,当前窗口换 workspace(VSCode 同款)**;
混合内容取第一个文件夹,空 dataTransfer 不处理。拖入普通文件 → 在编辑器里打开(见 `os-file-drop`)。issue #23 衍生 UX 缺口。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/window-drop.ts` | 纯函数 `pickDroppedDirectory(dataTransfer, getPath, isDir)` |
| `src/shell/App.tsx` | useEffect 挂 dragover/drop 全局监听,经 `switchToCheckedRoot`(与「最近打开」共用:去重聚焦别的窗口 / 过期作废 / setRoot 后焦点交给新文件树,见 `explorer-commands/README.md` §4)切换 |

## 关键行为

### 单个目录 drop → 返回路径

`isDir(path)` 返 true 时确认是目录,返路径。

### 多个 item 中含目录 → 返回第一个目录

VSCode 同款。混合 dataTransfer 不报错。

### 全部是文件 → 返 null

本函数只关心目录 → workspace;普通文件在编辑器里打开(`os-file-drop`)。

### 空 dataTransfer → 返 null

dataTransfer.files.length === 0 → 防御性返 null,不抛。

### 纯文件拖入不做目录探测(性能)

`captureDropCandidates` 在 drop 回调里同步用 `webkitGetAsEntry` 判定每个文件型 item:
全部可判定 → 只把目录(保持原顺序)交给 `resolveDroppedWorkspace`,纯文件拖入零 `listDir` IPC;
任一无法判定(API 缺失 / 返 null / items 与 files 对不上)→ 回退原逻辑,全部文件逐个探测。

### 落在 Explorer 文件树内 → 只复制,不切 workspace(`explorer-vs-window-folder-drop.spec.tsx`)

拖文件夹到 Explorer 文件树(空白处 / `[role=tree]` 容器本身)由 Explorer 复制进落点目录,
`FolderTree` 的外层 `handleDrop` 对 OS 文件 drop `stopPropagation`,不再冒泡到 App 的 window 级监听
(此前会复制完又把 workspace 切到源文件夹;行级 drop 原本就由 headless-tree stop)。
落在 Explorer 以外(dockview 区域、主布局空白)仍打开为 workspace。

不在 App 监听里判 `defaultPrevented`:dockview 根 Droptarget 的 drop 无条件 `preventDefault`
(无 overlay state 亦然),那样会打断「拖到 dock 区域打开为 workspace」—— 本规范用真实 `DockviewReact` 钉住。
