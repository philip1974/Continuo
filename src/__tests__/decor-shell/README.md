# shell decor / Splash / PopoutHost 装饰组件

行为契约:**装饰类组件,主要校验 SVG / DOM 结构正确,不引入交互。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/decor/BackgroundBeams.tsx` | 50 条 motion.path 动画(aceternity ui) |
| `src/shell/decor/Splash.tsx` | 启动 splash:Spotlight + Continuo 文字 |
| `src/shell/PopoutHost.tsx` | dockview popout 子窗根容器 |

## 关键行为

### BackgroundBeams

- 渲染单 svg viewBox='0 0 696 316' aria-hidden='true'
- 50 条 path(每条 stroke 引用对应 lm-beam-{i} gradient)
- 50 个 linearGradient defs(transition.duration ∈ [10, 20])
- className prop 与默认类合并

### Splash

- data-testid='splash'
- 内含 Spotlight(svg) + 标题「Continuo」

### PopoutHost

- data-testid='popout-host'
- 单 div 占满容器
