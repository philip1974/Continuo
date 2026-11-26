# popout-open-target(活动组在 popout 子窗时,主窗入口打开面板的落点)

背景:dockview `addPanel` 不给 position 时落进**活动组**。面板弹出到 popout 子窗后活动组就是子窗的组,此后从主窗入口
(齿轮 / 应用菜单 / 命令面板 / ⌘, / ⌘T / 插件 `app.dock.openPanel` / 打开文件)新建的面板都落进子窗,主窗里看不到;
⌘, toggle 只看 `api.isActive`,再点一次会把子窗里看不见的设置关掉。

对齐 VSCode:**在触发的窗口打开**;已打开的编辑器在其所在窗口激活并聚焦该窗口。主窗入口(全局热键只挂主窗 document,
见 `popout-panel-keyboard`)触发的打开都按「主窗」处理。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/group-mru.ts` | `mainWindowAddPosition(api)`:主窗入口新建面板的落点;`mainWindowActivePanel(api)`:主窗正显示的活动面板 |
| `src/shell/dock/dock-api-ref.ts` | `openOrFocusPanelNow` 未给 position 时用 `mainWindowAddPosition`;已存在 → `revealDockPanel`(在子窗则聚焦子窗与面板内容) |
| `src/lib/toggle-settings-panel.ts` | ⌘, / 齿轮 toggle:主窗正显示才关闭 |
| `src/shell/dock/DockReconciler.ts` | 新终端无 grid 参照时的落点(`gridFallbackPosition`)没有可见 grid 组 → 同上 |
| `src/shell/dock/DockShell.tsx` | 用户打开文件时补建的 editor 面板同上 |

## 行为(`popout-open-target.spec.ts`,editor 补建见 `dock-reconciler-api-rebuild/restore-after-fromjson.spec.tsx`)

### 新建面板落点(无显式 position)

- 活动组在主窗(grid / 浮动组)且可见 → 照旧落在活动组
- 活动组是主窗里**隐藏的 popout 引用组**(整组弹出后 dockview 留在 grid 里的 0 宽空组;主窗关光其余面板后 dockview 兜底
  把它设为活动组)→ 同活动组在 popout 处理,不落进去(此前「显示输出」/ ⌘, / ⇧⌘F / 新终端都进了这个看不见的组:主窗
  dock 空白、空态消失)
- 活动组在 popout 子窗 → 落在主窗最近使用的组(group MRU);主窗没有带面板的组 → 可见的 grid 组;都没有 → 在主窗 grid
  新建一组
- 覆盖:设置(⌘, / 齿轮 / 命令)、经 `openOrFocusPanel` 的单例面板(插件 `app.dock.openPanel`)、新终端(⌘T / 命令,
  无 grid 终端可作参照时)、用户打开文件时补建的 editor 面板
- 显式 position(dock 标题栏「⋯」菜单 → 落在菜单所在组,含子窗里的菜单)不受影响

### 已存在的单例面板在 popout 子窗

- 主窗入口再打开 → 在其所在窗口激活,聚焦该子窗(dockview 只在活动组变化时 focus 子窗,子窗组已是活动组时不会)并把焦点交给面板内容;
  不另开、不移回主窗

### ⌘, / 齿轮 toggle

- 设置在主窗**正显示**(主窗的活动面板;活动组在子窗时取主窗最近使用组的活动面板)→ 关闭
- 设置在主窗但被别的 tab 遮住 → 激活
- 设置在 popout 子窗(即便是活动面板)→ 不关闭,在子窗激活并聚焦子窗;主窗侧栏不收起

## 不在本主题验证

- 真实 Electron 子窗的系统焦点切换(e2e)
