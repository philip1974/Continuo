# tab 右键菜单(对齐 VSCode 编辑器标签右键菜单)

编辑器文件 tab(`EditorHeader` 的 `TabNavItem`)与 dock 面板 tab(`SharedTab`:终端 / 设置 / Debug / 输出 / 编辑器组 / 插件
面板)右键弹出菜单;此前只处理中键,右键无反应。外壳共用 `src/lib/TabContextMenu.tsx`(Radix ContextMenu + design
`MenuItem`,同 Explorer / 终端右键菜单),菜单画在 tab 所在文档(popout 子窗里画在子窗)。

## 菜单项

| tab | 项(VSCode 同名同序) |
|---|---|
| 编辑器文件 tab | 关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 ─ 复制路径 / 复制相对路径 ─ 在 Finder 中显示 |
| dock 面板 tab | 关闭 / 关闭其他 / 关闭右侧 ─ 全部关闭(面板无「已保存」概念,不列「关闭已保存」) |

- 「关闭其他」只有一个 tab 时禁用;「关闭右侧」在最右 tab 上禁用。
- 复制相对路径相对当前 workspace 根(无根 → 绝对路径);复制 / 显示失败给 toast(同 Explorer)。已删除(orphaned)的文件
  tab「在 Finder 中显示」禁用。
- 文案三语(`shell.tab.ctx.*`;路径项复用 `panels.explorer.ctx.*`)。

## 关闭语义(VSCode `editorGroupView.closeEditors` / `handleCloseConfirmation`)

- 目标集合(`src/lib/tab-close-targets.ts`,按 tab 顺序):关闭 = 自己;关闭其他 = 除自己外全部;关闭右侧 = 自己右边的;
  关闭已保存 = 不脏的;全部关闭 = 全部。
- **编辑器 tab**(`src/panels/Editor/tab-batch-close.ts` + `EditorPanel`):单个关闭与批量关闭同一路径。按顺序逐个确认仍脏
  的 tab —— 沿用现有「保存 / 不保存 / 取消」确认框,批量时先切到该 tab;**全部确认完才一起关闭**;任一处「取消」→ 整批都不
  关(先前选「保存」的已落盘,先前选「不保存」的也不关)。「保存」遇磁盘已被外部修改 / 写保护 → 走该文件已有的覆盖确认:
  「覆盖」/「放弃并重新加载」成功 → 接着确认下一个脏 tab(VSCode 同:保存成功即继续);该确认「取消」或写盘 / 还原失败
  → 整批结束、一个都不关。其它保存失败 → 失败提示,整批结束。
  「全部关闭」遇脏文件即逐个确认,与 VSCode 组内「全部关闭」一致(VSCode 跨组「关闭所有编辑器」/ 关窗才是一次性列多文件
  的确认,对应本仓库关窗流程 dirty-close)。
- **dock 面板 tab**(`closePanelsInOrder`,对齐 VSCode `closeEditors`):先按顺序逐个跑各面板的关闭确认(终端运行中程序;
  确认框同时只有一个),全部放行后再按序统一 `api.close()`(关闭动画照旧,此时不再重复确认);任一处选「取消」→ 整批都不关
  (含前面已放行的)。单个关闭(× / 中键 / ⌘W / 右键「关闭」)仍是 `api.close()` 先问再关。

## 键盘

tab 聚焦时 **Shift+F10 / 菜单键** 在 tab 左下角打开菜单(与终端右键菜单同一判定 `src/lib/context-menu-key.ts`);菜单内
方向键 / Enter / Esc 由 Radix 负责。双击 tab / 双击 tab 栏空白不做(前几轮已评估)。

## 规范

`tab-context-menu.spec.tsx`(目标集合、批量确认推进、两类 tab 的菜单项与动作、键盘打开、dock 批量关闭先问完再关 / 遇取消
整批不动);`editor-batch-close-confirm.spec.tsx`(编辑器批量关闭中途遇写保护 / 磁盘冲突确认后继续或整批结束);
真机 e2e `tests/e2e/tab-context-menu.spec.ts`(编辑器 tab 全部关闭遇脏文件确认、遇写保护覆盖后继续、dock tab 关闭其他)。
