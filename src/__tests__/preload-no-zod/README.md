# preload-no-zod(preload sandbox zod 泄漏守卫)

行为契约:**`electron/preload` 全部入口的值依赖闭包里不得出现 zod。**

- 值依赖 = `import … from` / `export … from` / 副作用导入 / 动态 `import()` / `require()` / `import x = require()`;
  `import type`、`export type`、全部成员都带 `type` 的导入编译时擦除,不算
- 沿相对路径递归(不限目录、不看文件命名),出现 `zod`,或出现沿 dependencies / peerDependencies 递归依赖 zod 的包
  (从包的真实位置解析,兼容 pnpm 布局)→ 泄漏,报出依赖链
- 解析不到的相对路径、既不是 Node 内置 / `electron` 也找不到包的说明符(如 preload 未配置的别名)→ 同样报出,不静默跳过

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
- zod 入参 schema 放 `electron/main/ipc/*.ipc.ts`,或(需要与 shared 类型单一来源时)放 shared 的独立 schema 模块,由 main 值导入。
- 跨进程**类型**若需从 zod schema 派生(`z.infer`):schema 放独立的 shared schema 模块,`*-channels.ts` 只
  `import type` 推出类型(被 bundler 擦除,不拖 zod)。

> 先例:`plugin-mcp-channels.ts` ↔ `plugin-mcp-schemas.ts`、`plugins-channels.ts` ↔ `plugin-permission-schema.ts`、
> `window-channels.ts` ↔ `window-create-schema.ts`。
