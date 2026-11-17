// main 构建的 Rollup treeshake.moduleSideEffects 判定(见 src/__tests__/main-bundle-mcp-sdk-treeshake/README.md)。
//
// main 只用 @continuo-terminal/server-node 的 SessionManager / getDefaultShell / isAllowedShell,但该包
// exports 只有包根 "."(无子路径,且 sibling 仓库不在本仓改动范围)。包根 barrel 再导出 server.ts,
// 其模块顶层的 bin 守卫(`if (argv[1] === import.meta.url) await main()`)是副作用,Rollup 只能整模块保留,
// 连带把完整 MCP SDK(server / types / hono node-server / zod v4)静态打进启动包(~444KB chunk)。
// bin 守卫在打包进 Electron 后永远不成立(argv[1] 不会是 chunk 文件),MCP SDK 等只被 server.ts / transports
// 使用,main 自己不导入 → 声明它们无副作用:没有导出被用到即整模块摇掉;一旦被用到仍照常完整保留(含副作用)。
//
// follow-up:上游 server-node 提供无副作用子路径(如 ./session-manager、./shell)后,改用子路径并删掉本判定。

const SIDE_EFFECT_FREE =
  /[\\/]@continuo-terminal[\\/]server-node[\\/]src[\\/]server\.ts$|[\\/]node_modules[\\/](?:@modelcontextprotocol[\\/]sdk|@hono[\\/]node-server|zod-to-json-schema)[\\/]/;

// 外部 node: 内置模块无副作用:被打包的依赖(如 server-node transports/http.ts)值导入了 node:http 但导出被摇掉时,
// 视为有副作用会留下裸 `import "node:http"` —— ESM 裸导入同样读取全部导出并连带加载编译 undici(冷启动 +17ms)。
export function mainModuleSideEffects(id: string, external?: boolean): boolean {
  if (external === true && id.startsWith('node:')) return false;
  return !SIDE_EFFECT_FREE.test(id);
}
