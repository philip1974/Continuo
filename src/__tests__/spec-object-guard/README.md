# spec-object-guard(E273,E271 registry 族)

## 行为契约

贡献 registry 的 `validate*Spec` 在读 `spec.id`/`spec.name` 等字段前,必须先校验 `spec` 本身是普通对象。
spec 来自第三方未类型化 JS 插件,TS 类型不构成运行时保证 —— 传 `null`/`undefined` 会让 `spec.id` 抛
非结构化 TypeError(冒泡到注册/激活路径,错误码与 UI 反馈不稳定)。

共享 `src/plugins/registries/spec-guard.ts` 的 `isSpecObject(spec)`(返 boolean,非 type guard)收口判定。

### 覆盖的 9 个贡献 registry validator

CommandRegistry / EditorActionRegistry / ExplorerContextMenuRegistry / PanelRegistry / RibbonRegistry /
SettingItemRegistry / SettingTabRegistry / StatusBarRegistry / PluginMcpRegistry。

### 规则

1. `isSpecObject`:`null`/`undefined`/primitive/数组 → false;普通对象 → true。
2. 各 `validate*Spec` 开头调用,非对象 → 抛**稳定** registry 错误(非 TypeError)。
3. 家族接线守卫:全 9 个 validator 源码都必须调用 `isSpecObject`(防某个兄弟漏接/回归)。
