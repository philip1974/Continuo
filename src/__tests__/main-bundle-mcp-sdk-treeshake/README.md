# main-bundle-mcp-sdk-treeshake

主进程启动包不再静态携带完整 MCP SDK(r5 审计 fresh #3)。

## 背景

main 只用 `@continuo-terminal/server-node` 的 `SessionManager` / `getDefaultShell` / `isAllowedShell`(以及
`@continuo-terminal/protocol` 的 schema)。但 server-node 的 `exports` 只有包根 `"."`,没有子路径,包内也只有
`src/*.ts`(无 dist);sibling 仓库不在本仓改动范围。包根 barrel 再导出 `server.ts`,其模块顶层的 bin 守卫
(`if (argv[1] === import.meta.url) await main()`)是副作用,Rollup 只能整模块保留,连带把 MCP SDK
(server / types / hono node-server / zod v4)打进 `out/main/chunks/server-*.js`(444,578 B),由 `index.js`
顶层静态导入,每次冷启动在 `app.whenReady()` 前解析求值。

`export * from '@continuo-terminal/protocol'` 不是成因:protocol 只依赖 zod,体积小,保持不变。

## 行为

- main 构建 `rollupOptions.treeshake.moduleSideEffects = mainModuleSideEffects`(`scripts/main-bundle-side-effects.ts`):
  server-node 的 `src/server.ts`、`@modelcontextprotocol/sdk`、`@hono/node-server`、`zod-to-json-schema` 视为无副作用
  —— 没有导出被用到即整模块摇掉;一旦被用到仍完整保留(含副作用),语义不变。其余模块保持默认。
- bin 守卫在 server.ts 落在独立 chunk 时不成立(argv[1] 不会是 chunk 文件);但若 server.ts 被打进单一
  `out/main/index.js`,e2e(argv[1]=out/main/index.js)下守卫会成立,在 main 里启动 stdio MCP server —— 故须摇掉。
- 前提守卫:`electron/` 源码不直接导入上述 SDK 模块,也不从 server-node 导入 MCP server 导出
  (`createTerminalMcpServer` / `main` / `startHttpTransport` / `startLocalSocketTransport`);覆盖 `import {…} from`、
  `export {…} from`、同文件多条导入,`import * as` / `export * from` / 动态 `import()` 一律视为引用。新增这类导入时规范失败,提醒复核。
- 产物守卫:`out/main` 存在时,其中所有 `.js` 不得含 `@modelcontextprotocol` 或 `StdioServerTransport`;未构建则跳过该条。

## 产物对比(`npx electron-vite build`)

| | 前 | 后 |
| --- | --- | --- |
| 启动静态加载 | `index.js` 589,985 B + `chunks/server-*.js` 444,578 B = 1,034,563 B | `index.js` 607,702 B(无 chunk) |
| 顶层静态导入 | 含 `http` / `http2` / `stream` / `crypto` / `zod/v3` / `zod/v4-mini` / `zod/v4` | 以上全部消失 |

## follow-up

上游 server-node 提供无副作用子路径(如 `./session-manager`、`./shell`)后,本仓改用子路径并删掉该判定。
