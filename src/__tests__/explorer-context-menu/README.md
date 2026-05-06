# explorer-context-menu(资源管理器右键菜单 plugin 贡献点 V1)

行为契约:**plugin 通过 `registerExplorerContextMenuItem(spec)` 给资源管理器
右键菜单贡献额外项**。内置 4 项(新建文件 / 新建文件夹 / 重命名 / 删除)
不可被 plugin 覆盖,plugin 项追加显示。

> V1 范围(2026-05):
> - group 是字符串(不限 enum,plugin 可任意填),内置约定 4 类:
>   `new` / `edit` / `plugin`(默认) / `danger`
> - 同步 when(返 boolean),抛错视为 false + warn
> - 上下文 3 字段:`target` / `selectedPaths` / `rootPath`
> - icon: ReactNode(可选)
> - fn: void | Promise<void>(可同步可异步)
> - **不支持** plugin 覆盖内置项 / 子菜单 / 异步 when(API 形态预留兼容,
>   将来加新字段不破坏老 plugin)

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/ExplorerContextMenuRegistry.ts` | Registry + filterVisible 纯函数 |
| `src/plugins/types.ts` | CoApp / CoPluginApp 加 `explorerContextMenu` 字段(透传,无 scoped 闭包) |
| `src/plugins/scoped-app.ts` | 透传(无权限层) |
| `src/plugins/Plugin.ts` | `protected registerExplorerContextMenuItem(spec): Disposable` proxy |
| `src/panels/Explorer/ContextMenu.tsx` | 订阅 registry → filterVisible(ctx) → 按 group 排序渲染 |

需 export 的形态:

```ts
export interface ExplorerContextMenuItemContext {
  readonly target: FileEntry | null;     // 右键的 entry,null=空白
  readonly selectedPaths: ReadonlySet<string>;
  readonly rootPath: string;
}

export interface ExplorerContextMenuItemSpec {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** 分组:'new' / 'edit' / 'plugin'(默认) / 'danger',或自定义 string. */
  readonly group?: string;
  /** 同步谓词,抛错视为 false. */
  readonly when?: (ctx: ExplorerContextMenuItemContext) => boolean;
  /** 升序,默认 100(同 EditorAction). */
  readonly priority?: number;
  readonly fn: (ctx: ExplorerContextMenuItemContext) => void | Promise<void>;
}

export class ExplorerContextMenuRegistry {
  register(spec): Disposable;
  getAll(): readonly ExplorerContextMenuItemSpec[];   // 按 priority 升序
  subscribe(listener): () => void;
}

export function filterVisible(
  items: readonly ExplorerContextMenuItemSpec[],
  ctx: ExplorerContextMenuItemContext,
): ExplorerContextMenuItemSpec[];
```

## 关键行为

### Registry

- `register(spec)` 同 id 后入赢 + warn(同 EditorActionRegistry 模式)
- `dispose()` 摘掉自己注册的(若仍是当前 spec 引用)
- `getAll()` 返按 priority 升序的副本
- `subscribe(listener)` 增删都 notify

### filterVisible

- 无 `when` → 始终可见
- `when(ctx)` 返 false → 隐藏
- `when(ctx)` 抛错 → 视为 false + console.warn(不让 plugin 异常拖崩 UI)

### group 排序约定(渲染层)

内置 group 顺序:`new` → `edit` → `plugin` → `danger`。
不在内置 4 类的自定义 group → 紧跟 `plugin` 后,按字母序。
group 之间渲染分隔线(Radix Separator)。

### Plugin proxy

`Plugin.registerExplorerContextMenuItem(spec)` 同步返回 Disposable,
入 `disposables`,_deactivate 时 LIFO 清理。

### 内置 4 项不变

ContextMenu UI 里的内置 4 项(新建文件 / 新建文件夹 / 重命名 / 删除)
保留硬编码,**不通过 registry 注册**。Plugin 不能覆盖它们;只能追加。

## 不在本主题验证

- ContextMenu UI 渲染细节(Radix Menu / Portal / 分隔线 dom 结构)— 由
  现有 ContextMenu 自身的隐式 spec 持有(无对应 BDD topic);本 topic
  仅测 registry + filterVisible 纯函数 + Plugin proxy 集成
- Plugin 生命周期(registerExplorerContextMenuItem 拿到的 Disposable
  会被 _deactivate LIFO 清理)— 由 plugin-base topic 持有
