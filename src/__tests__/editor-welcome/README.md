# EditorWelcome(无 tab 占位)

行为契约:**`<EditorWelcome />` 显示「未打开文件」标题 + 副提示与 KeyCap ⌘ S 引导。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/EditorWelcome.tsx` | UI |

## 关键行为

- 标题「未打开文件」
- 副提示包含「⌘」、「S」(KeyCap)与「保存」「Explorer 单击文件打开」字样
- aria-hidden 装饰图标 svg 存在
