# marketplace update-store(Phase 3 — 更新检查)

行为契约:**`useUpdateStore.refresh()` 拉远程 index、为每条 entry 并发拉远程 manifest,
跟本地 PluginManager.listAll 比对,把 remote > local 的攒成 `available[]`。
单个 manifest 失败不影响其它;index fetch 失败 → 静默 console.warn,store 不抛。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/update-store.ts` | zustand store + refresh() |
| `src/marketplace/fetcher.ts` | fetchMarketplaceIndex / fetchPluginManifest |
| `src/marketplace/semver.ts` | isNewerVersion |

## 关键行为

### refresh 正路径

1. `checking: true`
2. 拉 index → 为每条 entry 并发 `fetchPluginManifest`
3. 对 `mgr.listAll()` 中每条 installed,若 `isNewerVersion(remote, local)` → push 到 `available`
4. set `remoteVersions / available / lastCheckedAt: Date.now() / checking: false`

### 部分 manifest 失败

- 用 `Promise.allSettled`,失败的 entry 进 `remoteVersions` map 时跳过
- 该 entry 在 available 中也跳(因为没 remoteV)

### 本地未装 manifest 中的某 plugin

- 不计入 available(只对 installed 检查)

### remote 版本不新

- 不计入 available

### 本地无 PluginManager(getUserPluginManager 返 null)

- `installed = []`,available 空

### index fetch 抛

- catch + console.warn,`checking: false`,其它字段保持
