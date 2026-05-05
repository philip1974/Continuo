# marketplace(插件商店浏览 Phase 1)

行为契约:**fetchMarketplaceIndex 拉 raw.githubusercontent.com 上的 index.json,
1h memory + sessionStorage 缓存;网络失败有 cache 时回落,无 cache 才抛。
entryToGitUrl / entryToManifestUrl 把 entry.repo + branch 拼成可用 URL。**

> 计划详见 doc/13-插件商店.md。

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/types.ts` | MarketplaceEntry interface + URL 拼接 |
| `src/marketplace/fetcher.ts` | fetchMarketplaceIndex + cache 策略 |
| `src/marketplace/MarketplaceTab.tsx` | SettingTab UI(浏览,Phase 2 加 install) |

## 关键行为

### entryToGitUrl(entry)

- `https://github.com/${entry.repo}.git`
- 直接喂给 v4.5 installFromGit

### entryToManifestUrl(entry)

- `https://raw.githubusercontent.com/${entry.repo}/${branch ?? 'main'}/manifest.json`
- 用于 Phase 3 拉远程 manifest 取 version

### fetchMarketplaceIndex(forceRefresh = false)

- in-memory cache 优先,过期前 free hit
- memory cache miss → sessionStorage cache 兜底(冷启重 hydrate)
- cache 全部 miss → fetch 网络,成功更新两层 cache
- fetch 失败 + 有 cache → 返 cache(过期也返,better than nothing)
- fetch 失败 + 无 cache → 抛
- forceRefresh=true → 跳缓存直接 fetch
