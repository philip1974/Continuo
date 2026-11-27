# 自动保存可配置(对照 VSCode `files.autoSave` / `files.autoSaveDelay`)

此前只有 Markdown 停手 2 秒自动保存(`autoSave.markdown.enabled` / `autoSave.delayMs`),代码文件无法开启自动保存。
对齐 VSCode(`src/vs/workbench/browser/parts/editor/editorAutoSave.ts`、`filesConfigurationService.ts`)加上全局自动保存设置,
**默认行为不变**:Markdown 仍停手 2 秒自动保存,代码默认不自动保存。

## 行为

### 1. 设置项(`auto-save-config.spec.ts`)

| id | 类型 | 默认 | 说明 |
|---|---|---|---|
| `files.autoSave` | select | `off` | `off` / `afterDelay` / `onFocusChange` / `onWindowChange`(VSCode 桌面版默认 off) |
| `files.autoSaveDelay` | number(ms) | 1000 | `afterDelay` 的延迟,夹取到 100–60000(VSCode 默认 1000,不设上限) |
| `autoSave.markdown.enabled` | boolean | true | **Markdown 的语言级覆盖**(相当于 VSCode `"[markdown]": { "files.autoSave": "afterDelay" }`):开 → Markdown 总在停手后自动保存,不看 `files.autoSave`;关 → Markdown 跟随 `files.autoSave` |
| `autoSave.delayMs` | number(ms) | 2000 | Markdown 覆盖的延迟(相当于 `"[markdown]": { "files.autoSaveDelay": 2000 }`),500–10000 |

沿用既有两个 Markdown 设置的 id(用户已保存的值不丢);设置页三语描述写明「Markdown 默认自动保存,不受上面的设置影响」。

每个文件的生效模式(`resolveAutoSave`):

- 无路径 / 无标题文件 → 不自动保存(VSCode:never auto save untitled)
- Markdown 且 Markdown 覆盖开启 → `afterDelay`(Markdown 延迟)
- 其它 → `files.autoSave`(`afterDelay` 用 `files.autoSaveDelay`)

### 2. 触发时机(`auto-save-triggers.spec.tsx`)

- `afterDelay`:内容停止变化 delay 后保存(既有 Markdown 行为推广到所有文件类型:代码、Markdown 编辑 / 源码模式、非 UTF-8 编码同一条保存路径)
- `onFocusChange`:不按延迟保存;编辑器失焦(焦点移出该编辑器组面板:切到终端 / 资源管理器 / 别的编辑器组 / 命令面板)、切到同组另一个 tab、
  编辑器所在窗口失焦 → 保存(VSCode:活动编辑器切换 / 编辑器 onDidBlur / 窗口失焦 都触发 FOCUS_CHANGE 或 WINDOW_CHANGE)
- `onWindowChange`:只在编辑器所在窗口失焦时保存;切 tab / 焦点移到同窗的终端不保存
- 窗口失焦时保存该编辑器组里**全部**符合条件的脏 tab(VSCode saveAllDirtyAutoSaveables),不只活动 tab
- popout 子窗里的编辑器:按它所在的子窗失焦判断(子窗 → 主窗也算该子窗失焦)
- 失焦保存前先把 Markdown 编辑视图尚未上抛的输入同步回写(否则最后 200ms 的输入不在保存内容里)
- **打开自动保存时立即保存已有的脏文件**(VSCode `editorAutoSave.onDidChangeAutoSaveConfiguration` → `saveAllDirtyAutoSaveables`):
  自动保存设置变化(命令 / 文件菜单切换、设置页修改,含别的窗口改的)后 `files.autoSave` 不是 `off` → 每个编辑器组立即保存组内全部
  生效模式不是 off 的脏 tab(活动 tab 与后台 tab),不等延迟 / 失焦;跳过无标题、已删除、删除确认中的;磁盘冲突 / 写保护照常不覆盖、
  只提示一次。切到 `off`、`files.autoSave` 仍为 `off` 时只改 Markdown 覆盖、窗口打开时已开启(挂载)都不触发;关闭确认框开着时不保存。
  多窗口各自保存自己的脏文件

### 3. 沿用既有规则(各触发方式一致)

无标题不自动保存;已删除(orphaned)暂停并提示一次;关闭脏 tab 确认框 / Explorer 删除确认期间暂停;磁盘被外部修改(冲突)不覆盖、
写保护不去写保护、不可编码字符等失败只在 ok→失败时提示一次(同一文件提示替换不叠加);预览 tab 自动保存后是否转常驻按既有保存逻辑。
关窗时活动 tab 的待保存改动由关窗 flush 落盘(不计入「未保存」确认,同既有 Markdown);`countDirtyForClose` 按每个 tab 的生效模式判断。

### 4. 菜单与命令(`auto-save-menu.spec.ts`)

- 命令 `workbench.action.toggleAutoSave`(「文件:切换自动保存」/ File: Toggle Auto Save / 파일: 자동 저장 설정/해제):`files.autoSave` 为
  `afterDelay` / `onFocusChange` / `onWindowChange` → `off`,否则 → `afterDelay`(VSCode filesConfigurationService.toggleAutoSave)
- 文件菜单「全部保存」后分隔线 + 「自动保存」勾选项:勾选 = `files.autoSave` ≠ off(VSCode `toggled: config.files.autoSave != off`);
  点击执行上面的命令。勾选状态由 renderer 推给 main(`window:set-menu-checked`),设置变化(含别的窗口改的)后菜单随之重建
- Markdown 覆盖不影响勾选状态(VSCode 的语言级覆盖同样不影响该菜单项)

### 5. 多窗口

设置值经 localStorage 跨窗同步(既有 values-store),各窗口的编辑器即时按新模式工作,菜单勾选随之更新。

## 与 VSCode 的差异

- 语言级覆盖只做 Markdown 这一项(专用设置,不做通用 `[lang]` 语法)
- 不做 `files.autoSaveWorkspaceFilesOnly`、`files.autoSaveWhenNoErrors`
- 切到同组别的 tab 时(afterDelay / onFocusChange)保存的是被切走的 tab 的待保存改动;后台 tab 的改动在窗口失焦时保存

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/core-setting-specs.ts` | `FILES_AUTO_SAVE` / `FILES_AUTO_SAVE_DELAY` 设置 spec |
| `src/panels/Editor/auto-save-config.ts` | `resolveAutoSave` / `useAutoSaveSettings` / `toggleAutoSave` / 命令 spec |
| `src/panels/Editor/auto-save.ts` | 调度器(`delayMs: null` = 只在 flush 时保存) |
| `src/panels/Editor/useAutoSave.ts` | 失焦 / 窗口失焦触发 |
| `src/panels/Editor/EditorPanel.tsx` | 按活动 tab 的生效模式驱动 useAutoSave,跟踪 popout 搬移后的所在窗口 |
| `src/shell/dock/dirty-close.ts` | 关窗计数按生效模式 |
| `electron/main/menu-checked.ts`、`electron/main/app-menu.ts` | 菜单勾选状态 |
| `src/shell/menu-commands.ts` | 推送勾选状态 |

## E2E

`tests/e2e/files-auto-save.spec.ts`:默认 md 自动 / ts 不自动;Markdown 覆盖关 + off → md 不写盘;afterDelay 下 ts 自动写盘;
onFocusChange 切 tab / 终端时保存;onWindowChange 窗口失焦保存;菜单 / 命令切换;打开自动保存(命令 / 设置页)立即保存已有脏文件,多窗口各自保存。
