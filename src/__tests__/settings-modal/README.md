# settings-modal(设置弹窗 UI)

行为契约:**design Modal 浮层,左侧 Tab 列表 + 右侧内容**;订阅
SettingTabRegistry 动态渲染。空态 / 首次打开默认选首项。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/store.ts` | useSettingsStore(isOpen / activeTabId) |
| `src/plugins/settings/SettingsModal.tsx` | UI |

## 关键行为

- `open(tabId?)` 打开弹窗,可指定初始选中 tab
- `close()` 关闭
- 无 tab 注册时显示"暂无设置项"
- activeTabId 不存在时兜底到首项
- ESC / 点遮罩关闭(Modal 内置)
