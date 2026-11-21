// 安全:debug adapter(及其拉起的 debuggee)的 env 不得带宿主内部机密 CONTINUO_MCP_TOKEN —— 与插件 / git 子进程
// 共用 child-spawn-hardening 的 INTERNAL_SECRET_ENV_KEYS 名单。用一个把自身 env 写盘后立即退出的假 adapter 验证。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DapClient } from '../services/dap-client';

const realToken = process.env.CONTINUO_MCP_TOKEN;
let dir: string | null = null;
afterEach(async () => {
  if (realToken === undefined) delete process.env.CONTINUO_MCP_TOKEN;
  else process.env.CONTINUO_MCP_TOKEN = realToken;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('DapClient adapter env', () => {
  it('剥离 CONTINUO_MCP_TOKEN,并以 ELECTRON_RUN_AS_NODE=1 启动', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dap-env-'));
    const out = path.join(dir, 'env.json');
    const adapter = path.join(dir, 'fake-adapter.cjs');
    await writeFile(adapter, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`);
    process.env.CONTINUO_MCP_TOKEN = 'secret-token';
    const client = new DapClient({ adapterPath: adapter, nodePath: process.execPath, readyTimeoutMs: 5_000 });
    try {
      await expect(client.spawnServer()).rejects.toThrow();
    } finally {
      await client.dispose().catch(() => undefined);
    }
    const env = JSON.parse(await readFile(out, 'utf8')) as Record<string, string>;
    expect(env.CONTINUO_MCP_TOKEN).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
