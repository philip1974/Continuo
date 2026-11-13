# keyed-registry-base(重构:Map 型贡献 registry 的共享基类)

## 行为契约

8 个 Map 型插件贡献 registry(Command / EditorAction / ExplorerContextMenu / Panel / Ribbon /
SettingItem / SettingTab / StatusBar)此前各自逐字复制同一段「注册 → 容量守卫 → 覆盖告警 → 入表 →
失效快照 → 通知;dispose 幂等且只删自己;get / subscribe」样板。历史上守卫(E236 容量、R51-R59 live
复查、E273 spec 对象)都要逐个兄弟传播,漏一个即回归。收口为 `KeyedRegistry<T>` 基类
(`src/plugins/registries/keyed-registry.ts`),对外行为逐字不变。

### 规则

1. `registerKeyed(key, spec)`:新 key 且已达 `MAX_REGISTRY_ITEMS` → 抛、不入表;覆盖既有 key →
   `console.warn` 后注册者赢;入表后先失效快照缓存再同步通知订阅者。
2. 返回的 Disposable 幂等;仅当表中仍是**本次** spec 时才删除并通知(被后注册者顶替后 dispose 是 no-op)。
3. 子类钩子:`onBeforeSet(spec, previous)` 在容量守卫与覆盖告警之后、入表之前调用;`onRemoved(spec)`
   在 dispose 真正删除后、通知之前调用(CommandRegistry 的 hotkey 计数用)。
4. `snapshotByPriority(items)`:按 `priority ?? 100` 升序、等优先级保持注册顺序;已有序时不调用 sort。
5. 家族接线守卫:8 个 registry 都继承 `KeyedRegistry` 且不再自持 `listeners` / 内联 dispose 样板。
