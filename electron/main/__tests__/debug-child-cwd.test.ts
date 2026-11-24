// 安全:debug 相关子进程(登录 shell 探测 PATH、debug adapter)不继承主进程 cwd。CLI 从不可信仓库目录启动
// Continuo 时主进程 cwd 就是该目录:用户 rc 里「启动即读 cwd」的片段(nvm 的 load-nvmrc、direnv 等)会读到
// 仓库里的文件。两处都显式以用户主目录为 cwd(被调试程序自己的 cwd 经 DAP launch 参数显式传,不受影响)。
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DapClient } from '../services/dap-client';
import { defaultExecLoginShell } from '../services/debug.service';
import { CONTINUO_MCP_TOKEN_ENV } from '../lib/continuo-env-keys';

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('debug 子进程的 cwd', () => {
  it('前提:测试进程 cwd 不是主目录(否则下面的断言没有鉴别力)', async () => {
    expect(await realpath(process.cwd())).not.toBe(await realpath(homedir()));
  });

  it.skipIf(process.platform === 'win32')('登录 shell 探测在用户主目录执行', async () => {
    const stdout = await defaultExecLoginShell('/bin/sh', ['-c', 'pwd -P'], 5_000);
    expect(stdout.trim()).toBe(await realpath(homedir()));
  });

  it.skipIf(process.platform === 'win32')(
    '登录 shell 探测不继承 Continuo 内部凭据 env(Continuo 从其终端启动时主进程 env 带 MCP token)',
    async () => {
      const prev = process.env[CONTINUO_MCP_TOKEN_ENV];
      process.env[CONTINUO_MCP_TOKEN_ENV] = 'secret-token';
      try {
        const stdout = await defaultExecLoginShell(
          '/bin/sh',
          ['-c', `printf %s "\${${CONTINUO_MCP_TOKEN_ENV}-unset}"`],
          5_000,
        );
        expect(stdout).toBe('unset');
      } finally {
        if (prev === undefined) delete process.env[CONTINUO_MCP_TOKEN_ENV];
        else process.env[CONTINUO_MCP_TOKEN_ENV] = prev;
      }
    },
  );

  it('debug adapter 在用户主目录启动', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dap-cwd-'));
    const out = path.join(dir, 'cwd.txt');
    const adapter = path.join(dir, 'fake-adapter.cjs');
    await writeFile(adapter, `require('fs').writeFileSync(${JSON.stringify(out)}, process.cwd());\n`);
    const client = new DapClient({ adapterPath: adapter, nodePath: process.execPath, readyTimeoutMs: 5_000 });
    try {
      await expect(client.spawnServer()).rejects.toThrow();
    } finally {
      await client.dispose().catch(() => undefined);
    }
    expect(await realpath(await readFile(out, 'utf8'))).toBe(await realpath(homedir()));
  });
});
