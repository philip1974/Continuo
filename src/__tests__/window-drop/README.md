# 拖文件夹到窗口(`pickDroppedDirectory`)

行为契约:**用户拖文件夹到 Continuo 窗口,当前窗口换 workspace(VSCode 同款)**;
拖文件、混合内容、空 dataTransfer 不处理。issue #23 衍生 UX 缺口。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/window-drop.ts` | 纯函数 `pickDroppedDirectory(dataTransfer, getPath, isDir)` |
| `src/shell/App.tsx` | useEffect 挂 dragover/drop 全局监听,绑 setRoot |

## 关键行为

### 单个目录 drop → 返回路径

`isDir(path)` 返 true 时确认是目录,返路径。

### 多个 item 中含目录 → 返回第一个目录

VSCode 同款。混合 dataTransfer 不报错。

### 全部是文件 → 返 null

文件 drop 由 editor 自己处理(后续 Phase),本函数只关心目录 → workspace。

### 空 dataTransfer → 返 null

dataTransfer.files.length === 0 → 防御性返 null,不抛。
