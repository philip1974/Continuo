# ResultMessage(带严重度的操作结果 live region)

行为契约:**异步操作结果按严重度经 live region 播报:失败 role=alert,成功 role=status;无消息不渲染。**

设置 → 插件(安装 / 卸载 / 生命周期操作)、插件市场 Git URL 安装段、商店卡片安装 / 更新三处共用(A42-A44 族,
此前各写一份)。

## 接线守卫

PluginsTabContent、MarketplaceTab 渲染 `<ResultMessage`,且不再内联 `isError ? 'alert' : 'status'`。
