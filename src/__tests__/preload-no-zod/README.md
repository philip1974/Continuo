# preload-no-zod(preload sandbox zod 泄漏守卫)

行为契约:**`electron/shared/*-channels.ts`(channel 常量文件)不得 `import ... from 'zod'`。**

## 背景(回归来源)

preload 在 Electron **sandbox** 运行,`require('zod')` 不可用。preload 会把 channel 常量
(`MARKETPLACE_CHANNELS` / `TERMINAL_CHANNELS` …)当**值** import。若某 channel 文件混入
`import { z } from 'zod'`(例如顺手放了 zod 入参 schema),bundler(electron-vite +
externalizeDeps)会把整个模块连同 zod 拖进 preload 产物 → 运行时:

```
Unable to load preload script: out/preload/index.cjs
Error: module not found: zod  (at preloadRequire)
```

→ `window.__lmApi` 不注入 → renderer `coApi.*` 全抛 → **白屏**。**单测 / typecheck / lint 都抓不到**
(纯 bundling/运行时问题),只有真跑 Electron 才暴露。S4 的 `marketplace-channels.ts` 误把
`fetchReviewsInputSchema = z.object({}).strict()` 放进 channels 文件即触发本回归。

## 约定

- channel 常量 + 跨进程**类型**(interface)放 `*-channels.ts`(zod-free,preload 可安全 value-import)。
- zod 入参 schema(仅 main 用)放 `electron/main/ipc/*.ipc.ts`。
- 跨进程**类型**若需从 zod schema 派生(`z.infer`),放在**独立的** shared 类型/schema 文件,
  且 preload 只 `import type`(被 bundler 擦除,不拖 zod)。

> 已有先例:`plugin-mcp-channels.ts` 顶部注释「不 import zod」+ schema 另放 `plugin-mcp-schemas.ts`。
