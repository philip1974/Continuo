# settings-focus-after-action

设置 / 快捷键 / 插件 / 市场页的操作完成后,键盘焦点留在有意义的位置,不掉到 `<body>`(WAI-ARIA APG:被操作的元素
消失或变为不可用时,把焦点移到逻辑上最近的元素):

- 设置项「恢复默认」:重置后按钮变为不可用 / 不可见 → 焦点移到同一行的编辑控件(开关 / 输入框 / 当前选中的分段项)。
- 快捷键「恢复默认」:同上 → 焦点移到同一行的「编辑快捷键」按钮;该行被搜索过滤掉时回到搜索框。
- 卸载插件:确认并成功后 → 焦点移到原位置的下一行(没有则上一行)的「卸载」按钮,列表空了则移到「用户插件」标题;
  同时经 live region(role=status)播报「已卸载 {name}」。
- 市场卡片「安装 / 更新」:进行中用 `aria-disabled`(不用原生 `disabled`,按钮保持可聚焦,焦点不丢),重复点击不会重复触发;
  安装成功后同一按钮变为「已安装」(同样 `aria-disabled`),焦点仍在它上面。design `Button` 为 `aria-disabled="true"`
  提供与 `:disabled` 相同的视觉(半透明、禁止光标、无 hover 态)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/SettingItemRow.tsx` | 重置后聚焦本行控件 |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 重置后聚焦本行编辑按钮 |
| `src/plugins/settings/PluginsTabContent.tsx` | 卸载后焦点 + 成功播报 |
| `src/marketplace/MarketplaceTab.tsx` | 卡片按钮 aria-disabled |
| `src/design/Button.css` | aria-disabled 视觉 |
