# 03 · Motion 动画方案

## 设计原则

1. **Motion 不参与布局决策**，只在 Dockview 已经决定好新坐标后做"补间"。
2. 动画时长统一控制在 `180ms ~ 280ms`，缓动用 `ease: [0.32, 0.72, 0, 1]`（VSCode/macOS 的"果冻 ease"）。
3. 任何带 `layoutId` 的元素必须保证同一时刻 DOM 中**唯一**——否则 Motion 会拒绝动画或闪烁。
4. 用户系统设置 `prefers-reduced-motion: reduce` 时，所有 `layoutId` / `AnimatePresence` 自动短路（`MotionConfig reducedMotion="user"`）。

## 三个落点

### 落点 ① · Tab 切换的滑块（active indicator）

VSCode 切 tab 时下方有一条蓝色 indicator 滑过去，Motion 一行搞定：

```tsx
// src/shell/motion/SharedTab.tsx
import { motion } from 'motion/react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';

export function SharedTab(props: IDockviewPanelHeaderProps) {
  const { api } = props;
  const isActive = api.isActive;

  return (
    <div className="relative h-9 px-3 flex items-center gap-2 cursor-pointer">
      <span className="text-sm">{api.title}</span>
      {isActive && (
        <motion.span
          layoutId={`tab-indicator-${groupIdOf(api)}`}
          className="absolute inset-x-0 bottom-0 h-[2px] bg-sky-400"
          transition={{ type: 'spring', stiffness: 500, damping: 35 }}
        />
      )}
    </div>
  );
}
```

要点：
- `layoutId` **以 group 为单位**（`tab-indicator-${groupId}`），每个 dock group 内独立动画。
- 跨 group 不共享 indicator，否则 indicator 会"飞越"两个区域，反而干扰阅读。

### 落点 ② · Panel 进出场（AnimatePresence）

Dockview 添加 / 关闭 panel 时默认是硬切，我们包一层：

```tsx
// src/shell/motion/PanelMount.tsx
import { AnimatePresence, motion } from 'motion/react';

export function PanelMount({ children, panelId }: { children: React.ReactNode; panelId: string }) {
  return (
    <AnimatePresence mode="popLayout">
      <motion.div
        key={panelId}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.99 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        className="h-full w-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
```

在 `panels.ts` 注册时把 panel body 包一层：

```ts
explorer: (p) => <PanelMount panelId={p.api.id}><Explorer {...p.params} /></PanelMount>,
```

### 落点 ③ · Tab 拖动到新组的"幽灵"动画

Dockview 提供 `onDidActivePanelChange` 等事件。当一个 tab 从 group A 拖到 group B 后被激活，给它的标题 `layoutId="panel-title-${panelId}"`，让标题文字"飞"到新位置：

```tsx
// SharedTab 里再加一个 layoutId
<motion.span
  layoutId={`panel-title-${api.id}`}
  className="text-sm"
  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
>
  {api.title}
</motion.span>
```

> ⚠️ 注意：**只对 active tab 标题加 layoutId**。所有 tab 都加会导致 N 个相同 layoutId，Motion 会报错。

## 性能护栏

- 单帧 `layoutId` 元素总数控制在 ≤ 32。超出说明 layout 设计本身有问题。
- 在 Panel body 里做长列表的，**不要**给列表项加 `layout`——只在容器层加。
- 用 `layoutScroll` 包裹 Dockview 的滚动容器，避免滚动时触发 layout 测量风暴。
- React 19 的自动 batching 与 Motion 的 measure 阶段冲突时，用 `useDeferredValue` 包业务层数据。

## reduced-motion 短路

```tsx
// src/shell/App.tsx
import { MotionConfig } from 'motion/react';

<MotionConfig reducedMotion="user">
  <DockShell />
</MotionConfig>
```

加上这一行后，所有 `layoutId` / `transition` 在系统偏好为 reduce 时自动跳到终态，不再补间。这是无障碍的硬底线。
