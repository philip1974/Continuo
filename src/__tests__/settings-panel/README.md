# settings-panel(设置 Panel · VSCode 同款)

行为契约:**Settings 是 dockview 工作区里的一个普通 panel**(不再是 Modal)。
左侧 tab 导航 + 右侧内容,占满 dockview 分配的空间。订阅 SettingTabRegistry
动态渲染。

> 取代旧 `settings-modal` topic,迁移决策:
>
> 1. 单例 panel — 已存在则聚焦,不存在则新开(VSCode 同款)
> 2. 关闭 panel 后 `activeTabId` 状态保留(下次打开仍在同一 tab)
> 3. Modal 形态彻底删除
> 4. 默认 tab 取首项(priority 升序)

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/store.ts` | useSettingsStore — 仅 `activeTabId` + `setActiveTabId`(无 isOpen / open / close) |
| `src/plugins/settings/SettingsPanel.tsx` | UI:左导航 + 右内容,h-full 占满 |
| `src/core-plugins/SettingsPanelPlugin.ts` | 注册 `settings` panel type + 命令 `settings.toggle`(⌘,);toggle 行为见 `settings-toggle` 主题 |
| `src/shell/dock/dock-api-ref.ts` | `openOrFocusPanel(id, component, title)` helper |

## 关键行为

### SettingsPanel 渲染

- 左侧 nav 列 SettingTabRegistry 中所有 tab(按 priority 升序)
- 右侧 render 当前 active tab 内容
- 无注册 tab → 显示"暂无设置项"空态
- activeTabId 不存在(null / 已被 unregister)→ 兜底取 tabs[0]
- nav button 点击 → setActiveTabId(t.id),右侧内容切换
- 插件运行时 register 新 tab → registry notify → 列表自动更新

### Panel 生命周期(单例)

- `openOrFocusPanel('settings', 'settings', 'Settings')`:
  - panel 不存在 → `api.addPanel({ id, component, title })`
  - panel 已存在 → `panel.api.setActive()`(不重建)
- 用户关 tab → panel unmount,但 `activeTabId` 保留(决策 #2)
- 重新打开 → 还原到关闭前选中的 tab

### Store API

```ts
interface SettingsState {
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
}
```

无 `isOpen` / `open` / `close`(panel 生命周期由 dockview 管)。
原 `open(tabId?)` 调用方改为:`setActiveTabId(tabId)` + `openOrFocusPanel(...)`。

### 命令 `settings.toggle`(⌘,)

- 由 SettingsPanelPlugin 注册,fn 走 `toggleSettingsPanel()` helper
- toggle 语义 + sidebar 副作用 — 见 `settings-toggle` 主题
- 旧命令 ID `settings.open` 已重命名为 `settings.toggle`(行为也变 toggle)

## 不在本主题验证

- dockview API 真实行为(layout 持久化等)— 已由 layout-persistence topic 持有
- Tab registry 排序 / disposable — 已由 setting-tab-registry topic 持有
- 命令注册 / hotkey — 已由 command-hotkeys topic 持有
- Plugin 贡献 settingTab — 已由 plugin-base / plugin-contributions-core 持有
