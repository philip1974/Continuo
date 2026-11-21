# Spotlight(装饰用聚光灯 SVG)

行为契约:**`<Spotlight />` 渲染一个 absolute 定位的 svg 椭圆滤镜,装饰背景。
className 会拼到默认类列表;fill 控制椭圆颜色,默认 'white'。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/decor/Spotlight.tsx` | UI(来自 aceternity ui,MIT) |

## 关键行为

- 渲染 svg + viewBox '0 0 3787 2842' + aria-hidden=true
- fill prop → 内层 ellipse 的 fill;缺省 'white'
- className prop → 与默认 class 列表合并
- 滤镜定义 'lm-spotlight-filter' 存在
