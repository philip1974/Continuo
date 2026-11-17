import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { mainModuleSideEffects } from '../../../scripts/main-bundle-side-effects';

// 规范见 README.md:main 只用 server-node 的 SessionManager / shell helper,但包根 barrel 经 server.ts
// (模块顶层 bin 守卫 `if (argv[1] === import.meta.url) await main()` 是副作用)把完整 MCP SDK 静态拖进
// 启动包。main 构建对 server.ts 与只被它用到的依赖声明无副作用 → 未用即整模块摇掉。

const ROOT = path.resolve(__dirname, '../../..');
const PNPM = '/repo/node_modules/.pnpm/x@1/node_modules';

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

  // 前提守卫:「无副作用」只在 main 不直接用这些模块的导出时成立(用到则模块照常保留,语义不变,
  // 但需重新评估体积收益)。electron/ 下新增对它们的直接导入 → 本条失败提醒复核。
  it('前提:electron/ 源码不直接导入 MCP SDK / hono / zod-to-json-schema / server-node 的 MCP server 导出', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const src = readFileSync(p, 'utf-8');
          if (/from\s+['"](@modelcontextprotocol\/sdk|@hono\/node-server|zod-to-json-schema)/.test(src)) {
            offenders.push(p);
          }
          const m = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]@continuo-terminal\/server-node['"]/);
          if (m && /\b(createTerminalMcpServer|main|startHttpTransport|startLocalSocketTransport)\b/.test(m[1]!)) {
            offenders.push(p);
          }
        }
      }
    };
    walk(path.join(ROOT, 'electron'));
    expect(offenders).toEqual([]);
  });
});
