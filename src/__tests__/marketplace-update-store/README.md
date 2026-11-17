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

### 远端 manifest.id ≠ entry.id

- 跳过该 entry(warn),不写 `remoteVersions`、不计入 available(防更新检查错配)

### 本地未装 manifest 中的某 plugin

- 不计入 available(只对 installed 检查)

### remote 版本不新

- 不计入 available

### 本地无 PluginManager(getUserPluginManager 返 null)

- `installed = []`,available 空

### index fetch 抛

- catch + console.warn,`checking: false`,其它字段保持

### 启动检查排在插件扫描完成之后(startup-check-after-init.spec.ts)

- 启动时的更新检查经 `initPluginsThenCheckUpdates` 挂在 `userPluginManager.whenScanned()`(扫描完成;扫描失败也 resolve)之后,
  不再与 init 同一同步段发起:`refresh()` 先读 `listAll()` 按已安装规模裁剪网络,扫描前恒为空会直接落空,
  导致已装插件的更新角标永不出现。不等整个 init —— 某插件激活挂在授权弹窗 / onload 上时 init 可能永不完成。
  仍 fire-and-forget,不阻塞首次渲染;init 的结果(含失败)原样交给 reload-gate(flush 仍等整个 init)。
- popout 子窗口(只渲染 PopoutHost、无 IconSidebar 角标)不做启动更新检查,插件 init 照常
  (`startup-critical-path/init-ipc-prefetch.spec.ts`)。
