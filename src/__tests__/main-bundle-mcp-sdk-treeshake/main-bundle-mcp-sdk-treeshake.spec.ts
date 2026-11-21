import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { mainModuleSideEffects } from '../../../scripts/main-bundle-side-effects';

// 规范见 README.md:main 只用 server-node 的 SessionManager / shell helper,但包根 barrel 经 server.ts
// (模块顶层 bin 守卫 `if (argv[1] === import.meta.url) await main()` 是副作用)把完整 MCP SDK 静态拖进
// 启动包。main 构建对 server.ts 与只被它用到的依赖声明无副作用 → 未用即整模块摇掉。

const ROOT = path.resolve(__dirname, '../../..');
const PNPM = '/repo/node_modules/.pnpm/x@1/node_modules';

const SDK_SPEC = String.raw`['"](?:@modelcontextprotocol\/sdk|@hono\/node-server|zod-to-json-schema)`;
const SERVER_NODE_SPEC = String.raw`['"]@continuo-terminal\/server-node(?:\/[^'"]*)?['"]`;
const MCP_SERVER_EXPORTS = /\b(createTerminalMcpServer|main|startHttpTransport|startLocalSocketTransport)\b/;

/**
 * 源码是否直接引用 MCP SDK,或从 server-node 取 MCP server 导出。覆盖 `import {…} from` /
 * `export {…} from` / `import X, {…} from` / 同文件多条导入(matchAll);`import * as` / `export * from`
 * / 动态 `import()` 无法静态判断用到哪些成员,一律视为引用。`import type {…}` 编译期擦除,不算。
 */
function referencesMcpServer(src: string): boolean {
  if (new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*)${SDK_SPEC}`).test(src)) return true;
  const named = new RegExp(
    String.raw`\b(?:import|export)\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${SERVER_NODE_SPEC}`,
    'g',
  );
  for (const m of src.matchAll(named)) {
    if (MCP_SERVER_EXPORTS.test(m[1]!)) return true;
  }
  return new RegExp(
    String.raw`\b(?:(?:import|export)\s+\*(?:\s+as\s+[\w$]+)?\s+from\s*|\bimport\s*\(\s*)${SERVER_NODE_SPEC}`,
  ).test(src);
}

describe('main-bundle-mcp-sdk-treeshake', () => {
  describe('mainModuleSideEffects 判定', () => {
    it.each([
      `${PNPM}/@continuo-terminal/server-node/src/server.ts`,
      `${PNPM}/@modelcontextprotocol/sdk/dist/esm/server/index.js`,
      `${PNPM}/@modelcontextprotocol/sdk/dist/esm/types.js`,
      `${PNPM}/@hono/node-server/dist/index.mjs`,
      `${PNPM}/zod-to-json-schema/dist/esm/index.js`,
      'C:\\repo\\node_modules\\.pnpm\\x@1\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\types.js',
      'C:\\repo\\node_modules\\@continuo-terminal\\server-node\\src\\server.ts',
    ])('无副作用(未用即摇掉):%s', (id) => {
      expect(mainModuleSideEffects(id)).toBe(false);
    });

    it.each([
      `${PNPM}/@continuo-terminal/server-node/src/session-manager.ts`,
      `${PNPM}/@continuo-terminal/server-node/src/shell-env/integration.ts`,
      `${PNPM}/@continuo-terminal/server-node/src/index.ts`,
      `${PNPM}/@continuo-terminal/protocol/src/schemas.ts`,
      `${PNPM}/zod/index.js`,
      '/repo/electron/main/index.ts',
      '/repo/electron/main/services/server.ts',
    ])('保持默认(有副作用):%s', (id) => {
      expect(mainModuleSideEffects(id)).toBe(true);
    });
  });

  it('main 构建接入该判定', () => {
    const cfg = readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf-8');
    const mainBlock = cfg.slice(cfg.indexOf('main: {'), cfg.indexOf('preload: {'));
    expect(mainBlock).toMatch(/treeshake:\s*\{\s*moduleSideEffects:\s*mainModuleSideEffects\s*\}/);
  });

  describe('前提守卫判定 referencesMcpServer', () => {
    it.each([
      `import { SessionManager } from '@continuo-terminal/server-node';`,
      `import { getDefaultShell, isAllowedShell } from "@continuo-terminal/server-node";`,
      `import type { main } from '@continuo-terminal/server-node';`,
      `import { z } from 'zod';`,
    ])('不算引用:%s', (src) => {
      expect(referencesMcpServer(src)).toBe(false);
    });

    it.each([
      `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
      `export * from '@modelcontextprotocol/sdk';`,
      `const m = await import('@hono/node-server');`,
      `import { createTerminalMcpServer } from '@continuo-terminal/server-node';`,
      `export { startHttpTransport } from '@continuo-terminal/server-node';`,
      `import * as sn from '@continuo-terminal/server-node';`,
      `export * from '@continuo-terminal/server-node';`,
      `const sn = await import('@continuo-terminal/server-node');`,
      `import { SessionManager } from '@continuo-terminal/server-node';\nimport {\n  main,\n} from '@continuo-terminal/server-node';`,
    ])('算引用:%s', (src) => {
      expect(referencesMcpServer(src)).toBe(true);
    });
  });

  // 前提守卫:「无副作用」只在 main 不直接用这些模块的导出时成立(用到则模块照常保留,语义不变,
  // 但需重新评估体积收益)。electron/ 下新增对它们的直接导入 → 本条失败提醒复核。
  it('前提:electron/ 源码不直接导入 MCP SDK / hono / zod-to-json-schema / server-node 的 MCP server 导出', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && referencesMcpServer(readFileSync(p, 'utf-8'))) offenders.push(p);
      }
    };
    walk(path.join(ROOT, 'electron'));
    expect(offenders).toEqual([]);
  });

  // 产物守卫:server-node 的 server.ts 若被重新打进单一 out/main/index.js,其顶层 bin 守卫
  // `import.meta.url === pathToFileURL(argv[1])` 在 e2e(argv[1]=out/main/index.js)下成立 → main 里
  // 启动 stdio MCP server。已构建时校验产物;未构建(out/main 不存在)则跳过,单测不依赖构建。
  const OUT_MAIN = path.join(ROOT, 'out/main');
  it.skipIf(!existsSync(OUT_MAIN))('产物:out/main 下所有 .js 不含 MCP SDK / StdioServerTransport', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.[cm]?js$/.test(name)) {
          const src = readFileSync(p, 'utf-8');
          if (src.includes('@modelcontextprotocol') || src.includes('StdioServerTransport')) offenders.push(p);
        }
      }
    };
    walk(OUT_MAIN);
    expect(offenders).toEqual([]);
  });
});
