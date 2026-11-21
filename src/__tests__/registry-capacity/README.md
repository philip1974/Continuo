# registry-capacity (E236)

插件贡献类注册表的**条目数量上限**。各 registry(Command / EditorAction / ExplorerContextMenu /
Panel / Ribbon / SettingItem / SettingTab / StatusBar)此前只校验单条 spec 的字段长度/形态,无数量上限
—— 畸形/恶意插件可循环注册大量合法小条目,items Map 无界增长,getAll() 全量物化 + 命令面板搜索/排序 +
全局 hotkey 扫描被线性放大 → renderer 卡顿/内存上涨。

## 行为契约

- 注册条目数达 `MAX_REGISTRY_ITEMS`(1024)后,再注册**新 id** → 抛错,不入表。
- 覆盖**既有 id**(同 id 重注册)不增长条目数 → 即便已达上限也放行。
- dispose 既有条目释放名额后,可再注册新条目。
- 收口为共享 helper `assertRegistryCapacity`,全 8 个 Map 型 registry 统一调用(防漂移)。
  (ExplorerDecoratorRegistry 用数组 + 自带 MAX_DECORATORS,见 E54,不在此 helper 范围。)
