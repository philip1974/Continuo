// BDD: agent-terminal-mcp-install-stop-hook · I10 补充:文件系统不支持 chmod 时不拖垮 MCP host 启动
//
// 功能回归:ensureHookEventsDir 在 mkdir 后 chmod 0700。userData 位于不支持 chmod 的文件系统
//(部分网络盘 / FAT / 某些容器挂载)时 chmod 抛 EPERM → startMcpHost 外层 catch → 整个 MCP host 启动失败。
// 契约:chmod 失败只告警,目录照常可用;mkdir 失败仍抛出。

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  const chmod = async () => {
    throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
  };
  return { ...orig, chmod, default: { ...orig, chmod } };
});

const { ensureHookEventsDir } = await import('../../../electron/main/services/mcp-tools-hook-bridge');

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('I10 ensureHookEventsDir:chmod 不受支持', () => {
  it('chmod 抛 EPERM → 不抛出、告警,目录已建好', async () => {
    const base = await mkdtemp(join(tmpdir(), 'continuo-hook-chmod-'));
    roots.push(base);
    const dir = join(base, 'hook-events');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureHookEventsDir(dir)).resolves.toBeUndefined();
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
