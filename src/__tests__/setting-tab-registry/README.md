# setting-tab-registry(设置标签贡献)

行为契约:**Plugin 通过 `this.addSettingTab({ id, title, render })` 注入设置弹窗
左侧标签**;Settings UI(`SettingsModal`)订阅本 registry,左侧 Tabs 列表 + 右侧
内容区。Continuo 自身的"通用设置"也是一个标签项,与插件平等。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/SettingTabRegistry.ts` | SettingTabRegistry + SettingTabSpec |
| `src/plugins/Plugin.ts`(扩展) | `addSettingTab` 代理 |
| `src/plugins/settings/SettingsModal.tsx` | Settings UI(后续 v2.4 UI 阶段) |

## 关键行为

### SettingTabSpec

- `id`(全局唯一)
- `title`(标签名)
- `render(): ReactNode`(标签内容,通常是表单)
- `priority?`(排序,默认 100,小靠前)

### Registry 共通行为

- `register(spec)` → Disposable;dispose 后 getAll 不含
- 重复 id → 后注册赢 + warn
- subscribe 在 register/dispose 时触发
- `getAll()` 按 priority 升序

### Plugin.addSettingTab

- 内部 `this.app.settingTabs.register(spec)` → `this.register(d)`
- _deactivate 自动移除
