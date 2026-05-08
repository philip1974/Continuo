# MarketplaceTab(插件商店 SettingTab)

行为契约:**启动调 fetchMarketplaceIndex,loading=spinner;ok=渲染卡片列表 + 搜索框 + tag 过滤 + Git URL 安装段;
error=显示错误 + 提示。每张卡:已安装(installed map)显「已安装」,未装显「安装」按钮 →
coApi.plugins.installFromGit + setInstall.pending;有可用更新(updateStore)→ 显「更新」按钮 →
mgr.uninstall + installFromGit + refreshUpdates;ratings 显示评分。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/MarketplaceTab.tsx` | UI |
| `src/marketplace/fetcher.ts` | fetchMarketplaceIndex |
| `src/marketplace/update-store.ts` | available updates |
| `src/marketplace/reviews-store.ts` | rating 数据 |
| `src/marketplace/filter.ts` | applyFilter / collectAllTags |

## 关键行为

### loading / error / empty

- 初始 → spinner
- fetch 失败 → 「✘ 拉取索引失败:${msg}」
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
  - ok → setInstall.pending 加 entry.id,msg=「✔ 已安装 …」
  - 抛 / ok=false → msg=「✘ …」

### Git URL section

- 见 GitUrlInstallSection(同 PluginsTabContent 内嵌但独立 component)
