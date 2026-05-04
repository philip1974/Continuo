# explorer-decorator(文件树装饰贡献)

行为契约:**Plugin 通过 `this.registerExplorerDecorator(fn)` 注入装饰函数**;
FileRow 渲染时遍历所有装饰器,合并 badge / textColor / tooltip 应用到行。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/ExplorerDecoratorRegistry.ts` | 装饰函数列表 + 合并算法 |
| `src/plugins/Plugin.ts`(扩展) | `registerExplorerDecorator` 代理 |
| `src/panels/Explorer/FileRow.tsx`(扩展) | 调 mergeDecorations 渲染 |

## 关键行为

### Decorator 函数

```ts
type DecoratorFn = (entry: { path: string; isDirectory: boolean }) => Decoration | null;

interface Decoration {
  readonly badge?: string;        // 行右侧短标签(如 'M' / '12K' / '+3')
  readonly badgeColor?: string;   // 任意 CSS color(如 var(--md-error))
  readonly textColor?: string;    // 文件名颜色覆盖
  readonly tooltip?: string;      // 追加到 title attr(后缀,不替换原 path)
}
```

返回 null 表示该装饰器对此 entry 无意见。

### Registry

- `register(fn)` → Disposable;dispose 移除该函数
- `getAll()` 返回当前所有函数(顺序为注册顺序)
- 无 subscribe(FileRow 每次 render 调 getAll;数量小,频率低)

### mergeDecorations(entry, fns)

- 调用所有 fn,过滤掉 null 结果
- 合并规则:
  - badge:取**第一个**非空 badge(避免堆挤)
  - badgeColor:取首个 badge 对应的 color
  - textColor:**最后一个**赢(后注册者覆盖,语义"最近的更重要")
  - tooltip:全部用 ` · ` 拼接

返回 `Decoration | null`(无任何装饰则 null)。

### Plugin.registerExplorerDecorator

- 内部 `app.explorerDecorators.register(fn)` → `this.register(d)`
- _deactivate 自动移除
