# DEFERRED(打磨 R56):用户插件启动扫描拆 manifest + 按需源码加载

> 状态:**DEFER 到独立 dev-loop**(2026-06-20,打磨阶段 codex 协作第 R56 轮提出)。
> finding 有效且高价值,但 remedy 是多文件协议 + 插件生命周期重构,超出单个打磨
> 迭代的安全范围,需走 req → plan → red-team → execute → verify。

## 问题(codex R56)

`electron/main/services/plugins.service.ts:listPluginDirs()` 启动时对**每个**插件目录
读 `manifest.json` + `main.js` + `styles.css`;renderer(`PluginManager.init`)为每个
`mainText` 留在 `entry.dirInfo` 内(disabled 插件也持有源码字符串)。即使插件 disabled、
永不 import/activate,也已产生:磁盘 I/O(读 main/styles)+ IPC payload(传源码)+
renderer 内存(持有 mainText/stylesText)。

启动成本 = **所有已安装插件源码规模**,而非**启用插件源码规模**。插件多但多数禁用时
冷启动 I/O / 传输 / 内存浪费明显。

## 建议方向(codex)

把插件扫描协议拆两段:
1. 启动/列表只返回 `{ id, manifestText }` + 元信息(`listPluginManifests`)。
2. 只有 enabled 插件激活、用户 enable/reload 某插件时,再按 id 读 `main`/`styles` 并
   创建 module(Blob)URL(`readPluginSource(id)`)。
3. PluginsTab 展示 disabled 插件只需 manifest/status,不需源码。

## 为什么 DEFER(不在打磨 loop 内做)

触及面与风险:
- **协议改动**:`plugins.service`(拆 listPluginDirs + 加 readPluginSource)+
  `electron/main/ipc/plugins.ipc.ts`(新 IPC handler)+ `electron/preload`(暴露)+
  `src/plugins/PluginManager.ts`(host 接口 + init + activateEntry + reload)+
  `PluginDirInfo` 类型(mainText/stylesText 变可选/分离)。
- **生命周期雷区**:`activateEntry` 被 init / enable / reload 共用,且文档(本仓多次
  复审)记载过 lifecycleLock / token 泄漏 / 双激活 等并发缺口。改「源码何时加载进
  activate 路径」直接落在这条最敏感路径上。
- **测试负担**:需覆盖 disabled-不加载 / enabled-加载激活 / enable→按需加载+激活 /
  reload→重取源码 / uninstall / version-incompat 全生命周期矩阵,远超单个打磨迭代的
  neutralize-spec 规模。

故按「极简 + 不在敏感路径上仓促重构」原则 DEFER,留待独立 dev-loop 设计 + 红队 +
全生命周期验证。

## 后续(启动 dev-loop 时)

- 新 IPC:`plugins:list-manifests`(返 `{id, manifestText}[]`)+ `plugins:read-source`
  (按 id 返 `{mainText, stylesText?}`)。
- PluginManager:init 用 manifest 列表建 entry;enabled → 取源码 → activate;disabled →
  仅 manifest/status。`activateEntry` 在缺源码时先取。
- 兼容:旧 `listPluginDirs` 可保留为「list-manifests + 全量 read-source」的组合或弃用。
- 守护:全生命周期矩阵 + 「disabled 插件启动不触发 read-source」断言。
