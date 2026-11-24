# useCloseWhenGone(弹窗目标从实时列表消失即关闭)

行为契约:**弹窗持有打开瞬间捕获的目标;目标在实时列表中不再存在(按调用方给的判定)时自动关闭弹窗。**

防过期快照(R50 / R102 / R103 族):快捷键编辑弹窗(命令被注销)、插件权限编辑弹窗(插件被卸载)、卸载确认弹窗
(插件被卸载或同 id 重装成新版本)共用(此前三处各写一份 useEffect)。

## 行为

- 目标为 null → 不调用 close。
- 目标仍存在 → 不调用 close;列表变化后目标消失 → 调用一次 close。
- 判定函数与 close 取最新一次渲染传入的(调用方可传内联函数)。

## 接线守卫

KeybindingsTabContent、PluginsTabContent 调用 `useCloseWhenGone(`。
