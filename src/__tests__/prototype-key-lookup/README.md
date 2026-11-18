# 原型链键名查表(prototype-key-lookup)

行为契约:**以插件 / 外部可控的键(命令 id、titleKey、插件 id、设置 id、快捷键主键名)查普通对象字典时,
只认自有属性。键为 `constructor` / `toString` / `hasOwnProperty` / `valueOf` / `__proto__` 等
Object.prototype 成员名时,视同「无此键」,绝不返回原型上的函数 / 对象。**

此前同族缺陷:

- 注册命令 `{ id: 'toString' }` → `resolveEffectiveHotkey` 返回函数 → `compileCombo` 抛 TypeError,
  在 App 的 `useCommandHotkeys` useMemo 内 → 整窗白屏,每次启动复现。
- `titleKey: 'constructor'` → `tWithFallback` 返回函数 → CommandPalette 等渲染期抛错。
- 插件 id `constructor`(plugin-id 形态合法)→ main `mutatePluginPermissions` 读 `.decisions.filter`
  抛错、renderer `IpcPermissionStore.clearDenied` 读 `.decisions.some` 抛错 → 启用该插件失败。
- 逐键拷贝 JSON 数据(`makeJsonSafe`、`readRecord`)时 `out['__proto__'] = v` 改写局部对象原型、
  键被静默丢弃 —— 改为按 JSON 语义保留为自有数据属性。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/own-value.ts` | `ownValue`(只读自有属性)/ `setOwnValue`(`__proto__` 写成自有数据属性) |
| `src/i18n/translate.ts`、`electron/main/i18n.ts` | 字典查表 |
| `src/plugins/keybindings/keybindings-store.ts`、`command-palette/*` | 快捷键 override / 别名 / 显示映射 |
| `src/plugins/settings/values-store.ts` 等 | 设置值读取 |
| `electron/main/services/plugins.service.ts`、`src/plugins/permissions/IpcPermissionStore.ts` | 授权表 |
| `electron/shared/make-json-safe.ts`、`src/plugins/storage/local-storage-record.ts` | JSON 逐键拷贝 |

## 规范

- `renderer-lookup.spec.ts`:快捷键、i18n、设置值
- `main-permissions-lookup.spec.ts`:main 授权 / path scope 流程(插件 id `constructor`)
- `renderer-permissions-lookup.spec.ts`:renderer 权限缓存
- `own-value.spec.ts`:helper 单元规范
- `__proto__` 逐键拷贝见 `dock-layout-json-safe-write/make-json-safe.spec.ts`、
  `local-storage-record-guard/local-storage-record-guard.spec.ts`
