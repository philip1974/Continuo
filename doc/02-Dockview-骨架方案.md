# 02 · Dockview 骨架方案

## 为什么是 Dockview

| 能力 | Dockview | Allotment | FlexLayout | rc-dock |
|---|---|---|---|---|
| Tab 拖拽分组 | ✅ | ❌（只分栏） | ✅ | ✅ |
| Splitview / Gridview | ✅ | ✅ | 部分 | ✅ |
| **Popout 到独立窗口** | ✅（原生支持） | ❌ | ❌ | floating only |
| 序列化/反序列化 | `toJSON()` / `fromJSON()` | ❌ | ✅ | ✅ |
| 零运行时依赖 | ✅ | ✅ | ✅（仅 React） | ✅ |
| TS 类型 | 一等公民 | 一等公民 | 完整 | 完整 |
| 灵感来源 | 直接借鉴 VSCode splitview/gridview | 派生自 VSCode | 自研 | 自研 |

**关键决策**：选 Dockview 的核心理由是 **popout API 已经内建**，未来要把面板"拖出来变成独立 Electron 窗口"几乎零成本——Dockview 会暴露 `onWillShowOverlay` / `addPopoutGroup`，我们只要把它桥到 `BrowserWindow` 即可（详见 `05-Electron-集成.md`）。

## 面板模型

```ts
// src/shell/dock/panels.ts
import type { IDockviewPanelProps } from 'dockview-react';
import { Explorer }   from '@/panels/Explorer';
import { Editor }     from '@/panels/Editor';
import { Terminal }   from '@/panels/Terminal';
import { Output }     from '@/panels/Output';

export type PanelKey = 'explorer' | 'editor' | 'terminal' | 'output';

export const panelComponents = {
  explorer: (p: IDockviewPanelProps) => <Explorer {...p.params} />,
  editor:   (p: IDockviewPanelProps) => <Editor   {...p.params} />,
  terminal: (p: IDockviewPanelProps) => <Terminal {...p.params} />,
  output:   (p: IDockviewPanelProps) => <Output   {...p.params} />,
} as const;

export const tabComponents = {
  // 自定义 tab 渲染——这是塞 Motion layoutId 的入口
  default: SharedTab,
};
```

## 默认布局

```ts
// src/shell/dock/layout.default.ts
export const defaultLayout = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { views: ['explorer'], activeView: 'explorer' }, size: 240 },
        {
          type: 'branch',
          orientation: 'VERTICAL',
          data: [
            { type: 'leaf', data: { views: ['editor'], activeView: 'editor' }, size: 600 },
            { type: 'leaf', data: { views: ['terminal', 'output'], activeView: 'terminal' }, size: 200 },
          ],
        },
      ],
      size: 1280,
    },
    width: 1280,
    height: 800,
    orientation: 'HORIZONTAL',
  },
  panels: {
    explorer: { id: 'explorer', component: 'explorer', title: 'Explorer' },
    editor:   { id: 'editor',   component: 'editor',   title: 'Editor' },
    terminal: { id: 'terminal', component: 'terminal', title: 'Terminal' },
    output:   { id: 'output',   component: 'output',   title: 'Output' },
  },
  activeGroup: 'group-1',
};
```

## DockShell 组件骨架

```tsx
// src/shell/dock/DockShell.tsx
import { DockviewReact, DockviewReadyEvent } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

export function DockShell() {
  const onReady = (event: DockviewReadyEvent) => {
    const persisted = window.api.layout.read();
    try {
      event.api.fromJSON(persisted ?? defaultLayout);
    } catch {
      event.api.fromJSON(defaultLayout);
    }

    event.api.onDidLayoutChange(() => {
      window.api.layout.write(event.api.toJSON());
    });

    event.api.onDidAddGroup(group => {
      // popout 钩子：见 05 文档
    });
  };

  return (
    <DockviewReact
      components={panelComponents}
      tabComponents={tabComponents}
      onReady={onReady}
      className="dockview-theme-abyss"
    />
  );
}
```

## 状态序列化

- **写入时机**：`onDidLayoutChange` 防抖 300ms。
- **存储位置**：`app.getPath('userData') / layout.json`，main 进程持有读写权限，renderer 通过 IPC 调用。
- **版本号**：JSON 顶层加 `version: 1`，破坏性变更要走 migration 函数（先写空实现）。
- **回滚**：解析失败 → 落回 `defaultLayout`，不抛异常。

## 主题覆盖

Dockview 默认提供 `dockview-theme-light / dark / abyss / dracula / vs / replit`。我们：

1. 选 `dockview-theme-abyss` 当默认（深色，与装饰层 Spotlight 配合好）。
2. 在 `src/styles/dockview.css` 通过 CSS 变量微调：tab 间距 8 → 12，tab 高度 32 → 36，分割线颜色拉到 `rgba(255,255,255,0.08)`。
3. **不**自己写 tab DOM 结构——Tab 内的动画交给 Motion 的 `SharedTab` 组件（见下一份）。
