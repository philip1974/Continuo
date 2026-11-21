# CategoryTabContent(Settings 内通用 category 渲染器)

行为契约:**SettingTab 的内容容器:从 SettingItemRegistry.getByCategory 拿当前 category 的所有
SettingItemSpec,按 spec.group 分桶(undefined 归 default 无 header bucket),
每条 spec 渲染成 SettingItemRow。category 切换时强制重读;registry 增删 → subscribe 更新。
items 空 → 显示「本类暂无设置项」。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/CategoryTabContent.tsx` | UI |
| `src/plugins/registries/SettingItemRegistry.ts` | items 注册 |
| `src/plugins/settings/SettingItemRow.tsx` | 单项渲染(独立测) |

## 关键行为

### items 空

- 渲染「本类暂无设置项」

### group 分桶

- spec 没 group → 归默认 bucket(无 h3 header)
- spec 有 group → bucket header 是 group 字符串
- 同 group 多 item 一起渲染
- bucket 出现顺序 = items 内首条出现顺序(由 priority 排序决定)

### 动态变化

- registry.subscribe 触发 setSnap → 新增 item 立即出现
- category prop 切换 → 重读 getByCategory(避免 React 复用实例残留前一 category)
