# MarketplaceTab(插件商店 SettingTab)

行为契约:**启动调 fetchMarketplaceIndex,loading=spinner;ok=渲染卡片列表 + 搜索框 + tag 过滤 + Git URL 安装段;
error=显示错误 + 提示。每张卡:已安装(installed map)显「已安装」,未装显「安装」按钮 →
coApi.plugins.installFromGit + 记入会话级待重启 store;有可用更新(updateStore)→ 显「更新」按钮 →
mgr.uninstall + installFromGit + refreshUpdates;ratings 显示评分。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/MarketplaceTab.tsx` | UI |
| `src/marketplace/fetcher.ts` | fetchMarketplaceIndex |
| `src/marketplace/update-store.ts` | useAvailableUpdates(可用更新,派生) |
| `src/marketplace/reviews-store.ts` | rating 数据 |
| `src/marketplace/filter.ts` | applyFilter / collectAllTags |

## 关键行为

### loading / error / empty

- 初始 → spinner
- fetch 失败 → 「拉取索引失败:${msg}」;网络类失败(`MARKETPLACE_NETWORK`)msg 为三语「无法连接插件市场,请检查网络后重试」,
  不显示「Failed to fetch」;HTTP 非 2xx 时附「HTTP <状态码>」
- 拉到空数组 → 「暂无插件」+ 索引仓库链接

### 列表渲染 + 计数

- 「显示 N / 共 M 个插件」+ 「⟳ 刷新评分」按钮
- 点刷新评分 → reviewsStore.refresh(true)

### 搜索 / tag

- query 输入 → applyFilter
- tag 多选 → applyFilter
- 选中后显「清除筛选」按钮 → clearTags

### 卡片(MarketplaceCard 受 props 驱动)

- installed=true → 「已安装」disabled
- pendingRestart=true → 「等重启」
- updateAvailable=有 → 「更新」按钮
- installing=true → 「安装中…」
- 点「安装」 → coApi.plugins.installFromGit
  - ok → recordPendingInstall(已在列表的更新 / 覆盖重装不记),msg=「✔ 已安装 …」
  - 抛 / ok=false → msg=「✘ …」

### 卡片窄宽布局(容器查询)

- 卡片根节点是尺寸容器(`@container`);卡片窄于 28rem 时头部可换行、操作按钮独占下一行(`@max-md:basis-full`),
  窄于 24rem 隐藏首字头像 —— 安装按钮不再盖住 Verified 徽标
- 标题行 `flex-wrap`;插件 id 与底部仓库链接 `min-w-0 truncate`(`title` 给全文),不画出卡片;底部作者 / 标签行可换行

### 索引加载失败

- 失败块 `role=alert` 播报原因 + 提示;其外有「重试」按钮(不进 alert 播报内容)
- 点「重试」→ 回到加载态并重新拉取索引(reloadToken 递增重跑拉取 effect,同 QuickOpenModal 扫描失败重试)
- 重试后焦点不丢(「重试」按钮随加载态卸载):加载中焦点在加载状态块(`tabIndex=-1`),成功后移到搜索框,再次失败移到新的「重试」按钮;首次加载不抢焦点

### 评分刷新

- 刷新失败(error 非空)→ 错误文案 `role=alert`
- 未配置 GitHub token(store `unavailable`)是正常状态:默认静默不显示任何提示(对齐 VSCode 市场无鉴权时不报错);
  仅当用户手动点过「刷新评分」才显示一行中性提示(`role=status`、`text-fg-dim`,三语 `marketplace.reviews.unavailable`)

### Git URL section

- 不依赖市场索引:加载中 / 失败(断网)/ 空索引 / 有条目四种状态都渲染「从 Git URL 安装」段(VSCode:离线仍可从 VSIX 安装)
- 安装 / 更新失败文案「安装失败:原因」,不带内部错误码 `[CODE]`(code 已随 data-code / 日志带走);无效 URL(`BAD_URL`)
  文案说明仅支持以 https:// 开头的 Git 仓库地址(main 端 installFromGit 只接受 https://)

- 见 GitUrlInstallSection(同 PluginsTabContent 内嵌但独立 component);成功同样记入待重启 store
  (跨页共享行为见 `pending-installs-store/`)
