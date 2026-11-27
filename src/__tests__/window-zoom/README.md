# 窗口缩放级别:所有窗口统一、可设置、重启保持(VSCode window.zoomLevel)

行为契约:**界面缩放是一个全局设置值 `window.zoomLevel`(默认 0,范围 -8..8,每级 ±20%,可填小数)。主窗、⇧⌘N 新开的窗口、
弹出到独立窗口的编辑器组(popout 子窗)始终同一缩放;重启后保持。设置页「通用」可改、可恢复默认,改动即时作用于所有窗口。
放大 / 缩小 / 重置缩放命令(命令面板 / 菜单 / 快捷键)改的就是这个设置值。**

## 背景(修复前)

缩放用 Electron 菜单 role(`zoomIn` / `zoomOut` / `resetZoom`)与 `window:view-action` 只改发起窗口的 `webContents.zoomLevel`;
Chromium 按完整 URL 记缩放(`per_host_zoom_levels`,键含 `?windowSeq=N`)→ 只有 seq 0 主窗重启后保留,popout 子窗与新窗口
总是 0,同一窗口内的编辑器组字号不一。设置页没有缩放项;命令面板「查看: 放大」不显示键;搜「缩放」找不到放大 / 缩小;
role `zoomIn` 的键是 `CmdOrCtrl+Plus`,macOS US 键盘 ⌘= 可能触发不了。

## 对照 VSCode

- `src/vs/workbench/electron-browser/desktop.contribution.ts`:`window.zoomLevel`(number,默认 0,min `MIN_ZOOM_LEVEL` /
  max `MAX_ZOOM_LEVEL`,「Adjust the default zoom level for all windows… 20%… decimals」)与 `window.zoomPerWindow`(默认 true)。
- `src/vs/platform/window/electron-browser/window.ts`:`MIN_ZOOM_LEVEL = -8` / `MAX_ZOOM_LEVEL = 8`,`applyZoom` 夹取。
- `src/vs/workbench/electron-browser/actions/windowActions.ts` `BaseZoomAction`:放大 / 缩小 = 当前级别 ±1 后 `Math.round`,越界不动;
  `zoomPerWindow=false` 时写设置 `window.zoomLevel` 并作用于所有窗口,重置 = 0。默认键:放大 ⌘= / ⇧⌘= / ⌘Numpad+,缩小 ⌘- /
  ⇧⌘- / ⌘Numpad-,重置 ⌘Numpad0。
- 辅助窗口(`auxiliaryWindowService`)建出时继承主窗缩放。

**差异(刻意)**:Continuo 不提供 `window.zoomPerWindow`,固定采用其 `false` 语义(全局统一、写设置、持久化)——问题本身即
「窗口之间 / 同窗编辑器组缩放不一致」。重置另留 ⌘0 为主键(此前菜单 role 的键;无小键盘的笔记本可用),⌘Numpad0 为附加键。
Linux 上 VSCode 缩小不绑 ⇧Ctrl-,此处各平台同一组键。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/window-zoom.ts` | `MIN_ZOOM_LEVEL` / `MAX_ZOOM_LEVEL` / `clampZoomLevel`(main 与 renderer 共用) |
| `electron/main/services/window-zoom.service.ts` | 内存态 + `userData/window-zoom.json` 缓存;`setWindowZoomLevel` 套用到所有窗口;`trackWindowZoom` 每次导航 / 加载套用 |
| `electron/main/ipc/window.ipc.ts` | `window:set-zoom-level` `{ level }`(strict,finite) |
| `electron/main/index.ts` | 启动 `loadWindowZoom()`(先于首窗);`browser-window-created`(主窗 + popout)`trackWindowZoom` |
| `electron/main/app-menu.ts` | 显示菜单的重置缩放 / 放大 / 缩小 = 命令项(accelerator 来自 renderer 生效键位) |
| `src/plugins/settings/core-setting-specs.ts` | `WINDOW_ZOOM_LEVEL`(通用 tab) |
| `src/plugins/settings/ZoomLevelFromSettings.tsx` | 设置值 → main(挂载与变化时推) |
| `src/shell/window-commands.ts` | `workbench.action.zoomIn` / `zoomOut` / `zoomReset`(改设置值 + 默认键) |

## 规范文件

- `window-zoom-main.spec.ts`:main 侧 IPC / 套用 / 持久化 / 接线 / 菜单
- `window-zoom-settings.spec.tsx`:设置项、命令、默认键、桥、命令面板可搜

## 关键行为

1. 设置项 `window.zoomLevel`:通用 tab,number,默认 0,min -8,max 8,三语标题 + 说明;「恢复默认」= 0。
2. `window:set-zoom-level { level }`:非有限 / 非数字 / 多余字段拒绝;越界夹到 [-8, 8];立即对所有窗口(含 popout)
   `setZoomLevel`(已相同不重设);缓存到 `userData/window-zoom.json`(值未变不写)。
3. 冷启动:`loadWindowZoom()` 读缓存(缺失 / 损坏 / 超大 / 字段非法 → 0,不抛),与主题同批先于首个窗口;每个窗口
   (主窗、新窗口、popout)的主框架 `did-navigate` / `did-finish-load` 都套用统一级别,覆盖 Chromium 按 URL 记的旧值。
4. renderer 桥:挂载即推当前设置值,值变化(设置页 / 命令 / 别的窗口经 storage 同步)再推;挂载时失败只记日志,之后失败给提示。
5. 命令:放大 / 缩小 = `Math.round(当前 ± 1)`,越过 [-8, 8] 不动;重置 = 删掉设置覆盖(回到 0)。默认键:放大 `mod+=`
   (附加 `mod+shift+=`、`mod+numpad_add`),缩小 `mod+-`(附加 `mod+shift+-`、`mod+numpad_subtract`),重置 `mod+0`
   (附加 `mod+numpad0`);命令面板显示主键。
6. 菜单「显示」的重置缩放 / 放大 / 缩小是命令项(不再是 role),mac accelerator 显示 `Command+0` / `Command+=` / `Command+-`。
7. 命令面板:中文搜「缩放」、英文别名搜「zoom」都能找到放大 / 缩小 / 重置缩放。

## e2e

`tests/e2e/window-zoom.spec.ts`:主窗放大后 popout 子窗与新窗口一致;重启后保持;设置页改值即时生效到所有窗口;重置。
