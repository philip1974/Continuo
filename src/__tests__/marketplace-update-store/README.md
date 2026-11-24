# marketplace update-store(Phase 3 — 更新检查)

行为契约:**`useUpdateStore.refresh()` 拉远程 index,只为本地已安装插件对应的 entry 拉远程 manifest
(有界并发,上限 `MAX_MANIFEST_FETCH_CONCURRENCY`;本地未装插件则不发请求),把合法 semver 的远端版本存成 `remoteVersions`。
可用更新不存状态:`useAvailableUpdates()` / `computeAvailableUpdates()` 用**当前**已安装列表 × `remoteVersions` × `dismissed`
现算 remote > local 的项。单个 manifest 失败不影响其它;index fetch 失败 → 静默 console.warn,store 不抛。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/marketplace/update-store.ts` | zustand store + refresh() |
| `src/marketplace/fetcher.ts` | fetchMarketplaceIndex / fetchPluginManifest |
| `src/marketplace/semver.ts` | isNewerVersion |

## 关键行为

### refresh 正路径

1. 拉 index → 为已安装插件对应的 entry 有界并发 `fetchPluginManifest`
2. 记下 `remoteVersions`(id → 远端版本;非法 semver 不记)
3. 可用更新 = 当前已安装列表中 `isNewerVersion(remote, local)` 且未被 dismiss 压制的项(派生,不落库)

### 部分 manifest 失败

- 用 `allSettledWithConcurrency`(有界并发版 allSettled),失败的 entry 沿用上次已知的远端版本(离线时打开市场页
  不抹掉已显示的更新);从未拉到过的不记、不计入可用更新

### 远端 manifest.id ≠ entry.id

- 跳过该 entry(warn),不记远端版本、不计入可用更新(防更新检查错配)

### 本地未装 manifest 中的某 plugin

- 不计入可用更新(只对 installed 检查)

### remote 版本不新

- 不计入可用更新

### 远端版本要求更高应用版本

- 远端 manifest 声明的 `minLMVersion` 高于当前应用版本(`admitManifestVersion` 不通过)→ 不记远端版本、不计入可用更新
  (装上也会被准入拒载,main 安装同样以 `PLUGIN_INCOMPATIBLE` 拒)

### 本地无 PluginManager(getUserPluginManager 返 null)

- `installed = []`,可用更新为空

### index fetch 抛

- catch + console.warn,`remoteVersions` 保持不变

### 可用更新随已安装列表现算(available-derived.spec.tsx)

- 别的窗口卸载 / 更新插件(本窗口经 `handleUninstalled` / 文件监视 reload 改列表)→ 设置齿轮角标与市场卡片
  「更新到 vX」立即不再计入,无需任何手工同步。
- 设置页卸载不写 `dismissed`;卸载后重装旧版本 → 更新重新显示。
- `dismiss(id)`(市场页更新成功后的乐观收起)只压制「当时的已安装实例(manifest 引用)+ 目标版本」:
  reload 失败时仍收起(防二次覆盖安装),实例被替换(reload 成功 / 重装)或远端出现更新版本后失效。

### 启动检查排在插件扫描完成之后(startup-check-after-init.spec.ts)

- 启动时的更新检查经 `initPluginsThenCheckUpdates` 挂在 `userPluginManager.whenScanned()`(扫描完成;扫描失败也 resolve)之后,
  不再与 init 同一同步段发起:`refresh()` 先读 `listAll()` 按已安装规模裁剪网络,扫描前恒为空会直接落空,
  导致已装插件的更新角标永不出现。不等整个 init —— 某插件激活挂在授权弹窗 / onload 上时 init 可能永不完成。
  仍 fire-and-forget,不阻塞首次渲染;init 的结果(含失败)原样返回给调用方(main-app 只记录失败)。
- popout 子窗口(只渲染 PopoutHost、无 IconSidebar 角标)在 main-app 早退,既不 init 插件也不做启动更新检查
  (`startup-critical-path/init-ipc-prefetch.spec.ts`)。
