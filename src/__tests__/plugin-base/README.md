# plugin-base(插件基类与 Disposable 模型)

行为契约:**`Plugin` 抽象类 + `Disposable` LIFO 自动清理**,是 LM 插件系统的脊柱。
所有贡献点(`registerPanel` / `addCommand` / 等)返回 `Disposable`,由 Plugin 父类
自动收集,`_deactivate()` 时 LIFO 清理。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/Plugin.ts` | `Plugin` 抽象类 + `Disposable` 接口 + 生命周期 |
| `src/plugins/types.ts` | `PluginManifest` / `LMApp` 类型定义 |

## 关键行为

### Plugin 抽象 API

- 子类必须实现 `onload()`,可选 `onunload()`
- 构造接收 `(app: LMApp, manifest: PluginManifest)`,只读暴露
- `register(d: Disposable)` 是 `protected`(子类内部调用),也返回 `d` 便于链式

### Disposable LIFO 清理

- 多次 `register` 累积;`_deactivate()` 反序 dispose(后注册先清)
- 单个 dispose 抛错不影响其他 dispose 继续执行(警告日志)
- 不调 `register` 也能干净 deactivate

### 生命周期幂等性

- `_deactivate()` 多次调用幂等(只第一次执行清理)
- `_deactivate()` 之后再 `_activate()` → 抛错(plugin 不可复用)
- `_deactivate()` 之后再 `register(d)` → 立即 dispose 该 d(防泄漏),返回 d

### 异步 hooks

- `onload` / `onunload` 可同步可 async,父类 `await` 它们
- `onload` 抛错由调用方(PluginManager)捕获;父类不吞
